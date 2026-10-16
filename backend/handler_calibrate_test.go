// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"testing"
)

// 资源校准「操作系统版本」口径（2026-09-16 用户要求）：
// 取 /etc/os-release 的 ID + VERSION_ID 拼接值，例如 AlmaLinux 8.9 → almalinux8.9。
// 发行版全名（PRETTY_NAME）只放进 Raw 作展示，不写入资产。
func TestBuildCalibItemsOSValue(t *testing.T) {
	cases := []struct {
		name    string
		osText  string
		relText string // /etc/centos-release 等发行版版本文件
		want    string // 期望写入资产的「操作系统版本」
		wantTok string // 期望 mapOsType 能识别出的中间件部署令牌（空=不在令牌表内）
	}{
		{
			name: "almalinux8.9",
			osText: `NAME="AlmaLinux"
VERSION="8.9 (Midnight Oncilla)"
ID="almalinux"
ID_LIKE="rhel centos fedora"
VERSION_ID="8.9"
PRETTY_NAME="AlmaLinux 8.9 (Midnight Oncilla)"
HOME_URL="https://almalinux.org/"
`,
			want:    "almalinux8.9",
			wantTok: "almalinux8.9",
		},
		{
			name: "huawei-hce2.0",
			osText: `NAME="Huawei Cloud EulerOS"
VERSION="2.0 (aarch64)"
ID="hce"
VERSION_ID="2.0"
PRETTY_NAME="Huawei Cloud EulerOS 2.0 (aarch64)"
`,
			want:    "hce2.0",
			wantTok: "hce2.0",
		},
		{
			// VERSION_ID 只有主版本号：写入的就是 "7"（严格 ID+VERSION_ID），
			// 不得被 /etc/centos-release 的 7.9.2009 补成 centos7.9
			name: "centos7",
			osText: `NAME="CentOS Linux"
VERSION="7 (Core)"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="7"
PRETTY_NAME="CentOS Linux 7 (Core)"
`,
			relText: "CentOS Linux release 7.9.2009 (Core)",
			want:    "centos7",
			wantTok: "centos7",
		},
		{
			name: "kylinV10",
			osText: `NAME="Kylin Linux Advanced Server"
VERSION="V10 (Sword)"
ID="kylin"
VERSION_ID="V10"
PRETTY_NAME="Kylin Linux Advanced Server V10 (Sword)"
`,
			want:    "kylinV10",
			wantTok: "kylinV10",
		},
		{
			name: "openEuler22.03",
			osText: `NAME="openEuler"
VERSION="22.03 (LTS-SP3)"
ID="openEuler"
VERSION_ID="22.03"
PRETTY_NAME="openEuler 22.03 (LTS-SP3)"
`,
			want:    "openEuler22.03",
			wantTok: "openEuler22.03",
		},
		{
			// VERSION_ID 缺失 → 回退 VERSION 的版本号段（丢掉 "(LTS-SP3)" 描述）
			name: "openEuler-version-fallback",
			osText: `NAME="openEuler"
VERSION="22.03 (LTS-SP3)"
ID="openEuler"
PRETTY_NAME="openEuler 22.03 (LTS-SP3)"
`,
			want:    "openEuler22.03",
			wantTok: "openEuler22.03",
		},
		{
			// 未收录进令牌表的发行版：仍按 ID+版本号写入，但不影响资产管理
			name: "ubuntu-not-in-token-table",
			osText: `NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
VERSION_ID="22.04"
PRETTY_NAME="Ubuntu 22.04.3 LTS"
`,
			want:    "ubuntu22.04",
			wantTok: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pr := &calibProbeResult{OsText: c.osText, RelText: c.relText, Arch: "aarch64", NProc: "4"}
			items, _ := buildCalibItems(map[string]interface{}{"操作系统版本": "旧值"}, pr)

			var osItem *calibItem
			for i := range items {
				if items[i].Key == "操作系统版本" {
					osItem = &items[i]
				}
			}
			if osItem == nil {
				t.Fatalf("未生成「操作系统版本」校准项")
			}
			if osItem.Detected != c.want {
				t.Errorf("Detected = %q, 期望 %q", osItem.Detected, c.want)
			}
			if got := mapOsType(osItem.Detected); got != c.wantTok {
				t.Errorf("mapOsType(%q) = %q, 期望 %q", osItem.Detected, got, c.wantTok)
			}
			// Raw 必须是发行版全名，供人工核对（与写入值不同）
			if osItem.Raw == "" {
				t.Errorf("Raw 为空，应保留发行版全名（PRETTY_NAME）")
			}
			if osItem.Raw == osItem.Detected {
				t.Errorf("Raw 与 Detected 相同（%q），实测原始值应保留 PRETTY_NAME", osItem.Raw)
			}
			// Std（平台识别）只在「比写入值多出信息」时才给（如 华为欧拉 HCE2.0 / 银河麒麟 V10）；
			// AlmaLinux 8.9 这类与 hce2.0 同构的写法会被抑制，允许为空，但绝不允许等于写入值。
			if osItem.Std != "" && osItem.Std == osItem.Detected {
				t.Errorf("Std 与 Detected 相同（%q），无信息量的提示应省略", osItem.Std)
			}
			// 与旧值不同 → 应有差异且允许同步
			if !osItem.Diff || !osItem.Synced {
				t.Errorf("Diff=%v Synced=%v, 期望均为 true", osItem.Diff, osItem.Synced)
			}
			if c.wantTok == "" && osItem.Hint == "" {
				t.Errorf("不在令牌表内的发行版应给出提示")
			}
		})
	}
}

// 已按新口径登记过的资产（如 hce2.0）：重跑校准应为「一致」，不再反复提示同步
func TestBuildCalibItemsOSIdempotent(t *testing.T) {
	pr := &calibProbeResult{
		OsText: `NAME="Huawei Cloud EulerOS"
VERSION="2.0 (aarch64)"
ID="hce"
VERSION_ID="2.0"
PRETTY_NAME="Huawei Cloud EulerOS 2.0 (aarch64)"
`,
	}
	items, _ := buildCalibItems(map[string]interface{}{"操作系统版本": "hce2.0"}, pr)
	for _, it := range items {
		if it.Key != "操作系统版本" {
			continue
		}
		if it.Diff {
			t.Errorf("登记值已等于 hce2.0，不应再标记为差异")
		}
		return
	}
	t.Fatalf("未生成「操作系统版本」校准项")
}

// 历史遗留的 PRETTY_NAME 登记值：语义等价、书写不同 → 标为 Same（前端「写法不同」）
func TestBuildCalibItemsOSLegacyPretty(t *testing.T) {
	pr := &calibProbeResult{
		OsText: `NAME="Huawei Cloud EulerOS"
VERSION="2.0 (aarch64)"
ID="hce"
VERSION_ID="2.0"
PRETTY_NAME="Huawei Cloud EulerOS 2.0 (aarch64)"
`,
	}
	items, _ := buildCalibItems(
		map[string]interface{}{"操作系统版本": "Huawei Cloud EulerOS 2.0 (aarch64)"}, pr)
	for _, it := range items {
		if it.Key != "操作系统版本" {
			continue
		}
		if !it.Same {
			t.Errorf("同一系统仅书写不同，应标记 Same")
		}
		if !it.Diff {
			t.Errorf("书写不同仍应标记 Diff（允许同步改写）")
		}
		return
	}
	t.Fatalf("未生成「操作系统版本」校准项")
}
