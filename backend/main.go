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
		// 注册：默认关闭（防白嫖 / 防爆破新口子）。
		// 真要开放时用 env ALLOW_PUBLIC_REGISTER=true；前端会渲染对应提示。
		if !publicRegistrationAllowed() {
			api.POST("/auth/register", publicRegistrationDisabledHandler)
		} else {
			api.POST("/auth/register", Register)
		}
		api.GET("/fields", GetFields)
		// WebSocket SSH 终端：
		//   - /api/ws/ssh/ticket 先拿一次性 ticket（v1.7.1+ 替代 ?token= URL 形式，避免 token 进 access log）
		//   - /api/ws/ssh 升级 WebSocket
		api.POST("/ws/ssh/ticket", AuthMiddleware(), WsTicketHandler)
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

			auth.GET("/users", RequirePermission("user:view"), ListUsers)
			auth.POST("/users", RequirePermission("user:create"), CreateUser)
			auth.PUT("/users/:id", RequirePermission("user:update"), UpdateUser)
			auth.DELETE("/users/:id", RequirePermission("user:delete"), DeleteUser)
			// 查看 / 重置他人密码：仅内置 admin 角色（不经权限码，避免误配）
			auth.GET("/users/:id/password", RequireAdminRole(), RevealUserPassword)
			auth.POST("/users/:id/reset-password", RequireAdminRole(), ResetUserPassword)

			auth.GET("/roles", RequirePermission("role:view"), ListRoles)
			auth.POST("/roles", RequirePermission("role:create"), CreateRole)
			auth.PUT("/roles/:id", RequirePermission("role:update"), UpdateRole)
			auth.DELETE("/roles/:id", RequirePermission("role:delete"), DeleteRole)

			auth.GET("/categories", RequireAnyPermission("cmdb:view", "category:view"), GetCategoryTree)
			auth.POST("/categories", RequireAnyPermission("category:manage", "category:create"), CreateCategory)
			auth.PUT("/categories/:id", RequireAnyPermission("category:manage", "category:update"), UpdateCategory)
			auth.DELETE("/categories/:id", RequireAnyPermission("category:manage", "category:delete"), DeleteCategory)

			auth.GET("/assets", RequirePermission("cmdb:view"), ListAssets)
			auth.GET("/assets/:id", RequirePermission("cmdb:view"), GetAsset)
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

			// 中间件类型模板（全局共享，可增删改字段与默认值）
			auth.GET("/mw/templates", RequireAnyPermission("cmdb:view", "mwtemplate:view"), ListMwTemplates)
			auth.PUT("/mw/templates/:type", RequireAnyPermission("cmdb:update", "mwtemplate:manage"), UpsertMwTemplate)
			auth.DELETE("/mw/templates/:type", RequireAnyPermission("cmdb:update", "mwtemplate:manage"), DeleteMwTemplate)

			auth.GET("/ansible", RequireAnyPermission("ansible:manage", "ansible:view"), GetAnsibleHosts)
			auth.PUT("/ansible", RequireAnyPermission("ansible:manage", "ansible:update"), SaveAnsibleHosts)
			auth.GET("/ansible/raw", RequireAnyPermission("ansible:manage", "ansible:view"), RawAnsibleHosts)
			auth.POST("/ansible/raw", RequireAnyPermission("ansible:manage", "ansible:update"), RawAnsibleHosts)
			auth.POST("/ansible/import-cmdb", RequireAnyPermission("ansible:manage", "ansible:create"), ImportAnsibleFromCMDB)
			auth.GET("/ansible/cmdb-assets", RequireAnyPermission("ansible:manage", "ansible:view"), CmdbAssets)

			// 远程 Ansible 节点
			auth.GET("/ansible/remotes", RequireAnyPermission("ansible:manage", "ansible:view"), ListAnsibleRemotes)
			auth.POST("/ansible/remotes", RequireAnyPermission("ansible:manage", "ansible:create"), CreateAnsibleRemote)
			auth.GET("/ansible/remotes/:id", RequireAnyPermission("ansible:manage", "ansible:view"), GetAnsibleRemote)
			auth.PUT("/ansible/remotes/:id", RequireAnyPermission("ansible:manage", "ansible:update"), UpdateAnsibleRemote)
			auth.DELETE("/ansible/remotes/:id", RequireAnyPermission("ansible:manage", "ansible:delete"), DeleteAnsibleRemote)
			auth.POST("/ansible/remotes/:id/test", RequireAnyPermission("ansible:manage", "ansible:exec"), TestAnsibleRemote)
			auth.GET("/ansible/remotes/:id/info", RequireAnyPermission("ansible:manage", "ansible:view"), GetAnsibleRemoteInfo)
			auth.GET("/ansible/remotes/:id/hosts", RequireAnyPermission("ansible:manage", "ansible:view"), GetRemoteHosts)
			auth.PUT("/ansible/remotes/:id/hosts", RequireAnyPermission("ansible:manage", "ansible:update"), SaveRemoteHosts)
			auth.GET("/ansible/remotes/:id/hosts/raw", RequireAnyPermission("ansible:manage", "ansible:view"), GetRemoteHostsRaw)
			auth.POST("/ansible/remotes/:id/hosts/raw", RequireAnyPermission("ansible:manage", "ansible:update"), SaveRemoteHostsRaw)
			auth.POST("/ansible/remotes/:id/import-cmdb", RequireAnyPermission("ansible:manage", "ansible:create"), ImportCMDBToRemote)
			auth.POST("/ansible/remotes/:id/exec", RequireAdminRole(), ExecRemoteCommand)

			// 本机 Ansible 管理（v1.7.10 起新增）：管理 backend 容器内的 /etc/ansible/ + 在容器内 exec ansible。
			// 旧路由 /ansible（裸）保持不动以兼容老客户端；新菜单用 /ansible/local/*。
			auth.GET("/ansible/local/info", RequireAnyPermission("ansible:manage", "ansible:view"), GetLocalAnsibleInfo)
			auth.POST("/ansible/local/test", RequireAnyPermission("ansible:manage", "ansible:exec"), TestLocalAnsible)
			auth.POST("/ansible/local/exec", RequireAdminRole(), execLocalCommand)

			// 平台采集通道模式（v1.7.15）：一个开关决定全平台调 ansible 走本机还是远端控制节点
			auth.GET("/ansible/mode", RequireAnyPermission("ansible:manage", "ansible:view"), GetAnsibleRunnerMode)
			auth.PUT("/ansible/mode", RequireAnyPermission("ansible:manage", "ansible:update"), SetAnsibleRunnerMode)

			// 应用中间件安装（离线 ansible 部署）
			auth.GET("/deploy/catalog", RequireAnyPermission("deploy:manage", "deploy:view"), ListDeployCatalog)
			auth.POST("/deploy/detect", RequireAnyPermission("deploy:manage", "deploy:view"), DetectTargets)
			auth.GET("/deploy/middlewares", RequireAnyPermission("deploy:manage", "deploy:view"), ListDeployMiddlewares)
			auth.GET("/deploy/middlewares/:id", RequireAnyPermission("deploy:manage", "deploy:view"), GetDeployMiddleware)
			auth.POST("/deploy/middlewares", RequireAnyPermission("deploy:manage", "deploy:create"), CreateDeployMiddleware)
			auth.PUT("/deploy/middlewares/:id", RequireAnyPermission("deploy:manage", "deploy:update"), UpdateDeployMiddleware)
			auth.DELETE("/deploy/middlewares/:id", RequireAnyPermission("deploy:manage", "deploy:delete"), DeleteDeployMiddleware)
			auth.GET("/deploy/certs", RequireAnyPermission("deploy:manage", "cert:view"), ListDeployCerts)
			auth.GET("/deploy/certs/summary", RequireAnyPermission("deploy:manage", "cert:view"), DeployCertSummary)
			auth.GET("/deploy/certs/:id", RequireAnyPermission("deploy:manage", "cert:view"), GetDeployCert)
			auth.POST("/deploy/certs", RequireAnyPermission("deploy:manage", "cert:create"), CreateDeployCert)
			auth.POST("/deploy/certs/upload", RequireAnyPermission("deploy:manage", "cert:create"), UploadDeployCert)
			auth.PUT("/deploy/certs/:id", RequireAnyPermission("deploy:manage", "cert:update"), UpdateDeployCert)
			auth.DELETE("/deploy/certs/:id", RequireAnyPermission("deploy:manage", "cert:delete"), DeleteDeployCert)
			auth.POST("/deploy/run", RequireAnyPermission("deploy:manage", "deploy:exec"), DeployRun)
			auth.GET("/deploy/jobs", RequireAnyPermission("deploy:manage", "deploy:view"), ListDeployJobs)
			auth.POST("/deploy/jobs/:id/rerun", RequireAnyPermission("deploy:manage", "deploy:exec"), RerunDeployJob)
			auth.GET("/deploy/jobs/:id", RequireAnyPermission("deploy:manage", "deploy:view"), GetDeployJob)

			// 系统初始化（复用既有 ansible playbook）
			auth.GET("/deploy/sysinit/options", RequireAnyPermission("deploy:manage", "sysinit:view"), SysInitOptions)
			auth.POST("/deploy/sysinit", RequireAnyPermission("deploy:manage", "sysinit:exec"), CreateSysInitJob)
			auth.GET("/deploy/sysinit", RequireAnyPermission("deploy:manage", "sysinit:view"), ListSysInitJobs)
			auth.GET("/deploy/sysinit/:id", RequireAnyPermission("deploy:manage", "sysinit:view"), GetSysInitJob)
			auth.POST("/deploy/sysinit/detect", RequireAnyPermission("deploy:manage", "sysinit:view"), DetectSysInitEnv)

			// 系统初始化管理（目录可自定义，页面维护初始化选项）
			auth.GET("/deploy/sysinit/catalog", RequireAnyPermission("deploy:manage", "sysinit:catalog:view"), ListSysInitCatalog)
			auth.POST("/deploy/sysinit/catalog", RequireAnyPermission("deploy:manage", "sysinit:catalog:create"), CreateSysInitCatalog)
			auth.POST("/deploy/sysinit/catalog/sync", RequireAnyPermission("deploy:manage", "sysinit:catalog:create"), SyncSysInitCatalogAPI)
			auth.GET("/deploy/sysinit/catalog/playbooks", RequireAnyPermission("deploy:manage", "sysinit:catalog:view"), ListSysInitPlaybooks)
			auth.POST("/deploy/sysinit/catalog/check", RequireAnyPermission("deploy:manage", "sysinit:catalog:view"), CheckSysInitPlaybook)
			auth.PUT("/deploy/sysinit/catalog/:id", RequireAnyPermission("deploy:manage", "sysinit:catalog:update"), UpdateSysInitCatalog)
			auth.DELETE("/deploy/sysinit/catalog/:id", RequireAnyPermission("deploy:manage", "sysinit:catalog:delete"), DeleteSysInitCatalog)
			auth.PATCH("/deploy/sysinit/catalog/:id/enabled", RequireAnyPermission("deploy:manage", "sysinit:catalog:update"), ToggleSysInitCatalog)

			// 智能巡检
			auth.GET("/inspection/metrics", RequireAnyPermission("inspection:view", "inspection:manage", "inspection:screen", "inspection:task:view", "inspection:alert:view"), InspectionMetricCatalog)
			auth.DELETE("/inspection/tasks/batch", RequireAnyPermission("inspection:manage", "inspection:task:delete"), BatchDeleteInspectionTasks)
			auth.GET("/inspection/tasks", RequireAnyPermission("inspection:view", "inspection:task:view"), ListInspectionTasks)
			auth.POST("/inspection/tasks", RequireAnyPermission("inspection:manage", "inspection:task:create"), CreateInspectionTask)
			auth.PUT("/inspection/tasks/:id", RequireAnyPermission("inspection:manage", "inspection:task:update"), UpdateInspectionTask)
			auth.DELETE("/inspection/tasks/:id", RequireAnyPermission("inspection:manage", "inspection:task:delete"), DeleteInspectionTask)
			auth.POST("/inspection/tasks/:id/run", RequireAnyPermission("inspection:manage", "inspection:task:run"), RunInspectionTask)
			auth.GET("/inspection/records", RequireAnyPermission("inspection:view", "inspection:record:view"), ListInspectionRecords)
			auth.GET("/inspection/records/:id", RequireAnyPermission("inspection:view", "inspection:record:view"), GetInspectionRecord)
			auth.DELETE("/inspection/records", RequireAnyPermission("inspection:manage", "inspection:record:delete"), BatchDeleteInspectionRecords)
			auth.GET("/inspection/results", RequireAnyPermission("inspection:view", "inspection:record:view"), ListInspectionResults)
			auth.GET("/inspection/dashboard", RequireAnyPermission("inspection:view", "inspection:screen", "inspection:record:view"), InspectionDashboard)
			auth.GET("/inspection/dashboard/_inspect-env", RequireAnyPermission("inspection:view", "inspection:screen", "inspection:record:view"), InspectionDashboardInspectEnv)
			auth.GET("/inspection/export", RequireAnyPermission("inspection:view", "inspection:record:export"), InspectionExport)

			// 巡检告警规则：按「项目简称 / 应用系统名称 / 指定资产」自定义阈值与屏蔽告警
			// 说明：GET/POST 下挂静态子路径 catalog/preview，PUT/DELETE 才用 :id，
			// 各自独立的路由树，不会触发 gin 的 static/wildcard 冲突 panic。
			auth.GET("/inspection/alert-rules", RequireAnyPermission("inspection:manage", "inspection:alert:view"), ListInspectionAlertRules)
			auth.GET("/inspection/alert-rules/catalog", RequireAnyPermission("inspection:manage", "inspection:alert:view"), InspectionAlertRuleCatalog)
			auth.POST("/inspection/alert-rules", RequireAnyPermission("inspection:manage", "inspection:alert:create"), CreateInspectionAlertRule)
			auth.POST("/inspection/alert-rules/preview", RequireAnyPermission("inspection:manage", "inspection:alert:view"), PreviewInspectionAlertRule)
			auth.PUT("/inspection/alert-rules/:id", RequireAnyPermission("inspection:manage", "inspection:alert:update"), UpdateInspectionAlertRule)
			auth.DELETE("/inspection/alert-rules/:id", RequireAnyPermission("inspection:manage", "inspection:alert:delete"), DeleteInspectionAlertRule)

			// 配置管理（nginx 配置文件等）：扫描虚拟机列表中的配置文件，在线编辑同步、增删改查
			auth.GET("/config", RequirePermission("config:view"), ListNginxConfigs)
			auth.GET("/config/scan/scope", RequirePermission("config:view"), ConfigScanScope)
			auth.POST("/config/scan", RequireAnyPermission("config:manage", "config:sync"), ScanNginxConfigs)
			auth.POST("/config/import", RequireAnyPermission("config:manage", "config:sync"), ImportNginxConfigs)
			auth.GET("/config/:id", RequirePermission("config:view"), GetNginxConfig)
			auth.POST("/config", RequirePermission("config:manage"), CreateNginxConfig)
			auth.PUT("/config/:id", RequirePermission("config:manage"), UpdateNginxConfig)
			auth.DELETE("/config/:id", RequirePermission("config:manage"), DeleteNginxConfig)
			auth.POST("/config/:id/pull", RequireAnyPermission("config:manage", "config:sync"), PullNginxConfig)
			auth.POST("/config/:id/sync", RequireAnyPermission("config:manage", "config:sync"), SyncNginxConfig)

			// 中间件管控：把「已部署好的中间件」变成可运维对象 ——
			// 进程存活检测 / 启停重启重载 / 配置文件在线管理与回滚。
			auth.GET("/mwops/profiles", RequirePermission("mwops:view"), ListMwOpsProfiles)
			auth.PUT("/mwops/profiles/:type", RequirePermission("mwops:manage"), UpdateMwOpsProfile)
			auth.GET("/mwops/instances", RequirePermission("mwops:view"), ListMwOpsInstances)
			auth.POST("/mwops/instances/sync-deploy", RequirePermission("mwops:manage"), SyncMwOpsFromDeploy)
			auth.POST("/mwops/instances/check-batch", RequireAnyPermission("mwops:view", "mwops:exec"), CheckMwOpsInstancesBatch)
			auth.POST("/mwops/instances", RequirePermission("mwops:manage"), CreateMwOpsInstance)
			auth.GET("/mwops/instances/:id", RequirePermission("mwops:view"), GetMwOpsInstance)
			auth.PUT("/mwops/instances/:id", RequirePermission("mwops:manage"), UpdateMwOpsInstance)
			auth.DELETE("/mwops/instances/:id", RequirePermission("mwops:manage"), DeleteMwOpsInstance)
			auth.POST("/mwops/instances/:id/check", RequirePermission("mwops:view"), CheckMwOpsInstance)
			auth.POST("/mwops/instances/:id/action", RequireAnyPermission("mwops:manage", "mwops:exec"), MwOpsInstanceAction)
			auth.POST("/mwops/instances/:id/kill", RequireAnyPermission("mwops:manage", "mwops:exec"), MwOpsInstanceKill)
			auth.GET("/mwops/instances/:id/configs", RequirePermission("mwops:view"), ListMwOpsConfigs)
			auth.GET("/mwops/instances/:id/config", RequirePermission("mwops:view"), GetMwOpsConfig)
			auth.POST("/mwops/instances/:id/config", RequirePermission("mwops:manage"), SaveMwOpsConfig)
			auth.POST("/mwops/instances/:id/config/restore", RequirePermission("mwops:manage"), RestoreMwOpsConfig)

			// 中间件捕捉：不预设机器上装了什么，只读扫描整机把存量中间件也捞出来
			// （nginx / php-fpm / java / redis / 宝兰德bws310 的版本、端口、安装位置、
			//  配置文件、日志、代码路径、证书），结果落库后可在资产列表与详情里展示。
			auth.GET("/mwcapture/assets", RequirePermission("mwcapture:view"), ListMwCaptureAssets)
			auth.GET("/mwcapture/export", RequirePermission("mwcapture:view"), ExportMwCaptures)
			auth.GET("/mwcapture/asset/:id", RequirePermission("mwcapture:view"), GetMwCapture)
			auth.POST("/mwcapture/run", RequirePermission("mwcapture:manage"), RunMwCapture)
			auth.PUT("/mwcapture/asset/:id", RequirePermission("mwcapture:manage"), UpdateMwCapture)
			auth.DELETE("/mwcapture/asset/:id", RequirePermission("mwcapture:manage"), DeleteMwCapture)

			// 定时任务（crontab 管理）：以「资产」为中心，直读直写目标机的 /etc/crontab
			// （读写统一以 root 身份，见 handler_crontab.go 的提权口径）。
			// 平台不存任务副本、也不写标记行 —— 机器上有什么就管什么，
			// 读到的即真实执行的，改完立即生效。
			// 用户自己的 `crontab -l`、/etc/cron.d/* 与 /etc/cron.{hourly,daily,...}/* 不再采集。
			// /crontab/scan 支持批量扫描所有资产（并发读取 + 单机超时 + TCP 预探测）。
			auth.GET("/crontab/assets", RequirePermission("crontab:view"), CrontabAssetList)
			auth.POST("/crontab/scan", RequirePermission("crontab:view"), ScanCrontabAssets)
			auth.GET("/crontab/asset/:id", RequirePermission("crontab:view"), GetAssetCrontab)
			auth.POST("/crontab/asset/:id/tasks", RequirePermission("crontab:manage"), CreateAssetCrontabTask)
			auth.PUT("/crontab/asset/:id/tasks", RequirePermission("crontab:manage"), UpdateAssetCrontabTask)
			auth.DELETE("/crontab/asset/:id/tasks", RequirePermission("crontab:manage"), DeleteAssetCrontabTask)
			auth.PUT("/crontab/asset/:id/raw", RequirePermission("crontab:manage"), SaveAssetCrontabRaw)
			auth.PUT("/crontab/asset/:id/notes", RequirePermission("crontab:manage"), SetCrontabTaskNote)

			// 脚本管理：Java 启停脚本
			// 读用 script:view，写/删用 script:manage；
			// host 形参叫「主机/资产」而不是「schedule target」，与现有 crontab 语义保持一致。
			auth.GET("/scripts/java/ls", RequirePermission("script:view"), ListScriptsEntry)
			auth.GET("/scripts/java/file", RequirePermission("script:view"), GetScriptFile)
			auth.PUT("/scripts/java/file", RequirePermission("script:manage"), PutScriptFile)
			auth.POST("/scripts/java/file", RequirePermission("script:manage"), PostScriptFile)
			auth.POST("/scripts/java/dir", RequirePermission("script:manage"), MakeScriptDir)
			auth.DELETE("/scripts/java/entry", RequirePermission("script:manage"), DeleteScriptEntry)

			// Prometheus 监控（v1.8.0 独立大类）：数据源管理 + 只读查询代理 +
			// 大屏聚合 + 月度/季度/年度报表。
			// 读接口用 prom:view（大屏专属账号补 prom:screen 进 any-of），
			// 数据源增删改用 prom:manage。
			auth.GET("/prom/datasources", RequireAnyPermission("prom:view", "prom:manage"), ListPromDataSources)
			auth.POST("/prom/datasources", RequirePermission("prom:manage"), CreatePromDataSource)
			auth.PUT("/prom/datasources/:id", RequirePermission("prom:manage"), UpdatePromDataSource)
			auth.DELETE("/prom/datasources/:id", RequirePermission("prom:manage"), DeletePromDataSource)
			auth.POST("/prom/datasources/:id/test", RequireAnyPermission("prom:view", "prom:manage"), TestPromDataSource)
			auth.GET("/prom/query", RequireAnyPermission("prom:view", "prom:screen"), PromProxyQuery)
			auth.GET("/prom/query_range", RequireAnyPermission("prom:view", "prom:screen"), PromProxyQueryRange)
			auth.GET("/prom/metric-names", RequireAnyPermission("prom:view", "prom:screen"), PromMetricNames)
			auth.GET("/prom/label/:name/values", RequireAnyPermission("prom:view", "prom:screen"), PromLabelValues)
			auth.GET("/prom/overview", RequireAnyPermission("prom:view", "prom:screen"), PromOverview)
			auth.GET("/prom/report", RequireAnyPermission("prom:view", "prom:screen"), PromReport)
			// v1.7.36：报告记录 —— 「生成报告」即归档，可回看 / 重新导出 / 删除
			auth.POST("/prom/reports/generate", RequireAnyPermission("prom:view", "prom:manage"), PromGenerateReport)
			auth.GET("/prom/reports", RequireAnyPermission("prom:view", "prom:screen"), PromListReports)
			auth.GET("/prom/reports/:id", RequireAnyPermission("prom:view", "prom:screen"), PromGetReport)
			auth.PUT("/prom/reports/:id", RequirePermission("prom:manage"), PromUpdateReport)
			auth.DELETE("/prom/reports/:id", RequirePermission("prom:manage"), PromDeleteReport)
			// v1.7.33：大屏改为「服务端定期采集 → 读快照」，并支持阈值/采集频率的集中管理
			auth.GET("/prom/screen-config", RequireAnyPermission("prom:view", "prom:manage"), PromGetScreenConfig)
			auth.PUT("/prom/screen-config", RequirePermission("prom:manage"), PromSaveScreenConfig)
			auth.GET("/prom/snapshot", RequireAnyPermission("prom:view", "prom:screen"), PromGetSnapshot)
			auth.POST("/prom/collect", RequireAnyPermission("prom:manage", "prom:view", "prom:screen"), PromCollectNow)
		}
	}

	// Prometheus 大屏定期采集（后台 goroutine：快照缓存 + 落库，大屏只读快照）
	promStartCollector()

	log.Printf("云枢 OpsHub 服务已启动，监听端口 :%s", Cfg.ServerPort)
	if err := r.Run(":" + Cfg.ServerPort); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
