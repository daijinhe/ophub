// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"log"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// main 服务入口
//
// 安全相关初始化顺序（v1.7.1+）：
//  1. LoadConfig → 配置 panic 时需要的 env 都在 Cfg 里
//  2. enforceProductionSecrets（Cfg.Env != "dev" 时强制 JWT_SECRET / PWD_ENC_KEY 非默认值）
//  3. initPwdCipher（须在 InitDB 播种之前）
//  4. loadKnownHosts（启动时一次性从磁盘恢复 SSH known_hosts）
//  5. InitRedis / InitDB（Cfg）
func main() {
	Cfg = LoadConfig()
	enforceProductionSecrets(Cfg)
	initPwdCipher() // 初始化用户密码可逆加密（须在 InitDB 播种之前）
	loadKnownHosts()
	InitRedis(Cfg)
	InitDB(Cfg)

	r := gin.Default()

	// CORS（前端独立部署时需要）
	origins := strings.Split(Cfg.AllowOrigins, ",")
	corsConf := cors.Config{
		AllowMethods:  []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:  []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders: []string{"Content-Disposition"},
		MaxAge:        12 * time.Hour,
	}
	if Cfg.AllowOrigins == "*" {
		corsConf.AllowAllOrigins = true
		corsConf.AllowCredentials = false
	} else {
		corsConf.AllowOrigins = origins
		corsConf.AllowCredentials = true
	}
	r.Use(cors.New(corsConf))

	api := r.Group("/api")
	{
		// 公开接口
		api.POST("/auth/login", Login)
		// 注册：开关在「系统管理 → 用户管理 → 注册设置」里控制（存 SystemSetting，写完立即生效、
		// 不用重启）。v1.7.45 之前是启动时按 env 决定绑哪个 handler，改开关必须重启后端 ——
		// 用户要的是页面上随时能切，所以判断收进 Register 内部，env 只作为「没在页面上配过」时的回落值。
		api.POST("/auth/register", Register)
		// 是否开放注册：公开只读，登录页据此显示「立即注册」或「注册已关闭」
		api.GET("/auth/register-allow", GetRegisterAllow)
		api.GET("/fields", GetFields)
		// WebSocket SSH 终端：
		//   - /api/ws/ssh/ticket 先拿一次性 ticket（v1.7.1+ 替代 ?token= URL 形式，避免 token 进 access log）
		//   - /api/ws/ssh 升级 WebSocket
		// ⚠️ v1.7.46 补权限收口：这两个接口此前**只校验登录**，导致
		// 「零权限的自助注册账号」登录后即可连任意资产的 shell —— 实打实的越权。
		// 现在拿 ticket 需 asset:terminal（资产管理 → Web 终端 → 打开终端）；
		// WS 升级本身靠 ticket 兜底（ticket 是一次性且已过权限校验的）。
		api.POST("/ws/ssh/ticket", AuthMiddleware(), RequirePermission("asset:terminal"), WsTicketHandler)
		api.GET("/ws/ssh", WebShellHandler)

		auth := api.Group("")
		auth.Use(AuthMiddleware())
		{
			auth.POST("/auth/logout", Logout)
			auth.GET("/auth/me", Me)
			auth.GET("/permissions", ListPermissions)
			// 个人密码自助：修改自己的密码 / 查看自己的密码
			auth.POST("/auth/change-password", ChangeMyPassword)
			auth.GET("/auth/password", GetMyPassword)

			// 用户管理。GET 同时是「选负责人」的选择器数据源（部署/系统初始化页要用）
			auth.GET("/users", RequireAnyPermission(permUserPicker...), ListUsers)
			auth.POST("/users", RequirePermission("user:create"), CreateUser)
			auth.PUT("/users/:id", RequirePermission("user:update"), UpdateUser)
			auth.DELETE("/users/:id", RequirePermission("user:delete"), DeleteUser)
			// 查看 / 重置他人密码：仅内置 admin 角色（不经权限码，避免误配）
			auth.GET("/users/:id/password", RequireAdminRole(), RevealUserPassword)
			auth.POST("/users/:id/reset-password", RequireAdminRole(), ResetUserPassword)
			// 注册开关（v1.7.45）：属于「用户从哪来」的治理，与「编辑用户」同权限 ——
			// 不新增权限码，避免又多一处要维护的三层拦截。
			auth.GET("/system/register-allow", RequirePermission("user:update"), GetRegisterAllowAdmin)
			auth.PUT("/system/register-allow", RequirePermission("user:update"), SetRegisterAllow)

			// 角色权限。GET 同时是「新建/编辑用户」时的角色选择器数据源
			auth.GET("/roles", RequireAnyPermission(permRolePicker...), ListRoles)
			auth.POST("/roles", RequirePermission("role:create"), CreateRole)
			auth.PUT("/roles/:id", RequirePermission("role:update"), UpdateRole)
			auth.DELETE("/roles/:id", RequirePermission("role:delete"), DeleteRole)

			// 资产分类树：同时是资产管理页与巡检任务范围选择器的数据源
			auth.GET("/categories", RequireAnyPermission(permCategoryTree...), GetCategoryTree)
			auth.POST("/categories", RequirePermission("category:create"), CreateCategory)
			auth.PUT("/categories/:id", RequirePermission("category:update"), UpdateCategory)
			auth.DELETE("/categories/:id", RequirePermission("category:delete"), DeleteCategory)

			// 资产。列表/详情是**全平台选择器的数据源**（巡检选目标机、中间件管控、
			// 部署、定时任务、脚本、监控配置都要选资产），故用 permAssetPicker 的 any-of；
			// 写操作仍按 cmdb 的精确动作码收口。
			auth.GET("/assets", RequireAnyPermission(permAssetPicker...), ListAssets)
			auth.GET("/assets/:id", RequireAnyPermission(permAssetPicker...), GetAsset)
			auth.POST("/assets", RequirePermission("cmdb:create"), CreateAsset)
			auth.PUT("/assets/:id", RequirePermission("cmdb:update"), UpdateAsset)
			auth.DELETE("/assets/:id", RequirePermission("cmdb:delete"), DeleteAsset)
			auth.DELETE("/assets/batch", RequirePermission("cmdb:delete"), BatchDeleteAssets)
			auth.PUT("/assets/batch", RequirePermission("cmdb:update"), BatchUpdateAssets)
			auth.POST("/assets/import", RequirePermission("cmdb:import"), ImportAssets)
			auth.GET("/assets/export", RequirePermission("cmdb:export"), ExportAssets)
			// 资源校准：SSH 直连目标机采集硬件规格并与登记值比对 / 同步
			auth.POST("/assets/:id/calibrate", RequirePermission("cmdb:update"), CalibrateAsset)
			auth.POST("/assets/:id/calibrate/apply", RequirePermission("cmdb:update"), ApplyCalibration)

			auth.GET("/stats/overview", RequirePermission("dashboard:view"), StatsOverview)
			auth.GET("/stats/group", RequirePermission("dashboard:view"), StatsGroup)

			// 中间件类型模板（全局共享，可增删改字段与默认值）。
			// 维护入口有两处：资产管理页（编辑资产时维护「中间件信息」的字段模板）
			// 与「中间件部署配置」页，故两边的权限码都放行。
			auth.GET("/mw/templates", RequireAnyPermission("mwtemplate:view", "cmdb:view", "deploy:view"), ListMwTemplates)
			auth.PUT("/mw/templates/:type", RequireAnyPermission("mwtemplate:create", "mwtemplate:update", "cmdb:update", "deploy:update"), UpsertMwTemplate)
			auth.DELETE("/mw/templates/:type", RequireAnyPermission("mwtemplate:delete", "cmdb:update", "deploy:update"), DeleteMwTemplate)

			// 本机主机清单（/ansible 裸路由，兼容老客户端）
			auth.GET("/ansible", RequireAnyPermission("ansible:local:view", "ansible:remote:view", "ansible:mode:view"), GetAnsibleHosts)
			auth.PUT("/ansible", RequireAnyPermission("ansible:local:update", "ansible:remote:update"), SaveAnsibleHosts)
			auth.GET("/ansible/raw", RequireAnyPermission("ansible:local:view"), RawAnsibleHosts)
			auth.POST("/ansible/raw", RequireAnyPermission("ansible:local:update"), RawAnsibleHosts)
			auth.POST("/ansible/import-cmdb", RequireAnyPermission("ansible:local:update"), ImportAnsibleFromCMDB)
			auth.GET("/ansible/cmdb-assets", RequireAnyPermission(permAssetPicker...), CmdbAssets)

			// 远程 Ansible 节点。
			// 列表/详情是「选控制节点」的选择器数据源（资产页、巡检、部署都要用），故用 permRemotePicker。
			auth.GET("/ansible/remotes", RequireAnyPermission(permRemotePicker...), ListAnsibleRemotes)
			auth.POST("/ansible/remotes", RequireAnyPermission("ansible:remote:create"), CreateAnsibleRemote)
			auth.GET("/ansible/remotes/:id", RequireAnyPermission(permRemotePicker...), GetAnsibleRemote)
			auth.PUT("/ansible/remotes/:id", RequireAnyPermission("ansible:remote:update"), UpdateAnsibleRemote)
			auth.DELETE("/ansible/remotes/:id", RequireAnyPermission("ansible:remote:delete"), DeleteAnsibleRemote)
			auth.POST("/ansible/remotes/:id/test", RequireAnyPermission("ansible:remote:exec"), TestAnsibleRemote)
			auth.GET("/ansible/remotes/:id/info", RequireAnyPermission("ansible:remote:view", "ansible:mode:view"), GetAnsibleRemoteInfo)
			auth.GET("/ansible/remotes/:id/hosts", RequireAnyPermission("ansible:remote:view", "ansible:remote:update"), GetRemoteHosts)
			auth.PUT("/ansible/remotes/:id/hosts", RequireAnyPermission("ansible:remote:update"), SaveRemoteHosts)
			auth.GET("/ansible/remotes/:id/hosts/raw", RequireAnyPermission("ansible:remote:view", "ansible:remote:update"), GetRemoteHostsRaw)
			auth.POST("/ansible/remotes/:id/hosts/raw", RequireAnyPermission("ansible:remote:update"), SaveRemoteHostsRaw)
			auth.POST("/ansible/remotes/:id/import-cmdb", RequireAnyPermission("ansible:remote:create"), ImportCMDBToRemote)
			auth.POST("/ansible/remotes/:id/exec", RequireAdminRole(), ExecRemoteCommand)

			// 本机 Ansible 管理（v1.7.10 起新增）：管理 backend 容器内的 /etc/ansible/ + 在容器内 exec ansible。
			// 旧路由 /ansible（裸）保持不动以兼容老客户端；新菜单用 /ansible/local/*。
			// info 同时被「平台采集通道设置」页读取，故带上 ansible:mode:view。
			auth.GET("/ansible/local/info", RequireAnyPermission("ansible:local:view", "ansible:mode:view"), GetLocalAnsibleInfo)
			auth.POST("/ansible/local/test", RequireAnyPermission("ansible:local:exec"), TestLocalAnsible)
			auth.POST("/ansible/local/exec", RequireAdminRole(), execLocalCommand)

			// 平台采集通道模式（v1.7.15）：一个开关决定全平台调 ansible 走本机还是远端控制节点
			auth.GET("/ansible/mode", RequireAnyPermission("ansible:mode:view", "ansible:local:view", "ansible:remote:view"), GetAnsibleRunnerMode)
			auth.PUT("/ansible/mode", RequireAnyPermission("ansible:mode:update"), SetAnsibleRunnerMode)

			// 应用中间件安装（离线 ansible 部署）
			auth.GET("/deploy/catalog", RequirePermission("deploy:view"), ListDeployCatalog)
			auth.POST("/deploy/detect", RequirePermission("deploy:view"), DetectTargets)
			// 部署对象：安装在「应用中间件安装」页，配置在「中间件部署配置」页，两处都放行
			auth.GET("/deploy/middlewares", RequireAnyPermission("deploy:view", "mwtemplate:view"), ListDeployMiddlewares)
			auth.GET("/deploy/middlewares/:id", RequireAnyPermission("deploy:view", "mwtemplate:view"), GetDeployMiddleware)
			auth.POST("/deploy/middlewares", RequireAnyPermission("deploy:create", "mwtemplate:create"), CreateDeployMiddleware)
			auth.PUT("/deploy/middlewares/:id", RequireAnyPermission("deploy:update", "mwtemplate:update"), UpdateDeployMiddleware)
			auth.DELETE("/deploy/middlewares/:id", RequireAnyPermission("deploy:delete", "mwtemplate:delete"), DeleteDeployMiddleware)
			auth.GET("/deploy/certs", RequirePermission("cert:view"), ListDeployCerts)
			auth.GET("/deploy/certs/summary", RequirePermission("cert:view"), DeployCertSummary)
			auth.GET("/deploy/certs/:id", RequirePermission("cert:view"), GetDeployCert)
			auth.POST("/deploy/certs", RequirePermission("cert:create"), CreateDeployCert)
			auth.POST("/deploy/certs/upload", RequirePermission("cert:create"), UploadDeployCert)
			auth.PUT("/deploy/certs/:id", RequirePermission("cert:update"), UpdateDeployCert)
			auth.DELETE("/deploy/certs/:id", RequirePermission("cert:delete"), DeleteDeployCert)
			auth.POST("/deploy/run", RequirePermission("deploy:exec"), DeployRun)
			// 执行记录页读，安装页也要看任务进度
			auth.GET("/deploy/jobs", RequireAnyPermission("deploy:record:view", "deploy:view"), ListDeployJobs)
			auth.POST("/deploy/jobs/:id/rerun", RequirePermission("deploy:exec"), RerunDeployJob)
			auth.GET("/deploy/jobs/:id", RequireAnyPermission("deploy:record:view", "deploy:view"), GetDeployJob)

			// 系统初始化（复用既有 ansible playbook）。
			// 这是「应用中间件安装」页里的一个能力 tab，权限独立成 sysinit 组
			// （拥有 deploy:view 但没 sysinit:view 的账号看不到该 tab）。
			auth.GET("/deploy/sysinit/options", RequirePermission("sysinit:view"), SysInitOptions)
			auth.POST("/deploy/sysinit", RequirePermission("sysinit:exec"), CreateSysInitJob)
			auth.GET("/deploy/sysinit", RequirePermission("sysinit:view"), ListSysInitJobs)
			auth.GET("/deploy/sysinit/:id", RequirePermission("sysinit:view"), GetSysInitJob)
			auth.POST("/deploy/sysinit/detect", RequirePermission("sysinit:view"), DetectSysInitEnv)

			// 系统初始化管理（目录可自定义，页面维护初始化选项）
			auth.GET("/deploy/sysinit/catalog", RequirePermission("sysinit:catalog:view"), ListSysInitCatalog)
			auth.POST("/deploy/sysinit/catalog", RequirePermission("sysinit:catalog:create"), CreateSysInitCatalog)
			auth.POST("/deploy/sysinit/catalog/sync", RequirePermission("sysinit:catalog:create"), SyncSysInitCatalogAPI)
			auth.GET("/deploy/sysinit/catalog/playbooks", RequirePermission("sysinit:catalog:view"), ListSysInitPlaybooks)
			auth.POST("/deploy/sysinit/catalog/check", RequirePermission("sysinit:catalog:view"), CheckSysInitPlaybook)
			auth.PUT("/deploy/sysinit/catalog/:id", RequirePermission("sysinit:catalog:update"), UpdateSysInitCatalog)
			auth.DELETE("/deploy/sysinit/catalog/:id", RequirePermission("sysinit:catalog:delete"), DeleteSysInitCatalog)
			auth.PATCH("/deploy/sysinit/catalog/:id/enabled", RequirePermission("sysinit:catalog:update"), ToggleSysInitCatalog)

			// 智能巡检。
			// 指标目录 / 任务列表 / 记录 / 大屏聚合 之间互相取数（报表页按任务筛选、
			// 大屏点告警跳记录），故只读接口统一用 permInspectionRead（任务/报表/告警/大屏任一即可）。
			auth.GET("/inspection/metrics", RequireAnyPermission(permInspectionRead...), InspectionMetricCatalog)
			auth.DELETE("/inspection/tasks/batch", RequirePermission("inspection:task:delete"), BatchDeleteInspectionTasks)
			auth.GET("/inspection/tasks", RequireAnyPermission(permInspectionRead...), ListInspectionTasks)
			auth.POST("/inspection/tasks", RequirePermission("inspection:task:create"), CreateInspectionTask)
			auth.PUT("/inspection/tasks/:id", RequirePermission("inspection:task:update"), UpdateInspectionTask)
			auth.DELETE("/inspection/tasks/:id", RequirePermission("inspection:task:delete"), DeleteInspectionTask)
			auth.POST("/inspection/tasks/:id/run", RequirePermission("inspection:task:run"), RunInspectionTask)
			auth.GET("/inspection/records", RequireAnyPermission(permInspectionRead...), ListInspectionRecords)
			auth.GET("/inspection/records/:id", RequireAnyPermission(permInspectionRead...), GetInspectionRecord)
			auth.DELETE("/inspection/records", RequirePermission("inspection:record:delete"), BatchDeleteInspectionRecords)
			auth.GET("/inspection/results", RequireAnyPermission(permInspectionRead...), ListInspectionResults)
			auth.GET("/inspection/dashboard", RequireAnyPermission(permInspectionRead...), InspectionDashboard)
			auth.GET("/inspection/dashboard/_inspect-env", RequireAnyPermission(permInspectionRead...), InspectionDashboardInspectEnv)
			auth.GET("/inspection/export", RequirePermission("inspection:record:export"), InspectionExport)

			// 巡检告警规则：按「项目简称 / 应用系统名称 / 指定资产」自定义阈值与屏蔽告警
			// 说明：GET/POST 下挂静态子路径 catalog/preview，PUT/DELETE 才用 :id，
			// 各自独立的路由树，不会触发 gin 的 static/wildcard 冲突 panic。
			auth.GET("/inspection/alert-rules", RequirePermission("inspection:alert:view"), ListInspectionAlertRules)
			auth.GET("/inspection/alert-rules/catalog", RequirePermission("inspection:alert:view"), InspectionAlertRuleCatalog)
			auth.POST("/inspection/alert-rules", RequirePermission("inspection:alert:create"), CreateInspectionAlertRule)
			auth.POST("/inspection/alert-rules/preview", RequirePermission("inspection:alert:view"), PreviewInspectionAlertRule)
			auth.PUT("/inspection/alert-rules/:id", RequirePermission("inspection:alert:update"), UpdateInspectionAlertRule)
			auth.DELETE("/inspection/alert-rules/:id", RequirePermission("inspection:alert:delete"), DeleteInspectionAlertRule)

			// 配置管理（nginx 配置文件等）：扫描虚拟机列表中的配置文件，在线编辑同步、增删改查
			auth.GET("/config", RequirePermission("config:view"), ListNginxConfigs)
			auth.GET("/config/scan/scope", RequirePermission("config:view"), ConfigScanScope)
			auth.POST("/config/scan", RequirePermission("config:sync"), ScanNginxConfigs)
			auth.POST("/config/import", RequirePermission("config:sync"), ImportNginxConfigs)
			auth.GET("/config/:id", RequirePermission("config:view"), GetNginxConfig)
			auth.POST("/config", RequirePermission("config:create"), CreateNginxConfig)
			auth.PUT("/config/:id", RequirePermission("config:update"), UpdateNginxConfig)
			auth.DELETE("/config/:id", RequirePermission("config:delete"), DeleteNginxConfig)
			auth.POST("/config/:id/pull", RequirePermission("config:sync"), PullNginxConfig)
			auth.POST("/config/:id/sync", RequirePermission("config:sync"), SyncNginxConfig)

			// 中间件管控：把「已部署好的中间件」变成可运维对象 ——
			// 进程存活检测 / 启停重启重载 / 配置文件在线管理与回滚。
			auth.GET("/mwops/profiles", RequirePermission("mwops:view"), ListMwOpsProfiles)
			auth.PUT("/mwops/profiles/:type", RequirePermission("mwops:update"), UpdateMwOpsProfile)
			auth.GET("/mwops/instances", RequirePermission("mwops:view"), ListMwOpsInstances)
			auth.POST("/mwops/instances/sync-deploy", RequirePermission("mwops:create"), SyncMwOpsFromDeploy)
			auth.POST("/mwops/instances/check-batch", RequireAnyPermission("mwops:view", "mwops:exec"), CheckMwOpsInstancesBatch)
			auth.POST("/mwops/instances", RequirePermission("mwops:create"), CreateMwOpsInstance)
			auth.GET("/mwops/instances/:id", RequirePermission("mwops:view"), GetMwOpsInstance)
			auth.PUT("/mwops/instances/:id", RequirePermission("mwops:update"), UpdateMwOpsInstance)
			auth.DELETE("/mwops/instances/:id", RequirePermission("mwops:delete"), DeleteMwOpsInstance)
			auth.POST("/mwops/instances/:id/check", RequirePermission("mwops:view"), CheckMwOpsInstance)
			auth.POST("/mwops/instances/:id/action", RequirePermission("mwops:exec"), MwOpsInstanceAction)
			auth.POST("/mwops/instances/:id/kill", RequirePermission("mwops:exec"), MwOpsInstanceKill)
			auth.GET("/mwops/instances/:id/configs", RequirePermission("mwops:view"), ListMwOpsConfigs)
			auth.GET("/mwops/instances/:id/config", RequirePermission("mwops:view"), GetMwOpsConfig)
			auth.POST("/mwops/instances/:id/config", RequirePermission("mwops:update"), SaveMwOpsConfig)
			auth.POST("/mwops/instances/:id/config/restore", RequirePermission("mwops:update"), RestoreMwOpsConfig)

			// 中间件捕捉：不预设机器上装了什么，只读扫描整机把存量中间件也捞出来
			// （nginx / php-fpm / java / redis / 宝兰德bws310 的版本、端口、安装位置、
			//  配置文件、日志、代码路径、证书），结果落库后可在资产列表与详情里展示。
			auth.GET("/mwcapture/assets", RequirePermission("mwcapture:view"), ListMwCaptureAssets)
			auth.GET("/mwcapture/export", RequirePermission("mwcapture:view"), ExportMwCaptures)
			auth.GET("/mwcapture/asset/:id", RequirePermission("mwcapture:view"), GetMwCapture)
			auth.POST("/mwcapture/run", RequirePermission("mwcapture:create"), RunMwCapture)
			auth.PUT("/mwcapture/asset/:id", RequirePermission("mwcapture:update"), UpdateMwCapture)
			auth.DELETE("/mwcapture/asset/:id", RequirePermission("mwcapture:delete"), DeleteMwCapture)

			// 定时任务（crontab 管理）：以「资产」为中心，直读直写目标机的 /etc/crontab
			// （读写统一以 root 身份，见 handler_crontab.go 的提权口径）。
			// 平台不存任务副本、也不写标记行 —— 机器上有什么就管什么，
			// 读到的即真实执行的，改完立即生效。
			// 用户自己的 `crontab -l`、/etc/cron.d/* 与 /etc/cron.{hourly,daily,...}/* 不再采集。
			// /crontab/scan 支持批量扫描所有资产（并发读取 + 单机超时 + TCP 预探测）。
			auth.GET("/crontab/assets", RequirePermission("crontab:view"), CrontabAssetList)
			auth.POST("/crontab/scan", RequirePermission("crontab:view"), ScanCrontabAssets)
			auth.GET("/crontab/asset/:id", RequirePermission("crontab:view"), GetAssetCrontab)
			auth.POST("/crontab/asset/:id/tasks", RequirePermission("crontab:create"), CreateAssetCrontabTask)
			auth.PUT("/crontab/asset/:id/tasks", RequirePermission("crontab:update"), UpdateAssetCrontabTask)
			auth.DELETE("/crontab/asset/:id/tasks", RequirePermission("crontab:delete"), DeleteAssetCrontabTask)
			auth.PUT("/crontab/asset/:id/raw", RequirePermission("crontab:update"), SaveAssetCrontabRaw)
			auth.PUT("/crontab/asset/:id/notes", RequirePermission("crontab:update"), SetCrontabTaskNote)

			// 脚本管理：Java 启停脚本
			// 读用 script:view，写/删用 script:manage；
			// host 形参叫「主机/资产」而不是「schedule target」，与现有 crontab 语义保持一致。
			auth.GET("/scripts/java/ls", RequirePermission("script:view"), ListScriptsEntry)
			auth.GET("/scripts/java/file", RequirePermission("script:view"), GetScriptFile)
			auth.PUT("/scripts/java/file", RequirePermission("script:update"), PutScriptFile)
			auth.POST("/scripts/java/file", RequirePermission("script:create"), PostScriptFile)
			auth.POST("/scripts/java/dir", RequirePermission("script:create"), MakeScriptDir)
			auth.DELETE("/scripts/java/entry", RequirePermission("script:delete"), DeleteScriptEntry)

			// Prometheus 监控（v1.8.0 独立大类）：数据源管理 + 只读查询代理 +
			// 大屏聚合 + 月度/季度/年度报表。
			// 读接口用 prom:view（大屏专属账号补 prom:screen 进 any-of），
			// 数据源增删改用 prom:manage。
			auth.GET("/prom/datasources", RequireAnyPermission(permPromRead...), ListPromDataSources)
			auth.POST("/prom/datasources", RequirePermission("prom:datasource:create"), CreatePromDataSource)
			auth.PUT("/prom/datasources/:id", RequirePermission("prom:datasource:update"), UpdatePromDataSource)
			auth.DELETE("/prom/datasources/:id", RequirePermission("prom:datasource:delete"), DeletePromDataSource)
			auth.POST("/prom/datasources/:id/test", RequireAnyPermission(permPromRead...), TestPromDataSource)
			// 查询代理：大屏（prom:screen）与监控报表（prom:report:view）共用同一批只读接口
			auth.GET("/prom/query", RequireAnyPermission(permPromRead...), PromProxyQuery)
			auth.GET("/prom/query_range", RequireAnyPermission(permPromRead...), PromProxyQueryRange)
			auth.GET("/prom/metric-names", RequireAnyPermission(permPromRead...), PromMetricNames)
			auth.GET("/prom/label/:name/values", RequireAnyPermission(permPromRead...), PromLabelValues)
			auth.GET("/prom/overview", RequireAnyPermission(permPromRead...), PromOverview)
			auth.GET("/prom/report", RequireAnyPermission(permPromRead...), PromReport)
			// v1.7.36：报告记录 —— 「生成报告」即归档，可回看 / 重新导出 / 删除
			auth.POST("/prom/reports/generate", RequirePermission("prom:report:create"), PromGenerateReport)
			auth.GET("/prom/reports", RequireAnyPermission(permPromRead...), PromListReports)
			auth.GET("/prom/reports/:id", RequireAnyPermission(permPromRead...), PromGetReport)
			auth.PUT("/prom/reports/:id", RequirePermission("prom:report:update"), PromUpdateReport)
			auth.DELETE("/prom/reports/:id", RequirePermission("prom:report:delete"), PromDeleteReport)
			// v1.7.38：按项目出报告 —— 项目清单 + 报表模板。
			// 模板刻意**不用管理码收口**（那会把功能锁死在管理员手上）：
			// 路由只要求 prom:report 的对应动作码（大屏专属账号 prom:screen 不应看到报表模板），
			// 「改 / 删只能动自己的」在 handler 里按 owner 判定（改他人需 prom:report:delete，
			// ⚠️ 该判定在 handler_prom_report_template.go 里同步改成了新码）。
			auth.GET("/prom/projects", RequirePermission("prom:report:view"), PromListProjects)
			auth.GET("/prom/report-templates", RequirePermission("prom:report:view"), PromListReportTemplates)
			auth.POST("/prom/report-templates", RequirePermission("prom:report:create"), PromCreateReportTemplate)
			auth.PUT("/prom/report-templates/:id", RequirePermission("prom:report:update"), PromUpdateReportTemplate)
			auth.DELETE("/prom/report-templates/:id", RequirePermission("prom:report:delete"), PromDeleteReportTemplate)
			// v1.7.33：大屏改为「服务端定期采集 → 读快照」，并支持阈值/采集频率的集中管理
			// 读配置：大屏自身要读阈值来配色，故 prom:screen 与配置查看码都放行
			auth.GET("/prom/screen-config", RequireAnyPermission("prom:screen:config:view", "prom:screen"), PromGetScreenConfig)
			auth.PUT("/prom/screen-config", RequirePermission("prom:screen:config:update"), PromSaveScreenConfig)
			auth.GET("/prom/snapshot", RequirePermission("prom:screen"), PromGetSnapshot)
			auth.POST("/prom/collect", RequireAnyPermission("prom:screen", "prom:screen:config:update"), PromCollectNow)
			// 被屏蔽目标明细（v1.7.43）：审计视图 —— 大屏上看不到的主机 / 风险项 / 榜位都在这里，
			// 并附带它们当前的实时指标。只读，独立成 prom:hidden:view
			// （不给 prom:screen：大屏专属账号不需要审计视图）。
			auth.GET("/prom/hidden", RequirePermission("prom:hidden:view"), PromGetHidden)

			// 监控告警报表（v1.8.2）：把夜莺的历史告警拉到本地再查询/统计/导出。
			//   读（配置回显 / 列表 / 统计 / 同步进度 / 下拉取值）→ prom:alert:view
			//   保存连接配置 → prom:alert:update；触发同步 → prom:alert:sync；导出 Excel → prom:alert:export
			// 拆开的原因：「只想看报表」的角色不该拿到「改连接配置」和「触发同步」的能力，
			// 而导出是重操作（几十 MB），单独成码便于只给需要的人。
			auth.GET("/prom/n9e-config", RequirePermission("prom:alert:view"), PromN9eGetConfig)
			auth.PUT("/prom/n9e-config", RequirePermission("prom:alert:update"), PromN9eSaveConfig)
			auth.POST("/prom/n9e-config/test", RequirePermission("prom:alert:view"), PromN9eTestConfig)
			auth.POST("/prom/n9e/sync", RequirePermission("prom:alert:sync"), PromN9eSync)
			auth.GET("/prom/n9e/sync-status", RequirePermission("prom:alert:view"), PromN9eSyncStatus)
			auth.GET("/prom/n9e/events", RequirePermission("prom:alert:view"), PromN9eEvents)
			auth.GET("/prom/n9e/groups", RequirePermission("prom:alert:view"), PromN9eGroups)
			auth.GET("/prom/n9e/rule-prods", RequirePermission("prom:alert:view"), PromN9eRuleProds)
			auth.GET("/prom/n9e/datasources", RequirePermission("prom:alert:view"), PromN9eDatasources)
			auth.GET("/prom/n9e/departments", RequirePermission("prom:alert:view"), PromN9eDepartments)
			auth.GET("/prom/n9e/stats", RequirePermission("prom:alert:view"), PromN9eStats)
			auth.GET("/prom/n9e/export", RequirePermission("prom:alert:export"), PromN9eExport)
			// 导出模板（v1.7.51）：读用 view、写用 export —— 故意不新增权限码，
			// 导出模板是导出能力的附属物，单独开码只会让角色配置变复杂。
			auth.GET("/prom/n9e/export-columns", RequirePermission("prom:alert:view"), PromN9eExportColumns)
			auth.GET("/prom/n9e/export-templates", RequirePermission("prom:alert:view"), PromN9eTplList)
			auth.POST("/prom/n9e/export-templates", RequirePermission("prom:alert:export"), PromN9eTplSave)
			auth.PUT("/prom/n9e/export-templates/:id", RequirePermission("prom:alert:export"), PromN9eTplSave)
			auth.DELETE("/prom/n9e/export-templates/:id", RequirePermission("prom:alert:export"), PromN9eTplDelete)
		}
	}

	// Prometheus 大屏定期采集（后台 goroutine：快照缓存 + 落库，大屏只读快照）
	promStartCollector()

	// 夜莺连接初始配置（仅首次写入，之后以页面配置为准）
	ensureN9eDefaults()

	log.Printf("云枢 OpsHub 服务已启动，监听端口 :%s", Cfg.ServerPort)
	if err := r.Run(":" + Cfg.ServerPort); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
