package main

import (
	"encoding/json"
	"log"
	"os"

	"github.com/lib/pq"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/datatypes"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// DB 全局数据库句柄
var DB *gorm.DB

// RDB 全局 Redis 句柄
var RDB *redis.Client

// InitDB 初始化数据库连接、自动迁移并播种基础数据
func InitDB(cfg Config) {
	dsn := "host=" + cfg.DBHost + " port=" + cfg.DBPort + " user=" + cfg.DBUser +
		" password=" + cfg.DBPassword + " dbname=" + cfg.DBName + " sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("连接数据库失败: %v", err)
	}
	DB = db
	if err := db.AutoMigrate(&User{}, &Role{}, &Category{}, &Asset{}, &AnsibleRemote{}, &MwTemplate{}, &InspectionTask{}, &InspectionRecord{}, &InspectionResult{}, &InspectionAlertRule{}, &DeployCert{}, &DeployJob{}, &DeployMiddleware{}, &SysInitCatalog{}, &SysInitJob{}, &NginxConfig{}, &MwOpsProfile{}, &MwInstance{}, &CrontabTaskNote{}, &MwCapture{}, &SystemSetting{}, &PromDataSource{}, &PromScreenConfig{}, &PromScreenSnapshot{}, &PromReportRecord{}, &PromReportTemplate{}); err != nil {
		log.Fatalf("数据库迁移失败: %v", err)
	}
	seed()
	seedMwTemplates()
	normalizeMwTemplates()
	migrateAssetFieldKeys()
	SeedMiddleware()
	SyncMwOpsProfiles()
}

// normalizeMwTemplates 启动时幂等修正历史数据：
// 1) 将旧的大写类型名改为小写（MySQL/RabbitMQ/RocketMQ/Logstash/宝兰德BWS310，es→elasticsearch）
// 2) 设定各类型下拉顺序 order_no
// 3) 同步迁移资产里 中间件信息[].类型 的旧名 -> 新名，避免历史资产匹配不到模板
func normalizeMwTemplates() {
	renames := map[string]string{
		"MySQL":     "mysql",
		"RabbitMQ":  "rabbitmq",
		"RocketMQ":  "rocketmq",
		"Logstash":  "logstash",
		"宝兰德BWS310": "宝兰德bws310",
		"es":        "elasticsearch",
	}
	// 1) 重命名模板类型（带冲突保护，幂等）
	for old, neu := range renames {
		var c int64
		DB.Model(&MwTemplate{}).Where("type = ?", old).Count(&c)
		if c == 0 {
			continue
		}
		var c2 int64
		DB.Model(&MwTemplate{}).Where("type = ?", neu).Count(&c2)
		if c2 > 0 {
			DB.Where("type = ?", old).Delete(&MwTemplate{})
			continue
		}
		DB.Model(&MwTemplate{}).Where("type = ?", old).Update("type", neu)
	}
	// 2) 设定下拉顺序
	order := []string{
		"nginx", "宝兰德bws310", "jdk", "php", "redis", "mysql",
		"elasticsearch", "logstash", "kafka", "rocketmq", "rabbitmq", "其他",
	}
	for i, t := range order {
		DB.Model(&MwTemplate{}).Where("type = ?", t).Update("order_no", i+1)
	}
	// 3) 迁移资产中 中间件信息[].类型 的旧名 -> 新名
	var assets []Asset
	DB.Find(&assets)
	for _, a := range assets {
		var m map[string]interface{}
		if err := json.Unmarshal(a.Fields, &m); err != nil || m == nil {
			continue
		}
		raw, ok := m["中间件信息"]
		if !ok || raw == nil {
			continue
		}
		arr, ok := raw.([]interface{})
		if !ok {
			continue
		}
		changed := false
		for _, item := range arr {
			obj, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			for _, key := range []string{"类型", "type"} {
				if old, ok2 := obj[key].(string); ok2 {
					if nv, hit := renames[old]; hit {
						obj[key] = nv
						changed = true
					}
				}
			}
		}
		if changed {
			if b, err := json.Marshal(m); err == nil {
				a.Fields = datatypes.JSON(b)
				DB.Save(&a)
			}
		}
	}
}

// migrateAssetFieldKeys 启动时幂等迁移资产字段 key 的改名（历史数据兼容）。
// 字段改名后，若不同步迁移历史资产，旧 key 的数据将读不到，且在编辑保存时
// （前端按当前 schema 重建 fields）被整体丢弃。此处把旧 key 的值搬到新 key 并删除旧 key。
func migrateAssetFieldKeys() {
	renames := map[string]string{
		"系统盘":      "系统盘（GB）",
		"系统盘 (GB)": "系统盘（GB）",
		"系统盘(GB)":  "系统盘（GB）",
		"内存(GB)":   "内存（GB）",
		"项目规划资源使用量 - 内存(GB)": "项目规划资源使用量 - 内存（GB）",
		"已申请资源使用量 - 内存(GB)":  "已申请资源使用量 - 内存（GB）",
		"本次申请总量 - 内存(GB)":    "本次申请总量 - 内存（GB）",
	}
	var assets []Asset
	DB.Find(&assets)
	for _, a := range assets {
		var m map[string]interface{}
		if err := json.Unmarshal(a.Fields, &m); err != nil || m == nil {
			continue
		}
		changed := false
		for old, neu := range renames {
			v, ok := m[old]
			if !ok {
				continue
			}
			// 新 key 已存在则不覆盖，仅删除旧 key
			if _, exists := m[neu]; !exists {
				m[neu] = v
			}
			delete(m, old)
			changed = true
		}
		if changed {
			if b, err := json.Marshal(m); err == nil {
				a.Fields = datatypes.JSON(b)
				DB.Save(&a)
			}
		}
	}
}

// InitRedis 初始化 Redis
func InitRedis(cfg Config) {
	RDB = redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})
}

// seed 初始化角色、管理员账号与根分类
func seed() {
	// 角色
	adminRole := Role{}
	if err := DB.Where("code = ?", "admin").First(&adminRole).Error; err != nil {
		adminRole = Role{
			Name:        "超级管理员",
			Code:        "admin",
			Description: "拥有全部权限",
			Permissions: pq.StringArray(AllPermissionCodes()),
		}
		DB.Create(&adminRole)
	} else {
		// 兼容旧数据：补齐新增权限（如 ansible:manage）
		permSet := map[string]bool{}
		for _, p := range adminRole.Permissions {
			permSet[p] = true
		}
		changed := false
		for _, code := range AllPermissionCodes() {
			if !permSet[code] {
				adminRole.Permissions = append(adminRole.Permissions, code)
				changed = true
			}
		}
		if changed {
			DB.Save(&adminRole)
		}
	}
	memberRole := Role{}
	if err := DB.Where("code = ?", "member").First(&memberRole).Error; err != nil {
		memberRole = Role{
			Name:        "普通成员",
			Code:        "member",
			Description: "仅可查看资产",
			Permissions: pq.StringArray{"dashboard:view", "cmdb:view"},
		}
		DB.Create(&memberRole)
	}
	// 管理员账号
	var cnt int64
	DB.Model(&User{}).Where("username = ?", "admin").Count(&cnt)
	if cnt == 0 {
		hash, _ := bcrypt.GenerateFromPassword([]byte("admin123"), bcrypt.DefaultCost)
		enc, _ := encryptPassword("admin123")
		admin := User{
			Username:     "admin",
			PasswordHash: string(hash),
			PasswordEnc:  enc,
			Nickname:     "系统管理员",
			Status:       1,
			Roles:        []Role{adminRole},
		}
		DB.Create(&admin)
		log.Println("已创建默认管理员账号 admin / admin123，请及时修改密码")
	} else {
		// 兼容旧数据：若 admin 仍在使用默认密码却缺少可逆密文，补写一份，使「查看密码」开箱可用。
		// 仅当 bcrypt 校验确为默认密码时才写入 —— 绝不会为已改过密码的账号伪造明文。
		var adminUser User
		if DB.Where("username = ?", "admin").First(&adminUser).Error == nil &&
			adminUser.PasswordEnc == "" &&
			bcrypt.CompareHashAndPassword([]byte(adminUser.PasswordHash), []byte("admin123")) == nil {
			if enc, e := encryptPassword("admin123"); e == nil {
				DB.Model(&adminUser).Update("password_enc", enc)
				log.Println("已为默认管理员补写可查看密码记录（当前仍为默认密码，建议尽快修改）")
			}
		}
	}
	// 根分类
	var catCount int64
	DB.Model(&Category{}).Count(&catCount)
	if catCount == 0 {
		root := Category{Name: "全部资产", ParentID: nil, Level: 1, Path: "/0"}
		DB.Create(&root)
	}
	// 上传目录
	_ = os.MkdirAll(Cfg.UploadDir, 0o755)
}
