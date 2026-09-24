package main

import (
	"log"
	"sort"
	"strings"

	"github.com/lib/pq"
)

// ============================================================================
// 菜单 + 权限的「单一事实源」（Single Source of Truth）
//
// 为什么要收口到一处（v1.7.46）：
//   - 改造前「菜单树」（前端 MainLayout 硬编码）与「权限目录」（后端
//     models.go 的 PermissionCatalog）是两份手工维护的定义，必然漂移。
//     实测漂移：菜单里一个「中间件部署」二级分组，在权限目录里被拆成
//     「中间件部署 / 部署证书 / 系统初始化 / 系统初始化目录」4 个互不相邻的
//     Group；而「分类管理 / 中间件模板」在权限目录里有 Group，菜单里却没有
//     对应页面（属页内动作）。管理员在角色授权页满屏跳跃的 Group，
//     根本看不出哪一项对应哪个菜单。
//   - 权限颗粒度参差不齐：资产管理已是 cmdb:view/create/update/delete/import/export，
//     而「平台采集通道设置」「本机/远端 Ansible 管理」只有 ansible:manage 一个码，
//     「中间件管控」「定时任务」「Nginx 配置」「脚本管理」只有 view+manage 两档。
//
// 本文件提供的保证：
//   1. 权限颗粒度 = 每个菜单/子菜单的增删改查（view/create/update/delete）
//      + 必要特有动作（exec 执行 / export 导出 / import 导入 / sync 同步 / run 运行）。
//   2. 权限目录的 Group 由**菜单祖先路径**自动拼出（如
//      「中间件管理 / 中间件部署 / 应用中间件安装」），与菜单层级严格一致。
//   3. 权限显示名由「节点名 + 动作中文名」自动拼出，新增节点零手写文案。
//   4. 新增一个菜单只需要动：本文件（定义节点）+ main.go（挂路由）+
//      前端 iconMap（补一个图标）—— 权限目录、角色授权树、菜单渲染、
//      路由拦截全部自动跟上，不会再出现「菜单看不到但能访问」的漏配。
//
// 命名规范：<resource>:<action>，resource 可多段。
//   例：cmdb:view / inspection:task:run / prom:datasource:update / asset:terminal
//
// ⚠️ 新增/改名节点时的检查清单：
//   - Resource 为空的节点是「纯容器分组」，本身不产生权限码；
//   - NoMenu: true 表示「有权限、但不占菜单」（如资产管理页内的分类管理、
//     Web 终端），它会出现在角色授权树里，但不会渲染到侧边栏；
//   - Hidden: true 表示「菜单里有定义但不渲染」（如被屏蔽目标），
//     仍需登记 —— 否则页头面包屑标题反查不到 label，会退化成「概览」；
//   - EntryPerms 留空时自动推导：有 view 动作 → <resource>:view；
//     纯容器 → 所有子孙节点入口权限的**并集**（任一命中即算可见/可进）；
//   - 旧权限码一旦被拆分或改名，**必须**在 legacyPermUpgrade 里登记等价关系，
//     否则已经配好的角色会静默失去权限。
// ============================================================================

// 动作常量
const (
	ActView     = "view"     // 查看
	ActCreate   = "create"   // 新增
	ActUpdate   = "update"   // 编辑
	ActDelete   = "delete"   // 删除
	ActExec     = "exec"     // 执行（启停/重跑/测试连通性等）
	ActExport   = "export"   // 导出
	ActImport   = "import"   // 导入
	ActSync     = "sync"     // 同步（扫描/拉取/下发）
	ActRun      = "run"      // 运行（触发一次巡检）
	ActScreen   = "screen"   // 访问大屏（保留历史两段码 inspection:screen / prom:screen）
	ActTerminal = "terminal" // 打开 Web 终端
	// ActManage 管理他人数据：同一资源上「越过 owner 限制」的特权。
	// 用于「改/删只能动自己的，管理员可动全部」这类行级收口
	// （见 handler_prom_report_template.go 的 promTplCanEdit）。
	// ⚠️ 它不属于 CRUD，只在确实需要「他人数据」语义时使用。
	ActManage = "manage"
)

// actionName 动作中文名 —— 与节点 Label 拼成权限显示名（「资产分类 - 新增」）
var actionName = map[string]string{
	ActView:     "查看",
	ActCreate:   "新增",
	ActUpdate:   "编辑",
	ActDelete:   "删除",
	ActExec:     "执行",
	ActExport:   "导出",
	ActImport:   "导入",
	ActSync:     "同步",
	ActRun:      "运行",
	ActScreen:   "查看",
	ActTerminal: "打开终端",
	ActManage:   "管理他人数据",
}

// PermItem 一个具体权限码 + 中文名（下发给前端渲染角色授权树用）
type PermItem struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// MenuNode 菜单 + 权限树节点。
// 它同时承担三个角色：侧边栏菜单结构、权限目录分组、角色授权树结构。
type MenuNode struct {
	Key      string   `json:"key"`                // 菜单唯一键；页面节点用路由路径，分组用短名
	Label    string   `json:"label"`              // 显示名（也用于拼权限显示名与 Group 路径）
	Icon     string   `json:"icon,omitempty"`     // 图标名，前端 iconMap 映射到 antd 图标组件
	Route    string   `json:"route,omitempty"`    // 路由路径；空 = 纯容器分组
	Resource string   `json:"resource,omitempty"` // 权限资源前缀；空 = 本节点不产生权限码
	Actions  []string `json:"actions,omitempty"`  // 本节点支持的动作用，权限码 = Resource:Action
	NoMenu   bool     `json:"noMenu,omitempty"`   // 不占菜单（仅权限节点）
	Hidden   bool     `json:"hidden,omitempty"`   // 有菜单定义但不渲染（页头标题反查仍需它）
	NewTab   bool     `json:"newTab,omitempty"`   // 新标签页打开（大屏类）
	// EntryPerms 进入该页面所需权限码（any-of）。留空时由 enrichMenuTree 推导。
	EntryPerms []string `json:"entryPerms,omitempty"`
	// PermItems 本节点的权限码清单（含中文名），由 enrichMenuTree 填充。
	// 前端角色授权树直接用它渲染，不必再维护一份「动作 → 中文名」的映射。
	PermItems []PermItem `json:"permItems,omitempty"`
	Children  []MenuNode `json:"children,omitempty"`
}

// MenuPermTree 全平台菜单 + 权限树。切片顺序 = 侧边栏显示顺序。
var MenuPermTree = []MenuNode{
	{
		Key: "dashboard", Label: "概览", Icon: "dashboard", Route: "/dashboard",
		Resource: "dashboard", Actions: []string{ActView},
	},

	{
		Key: "cmdb", Label: "资产管理", Icon: "database", Route: "/cmdb",
		Resource: "cmdb",
		Actions:  []string{ActView, ActCreate, ActUpdate, ActDelete, ActImport, ActExport},
		Children: []MenuNode{
			// 资产分类树是资产管理页内的能力（不是独立菜单），但必须能独立授权
			{
				Key: "category", Label: "资产分类", NoMenu: true,
				Resource: "category", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
			},
			// Web 终端：入口在资产详情页。v1.7.46 之前 /ws/ssh 完全没有权限校验，
			// 导致「零权限的自助注册账号」也能连任意资产 —— 这里补上专用权限码。
			{
				Key: "asset:terminal", Label: "Web 终端", NoMenu: true,
				Resource: "asset", Actions: []string{ActTerminal},
			},
		},
	},

	{
		Key: "ansible", Label: "Ansible 管理", Icon: "cloud-server",
		Children: []MenuNode{
			{
				Key: "ansible:mode", Label: "平台采集通道设置", Icon: "api", Route: "/ansible/mode",
				Resource: "ansible:mode", Actions: []string{ActView, ActUpdate},
			},
			{
				Key: "ansible:local", Label: "本机 Ansible 管理", Icon: "code", Route: "/ansible/local",
				Resource: "ansible:local", Actions: []string{ActView, ActUpdate, ActExec},
			},
			{
				Key: "ansible:remote", Label: "远端 Ansible 管理", Icon: "cloud-server", Route: "/ansible/remote",
				Resource: "ansible:remote",
				Actions:  []string{ActView, ActCreate, ActUpdate, ActDelete, ActExec},
			},
		},
	},

	{
		Key: "middleware", Label: "中间件管理", Icon: "api",
		Children: []MenuNode{
			{
				Key: "deploy", Label: "中间件部署", Icon: "deployment-unit",
				Children: []MenuNode{
					{
						Key: "deploy:install", Label: "应用中间件安装", Icon: "rocket", Route: "/deploy",
						Resource: "deploy",
						Actions:  []string{ActView, ActCreate, ActUpdate, ActDelete, ActExec},
						Children: []MenuNode{
							// 「执行系统初始化」是本页内的一个能力，其目录维护在「系统初始化管理」页
							{
								Key: "deploy:sysinit", Label: "系统初始化执行", NoMenu: true,
								Resource: "sysinit", Actions: []string{ActView, ActExec},
							},
						},
					},
					{
						Key: "sysinit-config", Label: "系统初始化管理", Icon: "tool", Route: "/sysinit-config",
						Resource: "sysinit:catalog", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
					},
					{
						Key: "deploy-config", Label: "中间件部署配置", Icon: "appstore", Route: "/deploy-config",
						Resource: "mwtemplate", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
					},
					{
						Key: "deploy-certs", Label: "证书管理", Icon: "safety-certificate", Route: "/deploy-certs",
						Resource: "cert", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
					},
					{
						Key: "deploy-records", Label: "部署执行记录", Icon: "history", Route: "/deploy-records",
						// 记录本身只能看和删；「重跑任务」属执行动作 → deploy:exec
						Resource: "deploy:record", Actions: []string{ActView, ActDelete},
					},
				},
			},
			{
				Key: "ops", Label: "中间件运维", Icon: "hdd",
				Children: []MenuNode{
					{
						Key: "mwops", Label: "中间件管控", Icon: "thunderbolt", Route: "/mwops",
						Resource: "mwops", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete, ActExec},
					},
					{
						Key: "mw-capture", Label: "中间件捕捉", Icon: "file-search", Route: "/mw-capture",
						Resource: "mwcapture", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
					},
				},
			},
			{
				Key: "mwconfig", Label: "中间件配置管理", Icon: "file-protect",
				Children: []MenuNode{
					{
						Key: "nginx-config", Label: "Nginx 配置", Icon: "file-protect", Route: "/nginx-config",
						Resource: "config", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete, ActSync},
					},
				},
			},
		},
	},

	{
		Key: "crontab", Label: "定时任务", Icon: "field-time", Route: "/crontab",
		Resource: "crontab", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
	},

	{
		Key: "scripts", Label: "脚本管理", Icon: "code",
		Children: []MenuNode{
			{
				Key: "scripts:java", Label: "Java 启停脚本管理", Icon: "code", Route: "/scripts/java",
				Resource: "script", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
			},
		},
	},

	{
		Key: "monitor", Label: "监控巡检", Icon: "cluster",
		Children: []MenuNode{
			{
				// Resource 取 "inspection" + screen 动作，拼出历史的 inspection:screen 两段码
				Key: "inspection:screen", Label: "巡检大屏", Icon: "dot-chart",
				Route: "/inspection/screen", NewTab: true,
				Resource: "inspection", Actions: []string{ActScreen},
			},
			{
				Key: "inspection:tasks", Label: "智能巡检", Icon: "control", Route: "/inspection/tasks",
				Resource: "inspection:task",
				Actions:  []string{ActView, ActCreate, ActUpdate, ActDelete, ActRun},
			},
			{
				Key: "inspection:records", Label: "巡检报表", Icon: "file-text", Route: "/inspection/records",
				Resource: "inspection:record", Actions: []string{ActView, ActDelete, ActExport},
			},
			{
				Key: "inspection:alert-rules", Label: "告警规则", Icon: "alert",
				Route:    "/inspection/alert-rules",
				Resource: "inspection:alert",
				Actions:  []string{ActView, ActCreate, ActUpdate, ActDelete},
			},
		},
	},

	{
		Key: "prom", Label: "Prometheus 监控", Icon: "fund",
		Children: []MenuNode{
			{
				Key: "prom:datasources", Label: "数据源管理", Icon: "api", Route: "/prom/datasources",
				Resource: "prom:datasource", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
			},
			{
				Key: "prom:report", Label: "监控报表", Icon: "bar-chart", Route: "/prom/report",
				// 本页含「生成报告 / 报表模板 / 报告记录」三页签：
				// create = 生成报告与新建模板，update = 重命名/改模板，delete = 删报告/模板，
				// manage = 越过 owner 限制改删「他人」的模板（原 prom:manage 的行级特权）
				Resource: "prom:report", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete, ActManage},
			},
			{
				Key: "prom:alert-report", Label: "监控告警报表", Icon: "alert",
				Route: "/prom/alert-report",
				// 夜莺（Nightingale）历史告警采集与导出：
				//   view   = 看报表、统计、同步进度
				//   update = 改夜莺连接配置（地址 / Token）
				//   sync   = 触发一次数据同步（会真去连夜莺拉数据，耗时分钟级）
				//   export = 导出 Excel（数据量大时是重操作，单独成码便于只给需要的人）
				Resource: "prom:alert", Actions: []string{ActView, ActUpdate, ActSync, ActExport},
			},
			{
				Key: "prom:screen", Label: "监控大屏", Icon: "dot-chart",
				Route: "/prom/screen", NewTab: true,
				Resource: "prom", Actions: []string{ActScreen},
			},
			{
				Key: "prom:screen-admin", Label: "大屏管理", Icon: "control", Route: "/prom/screen-admin",
				Resource: "prom:screen:config", Actions: []string{ActView, ActUpdate},
			},
			{
				Key: "prom:hidden", Label: "被屏蔽目标", Icon: "eye-invisible",
				Route: "/prom/hidden", Hidden: true,
				Resource: "prom:hidden", Actions: []string{ActView},
			},
		},
	},

	{
		Key: "system", Label: "系统管理", Icon: "setting",
		Children: []MenuNode{
			{
				Key: "users", Label: "用户管理", Icon: "team", Route: "/users",
				Resource: "user", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
			},
			{
				Key: "roles", Label: "角色权限", Icon: "key", Route: "/roles",
				Resource: "role", Actions: []string{ActView, ActCreate, ActUpdate, ActDelete},
			},
		},
	},
}

// permCode 拼权限码：resource:action
func permCode(resource, action string) string {
	if resource == "" || action == "" {
		return ""
	}
	return resource + ":" + action
}

// walkMenuTree 深度优先遍历菜单权限树；path 为祖先 Label 链（用于拼 Group）。
func walkMenuTree(nodes []MenuNode, path []string, fn func(n *MenuNode, group []string)) {
	for i := range nodes {
		fn(&nodes[i], path)
		if len(nodes[i].Children) > 0 {
			walkMenuTree(nodes[i].Children, append(path, nodes[i].Label), fn)
		}
	}
}

// buildPermissionCatalog 由菜单权限树派生扁平权限目录。
// Group = 菜单祖先路径，Name = 节点名 + 动作中文名 —— 全部自动生成，无手写文案。
func buildPermissionCatalog() []PermissionDef {
	var out []PermissionDef
	walkMenuTree(MenuPermTree, nil, func(n *MenuNode, group []string) {
		g := strings.Join(group, " / ")
		for _, a := range n.Actions {
			c := permCode(n.Resource, a)
			if c == "" {
				continue
			}
			out = append(out, PermissionDef{Code: c, Name: n.Label + " - " + actionName[a], Group: g})
		}
	})
	return out
}

// computeEntryPerms 推导「进入本节点」所需权限码。
// 规则：显式指定 > 有 view 动作则取 view > 取第一个动作 > 纯容器则取所有子孙的并集。
func computeEntryPerms(n *MenuNode) []string {
	if len(n.EntryPerms) > 0 {
		return n.EntryPerms
	}
	if n.Resource != "" {
		for _, a := range n.Actions {
			if a == ActView {
				return []string{permCode(n.Resource, ActView)}
			}
		}
		if len(n.Actions) > 0 {
			return []string{permCode(n.Resource, n.Actions[0])}
		}
	}
	var out []string
	seen := map[string]bool{}
	for i := range n.Children {
		for _, c := range computeEntryPerms(&n.Children[i]) {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}
	return out
}

// cloneMenuTree 深拷贝菜单树（下发给前端时不能就地改包级变量）
func cloneMenuTree(nodes []MenuNode) []MenuNode {
	out := make([]MenuNode, len(nodes))
	copy(out, nodes)
	for i := range out {
		if len(nodes[i].Children) > 0 {
			out[i].Children = cloneMenuTree(nodes[i].Children)
		}
	}
	return out
}

// enrichMenuTree 自底向上补齐树中每个节点的派生字段：
//   - EntryPerms：进入该节点所需的权限码（容器节点依赖子节点的结果，故必须后序）
//   - PermItems：本节点自己的权限码清单（含中文名），供前端渲染授权树
func enrichMenuTree(nodes []MenuNode) {
	for i := range nodes {
		enrichMenuTree(nodes[i].Children)
		if len(nodes[i].EntryPerms) == 0 {
			nodes[i].EntryPerms = computeEntryPerms(&nodes[i])
		}
		if len(nodes[i].PermItems) == 0 && nodes[i].Resource != "" {
			for _, a := range nodes[i].Actions {
				c := permCode(nodes[i].Resource, a)
				if c == "" {
					continue
				}
				nodes[i].PermItems = append(nodes[i].PermItems, PermItem{
					Code: c,
					Name: nodes[i].Label + " - " + actionName[a],
				})
			}
		}
	}
}

// menuTreeForClient 返回补全了 EntryPerms / PermItems 的菜单树副本，
// 供前端渲染菜单、派生路由权限、渲染角色授权树。
func menuTreeForClient() []MenuNode {
	out := cloneMenuTree(MenuPermTree)
	enrichMenuTree(out)
	return out
}

// legacyPermUpgrade 旧权限码 → 等效新权限码集合。
//
// 只登记**语义被拆分**的码；语义未变的码（如 cmdb:view、user:create、
// script:view）无需登记，迁移时会原样保留。
//
// ⚠️ 原则：严格等价，不放大。写映射前先回 main.go 确认旧码当时能放行哪些接口，
// 宁可少给（事后管理员手工补），不可多给（静默提权，安全审计过不去）。
//
// 唯一的例外是「写权限附带对应查看权限」：拥有管理码的角色在迁移时一并获得
// 对应 view 码 —— 「能改不能看」在 UI 上无法使用（按钮全在页面里），属于死配置，
// 一并补齐是修复而非放大，迁移日志里会逐条打印。
var legacyPermUpgrade = map[string][]string{
	// ---- Ansible：原来只有一个 ansible:manage 撑三个页面 ----
	"ansible:manage": {
		"ansible:mode:view", "ansible:mode:update",
		"ansible:local:view", "ansible:local:update", "ansible:local:exec",
		"ansible:remote:view", "ansible:remote:create", "ansible:remote:update",
		"ansible:remote:delete", "ansible:remote:exec",
	},
	"ansible:view":   {"ansible:mode:view", "ansible:local:view", "ansible:remote:view"},
	"ansible:create": {"ansible:remote:create"},
	"ansible:update": {"ansible:mode:update", "ansible:local:update", "ansible:remote:update"},
	"ansible:delete": {"ansible:remote:delete"},
	"ansible:exec":   {"ansible:local:exec", "ansible:remote:exec"},

	// ---- 中间件部署：deploy:manage 当时同时放行 cert / sysinit / sysinit:catalog ----
	"deploy:manage": {
		"deploy:view", "deploy:create", "deploy:update", "deploy:delete", "deploy:exec",
		"sysinit:view", "sysinit:exec",
		"sysinit:catalog:view", "sysinit:catalog:create", "sysinit:catalog:update", "sysinit:catalog:delete",
		"cert:view", "cert:create", "cert:update", "cert:delete",
		"deploy:record:view", "deploy:record:delete",
	},
	// deploy:update 语义未变，无需登记。

	// ---- 证书 ----
	// cert:view/create/update/delete 语义未变，无需登记（迁移时原样保留）。
	// ⚠️ 别在这里加 `"cert:view": {"cert:view"}` 这类恒等映射：迁移代码把
	// 「命中映射表」一律视为 changed=true，恒等项会让持有该码的角色
	// 每次启动都被重写一遍（结果相同，但纯属无谓写库 + 日志噪音）。

	// ---- 系统初始化 ----
	// sysinit:view 是**被拆分**的：当时它同时能进「系统初始化管理」页
	// （sysinit:catalog:*），所以要连带补上 catalog 的查看权限。
	"sysinit:view": {"sysinit:view", "sysinit:catalog:view"},
	// sysinit:exec 语义未变，无需登记。

	// ---- 资产分类 ----
	"category:manage": {"category:view", "category:create", "category:update", "category:delete"},

	// ---- 中间件模板：manage → CRUD ----
	"mwtemplate:manage": {"mwtemplate:view", "mwtemplate:create", "mwtemplate:update", "mwtemplate:delete"},

	// ---- 中间件管控 ----
	"mwops:manage": {"mwops:view", "mwops:create", "mwops:update", "mwops:delete"},

	// ---- 中间件捕捉 ----
	"mwcapture:manage": {"mwcapture:view", "mwcapture:create", "mwcapture:update", "mwcapture:delete"},

	// ---- Nginx 配置 ----
	"config:manage": {"config:view", "config:create", "config:update", "config:delete"},

	// ---- 定时任务 ----
	"crontab:manage": {"crontab:view", "crontab:create", "crontab:update", "crontab:delete"},

	// ---- 脚本管理 ----
	"script:manage": {"script:view", "script:create", "script:update", "script:delete"},

	// ---- 智能巡检：inspection:view / inspection:manage 两个聚合码被拆散 ----
	// ⚠️ 回查 main.go 确认过：inspection:view 当时还能「导出巡检报表」
	// （GET /inspection/export 是 any-of(inspection:view, inspection:record:export)），
	// 也能进巡检大屏（App.tsx 的 RequireAnyPerm 放行），所以两处都要带上。
	"inspection:view": {
		"inspection:task:view", "inspection:record:view",
		"inspection:record:export", "inspection:alert:view", "inspection:screen",
	},
	// ⚠️ 管理码必须连带对应 view，否则会「收窄」——原设计里页面级入口权限
	// 混用了 view 与 manage（如「告警规则」页当年就是 RequirePerm(inspection:manage)），
	// 只给管理码不给 view，原来进得去的页面迁移后反而进不去了。
	"inspection:manage": {
		"inspection:task:view", "inspection:task:create", "inspection:task:update",
		"inspection:task:delete", "inspection:task:run",
		"inspection:record:view", "inspection:record:delete", "inspection:record:export",
		"inspection:alert:view", "inspection:alert:create",
		"inspection:alert:update", "inspection:alert:delete",
	},

	// ---- Prometheus：prom:view / prom:manage 两个聚合码被拆散 ----
	// ⚠️ prom:view 当时能生成报告（POST /prom/reports/generate 是 any-of(prom:view, prom:manage)），
	// 且报表模板的增删改当时**刻意不用 manage 收口**（详见 main.go 里那段注释），
	// 所以 prom:view 必须连带 prom:report 的 create/update/delete，否则会缩小原有能力。
	"prom:view": {
		"prom:datasource:view", "prom:report:view", "prom:report:create",
		"prom:report:update", "prom:report:delete", "prom:hidden:view", "prom:screen",
	},
	"prom:manage": {
		"prom:datasource:view", "prom:datasource:create",
		"prom:datasource:update", "prom:datasource:delete",
		"prom:report:view", "prom:report:create", "prom:report:update",
		"prom:report:delete", "prom:report:manage",
		"prom:screen:config:view", "prom:screen:config:update",
		"prom:hidden:view", "prom:screen",
	},
}

// ============================================================================
// 辅助读取接口的放行码集合（「下拉选择器」类只读接口）
//
// 这类接口的数据被多个业务页共用：例如 GET /assets 同时服务于资产管理、
// 巡检任务（选目标机）、中间件管控、中间件捕捉、部署、定时任务、脚本管理、
// 监控配置…… 若按「数据归属模块」的权限码严格卡死，就会出现
// 「有 A 页权限的人打开 A 页，下拉框却是空的」这类可用性事故
// —— 这是权限细化的第一号坑（比「少给权限」更难排查，因为接口返回 403 但页面只是空着）。
//
// 所以口径是：**页面主数据接口用精确码，选择器类只读接口用下面的 any-of 集合。**
// 新增业务模块若也需要选资产/选用户/选节点，把它的 view 码补进对应集合即可。
// ============================================================================
var (
	// permAssetPicker 资产选择器（几乎所有业务页都要选目标机）
	permAssetPicker = []string{
		"cmdb:view", "inspection:task:view", "inspection:record:view", "inspection:screen",
		"mwops:view", "mwcapture:view", "deploy:view", "sysinit:view", "sysinit:catalog:view",
		"crontab:view", "script:view", "config:view",
		"prom:datasource:view", "prom:report:view", "prom:screen",
		"ansible:mode:view", "ansible:local:view", "ansible:remote:view",
	}
	// permCategoryTree 分类树（资产管理、巡检任务范围选择）
	permCategoryTree = []string{"cmdb:view", "category:view", "inspection:task:view", "category:create", "category:update"}
	// permRemotePicker 远端 Ansible 节点列表（资产页、巡检、部署都要选控制节点）
	permRemotePicker = []string{
		"ansible:remote:view", "ansible:remote:create", "ansible:remote:update", "ansible:remote:delete",
		"ansible:mode:view", "ansible:local:view",
		"cmdb:view", "inspection:task:view", "deploy:view", "sysinit:view",
	}
	// permUserPicker 用户列表（部署页选负责人）
	permUserPicker = []string{"user:view", "deploy:view", "sysinit:view", "sysinit:catalog:view"}
	// permRolePicker 角色列表（用户管理页渲染角色下拉）
	permRolePicker = []string{"role:view", "user:view", "user:create", "user:update", "user:delete"}
	// permPromRead Prometheus 只读（大屏 prom:screen 与报表 prom:report:view 都要用同一批查询接口）
	permPromRead = []string{"prom:datasource:view", "prom:report:view", "prom:screen"}
	// permInspectionRead 巡检只读（大屏/报表/任务互相取数）
	permInspectionRead = []string{
		"inspection:task:view", "inspection:record:view", "inspection:alert:view", "inspection:screen",
	}
)

// terminalPermBackfill 附带补齐规则：拥有「查看资产」的角色自动获得「Web 终端」权限。
//
// 背景：v1.7.46 之前 /ws/ssh 接口完全没有权限校验（只要登录就能连任意资产的 shell），
// 而它的入口就在资产详情页。补权限时若只加码不给存量角色补，
// 会让原本正常使用终端的运维人员突然 403；而「能看资产详情的人能看到终端入口」
// 本来就是原设计的隐含语义。所以这里显式、可审计地补齐 —— 而不是继续留空权限。
var terminalPermBackfill = struct {
	IfHas string
	Grant string
}{
	IfHas: "cmdb:view",
	Grant: "asset:terminal",
}

// migrateLegacyPerms 启动时把已有角色（含自定义角色）的旧权限码展开为等效的细分码。
//
// 幂等：以**结果集合**判断是否需要写库 —— 展开后集合与原来完全一致时直接跳过。
// ⚠️ 不能只看「是否命中映射表」：`sysinit:view` 既是现存合法码、又是被拆分的旧码
// （展开会补上 sysinit:catalog:view），持有它的角色（含 admin）如果按「命中即写」，
// 每次启动都会做一次内容相同的重写 —— 无谓写库 + 日志噪音。
func migrateLegacyPerms() {
	known := map[string]bool{}
	for _, c := range AllPermissionCodes() {
		known[c] = true
	}
	var roles []Role
	if err := DB.Find(&roles).Error; err != nil {
		log.Printf("[perm-migrate] 读取角色失败: %v", err)
		return
	}
	for i := range roles {
		role := &roles[i]
		orig := map[string]bool{}
		for _, p := range role.Permissions {
			if p != "" {
				orig[p] = true
			}
		}
		seen := map[string]bool{}
		var out []string
		for _, p := range role.Permissions {
			repl, isLegacy := legacyPermUpgrade[p]
			switch {
			case isLegacy:
				// 命中等价映射：展开为细分码
			case known[p]:
				repl = []string{p}
			default:
				// 未知码：不静默丢弃（可能是历史遗留或手工写入），原样保留并告警
				log.Printf("[perm-migrate] 角色 %q 含未知权限码 %q，已原样保留，请人工确认", role.Code, p)
				repl = []string{p}
			}
			for _, c := range repl {
				if c == "" || seen[c] {
					continue
				}
				seen[c] = true
				out = append(out, c)
			}
		}
		// 附带补齐：能看资产 → 能开 Web 终端
		if seen[terminalPermBackfill.IfHas] && !seen[terminalPermBackfill.Grant] {
			seen[terminalPermBackfill.Grant] = true
			out = append(out, terminalPermBackfill.Grant)
			log.Printf("[perm-migrate] 角色 %q 持有 %s，已补 %s（Web 终端入口在资产详情页）",
				role.Code, terminalPermBackfill.IfHas, terminalPermBackfill.Grant)
		}
		// 结果集合与原来完全一致 → 无需写库
		if len(orig) == len(seen) {
			same := true
			for c := range orig {
				if !seen[c] {
					same = false
					break
				}
			}
			if same {
				continue
			}
		}
		sort.Strings(out)
		role.Permissions = pq.StringArray(out)
		if err := DB.Save(role).Error; err != nil {
			log.Printf("[perm-migrate] 角色 %q 保存失败: %v", role.Code, err)
			continue
		}
		log.Printf("[perm-migrate] 角色 %q 权限已迁移为细分码（%d 项）", role.Code, len(out))
	}
}
