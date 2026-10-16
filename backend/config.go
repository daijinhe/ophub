// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"strconv"
)

// Config 运行时配置（来自环境变量，便于 docker-compose 覆盖）。
// PwdEncKey 为用户密码「可查看」所用的可逆加密密钥（AES-256，任意长度经 SHA-256 派生）；
// 留空时使用内置默认值（便于开箱即用），生产环境建议显式配置并妥善保管。
type Config struct {
	ServerPort     string
	DBHost         string
	DBPort         string
	DBUser         string
	DBPassword     string
	DBName         string
	RedisAddr      string
	RedisPassword  string
	RedisDB        int
	JWTSecret      string
	JWTTTL         int // 分钟
	PwdEncKey      string
	AllowOrigins   string
	UploadDir      string
	Env            string
	AnsibleHosts   string
	DeployBase     string // 控制节点上离线中间件安装包根目录（<DeployBase>/<subDir>/files/）
	SystemInitDir  string // 控制节点上系统初始化 playbook 根目录（<SystemInitDir>/<任务目录>/<任务>.yml）
	GaussDBInitDir string // 控制节点上 GaussDB 初始化 playbook 根目录（对应 Jenkins 的 GAUSSDB_CHOICE_DIR）
	// Ansible 接入方式：platform（平台自建临时 inventory，默认）| group（先调用控制节点上的
	// ansible_host_manager.py 生成「<项目名>-应用安装」主机组，再以 -e hosts=<组名> 执行，等价 Jenkins）。
	DeployInventoryMode string
	AnsibleHostManager  string // 组模式下控制节点上 ansible_host_manager.py 的绝对路径（空=按 CDIR 推导）
	// 邮件通知（可选；留空则仅站内信）
	SMTPHost string
	SMTPPort int
	SMTPUser string
	SMTPPass string
	SMTPFrom string
}

// Cfg 全局配置
var Cfg Config

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// LoadConfig 从环境变量加载配置
func LoadConfig() Config {
	ttl, _ := strconv.Atoi(getEnv("JWT_TTL", "720"))
	rdb, _ := strconv.Atoi(getEnv("REDIS_DB", "0"))
	smtpPort, _ := strconv.Atoi(getEnv("SMTP_PORT", "25"))
	return Config{
		ServerPort:          getEnv("SERVER_PORT", "8080"),
		DBHost:              getEnv("DB_HOST", "postgres"),
		DBPort:              getEnv("DB_PORT", "5432"),
		DBUser:              getEnv("DB_USER", "ophub"),
		DBPassword:          getEnv("DB_PASSWORD", "ophub123"),
		DBName:              getEnv("DB_NAME", "ophub"),
		RedisAddr:           getEnv("REDIS_ADDR", "redis:6379"),
		RedisPassword:       getEnv("REDIS_PASSWORD", ""),
		RedisDB:             rdb,
		JWTSecret:           getEnv("JWT_SECRET", "ophub-secret-change-me"),
		JWTTTL:              ttl,
		PwdEncKey:           getEnv("PWD_ENC_KEY", ""),
		AllowOrigins:        getEnv("ALLOW_ORIGINS", "*"),
		UploadDir:           getEnv("UPLOAD_DIR", "./uploads"),
		Env:                 getEnv("ENV", "dev"),
		AnsibleHosts:        getEnv("ANSIBLE_HOSTS", "/etc/ansible/hosts"),
		DeployBase:          getEnv("DEPLOY_BASE", "/data/jenkins_home/scripts/V2_Project_App_Init_Install/main/app_choice"),
		SystemInitDir:       getEnv("SYSTEM_INIT_DIR", "/data/jenkins_home/scripts/V2_Project_App_Init_Install/main/system_init"),
		GaussDBInitDir:      getEnv("GAUSSDB_INIT_DIR", "/data/jenkins_home/scripts/V2_Project_App_Init_Install/main/gaussDB_init"),
		DeployInventoryMode: getEnv("DEPLOY_INVENTORY_MODE", "platform"),
		AnsibleHostManager:  getEnv("ANSIBLE_HOST_MANAGER", ""),
		SMTPHost:            getEnv("SMTP_HOST", ""),
		SMTPPort:            smtpPort,
		SMTPUser:            getEnv("SMTP_USER", ""),
		SMTPPass:            getEnv("SMTP_PASS", ""),
		SMTPFrom:            getEnv("SMTP_FROM", getEnv("SMTP_USER", "")),
	}
}
