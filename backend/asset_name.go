// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"strings"
)

// ---------------------------------------------------------------------------
// 资产展示名：全系统唯一口径
//
// 背景：此前平台里散落着 5 套互不相干的资产名拼法（Web 终端会话名、CMDB 列表名、
// 定时任务列表名、巡检大屏名、nginx 配置纳管名），且部分地方把名字复制一份存进
// 业务表当快照。结果用户在资产管理里改了字段，只有部分页面跟着变，看起来像
// 「不同步」。
//
// 约定：
//   1. 展示名一律实时由 Asset.Fields 计算，**任何表都不再存名字快照**；
//   2. 口径固定在 assetDisplayKeys，改动必须同步改 frontend/src/utils/assetName.ts；
//   3. 空段跳过（避免出现 "A__B" 这种空洞），全空时回退「虚拟机名称」→ 资产名。
// ---------------------------------------------------------------------------

// assetDisplayKeys 展示名各段对应的 CMDB 字段（顺序即拼接顺序，末尾再补 IP）
var assetDisplayKeys = []string{"项目简称", "环境", "业务环境"}

// AssetDisplayName 资产的统一展示名：项目简称_环境_业务环境_虚拟机IPv4
func AssetDisplayName(a *Asset) string {
	if a == nil {
		return ""
	}
	fields := map[string]interface{}{}
	if len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
	}
	return AssetDisplayNameOf(fields, a.IP, a.Name)
}

// AssetDisplayNameOf 由已解析的 fields 计算展示名（批量场景避免反复 unmarshal）
func AssetDisplayNameOf(fields map[string]interface{}, fallbackIP, fallbackName string) string {
	parts := make([]string, 0, 4)
	for _, k := range assetDisplayKeys {
		if s := strings.TrimSpace(toStr(fields[k])); s != "" {
			parts = append(parts, s)
		}
	}
	if ip := strings.TrimSpace(toStr(fields["虚拟机IPv4"])); ip != "" {
		parts = append(parts, ip)
	} else if ip := strings.TrimSpace(fallbackIP); ip != "" {
		parts = append(parts, ip)
	}
	if len(parts) > 0 {
		return strings.Join(parts, "_")
	}
	// 兜底链：虚拟机名称 → 应用系统名称 → 资产名（覆盖部署向导等原先各自实现的回退）
	for _, k := range []string{"虚拟机名称", "应用系统名称"} {
		if n := strings.TrimSpace(toStr(fields[k])); n != "" {
			return n
		}
	}
	return strings.TrimSpace(fallbackName)
}

// AssetShortDisplayName 短名：项目简称_环境_业务环境（不带 IP）。
// 巡检大屏一行要放很多主机，IP 另有列展示，故单独提供不带 IP 的版本。
func AssetShortDisplayName(fields map[string]interface{}, fallback string) string {
	parts := make([]string, 0, 3)
	for _, k := range assetDisplayKeys {
		if s := strings.TrimSpace(toStr(fields[k])); s != "" {
			parts = append(parts, s)
		}
	}
	if len(parts) == 0 {
		return strings.TrimSpace(fallback)
	}
	return strings.Join(parts, "_")
}

// AssetVMName CMDB「虚拟机名称」原文（云主机名，作为副标题 / 兜底展示）
func AssetVMName(a *Asset) string {
	if a == nil {
		return ""
	}
	fields := map[string]interface{}{}
	if len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
	}
	if n := strings.TrimSpace(toStr(fields["虚拟机名称"])); n != "" {
		return n
	}
	return strings.TrimSpace(a.Name)
}

// assetDisplayNameByID 按 ID 实时取展示名（历史记录需要用「当前资产名」覆盖旧快照时调用）
func assetDisplayNameByID(id uint) string {
	if id == 0 {
		return ""
	}
	var a Asset
	if err := DB.Select("id", "name", "ip", "fields").First(&a, id).Error; err != nil {
		return ""
	}
	return AssetDisplayName(&a)
}

// InvalidateAssetDerivedCaches 资产信息变更后清理所有「派生自资产」的进程内缓存。
//
// 不清理的后果：定时任务等页面用的是带展示名的缓存视图，资产改名后 15 秒内
// 仍返回旧名，用户就会看到「改了资产但名字没变」。
// 批量场景请逐个资产调用（缓存按资产 ID 维度存放）。
func InvalidateAssetDerivedCaches(assetID uint) {
	crontabViewInvalidate(assetID)
}

// InvalidateAllAssetDerivedCaches 全量清理（Excel 导入等批量变更，影响面不确定时调用）
func InvalidateAllAssetDerivedCaches() {
	crontabViewInvalidateAll()
}

// assetIDsByDisplayName 按「当前展示名」模糊匹配资产 ID。
// 历史表里存的是旧快照，用户改用新名字搜索时 SQL 匹配不到，故需额外按当前名反查。
func assetIDsByDisplayName(keyword string) []uint {
	kw := strings.TrimSpace(keyword)
	if kw == "" {
		return nil
	}
	var list []Asset
	if err := DB.Select("id", "name", "ip", "fields").Find(&list).Error; err != nil {
		return nil
	}
	ids := make([]uint, 0, 8)
	for i := range list {
		if strings.Contains(AssetDisplayName(&list[i]), kw) {
			ids = append(ids, list[i].ID)
		}
	}
	return ids
}

// refreshAssetNameSnapshots 把一批历史记录的展示名刷新为资产当前值。
// ids 为「记录下标 -> 资产ID」的映射返回器，用闭包是为了适配不同表的结果集。
func refreshAssetNameSnapshots(n int, assetID func(i int) uint, setName func(i int, name string)) {
	if n <= 0 {
		return
	}
	// 先收集去重的资产 ID，一次查完，避免 N+1
	ids := make([]uint, 0, n)
	seen := map[uint]bool{}
	for i := 0; i < n; i++ {
		if id := assetID(i); id != 0 && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return
	}
	var list []Asset
	if err := DB.Select("id", "name", "ip", "fields").Where("id IN ?", ids).Find(&list).Error; err != nil {
		return
	}
	nameOf := make(map[uint]string, len(list))
	for i := range list {
		nameOf[list[i].ID] = AssetDisplayName(&list[i])
	}
	for i := 0; i < n; i++ {
		if name, ok := nameOf[assetID(i)]; ok && name != "" {
			setName(i, name)
		}
	}
}
