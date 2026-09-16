package main

import (
	"log"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// main 服务入口
func main() {
	Cfg = LoadConfig()
	initPwdCipher() // 初始化用户密码可逆加密（须在 InitDB 播种之前）
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
		api.POST("/auth/register", Register)
		api.POST("/auth/login", Login)
		api.GET("/fields", GetFields)
		// WebSocket SSH 终端（handler 内自行用 query token 鉴权）
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

			auth.GET("/categories", RequirePermission("cmdb:view"), GetCategoryTree)
			auth.POST("/categories", RequirePermission("category:manage"), CreateCategory)
			auth.PUT("/categories/:id", RequirePermission("category:manage"), UpdateCategory)
			auth.DELETE("/categories/:id", RequirePermission("category:manage"), DeleteCategory)

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
			auth.GET("/mw/templates", ListMwTemplates)
			auth.PUT("/mw/templates/:type", RequirePermission("cmdb:update"), UpsertMwTemplate)
			auth.DELETE("/mw/templates/:type", RequirePermission("cmdb:update"), DeleteMwTemplate)

			auth.GET("/ansible", RequirePermission("ansible:manage"), GetAnsibleHosts)
			auth.PUT("/ansible", RequirePermission("ansible:manage"), SaveAnsibleHosts)
			auth.GET("/ansible/raw", RequirePermission("ansible:manage"), RawAnsibleHosts)
			auth.POST("/ansible/raw", RequirePermission("ansible:manage"), RawAnsibleHosts)
			auth.POST("/ansible/import-cmdb", RequirePermission("ansible:manage"), ImportAnsibleFromCMDB)
			auth.GET("/ansible/cmdb-assets", RequirePermission("ansible:manage"), CmdbAssets)

			// 远程 Ansible 节点
			auth.GET("/ansible/remotes", RequirePermission("ansible:manage"), ListAnsibleRemotes)
			auth.POST("/ansible/remotes", RequirePermission("ansible:manage"), CreateAnsibleRemote)
			auth.GET("/ansible/remotes/:id", RequirePermission("ansible:manage"), GetAnsibleRemote)
			auth.PUT("/ansible/remotes/:id", RequirePermission("ansible:manage"), UpdateAnsibleRemote)
			auth.DELETE("/ansible/remotes/:id", RequirePermission("ansible:manage"), DeleteAnsibleRemote)
			auth.POST("/ansible/remotes/:id/test", RequirePermission("ansible:manage"), TestAnsibleRemote)
			auth.GET("/ansible/remotes/:id/info", RequirePermission("ansible:manage"), GetAnsibleRemoteInfo)
			auth.GET("/ansible/remotes/:id/hosts", RequirePermission("ansible:manage"), GetRemoteHosts)
			auth.PUT("/ansible/remotes/:id/hosts", RequirePermission("ansible:manage"), SaveRemoteHosts)
			auth.GET("/ansible/remotes/:id/hosts/raw", RequirePermission("ansible:manage"), GetRemoteHostsRaw)
			auth.POST("/ansible/remotes/:id/hosts/raw", RequirePermission("ansible:manage"), SaveRemoteHostsRaw)
			auth.POST("/ansible/remotes/:id/import-cmdb", RequirePermission("ansible:manage"), ImportCMDBToRemote)
			auth.POST("/ansible/remotes/:id/exec", RequirePermission("ansible:manage"), ExecRemoteCommand)

			// 应用中间件安装（离线 ansible 部署）
			auth.GET("/deploy/catalog", RequirePermission("deploy:manage"), ListDeployCatalog)
			auth.POST("/deploy/detect", RequirePermission("deploy:manage"), DetectTargets)
			auth.GET("/deploy/middlewares", RequirePermission("deploy:manage"), ListDeployMiddlewares)
			auth.GET("/deploy/middlewares/:id", RequirePermission("deploy:manage"), GetDeployMiddleware)
			auth.POST("/deploy/middlewares", RequirePermission("deploy:manage"), CreateDeployMiddleware)
			auth.PUT("/deploy/middlewares/:id", RequirePermission("deploy:manage"), UpdateDeployMiddleware)
			auth.DELETE("/deploy/middlewares/:id", RequirePermission("deploy:manage"), DeleteDeployMiddleware)
			auth.GET("/deploy/certs", RequirePermission("deploy:manage"), ListDeployCerts)
			auth.GET("/deploy/certs/summary", RequirePermission("deploy:manage"), DeployCertSummary)
			auth.GET("/deploy/certs/:id", RequirePermission("deploy:manage"), GetDeployCert)
			auth.POST("/deploy/certs", RequirePermission("deploy:manage"), CreateDeployCert)
			auth.POST("/deploy/certs/upload", RequirePermission("deploy:manage"), UploadDeployCert)
			auth.PUT("/deploy/certs/:id", RequirePermission("deploy:manage"), UpdateDeployCert)
			auth.DELETE("/deploy/certs/:id", RequirePermission("deploy:manage"), DeleteDeployCert)
			auth.POST("/deploy/run", RequirePermission("deploy:manage"), DeployRun)
			auth.GET("/deploy/jobs", RequirePermission("deploy:manage"), ListDeployJobs)
			auth.POST("/deploy/jobs/:id/rerun", RequirePermission("deploy:manage"), RerunDeployJob)
			auth.GET("/deploy/jobs/:id", RequirePermission("deploy:manage"), GetDeployJob)

			// 系统初始化（复用既有 ansible playbook）
			auth.GET("/deploy/sysinit/options", RequirePermission("deploy:manage"), SysInitOptions)
			auth.POST("/deploy/sysinit", RequirePermission("deploy:manage"), CreateSysInitJob)
			auth.GET("/deploy/sysinit", RequirePermission("deploy:manage"), ListSysInitJobs)
			auth.GET("/deploy/sysinit/:id", RequirePermission("deploy:manage"), GetSysInitJob)
			auth.POST("/deploy/sysinit/detect", RequirePermission("deploy:manage"), DetectSysInitEnv)

			// 系统初始化管理（目录可自定义，页面维护初始化选项）
			auth.GET("/deploy/sysinit/catalog", RequirePermission("deploy:manage"), ListSysInitCatalog)
			auth.POST("/deploy/sysinit/catalog", RequirePermission("deploy:manage"), CreateSysInitCatalog)
			auth.POST("/deploy/sysinit/catalog/sync", RequirePermission("deploy:manage"), SyncSysInitCatalogAPI)
			auth.GET("/deploy/sysinit/catalog/playbooks", RequirePermission("deploy:manage"), ListSysInitPlaybooks)
			auth.POST("/deploy/sysinit/catalog/check", RequirePermission("deploy:manage"), CheckSysInitPlaybook)
			auth.PUT("/deploy/sysinit/catalog/:id", RequirePermission("deploy:manage"), UpdateSysInitCatalog)
			auth.DELETE("/deploy/sysinit/catalog/:id", RequirePermission("deploy:manage"), DeleteSysInitCatalog)
			auth.PATCH("/deploy/sysinit/catalog/:id/enabled", RequirePermission("deploy:manage"), ToggleSysInitCatalog)

			// 智能巡检
			auth.GET("/inspection/metrics", RequireAnyPermission("inspection:view", "inspection:manage", "inspection:screen"), InspectionMetricCatalog)
			auth.DELETE("/inspection/tasks/batch", RequirePermission("inspection:manage"), BatchDeleteInspectionTasks)
			auth.GET("/inspection/tasks", RequirePermission("inspection:view"), ListInspectionTasks)
			auth.POST("/inspection/tasks", RequirePermission("inspection:manage"), CreateInspectionTask)
			auth.PUT("/inspection/tasks/:id", RequirePermission("inspection:manage"), UpdateInspectionTask)
			auth.DELETE("/inspection/tasks/:id", RequirePermission("inspection:manage"), DeleteInspectionTask)
			auth.POST("/inspection/tasks/:id/run", RequirePermission("inspection:manage"), RunInspectionTask)
			auth.GET("/inspection/records", RequirePermission("inspection:view"), ListInspectionRecords)
			auth.GET("/inspection/records/:id", RequirePermission("inspection:view"), GetInspectionRecord)
			auth.DELETE("/inspection/records", RequirePermission("inspection:manage"), BatchDeleteInspectionRecords)
			auth.GET("/inspection/results", RequirePermission("inspection:view"), ListInspectionResults)
			auth.GET("/inspection/dashboard", RequireAnyPermission("inspection:view", "inspection:screen"), InspectionDashboard)
			auth.GET("/inspection/export", RequirePermission("inspection:view"), InspectionExport)

			// 巡检告警规则：按「项目简称 / 应用系统名称 / 指定资产」自定义阈值与屏蔽告警
			// 说明：GET/POST 下挂静态子路径 catalog/preview，PUT/DELETE 才用 :id，
			// 各自独立的路由树，不会触发 gin 的 static/wildcard 冲突 panic。
			auth.GET("/inspection/alert-rules", RequirePermission("inspection:manage"), ListInspectionAlertRules)
			auth.GET("/inspection/alert-rules/catalog", RequirePermission("inspection:manage"), InspectionAlertRuleCatalog)
			auth.POST("/inspection/alert-rules", RequirePermission("inspection:manage"), CreateInspectionAlertRule)
			auth.POST("/inspection/alert-rules/preview", RequirePermission("inspection:manage"), PreviewInspectionAlertRule)
			auth.PUT("/inspection/alert-rules/:id", RequirePermission("inspection:manage"), UpdateInspectionAlertRule)
			auth.DELETE("/inspection/alert-rules/:id", RequirePermission("inspection:manage"), DeleteInspectionAlertRule)

			// 配置管理（nginx 配置文件等）：扫描虚拟机列表中的配置文件，在线编辑同步、增删改查
			auth.GET("/config", RequirePermission("config:view"), ListNginxConfigs)
			auth.GET("/config/scan/scope", RequirePermission("config:view"), ConfigScanScope)
			auth.POST("/config/scan", RequirePermission("config:manage"), ScanNginxConfigs)
			auth.POST("/config/import", RequirePermission("config:manage"), ImportNginxConfigs)
			auth.GET("/config/:id", RequirePermission("config:view"), GetNginxConfig)
			auth.POST("/config", RequirePermission("config:manage"), CreateNginxConfig)
			auth.PUT("/config/:id", RequirePermission("config:manage"), UpdateNginxConfig)
			auth.DELETE("/config/:id", RequirePermission("config:manage"), DeleteNginxConfig)
			auth.POST("/config/:id/pull", RequirePermission("config:manage"), PullNginxConfig)
			auth.POST("/config/:id/sync", RequirePermission("config:manage"), SyncNginxConfig)

			// 中间件管控：把「已部署好的中间件」变成可运维对象 ——
			// 进程存活检测 / 启停重启重载 / 配置文件在线管理与回滚。
			auth.GET("/mwops/profiles", RequirePermission("mwops:view"), ListMwOpsProfiles)
			auth.PUT("/mwops/profiles/:type", RequirePermission("mwops:manage"), UpdateMwOpsProfile)
			auth.GET("/mwops/instances", RequirePermission("mwops:view"), ListMwOpsInstances)
			auth.POST("/mwops/instances/sync-deploy", RequirePermission("mwops:manage"), SyncMwOpsFromDeploy)
			auth.POST("/mwops/instances/check-batch", RequirePermission("mwops:view"), CheckMwOpsInstancesBatch)
			auth.POST("/mwops/instances", RequirePermission("mwops:manage"), CreateMwOpsInstance)
			auth.GET("/mwops/instances/:id", RequirePermission("mwops:view"), GetMwOpsInstance)
			auth.PUT("/mwops/instances/:id", RequirePermission("mwops:manage"), UpdateMwOpsInstance)
			auth.DELETE("/mwops/instances/:id", RequirePermission("mwops:manage"), DeleteMwOpsInstance)
			auth.POST("/mwops/instances/:id/check", RequirePermission("mwops:view"), CheckMwOpsInstance)
			auth.POST("/mwops/instances/:id/action", RequirePermission("mwops:manage"), MwOpsInstanceAction)
			auth.POST("/mwops/instances/:id/kill", RequirePermission("mwops:manage"), MwOpsInstanceKill)
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
		}
	}

	log.Printf("云枢 OpsHub 服务已启动，监听端口 :%s", Cfg.ServerPort)
	if err := r.Run(":" + Cfg.ServerPort); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
