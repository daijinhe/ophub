package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// 脚本管理 —— Java 启停脚本
//
// v1.7.9 起只支持「平台本机」模式（远端功能下线）：
//
//   平台获取虚拟机信息一律经 ansible —— 但脚本管理的典型场景是「Jenkins 与
//   平台同机、脚本就在这台机器上」，走 ansible 中转既没必要也徒增配置成本。
//   所以脚本管理在这里不开远端通道，直接读写平台所在机器的文件系统。
//
// 安全约束（沿用）：
//   - 路径硬约束：所有读写路径必须落在「允许根」之下（默认
//     /data/jenkins_home/scripts/Java_Start_Stop_SH）—— 即使前端把 root 传成
//     更宽的目录，读写也只能落在被约束的子树下，防止越界改 /etc、/home。
//   - 服务名 / 文件名再用 ^[A-Za-z0-9_.-]+$ 收口，禁掉空格与斜杠。
//   - 写文件大小上限 1MiB（防 base64 撑爆控制节点 argv，本机模式同样受限）。
//
// ⚠️ 平台跑在容器里时「本机」= 容器文件系统。要管理宿主机的脚本目录，必须
// 在 docker-compose.yml 的 backend.volumes 里把该路径挂进容器（默认挂
// /data/jenkins_home/scripts/Java_Start_Stop_SH，通过 SCRIPT_HOST_ROOT 覆盖），
// 否则容器内看到的是一个空目录。
//
// 权限：列出 / 读取 用 script:view；创建 / 修改 / 删除 用 script:manage。
// ============================================================================

// defaultScriptRoot 平台默认脚本根目录。
// 前端 root 传空时用此兜底，避免「切换落点 + 遗留旧路径」误伤。
const defaultScriptRoot = "/data/jenkins_home/scripts/Java_Start_Stop_SH"

// scriptMaxReadBytes 单文件读取上限（脚本以文本为主，1MiB 足够）。
const scriptMaxReadBytes = 1 * 1024 * 1024

// scriptMaxWriteBytes 单文件写入上限。
const scriptMaxWriteBytes = 1 * 1024 * 1024

// ---------------------------------------------------------------------------
// 落点抽象
// ---------------------------------------------------------------------------

// scriptHost 脚本管理的「数据落点」。
//
// *crontabTarget（远端）与 localScriptHost（本机）都实现它；方法签名刻意与
// crontabTarget 现有方法保持一致，让远端实现零改造即可满足接口。
type scriptHost interface {
	ListDir(dir string) ([]scriptDirEntry, error)
	ReadFile(path string) (string, error)
	WriteFile(path, content string) error
	MkDir(dir string) error
	RemoveFile(path string) error
	RemoveEmptyDir(dir string) error
	RemoveRec(dir string) error
	// Stat 返回 isDir；err 非空表示条目不存在或探测失败。
	// 删除接口靠它区分「文件 / 空目录 / 非空目录」三种语义 —— ListDir 做不到，
	// 因为空目录和文件都会返回空列表。
	Stat(path string) (bool, error)
}

// ---------------------------------------------------------------------------
// 本机落点
// ---------------------------------------------------------------------------

// localScriptHost 直接读写平台所在机器的文件系统。
//
// ⚠️ 平台跑在容器里时「本机」= 容器文件系统。要管理宿主机的脚本目录，必须
// 在 docker-compose.yml 的 backend.volumes 里把该路径挂进容器
// （见那里的 SCRIPT_HOST_ROOT），否则容器内看到的是一个空目录。
type localScriptHost struct{}

func (localScriptHost) ListDir(dir string) ([]scriptDirEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("列目录失败：%v", err)
	}
	out := make([]scriptDirEntry, 0, len(entries))
	for _, e := range entries {
		info, ierr := e.Info()
		if ierr != nil {
			continue
		}
		out = append(out, scriptDirEntry{
			Name:    e.Name(),
			Path:    filepath.Join(dir, e.Name()),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Format("2006-01-02 15:04"),
		})
	}
	return out, nil
}

func (localScriptHost) ReadFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("文件不存在或不可读：%s", path)
	}
	defer f.Close()
	// 与远端落点一致：超长文件截断而不是全量读入内存
	b, err := io.ReadAll(io.LimitReader(f, scriptMaxReadBytes))
	if err != nil {
		return "", fmt.Errorf("读取失败：%v", err)
	}
	return string(b), nil
}

func (localScriptHost) WriteFile(path, content string) error {
	// 备份：与远端 WriteFile 行为一致（*.ophub.bak），失败不阻断写入
	if old, err := os.ReadFile(path); err == nil {
		_ = os.WriteFile(path+".ophub.bak", old, 0o644)
	}
	tmp := path + ".ophub.tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return fmt.Errorf("写入失败：%v", err)
	}
	// rename 是原子操作，避免写到一半被读到残缺内容
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("替换失败：%v", err)
	}
	return nil
}

func (localScriptHost) MkDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建目录失败：%v", err)
	}
	return nil
}

func (localScriptHost) RemoveFile(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("删除文件失败：%v", err)
	}
	return nil
}

func (localScriptHost) RemoveEmptyDir(dir string) error {
	if err := os.Remove(dir); err != nil {
		return fmt.Errorf("删除目录失败（可能非空）：%v", err)
	}
	return nil
}

func (localScriptHost) RemoveRec(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("删除目录失败：%v", err)
	}
	return nil
}

func (localScriptHost) Stat(path string) (bool, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return false, fmt.Errorf("条目不存在：%s", path)
	}
	return fi.IsDir(), nil
}

// ---------------------------------------------------------------------------
// 路径与落点解析
// ---------------------------------------------------------------------------

// reSafeName 服务名 / 文件名安全字符约束：
//
//	Unicode 字母 / 数字 / 下划线 / 中划线 / 点 —— 与 java 服务命名习惯保持一致；
//	允许中文等服务名（v1.7.23 起放开，跟 reSafePath 同步）；禁止斜杠（防止
//	path 穿越）、禁止控制字符与 NUL byte（Go RE2 \p{L}/\p{N} 自然不匹配）。
var reSafeName = regexp.MustCompile(`^[\p{L}\p{N}_.-]+$`)

// normalizeScriptPath 校验路径合法性 + 强制落在允许根之下。
//
// 返回：
//   - absRoot : 规范化后的根（前端 root 或默认根，Clean 后确保无 ..）
//   - absPath : 规范化后的目标路径（p 为空时等于 absRoot —— 适用于「只校验根」
//     的场景，如 MakeScriptDir；其他场景都传完整 path，行为不变）
//   - err     : 越界 / 不合法时返回详细错误
//
// 为什么不用 reSafePath 单点过滤：reSafePath 只看字符集
// （^/[-A-Za-z0-9_./]+$），而「../etc/passwd」同样满足字符集，必须前缀二次把关。
//
// 重要：reSafePath 要求路径以 / 开头，因此 p 为空时跳过 regex 校验（视为「仅校验根」）。
// 修复历史：v1.7.x 起 MakeScriptDir 调 normalizeScriptPath(root, "")，空 p 匹配不上
// reSafePath（要求必须以 / 开头），导致「创建服务目录」永远报 400。改成允许空 p。
func normalizeScriptPath(root, p string) (absRoot, absPath string, err error) {
	root = strings.TrimSpace(root)
	if root == "" {
		root = defaultScriptRoot
	}
	if strings.Contains(root, "..") {
		return "", "", fmt.Errorf("根路径不允许包含 ..（防止越界）：%s", root)
	}
	if p != "" && strings.Contains(p, "..") {
		return "", "", fmt.Errorf("路径不允许包含 ..（防止越界）：%s", p)
	}
	if !reSafePath.MatchString(root) {
		return "", "", fmt.Errorf("根路径包含非法字符：%s", root)
	}
	if p != "" && !reSafePath.MatchString(p) {
		return "", "", fmt.Errorf("路径包含非法字符：%s", p)
	}
	absRoot = filepath.Clean(root)
	// p 既可能是绝对路径也可能是相对路径——相对时拼到根下，
	// 拼接后再次 Clean 防御性消除多重 ../ 穿越
	if p == "" {
		absPath = absRoot
	} else if !strings.HasPrefix(p, "/") {
		absPath = filepath.Clean(absRoot + "/" + p)
	} else {
		absPath = filepath.Clean(p)
	}
	// 强制前缀：absPath 必须等于 absRoot 或以 absRoot+"/" 开头
	// （带 "/" 是防止把 root 设成 /a 后请求 /abc 看起来"在根下"）
	if absPath != absRoot && !strings.HasPrefix(absPath, absRoot+"/") {
		return "", "", fmt.Errorf("路径越界：%s 不在允许的根目录 %s 下", absPath, absRoot)
	}
	return absRoot, absPath, nil
}

// resolveScriptHost 自 v1.7.9 起只支持本机模式 —— 远端功能下线，
// 接口签名保留 c 形参只是为了和旧路由 7 个 handler 一致，参数全忽略。
func resolveScriptHost(c *gin.Context) (scriptHost, error) {
	return localScriptHost{}, nil
}

// ---------------------------------------------------------------------------
// 接口实现
// ---------------------------------------------------------------------------

// ----- 列出一级条目（目录 + 文件，含类型/大小/修改时间） -----

func ListScriptsEntry(c *gin.Context) {
	h, err := resolveScriptHost(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	absRoot, absPath, err := normalizeScriptPath(c.Query("root"), c.Query("path"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	entries, err := h.ListDir(absPath)
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
	h, err := resolveScriptHost(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	_, absPath, err := normalizeScriptPath(c.Query("root"), c.Query("path"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	content, err := h.ReadFile(absPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"path":    absPath,
		"size":    len(content),
		"content": content,
	})
}

// scriptWriteBody 保存脚本的请求体
type scriptWriteBody struct {
	Content string `json:"content"`
}

// ----- 写入脚本文件 -----

func PutScriptFile(c *gin.Context) {
	h, err := resolveScriptHost(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	_, absPath, err := normalizeScriptPath(c.Query("root"), c.Query("path"))
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
	// 两种落点都会在写前自动备份 *.ophub.bak
	if err := h.WriteFile(absPath, body.Content); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg": "保存成功", "path": absPath, "size": len(body.Content)})
}

// ----- 创建服务目录（一个 Java 服务对应一个子目录） -----

func MakeScriptDir(c *gin.Context) {
	h, err := resolveScriptHost(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	absRoot, _, err := normalizeScriptPath(c.Query("root"), "")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	name := strings.TrimSpace(c.Query("name"))
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "请填写目录名"})
		return
	}
	if !reSafeName.MatchString(name) {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "目录名只能包含字母/数字/下划线/中划线/点"})
		return
	}
	target := absRoot + "/" + name
	if err := h.MkDir(target); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg": "创建成功", "path": target})
}

// ----- 删除条目 -----
//
// DeleteScriptEntry 按条目实际状态自适应三种语义：
//   - 文件        → rm -f（os.Remove）
//   - 空目录      → rmdir（os.Remove）
//   - 非空目录    → 递归删（前端已走强二次确认）
//
// 是否递归由后端判定、前端无法选择 —— 这样误删概率最低。

func DeleteScriptEntry(c *gin.Context) {
	h, err := resolveScriptHost(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	root := c.Query("root")
	_, absPath, err := normalizeScriptPath(root, c.Query("path"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	// 不允许删根目录本身
	absRoot, _, _ := normalizeScriptPath(root, "")
	if absPath == absRoot {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "不允许删除根目录：" + absRoot})
		return
	}
	isDir, err := h.Stat(absPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"msg": err.Error()})
		return
	}
	if !isDir {
		if err := h.RemoveFile(absPath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"msg": "文件已删除", "path": absPath})
		return
	}
	entries, err := h.ListDir(absPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	if len(entries) == 0 {
		if err := h.RemoveEmptyDir(absPath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"msg": "空目录已删除", "path": absPath})
		return
	}
	if err := h.RemoveRec(absPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg": "目录已递归删除", "path": absPath})
}

// ----- 新建脚本文件（在已存在的服务目录下） -----

func PostScriptFile(c *gin.Context) {
	h, err := resolveScriptHost(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	_, absPath, err := normalizeScriptPath(c.Query("root"), c.Query("path"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	// 文件名仅取 basename 校验（目录部分已由 normalizeScriptPath 把关）
	if !reSafeName.MatchString(filepath.Base(absPath)) {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "文件名只能包含字母/数字/下划线/中划线/点"})
		return
	}
	content := c.Query("content") // 新建时可选：给则写入，不给则建空文件
	if len(content) > scriptMaxWriteBytes {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "脚本内容超限"})
		return
	}
	if err := h.WriteFile(absPath, content); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg": "创建成功", "path": absPath})
}
