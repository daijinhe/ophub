package main

import (
	"encoding/json"
	"log"
	"strings"
	"time"
)

// ============================================================================
// 中间件管控（Middleware Ops）
//
// 目标：把「已经装到机器上的中间件」变成可运维的对象 —— 远程查看进程是否存活、
// 启停 / 重启 / 重载、在线查看与编辑配置文件。
//
// 两块数据：
//   - MwOpsProfile：**按类型**的能力档案（进程关键字 / systemd 单元候选 / 常见安装路径 /
//     配置文件候选 / 启停命令模板 / 配置校验命令）。内置种子启动幂等同步，页面可改。
//   - MwInstance：**具体一台机器上的一个中间件实例**。来源有两种：
//       1) deploy：从「部署执行记录」同步（谁在哪台机器上装了哪个中间件）
//       2) manual：页面手动纳管（不经过平台部署的存量中间件）
//     两者都会在「检测」时补齐实测信息（安装路径 / 版本 / 运行状态）。
//
// 命令模板占位符：
//
//	{path} 安装路径   {sbin} = {path}/sbin   {conf} 首个存在的配置文件
//	{port} 端口       {pid}  当前主进程 PID  {unit} systemd 单元名
//
// 与既有模块的口径复用：
//   - 目标机访问（SSH 用户 / 超级管理员用户 + 两级密码回退）复用定时任务的 crontabTarget
//   - 展示名统一走 AssetDisplayName，不另拼一套
// ============================================================================

// ---------------- 类型能力档案 ----------------

// MwOpsProfile 一种中间件的运维能力档案（全局共享，可按环境修改）
type MwOpsProfile struct {
	ID       uint   `gorm:"primaryKey" json:"id"`
	Type     string `gorm:"size:64;uniqueIndex" json:"type"` // 与部署目录 middlewares.name 同一口径
	Label    string `gorm:"size:128" json:"label"`
	Icon     string `gorm:"size:64" json:"icon"`
	Category string `gorm:"size:64" json:"category"`

	// 探测
	ProcessPattern string `gorm:"size:255" json:"processPattern"` // pgrep -f 的匹配串（ERE）
	Units          string `gorm:"size:255" json:"units"`          // 逗号分隔的 systemd 单元名候选
	DefaultPaths   string `gorm:"type:text" json:"defaultPaths"`  // JSON []string：常见安装路径（自动发现用）
	DefaultPort    string `gorm:"size:32" json:"defaultPort"`

	// 配置
	ConfigPaths   string `gorm:"type:text" json:"configPaths"` // JSON []string：配置文件候选（支持尾部 * 通配）
	ConfigTestCmd string `gorm:"size:512" json:"configTestCmd"`
	VersionCmd    string `gorm:"size:512" json:"versionCmd"` // 版本探测命令（输出用于回填实例版本号）

	// 动作（模板）
	CmdStart   string `gorm:"size:512" json:"cmdStart"`
	CmdStop    string `gorm:"size:512" json:"cmdStop"`
	CmdRestart string `gorm:"size:512" json:"cmdRestart"`
	CmdReload  string `gorm:"size:512" json:"cmdReload"`

	// ProcessOnly 为真表示该类型没有「单体服务」概念，以进程为管理对象（如 jdk / java 应用）
	ProcessOnly bool   `json:"processOnly"`
	Desc        string `gorm:"size:512" json:"desc"`
	Enabled     bool   `json:"enabled"`
	SeedVer     int    `gorm:"default:0" json:"seedVer"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// TableName 指定表名
func (MwOpsProfile) TableName() string { return "mw_ops_profiles" }

// PathList 解析 DefaultPaths JSON
func (p MwOpsProfile) PathList() []string { return decodeStrList(p.DefaultPaths) }

// ConfigPathList 解析 ConfigPaths JSON
func (p MwOpsProfile) ConfigPathList() []string { return decodeStrList(p.ConfigPaths) }

// UnitList 解析 Units（逗号分隔）
func (p MwOpsProfile) UnitList() []string {
	out := []string{}
	for _, u := range strings.Split(p.Units, ",") {
		if u = strings.TrimSpace(u); u != "" {
			out = append(out, u)
		}
	}
	return out
}

func decodeStrList(s string) []string {
	out := []string{}
	if strings.TrimSpace(s) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func encodeStrList(v []string) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// mwOpsSeedVer 内置类型档案版本，与部署目录版本 mwSeedVer 共用同一个值（两者由
// middlewareRegistry() 统一派生）：调整内置档案后把 mwSeedVer +1 即可，启动时覆盖
// seed_ver 小于该值的记录，但不覆盖页面上的手工改动。
const mwOpsSeedVer = mwSeedVer

// mwOpsSeedProfiles 内置类型档案：由统一注册表 middlewareRegistry() 派生（部署侧 Name 即运维侧 Type）。
// 路径/单元名按控制节点部署脚本的实际落点填写；页面可逐项修改以适配现场。
func mwOpsSeedProfiles() []MwOpsProfile {
	out := make([]MwOpsProfile, 0, len(middlewareRegistry()))
	for _, d := range middlewareRegistry() {
		if !d.IncludeOps {
			continue
		}
		out = append(out, MwOpsProfile{
			Type: d.Name, Label: d.Label, Icon: d.Icon, Category: d.Category,
			ProcessPattern: d.ProcessPattern,
			Units:          encodeStrList(d.Units),
			DefaultPaths:   encodeStrList(d.DefaultPaths),
			DefaultPort:    d.DefaultPort,
			ConfigPaths:    encodeStrList(d.ConfigPaths),
			ConfigTestCmd:  d.ConfigTestCmd,
			VersionCmd:     d.VersionCmd,
			CmdStart:       d.CmdStart,
			CmdStop:        d.CmdStop,
			CmdRestart:     d.CmdRestart,
			CmdReload:      d.CmdReload,
			ProcessOnly:    d.ProcessOnly,
			Desc:           d.OpsDesc,
			Enabled:        d.Enabled,
		})
	}
	return out
}

// SyncMwOpsProfiles 启动时幂等同步内置类型档案（规则与中间件目录一致：
// 已同步过的保留运维改动，未同步/新增的按内置值写入）。
func SyncMwOpsProfiles() {
	seeds := mwOpsSeedProfiles()
	for _, s := range seeds {
		var cur MwOpsProfile
		err := DB.Where("type = ?", s.Type).First(&cur).Error
		if err != nil {
			s.SeedVer = mwOpsSeedVer
			if e := DB.Create(&s).Error; e != nil {
				log.Printf("中间件运维档案初始化失败 %s: %v", s.Type, e)
			}
			continue
		}
		if cur.SeedVer >= mwOpsSeedVer {
			continue
		}
		keepEnabled := cur.Enabled
		cur.Label = s.Label
		cur.Icon = s.Icon
		cur.Category = s.Category
		cur.ProcessPattern = s.ProcessPattern
		cur.Units = s.Units
		cur.DefaultPaths = s.DefaultPaths
		cur.DefaultPort = s.DefaultPort
		cur.ConfigPaths = s.ConfigPaths
		cur.ConfigTestCmd = s.ConfigTestCmd
		cur.VersionCmd = s.VersionCmd
		cur.CmdStart = s.CmdStart
		cur.CmdStop = s.CmdStop
		cur.CmdRestart = s.CmdRestart
		cur.CmdReload = s.CmdReload
		cur.ProcessOnly = s.ProcessOnly
		cur.Desc = s.Desc
		cur.Enabled = keepEnabled
		cur.SeedVer = mwOpsSeedVer
		cur.UpdatedAt = time.Now()
		if e := DB.Save(&cur).Error; e != nil {
			log.Printf("中间件运维档案同步失败 %s: %v", s.Type, e)
		}
	}
	log.Printf("中间件运维档案同步完成，共 %d 类", len(seeds))
}

// ---------------- 实例 ----------------

// 运行状态常量
const (
	MwOpsRunning = "running" // 进程存活（或 systemd active）
	MwOpsStopped = "stopped" // 明确未运行（有单元但 inactive，或未探测到进程）
	MwOpsUnknown = "unknown" // 尚未检测 / 检测失败
)

// 实例来源常量
const (
	MwOpsSourceDeploy = "deploy" // 由「部署执行记录」同步
	MwOpsSourceManual = "manual" // 页面手动纳管
)

// MwInstance 一台机器上的一个中间件实例
type MwInstance struct {
	ID      uint   `gorm:"primaryKey" json:"id"`
	MwType  string `gorm:"size:64;index;uniqueIndex:uniq_mwinst,priority:1" json:"mwType"`
	Version string `gorm:"size:64" json:"version"`

	// 归属资产（AssetID=0 表示非 CMDB 资产的手动纳管，连接信息取下方覆盖字段）
	AssetID   uint   `gorm:"index" json:"assetId"`
	AssetName string `gorm:"size:255" json:"assetName"`
	Host      string `gorm:"size:64;index;uniqueIndex:uniq_mwinst,priority:2" json:"host"`
	Zone      string `gorm:"size:64" json:"zone"`

	Port        string `gorm:"size:16" json:"port"`
	InstallPath string `gorm:"size:255" json:"installPath"` // 空 = 检测时按类型档案的 DefaultPaths 自动发现

	// 覆盖项（空 = 继承类型档案）
	ProcessPattern string `gorm:"size:255" json:"processPattern"`
	Unit           string `gorm:"size:128" json:"unit"`
	CmdStart       string `gorm:"size:512" json:"cmdStart"`
	CmdStop        string `gorm:"size:512" json:"cmdStop"`
	CmdRestart     string `gorm:"size:512" json:"cmdRestart"`
	CmdReload      string `gorm:"size:512" json:"cmdReload"`
	ConfigPaths    string `gorm:"type:text" json:"configPaths"` // JSON []string，空=继承档案

	// 连接覆盖（AssetID=0 时必填；资产实例留空即可，连接信息以资产为准）
	// 密码类字段不出现在任何响应里（json:"-"）；用户名 / 端口这类非机密字段返回，
	// 否则前端编辑时拿不到原值，只能靠「留空保持原值」兜底。
	SSHPort   string `gorm:"size:16" json:"sshPort"`
	SSHUser   string `gorm:"size:64" json:"sshUser"`
	SSHPass   string `gorm:"size:255" json:"-"`
	AdminUser string `gorm:"size:64" json:"adminUser"`
	AdminPass string `gorm:"size:255" json:"-"`

	Source      string `gorm:"size:16" json:"source"`
	DeployJobID uint   `json:"deployJobId"`

	Status      string     `gorm:"size:16;default:'unknown'" json:"status"`
	StatusText  string     `gorm:"size:512" json:"statusText"` // 人类可读摘要
	LastCheckAt *time.Time `json:"lastCheckAt"`
	LastOutput  string     `gorm:"type:text" json:"lastOutput"` // 状态探测原始输出（排查用）
	LastError   string     `gorm:"size:512" json:"lastError"`

	Remark    string    `gorm:"size:512" json:"remark"`
	Enabled   bool      `json:"enabled"`
	CreatedBy uint      `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// TableName 指定表名
func (MwInstance) TableName() string { return "mw_instances" }

// ConfigPathList 实例自定义配置文件候选（空 = 继承档案）
func (i MwInstance) ConfigPathList() []string { return decodeStrList(i.ConfigPaths) }

// mwOpsTypeAlias 归一化类型 key：前端可能填 bws / BWS310，与部署目录的「宝兰德bws310」对齐。
func mwOpsTypeAlias(t string) string {
	s := strings.TrimSpace(t)
	switch strings.ToLower(s) {
	case "bws", "bws310", "bws-310", "宝兰德bws310", "宝兰德bws":
		return "宝兰德bws310"
	case "java", "jdk8", "openjdk":
		return "jdk"
	}
	return s
}

// mwOpsProfileFor 取类型档案（不存在返回 nil）
func mwOpsProfileFor(mwType string) *MwOpsProfile {
	var p MwOpsProfile
	if err := DB.Where("type = ?", mwOpsTypeAlias(mwType)).First(&p).Error; err != nil {
		return nil
	}
	return &p
}

// mwOpsInstanceDisplay 实例展示名：资产实例用资产展示名，手动实例用「IP」兜底。
func mwOpsInstanceDisplay(inst *MwInstance) string {
	if strings.TrimSpace(inst.AssetName) != "" {
		return inst.AssetName
	}
	return inst.Host
}
