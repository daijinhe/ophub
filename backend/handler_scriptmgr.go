package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// 脚本管理 —— Java 启停脚本
//
// 设计要点（2026-09-17）：
//   1. 经 `crontabTarget` 走 ansible 通道：与定时间任务 / 中间件捕捉同一条远端通道，
//      路径前缀解析、sudo 通道记忆、TCP 预探测等复用，无任何直连 SSH 路径。
//   2. 平台获取虚拟机信息一律经 ansible 控制节点：禁止静默退化为直连 SSH（见 handler_config.go 入口）。
//   3. 路径硬约束：所有读写路径必须落在「允许根」之下（默认 /data/jenkins_home/scripts/Java_Start_Stop_SH）
//      —— 即使 ROOT_PATH 被未来改成更宽的目录，文件读写依然只能落在被约束的子树下，
//      防止越界修改 /etc、/home 等系统目录。
//   4. 写文件大小上限 1MB：脚本文件过大时强制要求「先在本地编辑 → SCP」，
//      避免 base64 命令行把控制节点的 argv 撑爆。
//
// 角色权限：
//   - 列出 / 读取   script:view
//   - 创建 / 修改 / 删除  script:manage
// 路由注册在 main.go 的 auth 分组下；PermissionCatalog 同步暴露。
// ============================================================================

// defaultScriptRoot 平台默认脚本根目录。
// 前端传入 root 时允许为空字符串 → 用此兜底，避免「切换主机 + 遗留旧路径」误伤。
const defaultScriptRoot = "/data/jenkins_home/scripts/Java_Start_Stop_SH"

// scriptMaxReadBytes 单文件读取上限（脚本管理用，文本为主，足够大）。
const scriptMaxReadBytes = 1 * 1024 * 1024 // 1 MiB

// scriptMaxWriteBytes 单文件写入上限。
const scriptMaxWriteBytes = 1 * 1024 * 1024 // 1 MiB

// normalizeScriptPath 校验路径合法性 + 强制落在允许根之下。
//
// 返回「绝对路径 + 已校验」三元：
//   - absRoot : 规范化后的根（从前端 root 传入或默认根，Clean 后确保无 ..）
//   - absPath : 规范化后的目标路径
//   - err     : 越界 / 不合法时返回详细错误
//
// 为什么不用 reSafePath 单点过滤：reSafePath 只看字符集
// （^[A-Za-z0-9_./-]+），但「../etc/passwd」也满足字符集，必须前缀二次把关。
func normalizeScriptPath(root, p string) (absRoot, absPath string, err error) {
	root = strings.TrimSpace(root)
	if root == "" {
		root = defaultScriptRoot
	}
	if !reSafePath.MatchString(root) || !reSafePath.MatchString(p) {
		return "", "", fmt.Errorf("路径包含非法字符")
	}
	absRoot = filepath.Clean(root)
	// 传入 p 既可能是绝对路径也可能是相对路径——做一次拼接兜底，
	// 拼接后再次 Clean 防御性消除 ../ 多重穿越
	if !strings.HasPrefix(p, "/") {
		absPath = filepath.Clean(absRoot + "/" + p)
	} else {
		absPath = filepath.Clean(p)
	}
	// 强制前缀：absPath 必须以 absRoot + "/" 开头
	// （用 "/" 防止用户把 root 设为 /a 然后请求 /abc 看起来"在根下"）
	if absPath != absRoot && !strings.HasPrefix(absPath, absRoot+"/") {
		return "", "", fmt.Errorf("路径越界：%s 不在允许的根目录 %s 下", absPath, absRoot)
	}
	return absRoot, absPath, nil
}

// resolveScriptTarget 把前端传入的 host 解析成 crontabTarget。
//
// assetID < 0 表示「资产表外的目标机」专用通道（保留接口）；
// 现在阶段业务只走资产管理，所以未配置资产的请求直接 400 拒绝。
func resolveScriptTarget(c *gin.Context, assetID int64) (*crontabTarget, *Asset, error) {
	if assetID <= 0 {
		return nil, nil, errors.New("请选择目标资产")
	}
	var a Asset
	if err := DB.First(&a, assetID).Error; err != nil {
		return nil, nil, fmt.Errorf("资产不存在或已被删除（ID=%d）", assetID)
	}
	if strings.TrimSpace(a.IP) == "" {
		return nil, &a, errors.New("资产缺少 IP，无法连接")
	}
	t, err := assetTarget(a)
	if err != nil {
		return nil, &a, err
	}
	return t, &a, nil
}

// ----- 列出一级条目（目录 + 文件，含类型/大小/修改时间） -----

func ListScriptsEntry(c *gin.Context) {
	assetID, _ := strconv.ParseInt(c.Query("host"), 10, 64)
	path := c.Query("path")
	root := c.Query("root")

	t, _, err := resolveScriptTarget(c, assetID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	absRoot, absPath, err := normalizeScriptPath(root, path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	entries, err := t.ListDir(absPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"root":  absRoot,
		"path":  absPath,
		"items": entries,
	})
}

// ----- 读取脚本文件 -----

func GetScriptFile(c *gin.Context) {
	assetID, _ := strconv.ParseInt(c.Query("host"), 10, 64)
	path := c.Query("path")
	root := c.Query("root")

	t, _, err := resolveScriptTarget(c, assetID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	_, absPath, err := normalizeScriptPath(root, path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	// 先快速判定：目标存在 + 是文件
	raw, err := t.exec(fmt.Sprintf(`if [ -f %q ] && [ -r %q ]; then echo OK; else echo NO; fi`,
		absPath, absPath), 10*1e9)
	if err != nil || !strings.Contains(raw, "OK") {
		c.JSON(http.StatusNotFound, gin.H{"msg": "文件不存在或不可读：" + absPath})
		return
	}
	// 用 cat | base64 控制传输；与 crontabTarget.ReadFile 同样的通道
	pre := t.sudoPrefix()
	cmd := fmt.Sprintf(
		`%sif [ -f %q ]; then cat %q; else %scat %q; fi | head -c %d | base64 -w 0`,
		pre, absPath, absPath, pre, absPath, scriptMaxReadBytes,
	)
	encoded, err := t.exec(cmd, 30*time.Second)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "读取失败：" + err.Error()})
		return
	}
	decoded, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if derr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "返回内容解析失败：" + derr.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"path":    absPath,
		"size":    len(decoded),
		"content": string(decoded),
	})
}

// bodyOf: 临时辅助，从 gin body 解析一段 json。
type scriptWriteBody struct {
	Content string `json:"content"`
}

// ----- 写入脚本文件 -----

func PutScriptFile(c *gin.Context) {
	assetID, _ := strconv.ParseInt(c.Query("host"), 10, 64)
	path := c.Query("path")
	root := c.Query("root")

	t, _, err := resolveScriptTarget(c, assetID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	_, absPath, err := normalizeScriptPath(root, path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	var body scriptWriteBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "请求体不合法：" + err.Error()})
		return
	}
	if len(body.Content) > scriptMaxWriteBytes {
		c.JSON(http.StatusBadRequest, gin.H{
			"msg": fmt.Sprintf("脚本大小超出限制（上限 %d 字节），请在本地编辑后用 SCP 上传", scriptMaxWriteBytes),
		})
		return
	}
	// crontabTarget.WriteFile 会在写前自动备份 *.ophub.bak，无需这里再做
	if err := t.WriteFile(absPath, body.Content); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg": "保存成功", "path": absPath, "size": len(body.Content)})
}

// ----- 创建服务目录（一个 Java 服务对应一个子目录） -----

func MakeScriptDir(c *gin.Context) {
	assetID, _ := strconv.ParseInt(c.Query("host"), 10, 64)
	root := c.Query("root")
	name := strings.TrimSpace(c.Query("name"))

	t, _, err := resolveScriptTarget(c, assetID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	absRoot, _, err := normalizeScriptPath(root, "")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "请填写目录名"})
		return
	}
	// 目录名校验：服务名只允许字母/数字/下划线/中划线/点（java 包名常见字符）
	if !reSafeName.MatchString(name) {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "目录名只能包含字母/数字/下划线/中划线/点"})
		return
	}
	target := absRoot + "/" + name
	if err := t.MkDir(target); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg": "创建成功", "path": target})
}

// reSafeName 服务名 / 文件名安全字符约束：
//
//	字母 / 数字 / 下划线 / 中划线 / 点 —— 与 java 服务命名习惯保持一致；
//	禁止斜杠（防止 path 穿越）、禁止空格（防止 shell 上下文被误解析）。
var reSafeName = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// ----- 删除条目 -----
// DeleteScriptEntry 一次性「文件/空目录/递归目录」三种语义：
//   - path 命中文件 → 仅删文件
//   - path 是空目录 → rmdir
//   - path 是非空目录 → 递归删（前端走强二次确认）
// 是否递归由后端按目录状态自适配，前端无法选择——这样误删概率最低。

func DeleteScriptEntry(c *gin.Context) {
	assetID, _ := strconv.ParseInt(c.Query("host"), 10, 64)
	path := c.Query("path")
	root := c.Query("root")

	t, _, err := resolveScriptTarget(c, assetID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	_, absPath, err := normalizeScriptPath(root, path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	// 不允许直接删根目录
	absRoot, _, _ := normalizeScriptPath(root, "")
	if absPath == absRoot {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "不允许删除根目录：" + absRoot})
		return
	}
	// 类型探测：是文件 / 空目录 / 非空目录
	probe, _ := t.exec(
		fmt.Sprintf(`if [ -f %q ]; then FILE; elif [ -d %q ]; then if [ -z "$(%sls -1A %q | head -n 50)" ]; then EMPTYDIR; else NONEMPTY; fi; else MISSING; fi`,
			absPath, absPath, t.sudoPrefix(), absPath), 10*1e9)
	switch {
	case strings.Contains(probe, "FILE"):
		if err := t.RemoveFile(absPath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"msg": "文件已删除", "path": absPath})
	case strings.Contains(probe, "EMPTYDIR"):
		if err := t.RemoveEmptyDir(absPath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"msg": "空目录已删除", "path": absPath})
	case strings.Contains(probe, "NONEMPTY"):
		// 走前端二次确认触达这里：rm -rf
		if err := t.RemoveRec(absPath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"msg": "目录已递归删除", "path": absPath})
	default:
		c.JSON(http.StatusNotFound, gin.H{"msg": "条目不存在：" + absPath})
	}
}

// 创建空白文件：用于在已存在的服务目录下新建 start.sh / stop.sh
func PostScriptFile(c *gin.Context) {
	assetID, _ := strconv.ParseInt(c.Query("host"), 10, 64)
	path := c.Query("path")
	root := c.Query("root")
	content := c.Query("content") // 新建时 content 可选（提供则写入；空则建空文件）

	t, _, err := resolveScriptTarget(c, assetID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	_, absPath, err := normalizeScriptPath(root, path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	// 文件名仅取 basename + 用 reSafeName 校验
	base := filepath.Base(absPath)
	if !reSafeName.MatchString(base) {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "文件名只能包含字母/数字/下划线/中划线/点"})
		return
	}
	if len(content) > scriptMaxWriteBytes {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "脚本内容超限"})
		return
	}
	if err := t.WriteFile(absPath, content); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg": "创建成功", "path": absPath})
}
