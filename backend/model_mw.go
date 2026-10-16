// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"log"
	"time"
)

// MwTemplate 中间件类型模板：每种中间件类型自带字段清单（含默认值/选项）
// 全局共享，新建/编辑任意资产时可直接套用默认值，实现「别的项目复用默认值」
type MwTemplate struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Type      string    `gorm:"size:128;uniqueIndex" json:"type"` // 类型名，小写，如 nginx / 宝兰德bws310
	Fields    string    `gorm:"type:text" json:"fields"`          // JSON 数组字符串
	OrderNo   int       `gorm:"default:0" json:"orderNo"`         // 下拉排序，越小越靠前
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// MwDepend 字段依赖显示条件（仅当依赖字段的值等于指定值时才显示该字段）
type MwDepend struct {
	Field string `json:"field"` // 依赖的字段名（label）
	Value string `json:"value"` // 等于该值时才显示
}

// MwField 模板中的一个字段定义
type MwField struct {
	Key       string    `json:"key"`                 // 存储 key（默认等于 label）
	Label     string    `json:"label"`               // 显示名
	Default   string    `json:"default,omitempty"`   // 默认值（新建/切换类型时套用）
	Options   []string  `json:"options,omitempty"`   // 下拉选项（为空则为文本输入）
	DependsOn *MwDepend `json:"dependsOn,omitempty"` // 依赖显示条件
}

// 内置中间件类型模板（仅在没有数据时播种，之后以数据库为准，可自由增删改）
// 类型名统一小写；es 更名为 elasticsearch。字段中文名保持原样（无大小写概念）。
var mwSeeds = map[string][]MwField{
	"nginx": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "1.28.3"},
		{Key: "配置文件路径", Label: "配置文件路径", Default: "/opt/servers/nginx/conf/nginx.conf"},
		{Key: "日志存放路径", Label: "日志存放路径", Default: "/opt/wwwlogs/"},
		{Key: "监听端口", Label: "监听端口", Default: ""},
		{Key: "关联的域名或虚拟主机", Label: "关联的域名或虚拟主机", Default: ""},
		{Key: "对应后端地址", Label: "对应后端地址", Default: ""},
		{Key: "是否有证书", Label: "是否有证书", Default: "", Options: []string{"是", "否"}},
		{Key: "证书存放路径", Label: "证书存放路径", Default: "", DependsOn: &MwDepend{Field: "是否有证书", Value: "是"}},
	},
	"宝兰德bws310": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "310"},
		{Key: "配置文件路径", Label: "配置文件路径", Default: "/data/BWS310/conf/bws.conf"},
		{Key: "日志存放路径", Label: "日志存放路径", Default: "/data/wwwlogs/"},
		{Key: "监听端口", Label: "监听端口", Default: ""},
		{Key: "关联的域名或虚拟主机", Label: "关联的域名或虚拟主机", Default: ""},
		{Key: "对应后端地址", Label: "对应后端地址", Default: ""},
		{Key: "是否有证书", Label: "是否有证书", Default: "", Options: []string{"是", "否"}},
		{Key: "证书存放路径", Label: "证书存放路径", Default: "/data/BWS310/ssl/", DependsOn: &MwDepend{Field: "是否有证书", Value: "是"}},
	},
	"jdk": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "1.8"},
	},
	"redis": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "7.0"},
		{Key: "端口", Label: "端口", Default: "6379"},
		{Key: "密码", Label: "密码", Default: ""},
		{Key: "最大内存限制", Label: "最大内存限制", Default: "2gb"},
		{Key: "是否持久化", Label: "是否持久化", Default: "", Options: []string{"是", "否"}},
		{Key: "配置文件路径", Label: "配置文件路径", Default: "/etc/redis/redis.conf"},
		{Key: "数据目录", Label: "数据目录", Default: "/var/lib/redis/"},
	},
	"php": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: ""},
		{Key: "安装路径", Label: "安装路径", Default: ""},
		{Key: "配置文件路径", Label: "配置文件路径", Default: ""},
		{Key: "端口", Label: "端口", Default: ""},
		{Key: "访问地址", Label: "访问地址", Default: ""},
		{Key: "密码", Label: "密码", Default: ""},
	},
	"mysql": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "8.0"},
		{Key: "端口", Label: "端口", Default: "3306"},
		{Key: "配置文件路径", Label: "配置文件路径", Default: "/etc/my.cnf"},
		{Key: "数据目录", Label: "数据目录", Default: "/var/lib/mysql/"},
		{Key: "日志路径", Label: "日志路径", Default: "/var/log/mysql/"},
		{Key: "字符集", Label: "字符集", Default: "utf8mb4", Options: []string{"utf8mb4", "utf8", "gbk"}},
		{Key: "最大连接数", Label: "最大连接数", Default: "151"},
		{Key: "运行模式", Label: "运行模式", Default: "单机", Options: []string{"单机", "主库", "从库"}},
		{Key: "管理员账号", Label: "管理员账号", Default: "root"},
		{Key: "管理员密码", Label: "管理员密码", Default: ""},
	},
	"elasticsearch": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: ""},
		{Key: "安装路径", Label: "安装路径", Default: ""},
		{Key: "配置文件路径", Label: "配置文件路径", Default: ""},
		{Key: "端口", Label: "端口", Default: "9200"},
		{Key: "集群名称", Label: "集群名称", Default: ""},
		{Key: "密码", Label: "密码", Default: ""},
	},
	"logstash": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "8.13"},
		{Key: "配置文件路径", Label: "配置文件路径", Default: "/etc/logstash/conf.d/"},
		{Key: "日志路径", Label: "日志路径", Default: "/var/log/logstash/"},
		{Key: "监听端口", Label: "监听端口", Default: "5044"},
		{Key: "输入来源", Label: "输入来源", Default: "Beats", Options: []string{"Beats", "Kafka", "File", "TCP"}},
		{Key: "输出目标", Label: "输出目标", Default: "Elasticsearch", Options: []string{"Elasticsearch", "Kafka", "File", "TCP"}},
	},
	"kafka": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: ""},
		{Key: "安装路径", Label: "安装路径", Default: ""},
		{Key: "配置文件路径", Label: "配置文件路径", Default: ""},
		{Key: "端口", Label: "端口", Default: "9092"},
		{Key: "Broker列表", Label: "Broker列表", Default: ""},
	},
	"rocketmq": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "5.1"},
		{Key: "NameServer端口", Label: "NameServer端口", Default: "9876"},
		{Key: "Broker端口", Label: "Broker端口", Default: "10911"},
		{Key: "配置文件路径", Label: "配置文件路径", Default: "/usr/local/rocketmq/conf/broker.conf"},
		{Key: "存储路径", Label: "存储路径", Default: "/usr/local/rocketmq/store/"},
		{Key: "日志路径", Label: "日志路径", Default: "/usr/local/rocketmq/logs/"},
		{Key: "角色", Label: "角色", Default: "Master", Options: []string{"Master", "Slave"}},
		{Key: "NameServer地址", Label: "NameServer地址", Default: ""},
	},
	"rabbitmq": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "版本号", Label: "版本号", Default: "3.12"},
		{Key: "端口", Label: "端口", Default: "5672"},
		{Key: "管理端口", Label: "管理端口", Default: "15672"},
		{Key: "配置文件路径", Label: "配置文件路径", Default: "/etc/rabbitmq/rabbitmq.conf"},
		{Key: "数据目录", Label: "数据目录", Default: "/var/lib/rabbitmq/"},
		{Key: "日志路径", Label: "日志路径", Default: "/var/log/rabbitmq/"},
		{Key: "默认账号", Label: "默认账号", Default: "guest"},
		{Key: "默认密码", Label: "默认密码", Default: ""},
		{Key: "Erlang Cookie", Label: "Erlang Cookie", Default: ""},
	},
	"其他": {
		{Key: "实例名称", Label: "实例名称", Default: ""},
		{Key: "关键信息", Label: "关键信息", Default: ""},
		{Key: "安装路径", Label: "安装路径", Default: ""},
		{Key: "配置文件路径", Label: "配置文件路径", Default: ""},
	},
}

// mwSeedOrder 定义中间件类型的下拉顺序（新建/编辑资产时按此排序展示）
var mwSeedOrder = []string{
	"nginx", "宝兰德bws310", "jdk", "php", "redis", "mysql",
	"elasticsearch", "logstash", "kafka", "rocketmq", "rabbitmq", "其他",
}

// seedMwTemplates 在中间件模板表为空时，按固定顺序播种内置类型模板
func seedMwTemplates() {
	var cnt int64
	DB.Model(&MwTemplate{}).Count(&cnt)
	if cnt > 0 {
		return
	}
	for i, t := range mwSeedOrder {
		fields, ok := mwSeeds[t]
		if !ok {
			continue
		}
		b, _ := json.Marshal(fields)
		if err := DB.Create(&MwTemplate{Type: t, Fields: string(b), OrderNo: i + 1}).Error; err != nil {
			log.Printf("中间件模板播种失败 %s: %v", t, err)
		}
	}
	log.Printf("已初始化中间件类型模板 %d 种", len(mwSeedOrder))
}
