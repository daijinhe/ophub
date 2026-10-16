// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

//
// 登录限流 + 账户锁定 + 密码策略（v1.7.1+）
//
// 工具函数集中于此供 Login/ChangeMyPassword/ResetUserPassword 等调用：
//   - LoginRateLimitCheck  校验是否仍在锁定窗口内；命中 → 返回错误 + 剩余秒数
//   - RecordLoginFailure   累计 IP / 账号失败次数；阈值到 → 锁定 10 分钟
//   - RecordLoginSuccess   清零失败计数
//   - validatePasswordStrength  强密码校验（≥10 位，含 2 类字符）
//
// 设计权衡：
//   - Redis 不可用时 fail-open：仅打 warning，不阻断登录（运维场景 Redis 挂了不能锁死账号）。
//   - 限流粒度：IP+账号双维度。IP 维度防爆破；账号维度防单账号被定向爆破。
//   - 锁定窗口：失败 5 次锁 10 分钟；admin 失败 1 次就给运维发邮件（v1.7.2 follow-up）。
//

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

// 失败阈值：达到 N 次后锁定。
const (
	loginMaxFailures     = 5
	loginLockoutDuration = 10 * time.Minute
)

// shortCtx 给 Redis 调用一个统一短超时，避免 Redis 卡死时把登录请求整个拖挂。
// 调用方必须 defer cancel()。
func shortCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 3*time.Second)
}

func loginCountersKey(scope, ident string) string {
	return "login:fail:" + scope + ":" + ident
}

func loginLockKey(scope, ident string) string {
	return "login:lock:" + scope + ":" + ident
}

func loginCounterTTL() time.Duration { return 30 * time.Minute }

// bumpLoginFailure Redis 不可用时按 fail-open 处理：只 log warning，不阻断。
func bumpLoginFailure(scope, ident string) (count int64, locked bool) {
	if RDB == nil || strings.TrimSpace(ident) == "" {
		return 0, false
	}
	ctx, cancel := shortCtx()
	defer cancel()
	k := loginCountersKey(scope, ident)
	n, err := RDB.Incr(ctx, k).Result()
	if err != nil {
		log.Printf("[rate-limit] redis INCR %s 失败：%v（fail-open）", k, err)
		return 0, false
	}
	if n == 1 {
		RDB.Expire(ctx, k, loginCounterTTL())
	}
	if n >= loginMaxFailures {
		RDB.Set(ctx, loginLockKey(scope, ident), "1", loginLockoutDuration)
		return n, true
	}
	return n, false
}

// LoginRateLimitCheck 在尝试登录前调用：返回 nil 表示不在锁定期；否则返回错误。
func LoginRateLimitCheck(ip, username string) error {
	if RDB == nil {
		return nil
	}
	ctx, cancel := shortCtx()
	defer cancel()
	if ip != "" {
		if exists, _ := RDB.Exists(ctx, loginLockKey("ip", ip)).Result(); exists > 0 {
			return fmt.Errorf("登录尝试超限，请稍后再试（IP 维度已锁定 %d 分钟）", int(loginLockoutDuration.Minutes()))
		}
	}
	if username != "" {
		if exists, _ := RDB.Exists(ctx, loginLockKey("user", strings.ToLower(username))).Result(); exists > 0 {
			return fmt.Errorf("账号已被临时锁定（10 分钟内失败次数过多），请稍后再试")
		}
	}
	return nil
}

// RecordLoginFailure 失败计数 + 锁定；返回新的失败次数与是否已锁定。
func RecordLoginFailure(ip, username string) (count int64, locked bool) {
	if ip != "" {
		c, l := bumpLoginFailure("ip", ip)
		if c > count {
			count = c
		}
		if l {
			locked = true
		}
	}
	if username != "" {
		c, l := bumpLoginFailure("user", strings.ToLower(username))
		if c > count {
			count = c
		}
		if l {
			locked = true
		}
	}
	return
}

// RecordLoginSuccess 清零失败计数（登录成功后）。
func RecordLoginSuccess(ip, username string) {
	if RDB == nil {
		return
	}
	ctx, cancel := shortCtx()
	defer cancel()
	if ip != "" {
		RDB.Del(ctx, loginCountersKey("ip", ip))
	}
	if username != "" {
		RDB.Del(ctx, loginCountersKey("user", strings.ToLower(username)))
	}
}

// validatePasswordStrength 强密码：≥10 位 + 至少 2 类字符（数字 / 字母 / 符号）。
// 0 = 数字类字符数；1 = 字母类字符数；2 = 符号类字符数。
func validatePasswordStrength(p string) error {
	if len(p) < 10 {
		return errors.New("密码长度至少 10 位")
	}
	hasDigit, hasLetter, hasSymbol := false, false, false
	for _, r := range p {
		switch {
		case r >= '0' && r <= '9':
			hasDigit = true
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			hasLetter = true
		default:
			hasSymbol = true
		}
	}
	classes := 0
	if hasDigit {
		classes++
	}
	if hasLetter {
		classes++
	}
	if hasSymbol {
		classes++
	}
	if classes < 2 {
		return errors.New("密码需包含两类字符（数字 / 字母 / 符号）")
	}
	return nil
}
