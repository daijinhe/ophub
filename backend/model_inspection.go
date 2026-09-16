package main

import (
	"time"

	"gorm.io/datatypes"
)

// 巡检模块数据模型
// ---------------------------------------------------------------------------
// InspectionTask   巡检任务（定义范围 / 指标 / 调度）
// InspectionRecord 一次巡检运行的汇总
// InspectionResult 单次运行中每个资产的采集结果
// ---------------------------------------------------------------------------

// 调度频率
const (
	FreqManual  = "manual"  // 仅手动
	FreqDay     = "day"     // 每日
	FreqWeek    = "week"    // 每周
	FreqMonth   = "month"   // 每月
	FreqQuarter = "quarter" // 每季度
	FreqYear    = "year"    // 每年
)

// 采集来源
const (
	SrcAnsible   = "ansible"   // 通过 ansible 远程节点采集
	SrcSSH       = "ssh"       // 直接 SSH 采集
	SrcSimulated = "simulated" // 采集不可用时模拟（演示 / 离线兜底）
)

// InspectionTask 巡检任务
type InspectionTask struct {
	ID              uint           `gorm:"primaryKey" json:"id"`
	Name            string         `gorm:"size:128" json:"name"`                 // 任务名称
	ScopeType       string         `gorm:"size:16;default:all" json:"scopeType"` // all | category | selected
	CategoryID      *uint          `json:"categoryId"`                           // 按分类时生效
	AssetIDs        datatypes.JSON `json:"assetIds"`                             // 选中资产 id 列表（scopeType=selected）
	Metrics         datatypes.JSON `json:"metrics"`                              // 采集指标 key 列表（可自定义）
	Freq            string         `gorm:"size:16;default:manual" json:"freq"`   // 调度频率
	RemoteNodeID    *uint          `json:"remoteNodeId"`                         // ansible 控制节点（可选）
	SshUser         string         `gorm:"size:64" json:"sshUser"`               // 目标机 SSH 用户（默认取节点用户）
	SshPass         string         `gorm:"size:255" json:"sshPass,omitempty"`    // 目标机 SSH 密码
	SshPort         int            `gorm:"default:65181" json:"sshPort"`         // 目标机 SSH 端口
	ScheduleEnabled bool           `gorm:"default:false" json:"scheduleEnabled"` // 是否启用定时
	LastRunAt       *time.Time     `json:"lastRunAt"`                            // 上次执行时间
	NextRunAt       *time.Time     `json:"nextRunAt"`                            // 下次执行时间
	Status          string         `gorm:"size:16;default:idle" json:"status"`   // idle | running
	CreatedBy       uint           `json:"createdBy"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
}

// InspectionRecord 一次巡检运行汇总
type InspectionRecord struct {
	ID           uint           `gorm:"primaryKey" json:"id"`
	TaskID       uint           `json:"taskId"`
	TaskName     string         `gorm:"size:128" json:"taskName"`
	RunAt        time.Time      `json:"runAt"`
	Status       string         `gorm:"size:16" json:"status"` // running | done | partial | failed
	TotalAssets  int            `json:"totalAssets"`
	SuccessCount int            `json:"successCount"`
	FailCount    int            `json:"failCount"`
	DurationMs   int64          `json:"durationMs"`
	Source       string         `gorm:"size:16" json:"source"` // ansible | ssh | simulated
	Summary      datatypes.JSON `json:"summary"`               // 聚合统计 JSON
	CreatedAt    time.Time      `json:"createdAt"`
}

// InspectionResult 单资产采集结果
type InspectionResult struct {
	ID          uint           `gorm:"primaryKey" json:"id"`
	RecordID    uint           `json:"recordId"`
	TaskID      uint           `json:"taskId"`
	AssetID     uint           `json:"assetId"`
	AssetName   string         `gorm:"size:255" json:"assetName"`  // 联动资产管理：ERP系统名称
	IP          string         `gorm:"size:64" json:"ip"`          // 联动资产管理：虚拟机IPv4
	Department  string         `gorm:"size:128" json:"department"` // 联动资产管理：归属部门
	Developer   string         `gorm:"size:255" json:"developer"`  // 联动资产管理：开发人员
	Status      string         `gorm:"size:16" json:"status"`      // ok | fail
	Source      string         `gorm:"size:16" json:"source"`
	CollectedAt time.Time      `json:"collectedAt"`
	Data        datatypes.JSON `json:"data"`   // 指标 key -> value
	Alerts      datatypes.JSON `json:"alerts"` // 触发的告警项 [{metric,level,value}]
	Error       string         `gorm:"size:512" json:"error"`
}

func (InspectionTask) TableName() string   { return "inspection_tasks" }
func (InspectionRecord) TableName() string { return "inspection_records" }
func (InspectionResult) TableName() string { return "inspection_results" }

// ---------------------------------------------------------------------------
// InspectionAlertRule 巡检告警规则
//
// 不同项目/应用系统对同一指标的容忍度不同（例如数据库机磁盘 70% 就该告警，
// 而文件服务器 85% 才算严重），因此把「阈值」与「屏蔽」从硬编码的指标目录里
// 抽出来，按 CMDB 维度配置：
//
//	MatchType=project → 按资产「项目简称」匹配
//	MatchType=system  → 按资产「应用系统名称」匹配
//	MatchType=asset   → 直接指定资产 ID
//
// 多条规则命中同一资产时，按「Priority 升序 + id 升序」依次叠加，**后者覆盖前者**
// （即 Priority 越大越优先）。MuteAll / MuteMetrics 一旦命中即生效，不可被后续规则反向取消。
//
// 注意：Enabled / MuteAll 这类 bool 字段**不加 gorm default 标签**——带 default 时
// GORM 会忽略零值，导致「新建时选禁用/不屏蔽」被数据库默认值覆盖（User.Status 踩过同款坑）。
// ---------------------------------------------------------------------------
type InspectionAlertRule struct {
	ID          uint           `gorm:"primaryKey" json:"id"`
	Name        string         `gorm:"size:128" json:"name"`      // 规则名称
	Enabled     bool           `json:"enabled"`                   // 是否启用
	MatchType   string         `gorm:"size:16" json:"matchType"`  // project | system | asset
	MatchValues datatypes.JSON `json:"matchValues"`               // 项目简称/应用系统名称列表，或资产 ID 列表
	Thresholds  datatypes.JSON `json:"thresholds"`                // {"cpu_usage":{"warn":80,"crit":92}}；缺省字段=继承目录默认
	MuteAll     bool           `json:"muteAll"`                   // 屏蔽该范围内全部告警
	MuteMetrics datatypes.JSON `json:"muteMetrics"`               // 屏蔽的阈值项 key 列表
	Priority    int            `gorm:"default:0" json:"priority"` // 越大越优先
	Remark      string         `gorm:"size:255" json:"remark"`    // 备注
	CreatedAt   time.Time      `json:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
}

func (InspectionAlertRule) TableName() string { return "inspection_alert_rules" }
