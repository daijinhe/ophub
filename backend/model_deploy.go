package main

import (
	"encoding/json"
	"log"
	"sort"
	"strings"
	"time"
)

// DeployCert 证书仓库：存放离线环境所需的 SSL 证书（CRT/KEY 文本），
// 部署 nginx / 宝兰德 BWS 等“有证书”中间件时从中选择，由 playbook 下发到目标机并启用 443 SSL。
// 保存时自动解析 CRT 的到期时间、签发者、序列号、算法、SAN，便于到期预警与按项目轮转。
type DeployCert struct {
	ID                uint       `gorm:"primaryKey" json:"id"`
	Name              string     `gorm:"size:128;uniqueIndex" json:"name"` // 证书标识，如 example.com
	Domain            string     `gorm:"size:255" json:"domain"`           // 主域名
	SANs              string     `gorm:"type:text" json:"sans"`            // 备用域名（SAN，逗号分隔）
	Project           string     `gorm:"size:255" json:"project"`          // 关联项目/用途（如 ERP、OA 门户），冗余展示名
	ProjectCategoryID *uint      `gorm:"index" json:"projectCategoryId"`   // 关联 CMDB 业务项目分类（叶子节点）
	Issuer            string     `gorm:"size:255" json:"issuer"`           // 签发者（CA 通用名称）
	SerialNumber      string     `gorm:"size:128" json:"serialNumber"`     // 证书序列号（十六进制）
	Algorithm         string     `gorm:"size:64" json:"algorithm"`         // 公钥算法：RSA / ECC / EdDSA
	CommonName        string     `gorm:"size:255" json:"commonName"`       // 证书主体 CN
	NotBefore         *time.Time `json:"notBefore"`                        // 生效时间
	NotAfter          *time.Time `json:"notAfter"`                         // 到期时间
	CaContent         string     `gorm:"type:text" json:"caContent"`       // 可选：CA 链证书（PEM 文本）
	CrtContent        string     `gorm:"type:text" json:"crtContent"`      // 证书 PEM 文本
	KeyContent        string     `gorm:"type:text" json:"keyContent"`      // 私钥 PEM 文本
	Remark            string     `gorm:"size:512" json:"remark"`           // 备注
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

// TableName 指定表名
func (DeployCert) TableName() string { return "deploy_certs" }

// DeployJob 一次中间件部署任务（异步执行，前端轮询）
type DeployJob struct {
	ID            uint       `gorm:"primaryKey" json:"id"`
	Middleware    string     `gorm:"size:64" json:"middleware"`             // 主中间件类型（如 nginx）
	Version       string     `gorm:"size:64" json:"version"`                // 版本号
	Mode          string     `gorm:"size:64" json:"mode"`                   // 部署模式（如 cluster/sentinel/standalone）
	Topology      string     `gorm:"type:text" json:"topology"`             // 拓扑（节点角色映射 JSON：assetId->role）
	RemoteID      uint       `gorm:"index" json:"remoteId"`                 // 执行节点（兼容旧字段，取首个区域节点）
	Remotes       string     `gorm:"type:text" json:"remotes"`              // 各网络区域对应的执行节点 JSON：map[zone]remoteID
	HasCert       bool       `json:"hasCert"`                               // 是否启用证书
	CertID        *uint      `json:"certId"`                                // 选用的证书ID（可选）
	CertName      string     `gorm:"size:128" json:"certName"`              // 证书域名/名称（用于 vhost）
	Env           string     `gorm:"size:64" json:"env"`                    // 环境（如 生产/测试）
	BusinessEnv   string     `gorm:"size:64" json:"businessEnv"`            // 业务环境
	ExtraMW       string     `gorm:"type:text" json:"extraMw"`              // 额外勾选的中间件类型 JSON 数组
	MwItems       string     `gorm:"type:text" json:"mwItems"`              // 逐项配置 JSON 数组 [{middleware,version,mode}]（多选时各自版本/模式）
	Targets       string     `gorm:"type:text" json:"targets"`              // 目标清单 JSON（含识别出的 os_type/cpu_type）
	InventoryMode string     `gorm:"size:16" json:"inventoryMode"`          // Ansible 接入方式：platform（自建 inventory）/ group（复用 Jenkins 组）
	Status        string     `gorm:"size:32;default:pending" json:"status"` // pending/running/success/failed
	Output        string     `gorm:"type:text" json:"output"`               // 执行输出
	ErrorMsg      string     `gorm:"type:text" json:"errorMsg"`             // 错误信息
	CreatedBy     uint       `json:"createdBy"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	FinishedAt    *time.Time `json:"finishedAt"`
}

// TableName 指定表名
func (DeployJob) TableName() string { return "deploy_jobs" }

// SysInitJob 系统初始化任务：按所选操作，在目标服务器上执行既有 ansible playbook。
// 复用中间件部署的控制节点自动分配（按资产「所属网络区域」）与 SSH 执行链路。
type SysInitJob struct {
	ID            uint       `gorm:"primaryKey" json:"id"`
	Tasks         string     `gorm:"type:text" json:"tasks"`                // 所选操作 JSON []string（与前端选项标签一致）
	Targets       string     `gorm:"type:text" json:"targets"`              // 目标清单 JSON []deployTargetRow
	OsType        string     `gorm:"size:64" json:"osType"`                 // 传递给 playbook 的 OS_TYPE
	CpuType       string     `gorm:"size:64" json:"cpuType"`                // 传递给 playbook 的 CPU_TYPE
	InventoryMode string     `gorm:"size:16" json:"inventoryMode"`          // Ansible 接入方式：platform / group
	Status        string     `gorm:"size:32;default:pending" json:"status"` // pending/running/success/failed
	Output        string     `gorm:"type:text" json:"output"`               // 执行输出
	ErrorMsg      string     `gorm:"type:text" json:"errorMsg"`             // 错误信息
	CreatedBy     uint       `json:"createdBy"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	FinishedAt    *time.Time `json:"finishedAt"`
}

// TableName 指定表名
func (SysInitJob) TableName() string { return "sysinit_jobs" }

// ---------- 系统初始化操作目录（DB 驱动，启动幂等同步，与中间件 DeployMiddleware 同构）----------
// 每个操作映射到控制节点 SYSTEM_INIT_DIR 下的一个既有 ansible playbook，并按真实脚本目录登记：
//   - VarMode=os    ：向 playbook 透传 OS_TYPE=<识别出的OS令牌>（yum-config / sysctl-config 按 OS 选脚本）
//   - VarMode=cpu   ：向 playbook 透传 CPU_TYPE=<识别出的CPU令牌>（各 exporter 按 CPU 选安装包）
//   - VarMode=static：透传固定变量（磁盘挂载 DISK_DIR/FORMAT_TYPE、改密码 target_user/new_password）
//   - VarMode=none  ：不透传额外变量（脚本自包含）
// OsTypes / CpuTypes 为空表示不限制（全平台通用）。

type SysInitCatalog struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Key       string    `gorm:"size:128;uniqueIndex" json:"key"`       // 选项标签（任务唯一标识），与前端一致
	Label     string    `gorm:"size:128" json:"label"`                 // 展示名
	Group     string    `gorm:"size:64" json:"group"`                  // 向导中的分组（基础配置 / 系统优化 / …）
	Domain    string    `gorm:"size:32;index" json:"domain"`           // 目录域：空/system=系统初始化(SystemInitDir)；gaussdb=GaussDB(GaussDBInitDir)
	Playbook  string    `gorm:"size:512" json:"playbook"`              // 相对所属域根目录的 playbook 路径
	Desc      string    `gorm:"size:512" json:"desc"`                  // 说明
	VarMode   string    `gorm:"size:16" json:"varMode"`                // os | cpu | static | none
	VarArgs   string    `gorm:"size:255" json:"varArgs"`               // static 模式的固定变量
	OsTypes   string    `gorm:"type:text" json:"osTypes"`              // JSON []string，空=全部 OS
	CpuTypes  string    `gorm:"type:text" json:"cpuTypes"`             // JSON []string，空=全部 CPU
	OrderNo   int       `gorm:"default:0" json:"orderNo"`              // 执行顺序
	Enabled   bool      `gorm:"not null" json:"enabled"`               // 是否在初始化向导中可选
	Custom    bool      `gorm:"not null;default:false" json:"custom"`  // 页面自定义添加（内置目录同步不会碰它）
	Deleted   bool      `gorm:"not null;default:false" json:"deleted"` // 删除墓碑：内置项删除后保留行，避免启动同步又建回来
	SeedVer   int       `gorm:"default:0" json:"seedVer"`              // 内置目录版本，用于启动时幂等同步
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// TableName 指定表名
func (SysInitCatalog) TableName() string { return "sysinit_catalog" }

// BaseDir 返回该任务所属域的根目录（控制节点上）：
// 空/system → SystemInitDir；gaussdb → GaussDBInitDir。
func (s SysInitCatalog) BaseDir() string {
	if strings.EqualFold(strings.TrimSpace(s.Domain), "gaussdb") {
		return Cfg.GaussDBInitDir
	}
	return Cfg.SystemInitDir
}

// sysInitSeedVer 内置系统初始化目录版本。每按控制节点 system_init 真实脚本调整一次就 +1；
// 启动时 SyncSysInitCatalog 只覆盖 seed_ver 小于该值的记录，避免覆盖运维在页面上的手工调整。
// v2：补充 Group 分组字段（向导按分组展示）。
// v3：补充 Domain 字段并接入 GaussDB（gaussDB_init 目录，3 个任务）。
const sysInitSeedVer = 3

// sysInitSeedCatalog 内置系统初始化目录：全部按控制节点 system_init 下真实存在的子目录与 playbook 登记。
// 各子目录内部结构（playbook + files/ 脚本）已逐一核对；yum/sysctl 内含 per-OS 脚本，exporter 内含 per-CPU 包。
func sysInitSeedCatalog() []SysInitCatalog {
	must := func(v interface{}) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	osYum := []string{"centos7", "almalinux8.9", "almalinux8.10", "openEuler20.03", "openEuler22.03", "hce2.0", "kylinV10", "ubuntu22"}
	osSysctl := []string{"centos7", "almalinux8.9", "almalinux8.10", "openEuler20.03", "openEuler22.03", "hce2.0", "kylinV10"}
	cpuAll := []string{"x86_64", "aarch64"}
	return []SysInitCatalog{
		{Key: "配置Yum源", Label: "配置Yum源", Group: "基础配置", Playbook: "yum-config/yum-config.yml", Desc: "配置 YUM 软件源（按 OS_TYPE 选对应 <os>_yum.sh）", VarMode: "os", OsTypes: must(osYum), OrderNo: 1, Enabled: true},
		{Key: "配置chrony时间同步", Label: "配置chrony时间同步", Group: "基础配置", Playbook: "chrony-config/chrony-config.yml", Desc: "配置 chrony 时间同步（脚本自包含，无需 OS 变量）", VarMode: "none", OrderNo: 2, Enabled: true},
		{Key: "配置本机hosts", Label: "配置本机hosts", Group: "基础配置", Playbook: "hosts-config/hosts-config.yml", Desc: "写入本机 hosts 解析", VarMode: "none", OrderNo: 3, Enabled: true},
		{Key: "优化内核参数", Label: "优化内核参数", Group: "系统优化", Playbook: "sysctl-config/sysctl-config.yml", Desc: "优化内核参数 sysctl（按 OS_TYPE 选对应 <os>_sysctl.sh）", VarMode: "os", OsTypes: must(osSysctl), OrderNo: 4, Enabled: true},
		{Key: "优化limits限制", Label: "优化limits限制", Group: "系统优化", Playbook: "limits-config/limits-config.yml", Desc: "优化系统 limits 限制", VarMode: "none", OrderNo: 5, Enabled: true},
		{Key: "优化history历史记录", Label: "优化history历史记录", Group: "系统优化", Playbook: "history-config/history-config.yml", Desc: "优化 history 历史记录", VarMode: "none", OrderNo: 6, Enabled: true},
		{Key: "优化内核启动参数cmdline", Label: "优化内核启动参数cmdline", Group: "系统优化", Playbook: "cmdline-config/cmdline-config.yml", Desc: "优化内核启动参数 cmdline", VarMode: "none", OrderNo: 7, Enabled: true},
		{Key: "挂载数据盘vdb到/data（ext4）", Label: "挂载数据盘vdb到/data（ext4）", Group: "数据盘挂载", Playbook: "disk-mount-config/disk-mount-config.yml", Desc: "挂载 vdb 到 /data（ext4）", VarMode: "static", VarArgs: "DISK_DIR=data FORMAT_TYPE=ext4", OrderNo: 8, Enabled: true},
		{Key: "挂载数据盘vdb到/export（xfs）", Label: "挂载数据盘vdb到/export（xfs）", Group: "数据盘挂载", Playbook: "disk-mount-config/disk-mount-config.yml", Desc: "挂载 vdb 到 /export（xfs）", VarMode: "static", VarArgs: "DISK_DIR=export FORMAT_TYPE=xfs", OrderNo: 9, Enabled: true},
		{Key: "安装node-exporter", Label: "安装node-exporter", Group: "监控组件", Playbook: "node-exporter-config/node-exporter-config.yml", Desc: "安装 node-exporter 监控（按 CPU_TYPE 选包）", VarMode: "cpu", CpuTypes: must(cpuAll), OrderNo: 10, Enabled: true},
		{Key: "安装blackbox-exporter", Label: "安装blackbox-exporter", Group: "监控组件", Playbook: "blackbox-exporter-config/blackbox-exporter-config.yml", Desc: "安装 blackbox-exporter 探测（按 CPU_TYPE 选包）", VarMode: "cpu", CpuTypes: must(cpuAll), OrderNo: 11, Enabled: true},
		{Key: "安装日志易agent", Label: "安装日志易agent", Group: "监控组件", Playbook: "rizhiyi-config/rizhiyi-config.yml", Desc: "安装日志易 agent（按 CPU_TYPE 选包）", VarMode: "cpu", CpuTypes: must(cpuAll), OrderNo: 12, Enabled: true},
		{Key: "修改用户密码", Label: "修改用户密码", Group: "账号安全", Playbook: "change_user_pass/change_user_pass.yml", Desc: "批量修改普通用户密码（target_user/new_password 由变量传入）", VarMode: "static", VarArgs: "target_user=ituser new_password=Devops@123456", OrderNo: 13, Enabled: true},

		// ---------- GaussDB（对应 Jenkins 的 GaussDB_CHOICE_DIR，独立目录 gaussDB_init）----------
		// 与 Jenkins pipeline「GaussDB安装」阶段逐条一致：GaussDB系统初始化 + vdb 挂载 data(ext4) / export(xfs)。
		{Key: "GaussDB系统初始化", Label: "GaussDB系统初始化", Group: "GaussDB 安装", Domain: "gaussdb", Playbook: "gaussDB-init/gaussDB-init-config.yml", Desc: "GaussDB 数据库主机系统初始化（脚本自包含，无需 OS/CPU 变量）", VarMode: "none", OrderNo: 20, Enabled: true},
		{Key: "GaussDB-挂载数据盘vdb到/data（ext4）", Label: "GaussDB-挂载数据盘vdb到/data（ext4）", Group: "GaussDB 安装", Domain: "gaussdb", Playbook: "disk-mount-config/disk-mount-config.yml", Desc: "GaussDB 数据盘 vdb 挂载到 /data（ext4）", VarMode: "static", VarArgs: "DISK_DIR=data FORMAT_TYPE=ext4", OrderNo: 21, Enabled: true},
		{Key: "GaussDB-挂载数据盘vdb到/export（xfs）", Label: "GaussDB-挂载数据盘vdb到/export（xfs）", Group: "GaussDB 安装", Domain: "gaussdb", Playbook: "disk-mount-config/disk-mount-config.yml", Desc: "GaussDB 数据盘 vdb 挂载到 /export（xfs）", VarMode: "static", VarArgs: "DISK_DIR=export FORMAT_TYPE=xfs", OrderNo: 22, Enabled: true},
	}
}

// SyncSysInitCatalog 启动时幂等同步内置系统初始化目录。
// 规则与 SyncMiddlewareCatalog 一致，并额外处理「页面自定义」与「删除墓碑」：
//   - 记录不存在 → 新建（内置项）；
//   - 记录是删除墓碑（deleted）→ 跳过，不复活（页面点「同步内置目录」可清墓碑恢复）；
//   - 已被本版本同步过且 playbook 非空 → 跳过，避免覆盖页面上的手工调整；
//   - 否则 → 刷新内容字段，但保留页面上的启用状态与排序。
func SyncSysInitCatalog() {
	seeds := sysInitSeedCatalog()
	for _, s := range seeds {
		var cur SysInitCatalog
		err := DB.Where("key = ?", s.Key).First(&cur).Error
		if err != nil {
			s.SeedVer = sysInitSeedVer
			s.CreatedAt = time.Now()
			s.UpdatedAt = time.Now()
			if e := DB.Create(&s).Error; e != nil {
				log.Printf("系统初始化目录初始化失败 %s: %v", s.Key, e)
			}
			continue
		}
		if cur.Deleted {
			continue // 运维在页面上删掉的内置项，启动不复活
		}
		if cur.SeedVer >= sysInitSeedVer && strings.TrimSpace(cur.Playbook) != "" {
			continue
		}
		keepEnabled := cur.Enabled
		keepOrder := cur.OrderNo
		cur.Label = s.Label
		cur.Group = s.Group
		cur.Domain = s.Domain
		cur.Playbook = s.Playbook
		cur.Desc = s.Desc
		cur.VarMode = s.VarMode
		cur.VarArgs = s.VarArgs
		cur.OsTypes = s.OsTypes
		cur.CpuTypes = s.CpuTypes
		cur.Enabled = keepEnabled
		if keepOrder != 0 {
			cur.OrderNo = keepOrder
		} else {
			cur.OrderNo = s.OrderNo
		}
		cur.SeedVer = sysInitSeedVer
		cur.UpdatedAt = time.Now()
		if e := DB.Save(&cur).Error; e != nil {
			log.Printf("系统初始化目录同步失败 %s: %v", s.Key, e)
		}
	}
	log.Printf("系统初始化目录同步完成，共 %d 项", len(seeds))
}

// ---------- 中间件离线部署配置（数据库驱动，可页面管理）----------
// 每种中间件登记：版本、是否需要证书、是否已就绪（离线包就位）、是否启用，
// 以及“操作系统 × CPU 架构”维度下的离线包信息（安装包路径、部署脚本路径、目标安装路径）。
// 部署时按目标资产的操作系统/CPU 自动匹配对应的离线包，生成 inventory + playbook 下发执行。

// PkgInfo 一个具体的离线安装包（操作系统 × CPU 架构）
type PkgInfo struct {
	Pkg    string   `json:"pkg"`             // 控制节点上 tar.gz 安装包的完整路径
	Script string   `json:"script"`          // 控制节点上部署脚本（.sh）的完整路径
	Target string   `json:"target"`          // 目标安装路径（作为参数传给部署脚本，可选）
	Zones  []string `json:"zones,omitempty"` // 适用网络区域（互联网/政务外网）；为空表示所有区域通用
}

// MatchZone 判断该离线包是否适用于指定网络区域（空列表 = 全部区域）
func (p PkgInfo) MatchZone(zone string) bool {
	if len(p.Zones) == 0 || strings.TrimSpace(zone) == "" {
		return true
	}
	for _, z := range p.Zones {
		if strings.TrimSpace(z) == strings.TrimSpace(zone) {
			return true
		}
	}
	return false
}

// 部署执行方式（与控制节点上既有 ansible 脚本的形态一一对应）
//
//	copy      ：上传安装包 + 部署脚本到 /tmp，执行脚本（nginx、jdk）
//	unarchive ：上传并解压安装包到 /tmp，执行包内同名脚本（php）
//	dir       ：上传整个 files 目录到 /tmp，再执行脚本（宝兰德 bws310）
//	playbook  ：直接执行控制节点上已有的 playbook（redis）
const (
	StyleCopy      = "copy"
	StyleUnarchive = "unarchive"
	StyleDir       = "dir"
	StylePlaybook  = "playbook"
)

// 离线包矩阵 key 中的通配令牌：any 表示不区分该维度
const WildcardAny = "any"

// DeployMiddleware 中间件部署配置（单条记录即一种中间件）
type DeployMiddleware struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:64;uniqueIndex" json:"name"` // 类型 key（如 nginx/jdk/redis），建表/脚本引用
	Label       string    `gorm:"size:128" json:"label"`           // 展示名（如 Nginx）
	Icon        string    `gorm:"size:64" json:"icon"`             // 图标 key（前端映射 emoji/颜色）
	Description string    `gorm:"size:512" json:"description"`     // 说明
	Category    string    `gorm:"size:64" json:"category"`         // 分类（Web服务器/运行环境/应用服务器/数据库缓存）
	Versions    string    `gorm:"type:text" json:"versions"`       // JSON []string 可用版本
	Packages    string    `gorm:"type:text" json:"packages"`       // JSON map[osType_cpuType]PkgInfo
	Modes       string    `gorm:"type:text" json:"modes"`          // JSON []DeployModeDef 部署模式（如 Redis 单机/集群/哨兵）
	SubDir      string    `gorm:"size:128" json:"subDir"`          // 控制节点上该中间件的脚本子目录（默认等于 name）
	Style       string    `gorm:"size:32" json:"style"`            // 部署执行方式：copy / unarchive / dir / playbook
	Playbook    string    `gorm:"size:512" json:"playbook"`        // style=playbook 时，控制节点上既有 playbook 的绝对路径
	InstallPath string    `gorm:"size:255" json:"installPath"`     // 默认安装路径（展示用，不覆盖 packages.target）
	DefaultPort string    `gorm:"size:64" json:"defaultPort"`      // 默认监听端口（展示用）
	CertDir     string    `gorm:"size:255" json:"certDir"`         // 证书下发目录（目标机绝对路径；空=按类型默认，nginx 走 nginxPaths）
	NeedCert    bool      `json:"needCert"`                        // 部署时是否需要证书（如 nginx SSL）
	Ready       bool      `json:"ready"`                           // 离线包是否已就位（控制节点路径存在）
	Enabled     bool      `json:"enabled"`                         // 是否在部署向导中可选
	SeedVer     int       `gorm:"default:0" json:"seedVer"`        // 内置目录版本，用于启动时幂等同步
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// StyleOrCopy 返回部署执行方式，为空时按 copy 处理
func (m DeployMiddleware) StyleOrCopy() string {
	if m.Style == "" {
		return StyleCopy
	}
	return m.Style
}

// SubDirOrName 控制节点子目录，未配置时回退到 name
func (m DeployMiddleware) SubDirOrName() string {
	if strings.TrimSpace(m.SubDir) != "" {
		return strings.TrimSpace(m.SubDir)
	}
	return m.Name
}

// TableName 指定表名
func (DeployMiddleware) TableName() string { return "deploy_middlewares" }

// DeployModeDef 一种部署模式（如 Redis 的 单机 / 三主三从集群 / 哨兵）
// topology:
//   - "single"  单机（默认，无需拓扑）
//   - "cluster" 集群：需选中 NodeCount 台，平台用 --cluster-replicas 自动分配主从
//   - "roles"   角色模式：需为每个节点手动指定 Roles 中的一种（如 master/replica/sentinel）
type DeployModeDef struct {
	Key       string   `json:"key"`
	Label     string   `json:"label"`
	Topology  string   `json:"topology"`
	NodeCount int      `json:"nodeCount,omitempty"`
	Replicas  int      `json:"replicas,omitempty"`
	Roles     []string `json:"roles,omitempty"`
}

// ModesList 解析 modes JSON
func (m DeployMiddleware) ModesList() []DeployModeDef {
	out := []DeployModeDef{}
	if m.Modes == "" {
		return out
	}
	_ = json.Unmarshal([]byte(m.Modes), &out)
	return out
}

// PkgMap 解析 packages JSON 为 map
func (m DeployMiddleware) PkgMap() map[string]PkgInfo {
	out := map[string]PkgInfo{}
	if m.Packages == "" {
		return out
	}
	_ = json.Unmarshal([]byte(m.Packages), &out)
	return out
}

// GetPkg 取指定 操作系统×CPU（可选网络区域） 的离线包配置。
// 支持 any 通配（如 redis 只按 CPU 分发：any_x86_64；bws310 不区分平台：any_any），
// 匹配优先级：精确 os_cpu → os_any → any_cpu → any_any；
// 每层再按 zones 过滤（互联网 / 政务外网的脚本可能不同），zone 为空则不做区域限制。
func (m DeployMiddleware) GetPkg(osType, cpuType, zone string) (PkgInfo, bool) {
	pm := m.PkgMap()
	keys := []string{
		osType + "_" + cpuType,
		osType + "_" + WildcardAny,
		WildcardAny + "_" + cpuType,
		WildcardAny + "_" + WildcardAny,
	}
	for _, k := range keys {
		p, ok := pm[k]
		if !ok || strings.TrimSpace(p.Pkg) == "" {
			continue
		}
		if !p.MatchZone(zone) {
			continue
		}
		return p, true
	}
	return PkgInfo{}, false
}

// SupportMatrix 返回已登记离线包的「OS×CPU」列表（用于不支持时的提示文案）
func (m DeployMiddleware) SupportMatrix() []string {
	pm := m.PkgMap()
	out := make([]string, 0, len(pm))
	for k := range pm {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// VersionsList 解析 versions JSON
func (m DeployMiddleware) VersionsList() []string {
	out := []string{}
	if m.Versions == "" {
		return out
	}
	_ = json.Unmarshal([]byte(m.Versions), &out)
	return out
}

// mwSeedVer 内置中间件目录版本。
// 每当我们根据控制节点上真实的 ansible 脚本调整一次内置目录，就把该值 +1；
// 启动时 SyncMiddlewareCatalog 只覆盖 seed_ver 小于该值的记录，避免反复覆盖运维手工改动。
const mwSeedVer = 4

// mwBase 控制节点上中间件脚本的根目录（取配置 DEPLOY_BASE，去掉结尾斜杠）
func mwBase() string {
	return strings.TrimRight(Cfg.DeployBase, "/")
}

// zoneList 把逗号分隔的区域名转成列表（空串返回 nil，表示不限制区域）
func zoneList(zones ...string) []string {
	var out []string
	for _, z := range zones {
		if z = strings.TrimSpace(z); z != "" {
			out = append(out, z)
		}
	}
	return out
}

// MiddlewareDef 中间件「统一注册定义」：部署侧（DeployMiddleware）与运维侧（MwOpsProfile）
// 的全部信息都在这里登记。新增一种中间件 = 在 middlewareRegistry() 中加一条定义，
// 部署目录与运维档案由它分别派生，从根本上避免两侧 Name/Type 漂移、漏登。
type MiddlewareDef struct {
	// 公共标识（部署侧 Name 同时是运维侧 Type 的唯一 key，如 nginx / redis / 宝兰德bws310）
	Name        string
	Label       string
	Icon        string
	Category    string
	Description string
	Enabled     bool

	// —— 部署侧（DeployMiddleware）——
	Versions    []string           // 可选版本列表（展示用）
	Packages    map[string]PkgInfo // key = osType_cpuType（支持 any_ 通配），value 含离线包/脚本/目标路径
	Modes       []DeployModeDef    // 部署模式（单机/集群/哨兵），无则留 nil
	SubDir      string             // 控制节点脚本子目录（默认 = Name）
	Style       string             // 部署执行方式：copy / unarchive / dir / playbook
	Playbook    string             // style=playbook 时控制节点 playbook 绝对路径
	InstallPath string             // 默认安装路径（展示用，部署以 packages.target 为准）
	DefaultPort string
	CertDir     string // 证书下发目录（目标机绝对路径）
	NeedCert    bool
	Ready       bool // 离线包是否已就位

	// —— 运维侧（MwOpsProfile）——
	ProcessPattern string   // pgrep -f 匹配串（ERE）；空表示「以进程为对象」时仍可填
	Units          []string // systemd 单元名候选（逗号分隔落库）
	DefaultPaths   []string // 常见安装路径（自动发现用）
	ConfigPaths    []string // 配置文件候选（支持尾部 * 通配，{path} 占位）
	ConfigTestCmd  string   // 配置校验命令（{sbin}/{path} 占位）
	VersionCmd     string   // 版本探测命令（输出回填实例版本号）
	CmdStart       string
	CmdStop        string
	CmdRestart     string
	CmdReload      string
	ProcessOnly    bool // 无「单体服务」概念，以进程为管理对象（如 jdk / java 应用）
	OpsDesc        string

	// IncludeOps 为 false 时只在「部署目录」登记、不生成运维档案（mysql 等暂未接入运维）
	IncludeOps bool
}

// middlewareRegistry 内置中间件统一注册表（单一可信源）。
// 离线包路径按控制节点 app_choice 下真实存在的脚本登记；OS/CPU 令牌与脚本文件名一致。
func middlewareRegistry() []MiddlewareDef {
	base := mwBase()

	// ---------- Nginx 1.28.3 ----------
	nginxPkgs := map[string]PkgInfo{}
	for _, kv := range [][3]string{
		{"centos7", "x86_64", "/opt/servers/nginx"},
		{"almalinux8.9", "x86_64", "/opt/servers/nginx"},
		{"openEuler20.03", "x86_64", "/data/nginx"},
	} {
		os, cpu, target := kv[0], kv[1], kv[2]
		nginxPkgs[os+"_"+cpu] = PkgInfo{
			Pkg:    base + "/nginx/files/nginx-1.28.3-" + os + "-" + cpu + ".tar.gz",
			Script: base + "/nginx/files/deploy-nginx-1.28.3-" + os + "-" + cpu + ".sh",
			Target: target,
		}
	}

	// ---------- JDK 8u481（X86 + ARM 双架构）----------
	jdkPkgs := map[string]PkgInfo{}
	// 注：标注「互联网」的组合仅在该区域控制节点上存在脚本，政务外网暂未同步，
	//     故限定 zones，避免在政务外网选到后部署时才报错。
	for _, spec := range [][3]string{
		{"centos7", "x86_64", ""},
		{"almalinux8.9", "x86_64", ""},
		{"almalinux8.10", "x86_64", "互联网"},
		{"openEuler20.03", "x86_64", "互联网"},
		{"openEuler22.03", "x86_64", "互联网"},
		{"hce2.0", "aarch64", ""},
		{"kylinV10", "aarch64", ""},
		{"openEuler22.03", "aarch64", "互联网"},
	} {
		os, cpu, zo := spec[0], spec[1], spec[2]
		jdkPkgs[os+"_"+cpu] = PkgInfo{
			Pkg:    base + "/jdk/files/jdk-8u481-linux-" + cpu + ".tar.gz",
			Script: base + "/jdk/files/jdk-8-linux-" + cpu + "-" + os + ".sh",
			Target: "/usr/local/java",
			Zones:  zoneList(zo),
		}
	}

	// ---------- PHP（7.2.34 / 7.4.33，随 OS×CPU 选择对应离线包，包内自带安装脚本）----------
	phpPkgs := map[string]PkgInfo{
		"centos7_x86_64": {
			Pkg:    base + "/php/files/php-7.2.34-centos7-x86_64.tar.gz",
			Target: "/opt/servers/php",
		},
		"almalinux8.9_x86_64": {
			Pkg:    base + "/php/files/php-7.4.33-almalinux8.9-x86_64.tar.gz",
			Target: "/opt/servers/php",
		},
		"openEuler20.03_x86_64": {
			Pkg:    base + "/php/files/php-7.4.33-openEuler20.03-x86_64.tar.gz",
			Target: "/opt/servers/php",
		},
		"hce2.0_aarch64": {
			Pkg:    base + "/php/files/php-7.2.34-bws310-hce2.0-aarch64.tar.gz",
			Target: "/opt/servers/php",
		},
	}

	// ---------- 宝兰德 BWS310（不区分 OS/CPU，整个 files 目录下发后执行安装脚本）----------
	bwsPkgs := map[string]PkgInfo{
		WildcardAny + "_" + WildcardAny: {
			Pkg:    base + "/bws310/files/bws310-standard-hd.tar.gz",
			Script: base + "/bws310/files/bws310_install.sh",
			Target: "/data/BWS310",
		},
	}

	// ---------- Redis 5.0.14 单机（只按 CPU 分发，直接复用既有 playbook）----------
	redisPkgs := map[string]PkgInfo{}
	for _, cpu := range []string{"x86_64", "aarch64"} {
		redisPkgs[WildcardAny+"_"+cpu] = PkgInfo{
			Pkg:    base + "/redis/STAND-ALONE/files/redis-5.0.14-" + cpu + ".tar.gz",
			Target: "/data/redis-5.0.14_sentinel",
		}
	}

	return []MiddlewareDef{
		{
			Name: "nginx", Label: "Nginx", Icon: "nginx", Category: "Web服务器",
			Description: "高性能 Web / 反向代理服务器 1.28.3（含 systemd 服务与日志切割，默认站点 8089）",
			Versions:    []string{"1.28.3"}, Packages: nginxPkgs, SubDir: "nginx", Style: StyleCopy,
			InstallPath: "/opt/servers/nginx（openEuler 为 /data/nginx）", DefaultPort: "8089",
			NeedCert: true, Ready: true, Enabled: true, IncludeOps: true,
			ProcessPattern: "nginx: master", Units: []string{"nginx"},
			DefaultPaths:  []string{"/opt/servers/nginx", "/data/nginx", "/usr/local/nginx"},
			ConfigPaths:   []string{"{path}/conf/nginx.conf", "{path}/conf/conf.d/*.conf", "{path}/conf/vhost/*.conf"},
			ConfigTestCmd: "{sbin}/nginx -t", VersionCmd: "{sbin}/nginx -v 2>&1",
			CmdStart: "{sbin}/nginx", CmdStop: "{sbin}/nginx -s stop",
			CmdRestart: "{sbin}/nginx -s stop; sleep 1; {sbin}/nginx", CmdReload: "{sbin}/nginx -s reload",
			OpsDesc: "主进程 \"nginx: master\"；配置改动后先 nginx -t 校验再 reload",
		},
		{
			Name: "jdk", Label: "JDK", Icon: "jdk", Category: "运行环境",
			Description: "Java 运行环境 JDK 8u481（X86 / ARM 双架构，安装到 /usr/local/java 并写入 /etc/profile.d）",
			Versions:    []string{"8u481"}, Packages: jdkPkgs, SubDir: "jdk", Style: StyleCopy,
			InstallPath: "/usr/local/java", NeedCert: false, Ready: true, Enabled: true, IncludeOps: true,
			ProcessPattern: "java", Units: []string{}, DefaultPaths: []string{"/usr/local/java", "/usr/local/jdk", "/opt/java"},
			ConfigPaths: []string{}, VersionCmd: "{path}/bin/java -version 2>&1", ProcessOnly: true,
			OpsDesc: "JDK 本身是运行环境，这里以 java 进程为管理对象：可查看每个 java 应用的 PID / 启动命令 / 端口，并按 PID 结束进程",
		},
		{
			Name: "php", Label: "PHP", Icon: "php", Category: "运行环境",
			Description: "PHP-FPM 运行环境（7.2.34 / 7.4.33，含 swoole、redis 扩展；按 OS×CPU 选包，包内自带安装脚本）",
			Versions:    []string{"7.2.34", "7.4.33"}, Packages: phpPkgs, SubDir: "php", Style: StyleUnarchive,
			InstallPath: "/opt/servers/php", DefaultPort: "9999（示例站点，php-fpm 监听 /dev/shm/php-cgi.sock）",
			NeedCert: false, Ready: true, Enabled: true, IncludeOps: true,
			ProcessPattern: "php-fpm", Units: []string{"php-fpm", "php-fpm.service"},
			DefaultPaths:  []string{"/opt/servers/php", "/usr/local/php"},
			ConfigPaths:   []string{"{path}/etc/php.ini", "{path}/etc/php-fpm.conf", "{path}/etc/php-fpm.d/*.conf"},
			ConfigTestCmd: "{sbin}/php-fpm -t", VersionCmd: "{sbin}/php-fpm -v 2>&1",
			CmdStart:   "{sbin}/php-fpm",
			CmdStop:    "kill -QUIT $(cat {path}/var/run/php-fpm.pid 2>/dev/null) 2>/dev/null || true",
			CmdRestart: "kill -QUIT $(cat {path}/var/run/php-fpm.pid 2>/dev/null) 2>/dev/null; sleep 1; {sbin}/php-fpm",
			CmdReload:  "kill -USR2 $(cat {path}/var/run/php-fpm.pid 2>/dev/null) 2>/dev/null || true",
			OpsDesc:    "php-fpm 主进程；reload 用 USR2 平滑重载（不中断请求）",
		},
		{
			Name: "宝兰德bws310", Label: "宝兰德 BWS310", Icon: "bws", Category: "应用服务器",
			Description: "宝兰德应用服务器 BWS310 标准版（安装到 /data/BWS310，含 vhost 示例与开机自启）；启用证书时平台把 CRT/KEY 下发到 /data/BWS310/ssl，并通过 HAS_CERT / CERT_DIR / CERT_NAME / CERT_CRT / CERT_KEY / CERT_CA 环境变量交给 bws310_install.sh 自行配置 SSL",
			Versions:    []string{"310"}, Packages: bwsPkgs, SubDir: "bws310", Style: StyleDir,
			InstallPath: "/data/BWS310", DefaultPort: "8080", CertDir: "/data/BWS310/ssl",
			NeedCert: true, Ready: true, Enabled: true, IncludeOps: true,
			ProcessPattern: "bws", Units: []string{"bws310", "bws", "bws310.service"},
			DefaultPaths: []string{"/data/BWS310", "/opt/BWS310"},
			ConfigPaths:  []string{"{path}/conf/bws.conf", "{path}/conf/vhost/*.conf", "{path}/conf/*.conf"},
			CmdStart:     "{path}/bin/start.sh", CmdStop: "{path}/bin/stop.sh",
			CmdRestart: "{path}/bin/restart.sh", CmdReload: "{path}/bin/restart.sh",
			OpsDesc: "优先用 systemd 单元管理；未注册为服务时回退 {path}/bin 下的启停脚本（可在实例上覆盖）",
		},
		{
			Name: "redis", Label: "Redis", Icon: "redis", Category: "数据库缓存",
			Description: "Redis 5.0.14 单机（复用既有 playbook：systemd 服务 + 日志切割 + 运维脚本，端口 17000）",
			Versions:    []string{"5.0.14"}, Packages: redisPkgs, SubDir: "redis/STAND-ALONE",
			Style: StylePlaybook, Playbook: base + "/redis/STAND-ALONE/redis-5.0.14-stand-alone.yml",
			InstallPath: "/data/redis-5.0.14_sentinel", DefaultPort: "17000",
			NeedCert: false, Ready: true, Enabled: true, IncludeOps: true,
			ProcessPattern: "redis-server", Units: []string{"redis", "redis-server", "redis-5.0.14"},
			DefaultPaths: []string{"/data/redis-5.0.14_sentinel", "/usr/local/redis", "/data/redis"},
			ConfigPaths:  []string{"{path}/redis.conf", "{path}/conf/redis.conf", "{path}/etc/redis.conf", "/etc/redis/redis.conf"},
			CmdStart:     "{path}/bin/redis-server {conf} --daemonize yes",
			CmdStop:      "{path}/bin/redis-cli -h 127.0.0.1 -p {port} shutdown",
			CmdRestart:   "{path}/bin/redis-cli -h 127.0.0.1 -p {port} shutdown 2>/dev/null; sleep 1; {path}/bin/redis-server {conf} --daemonize yes",
			CmdReload:    "", VersionCmd: "{path}/bin/redis-server -v 2>&1",
			OpsDesc: "Redis 无配置热加载：改完配置需 restart（平台会在配置页提示）",
		},
		{
			Name: "mysql", Label: "MySQL", Icon: "mysql", Category: "数据库缓存",
			Description: "关系型数据库（控制节点暂无离线安装脚本，保持停用）",
			Versions:    []string{}, Packages: map[string]PkgInfo{}, SubDir: "mysql",
			Style: StyleCopy, NeedCert: false, Ready: false, Enabled: false, IncludeOps: false,
		},
	}
}

// mwSeedCatalog 内置中间件目录（部署侧）：由统一注册表 middlewareRegistry() 派生。
func mwSeedCatalog() []DeployMiddleware {
	mustJSON := func(v interface{}) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	out := make([]DeployMiddleware, 0, len(middlewareRegistry()))
	for _, d := range middlewareRegistry() {
		modes := ""
		if d.Modes != nil {
			modes = mustJSON(d.Modes)
		}
		out = append(out, DeployMiddleware{
			Name: d.Name, Label: d.Label, Icon: d.Icon, Category: d.Category,
			Description: d.Description, Versions: mustJSON(d.Versions), Packages: mustJSON(d.Packages),
			Modes: modes, SubDir: d.SubDir, Style: d.Style, Playbook: d.Playbook,
			InstallPath: d.InstallPath, DefaultPort: d.DefaultPort, CertDir: d.CertDir,
			NeedCert: d.NeedCert, Ready: d.Ready, Enabled: d.Enabled,
		})
	}
	return out
}

// SyncMiddlewareCatalog 启动时幂等同步内置中间件目录。
// 规则：
//   - 记录不存在 → 新建；
//   - 记录已存在且 seed_ver < mwSeedVer（或从未登记离线包）→ 用内置目录刷新，保留 ID；
//   - 记录已被本版本同步过 → 原样保留，避免覆盖运维在页面上的手工调整。
func SyncMiddlewareCatalog() {
	seeds := mwSeedCatalog()
	for _, s := range seeds {
		var cur DeployMiddleware
		err := DB.Where("name = ?", s.Name).First(&cur).Error
		if err != nil {
			s.SeedVer = mwSeedVer
			s.CreatedAt = time.Now()
			s.UpdatedAt = time.Now()
			if e := DB.Create(&s).Error; e != nil {
				log.Printf("中间件目录初始化失败 %s: %v", s.Name, e)
			}
			continue
		}
		if cur.SeedVer >= mwSeedVer && strings.TrimSpace(cur.Packages) != "" && cur.Packages != "{}" {
			continue
		}
		cur.Label = s.Label
		cur.Icon = s.Icon
		cur.Category = s.Category
		cur.Description = s.Description
		cur.Versions = s.Versions
		cur.Packages = s.Packages
		cur.SubDir = s.SubDir
		cur.Style = s.Style
		cur.Playbook = s.Playbook
		cur.InstallPath = s.InstallPath
		cur.DefaultPort = s.DefaultPort
		cur.CertDir = s.CertDir
		cur.NeedCert = s.NeedCert
		cur.Ready = s.Ready
		cur.Enabled = s.Enabled
		cur.SeedVer = mwSeedVer
		cur.UpdatedAt = time.Now()
		if e := DB.Save(&cur).Error; e != nil {
			log.Printf("中间件目录同步失败 %s: %v", s.Name, e)
		}
	}
}

// SeedMiddleware 兼容旧调用入口，实际由 SyncMiddlewareCatalog 完成目录同步
func SeedMiddleware() {
	SyncMiddlewareCatalog()
	SyncSysInitCatalog()
}

// ---------- 操作系统 / CPU 映射（CMDB 字段 → 离线包令牌）----------

// osVersionOf 从自由文本中抽取第一个版本号片段（如 7.9.2009 / 20.03 / 8.10 / V10）
func osVersionOf(s string) string {
	i := 0
	for i < len(s) {
		if s[i] >= '0' && s[i] <= '9' {
			j := i
			for j < len(s) && ((s[j] >= '0' && s[j] <= '9') || s[j] == '.') {
				j++
			}
			return s[i:j]
		}
		i++
	}
	return ""
}

// mapOsType 将 CMDB “操作系统版本”自由文本映射到安装包 OS 令牌。
// 令牌与控制节点脚本文件名保持一致：
// centos7 / almalinux8.9 / almalinux8.10 / openEuler20.03 / openEuler22.03 / hce2.0 / kylinV10。
// 仅识别已准备离线包的系统；无法识别或版本不匹配返回空串（即不支持）。
//
// 入参既可能是人工录入的中文简写（”华为欧拉 HCE2.0“），也可能是资源校准同步进来的
// /etc/os-release 的 ID+VERSION_ID 拼接值（”hce2.0“ / ”almalinux8.9“ / ”centos7“），
// 还可能是历史遗留的实测原值 PRETTY_NAME（”Huawei Cloud EulerOS 2.0 (aarch64)“），
// 因此关键词需同时覆盖中英文书写习惯。
func mapOsType(raw string) string {
	s := lowerASCII(raw)
	ver := osVersionOf(s)
	has := func(sub string) bool { return contains(s, sub) }
	switch {
	case has("kylin"), has("麒麟"):
		return "kylinV10"
	// 华为 HCE：人工写法用"hce/华为"，实测 PRETTY_NAME 为
	// "Huawei Cloud EulerOS 2.0 (aarch64)"（不含 hce 字样），EulerOS 系商业版同为华为出品。
	case has("hce"), has("华为"), has("euleros"), has("huawei cloud euler"):
		return "hce2.0"
	case has("openeuler"), has("欧拉"):
		switch {
		case has("22.03"), ver == "22", strings.HasPrefix(ver, "22.03"):
			return "openEuler22.03"
		case has("20.03"), ver == "20", strings.HasPrefix(ver, "20.03"):
			return "openEuler20.03"
		}
		return ""
	case has("almalinux"):
		switch {
		case has("8.10"), strings.HasPrefix(ver, "8.10"):
			return "almalinux8.10"
		case has("8.9"), strings.HasPrefix(ver, "8.9"):
			return "almalinux8.9"
		}
		return ""
	case has("centos"):
		if strings.HasPrefix(ver, "7") || (has("centos 7")) {
			return "centos7"
		}
		return ""
	}
	return ""
}

// mapCpuType 将 CMDB “CPU类型”(X86/ARM) 映射到安装包 CPU 令牌
func mapCpuType(raw string) string {
	s := lowerASCII(raw)
	switch {
	case contains(s, "x86"), contains(s, "amd64"), contains(s, "海光"), contains(s, "兆芯"), contains(s, "intel"):
		return "x86_64"
	case contains(s, "arm"), contains(s, "aarch64"), contains(s, "鲲鹏"), contains(s, "飞腾"), contains(s, "kunpeng"):
		return "aarch64"
	default:
		return ""
	}
}

// normalizeOsType 将 /etc/os-release 的 ID / ID_LIKE / VERSION_ID 归一化为平台 OS 令牌。
// 覆盖系统初始化选项里的全部发行版：centos7 / centos8 / openEuler20.03 /
// almalinux8.9 / rocky8 / rocky9 / rhel7 / rhel8 / rhel9 / kylin / hce2.0。
// 逻辑与 Jenkins「操作系统和cpu类型检测」stage 一致：先读 ID，回退到 ID_LIKE 判定家族。
func normalizeOsType(id, idLike, versionID string) string {
	s := strings.ToLower(id)
	like := strings.ToLower(idLike)
	ver := strings.ToLower(versionID)
	major := ver
	if i := strings.Index(ver, "."); i > 0 {
		major = ver[:i]
	}
	// 麒麟（银河麒麟 / 中标麒麟）
	if strings.Contains(s, "kylin") || strings.Contains(s, "neokylin") || strings.Contains(s, "麒麟") {
		return "kylin"
	}
	// 华为 HCE
	if strings.Contains(s, "hce") || strings.Contains(s, "华为") {
		return "hce2.0"
	}
	// openEuler
	if strings.Contains(s, "openeuler") || strings.Contains(like, "openeuler") {
		if strings.Contains(ver, "20.03") {
			return "openEuler20.03"
		}
		return "openEuler" + ver
	}
	switch {
	case strings.Contains(s, "almalinux"):
		if major == "8" {
			return "almalinux8.9"
		}
		return "almalinux" + major
	case strings.Contains(s, "rocky"):
		return "rocky" + major
	case strings.Contains(s, "centos") || strings.Contains(like, "centos"):
		return "centos" + major
	case strings.Contains(s, "rhel") || strings.Contains(s, "redhat"):
		return "rhel" + major
	case strings.Contains(s, "anolis"):
		return "centos" + major
	}
	return ""
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 32
		}
	}
	return string(b)
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if indexOf(s, sub) < 0 {
			return false
		}
	}
	return true
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
