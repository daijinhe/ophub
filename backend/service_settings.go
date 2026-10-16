// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

// ============================================================================
// 全局 KV 配置（SystemSetting）
//
// 用途：把「页面可改、且要全平台生效」的开关持久化到数据库，避免每次改都要
// 动 .env + 重建容器。首个使用者是「平台 ansible 采集通道模式」（v1.7.15）。
//
// 约定：
//   - Key 用点分层级命名（如 ansible.runner.mode），便于以后扩展
//   - Value 一律存字符串，调用方自己解析/校验
//   - 读走 getSetting（10s 缓存，避免采集热路径每次查库）；写走 setSetting
//     （写完立即失效缓存，保证设置页面马上能看到新值）
// ============================================================================

import (
	"errors"
	"log"
	"sync"
	"time"

	"gorm.io/gorm/clause"
)

// errNoDB 数据库尚未初始化（InitDB 之前被调用）
var errNoDB = errors.New("数据库未初始化")

// SystemSetting 全局 KV 配置项
type SystemSetting struct {
	Key       string    `gorm:"primaryKey;size:64" json:"key"`
	Value     string    `gorm:"size:1024" json:"value"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// settingCache getSetting 的短 TTL 缓存（采集类调用极频繁，不能每次查库）
var (
	settingCacheMu   sync.Mutex
	settingCacheData = map[string]string{}
	settingCacheAt   time.Time
)

const settingCacheTTL = 10 * time.Second

// getSetting 读配置项；不存在或 DB 异常时返回 def。
func getSetting(key, def string) string {
	settingCacheMu.Lock()
	defer settingCacheMu.Unlock()
	if time.Since(settingCacheAt) < settingCacheTTL {
		if v, ok := settingCacheData[key]; ok {
			return v
		}
	}
	// 缓存过期：整表刷新（配置项数量极少，一次查完更省心）
	fresh := map[string]string{}
	if DB != nil {
		var rows []SystemSetting
		if err := DB.Find(&rows).Error; err != nil {
			log.Printf("读取系统配置失败（按默认值 %s=%s 处理）：%v", key, def, err)
		} else {
			for _, r := range rows {
				fresh[r.Key] = r.Value
			}
		}
	}
	settingCacheData = fresh
	settingCacheAt = time.Now()
	if v, ok := fresh[key]; ok {
		return v
	}
	return def
}

// setSetting 写配置项（Upsert），写完立即失效缓存。
func setSetting(key, value string) error {
	if DB == nil {
		return errNoDB
	}
	err := DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&SystemSetting{Key: key, Value: value}).Error
	if err != nil {
		return err
	}
	settingCacheMu.Lock()
	settingCacheData[key] = value
	settingCacheMu.Unlock()
	return nil
}
