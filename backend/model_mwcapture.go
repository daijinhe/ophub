// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"strings"
	"time"
)

// ============================================================================
// 中间件捕捉（Middleware Capture）
//
// 目标：把「这台机器上到底装了什么中间件、装在哪、配置在哪、日志在哪、代码在哪、
// 有没有证书」一次性捕捉下来，形成可留档、可在资产列表展示的快照。
//
// 与「中间件管控（mwops）」的分工：
//   - 中间件管控：**已纳管**的实例 → 看存活 / 启停 / 改配置（有写动作）
//   - 中间件捕捉：**不预设装了什么** → 只读扫描整机，发现存量中间件并补齐落点信息
//     存量机器（手工装的 nginx 1.19.2、系统包里带的老 redis）就是靠它才能被发现。
//
// 数据口径：
//   - 每次捕捉产生一份「资产级快照」，同资产重复捕捉覆盖前一份（幂等 upsert）
//   - 快照内容为 JSON（MwCaptureItem 列表），展示顺序与字段标签严格对齐需求
//   - 平台不存中间件的运行数据副本以外的任何东西，也不写目标机（全链路只读）
// ============================================================================

// 捕捉状态
const (
	MwCaptureStatusOK      = "ok"      // 命中中间件且信息完整
	MwCaptureStatusPartial = "partial" // 命中中间件，但部分信息读不全（多为未提权 / 路径不可读）
	MwCaptureStatusNone    = "none"    // 连上了，但没发现目标中间件
	MwCaptureStatusFailed  = "failed"  // 连不上 / 认证失败 / 探测报错
)

// MwCapture 一台资产的一次中间件捕捉快照
type MwCapture struct {
	ID               uint      `gorm:"primaryKey" json:"id"`
	AssetID          uint      `gorm:"uniqueIndex" json:"assetId"`
	AssetName        string    `gorm:"size:255" json:"assetName"`
	Host             string    `gorm:"size:64" json:"host"`
	Zone             string    `gorm:"size:64" json:"zone"`
	Status           string    `gorm:"size:16;index" json:"status"`
	MwTypes          string    `gorm:"size:255;index" json:"mwTypes"`
	Items            string    `gorm:"type:text" json:"items"`
	Error            string    `gorm:"size:512" json:"error"`
	Raw              string    `gorm:"type:text" json:"-"` // 探测原始输出（排查用，不随列表返回）
	Privileged       bool      `json:"privileged"`
	DurationMs       int64     `json:"durationMs"`
	CapturedAt       time.Time `json:"capturedAt"`
	CapturedBy       string    `gorm:"size:64" json:"capturedBy"`
	CustomFieldsJSON string    `gorm:"type:text" json:"-"`
	CustomFields     []MwKv    `gorm:"-" json:"customFields,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// CustomFieldList 解析自定义字段（资产详情里用户手工添加的键值）
func (c *MwCapture) CustomFieldList() []MwKv {
	out := []MwKv{}
	if strings.TrimSpace(c.CustomFieldsJSON) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(c.CustomFieldsJSON), &out)
	return out
}

// TableName 指定表名
func (MwCapture) TableName() string { return "mw_captures" }

// ItemList 解析快照明细
func (c MwCapture) ItemList() []MwCaptureItem {
	out := []MwCaptureItem{}
	if strings.TrimSpace(c.Items) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(c.Items), &out)
	return out
}

// TypeList 解析命中类型（列表列 / 搜索用）
func (c MwCapture) TypeList() []string {
	out := []string{}
	for _, t := range strings.Split(c.MwTypes, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// MwCaptureItem 一类中间件的捕捉结果。
//
// 字段按需求逐项落位：nginx / 宝兰德bws310 用 Version/Ports/InstallPath/ConfigPaths/
// LogPaths/CodePaths/Certs；php 只用 InstallPath/ConfigPaths；java 用 Version/Jars。
// redis 用 Version/Ports/InstallPath/Password —— 2026-09-17 用户要求去掉「配置文件位置 /
// 日志路径 / 存储位置」，改为登记 Redis 访问密码。
// elasticsearch 用 Version/Ports/InstallPath/AccessUrl/Username/Password —— 2026-09-17
// 用户新增：访问地址（HTTP endpoint）、账号（xpack 用户名），跑不出时留空让用户手填。
// 没有的字段留空，前端不渲染空行。
type MwCaptureItem struct {
	Type        string       `json:"type"`
	Label       string       `json:"label"`
	Running     bool         `json:"running"`
	Version     string       `json:"version,omitempty"`
	Ports       []string     `json:"ports,omitempty"`
	InstallPath string       `json:"installPath,omitempty"`
	AccessUrl   string       `json:"accessUrl,omitempty"` // 访问地址（ES 用户新增 2026-09-17）
	Username    string       `json:"username,omitempty"`  // 账号（ES 用户新增 2026-09-17；密码另存 Password）
	ConfigPaths []string     `json:"configPaths,omitempty"`
	LogPaths    []string     `json:"logPaths,omitempty"`
	CodePaths   []MwCodePath `json:"codePaths,omitempty"`
	Certs       []string     `json:"certs,omitempty"`
	Jars        []MwJavaApp  `json:"jars,omitempty"`
	Storage     []MwKv       `json:"storage,omitempty"`
	Password    string       `json:"password,omitempty"` // 访问密码（2026-09-17 新增，当前 redis / es 使用）
	Notes       []string     `json:"notes,omitempty"`
}

// MwCodePath 代码路径（按端口配对：一台机器上两个端口常对应两套代码）
//
// Biz 是「代码业务」——这个代码目录承载的业务名称（如 权责清单/信访系统）。
// 仅供手工填写，采集脚本不解析；老快照里没有该字段时取零值（omitempty 不出现）。
type MwCodePath struct {
	Port string `json:"port"`
	Path string `json:"path"`
	Biz  string `json:"biz,omitempty"`
}

// MwJavaApp 一个 java 应用（可能多个 jar 包 / 多个应用）
//
// Biz 同上：手工填写的「代码业务」。
type MwJavaApp struct {
	Pid      int    `json:"pid"`
	Name     string `json:"name"` // jar/war 文件名，兜底主类
	Jar      string `json:"jar"`  // jar/war 全路径
	CodePath string `json:"codePath"`
	Biz      string `json:"biz,omitempty"` // 代码业务（手工填写）
	Port     string `json:"port"`          // 监听端口（多个用 , 分隔）
	Command  string `json:"command"`       // 启动命令全文
	Version  string `json:"version"`       // JVM 版本
}

// MwKv 通用键值（redis 的存储位置等）
type MwKv struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// mwTypeLabelMap 类型码 → 展示名（资产列表列 / 导出共用同一口径）
var mwTypeLabelMap = map[string]string{
	"nginx":  "Nginx",
	"php":    "PHP-FPM",
	"java":   "Java",
	"redis":  "Redis",
	"es":     "ElasticSearch",
	"bws310": "BWS310",
	"tomcat": "Tomcat",
}

// mwTypeLabels 把「nginx,redis」形式的类型串转成展示名串（未知类型原样保留）
func mwTypeLabels(csv string) string {
	names := []string{}
	for _, t := range strings.Split(csv, ",") {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if lb, ok := mwTypeLabelMap[t]; ok {
			names = append(names, lb)
			continue
		}
		names = append(names, t)
	}
	return strings.Join(names, ",")
}

// mergeHandBiz 把「老的 items」里手工填的 biz 字段（按 type + codePath 端口路径 / jar
// 包名匹配）合并回「本次扫描结果」中同位置的对应字段，避免重捕时被脚本输出覆盖。
//
// 仅在新条目 biz 为空时才回填（避免脚本未来也支持自动采集时，老值反向覆盖）；
// 老条目里 port+path 完全相同（或 jar 全路径相同；jar 缺失时回退到 name）才算命中。
// 该函数不会修改入参 slice（先 copy）。
func mergeHandBiz(scanItems, oldItems []MwCaptureItem) []MwCaptureItem {
	if len(scanItems) == 0 || len(oldItems) == 0 {
		return scanItems
	}
	out := make([]MwCaptureItem, len(scanItems))
	copy(out, scanItems)
	for i := range out {
		for _, old := range oldItems {
			if old.Type != out[i].Type {
				continue
			}
			// codePaths：按 port+path 配对回填老 biz
			for ni := range out[i].CodePaths {
				ncp := &out[i].CodePaths[ni]
				if ncp.Biz != "" {
					continue
				}
				for _, ocp := range old.CodePaths {
					if ocp.Port == ncp.Port && ocp.Path == ncp.Path && ocp.Biz != "" {
						ncp.Biz = ocp.Biz
						break
					}
				}
			}
			// jars：按 jar 全路径（缺失时回退 name）回填老 biz
			for ni := range out[i].Jars {
				nj := &out[i].Jars[ni]
				if nj.Biz != "" {
					continue
				}
				nkey := nj.Jar
				if nkey == "" {
					nkey = nj.Name
				}
				for _, oj := range old.Jars {
					okey := oj.Jar
					if okey == "" {
						okey = oj.Name
					}
					if okey != "" && okey == nkey && oj.Biz != "" {
						nj.Biz = oj.Biz
						break
					}
				}
			}
		}
	}
	return out
}
