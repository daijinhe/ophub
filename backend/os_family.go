// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strings"
)

// ============================================================================
// 操作系统归一化（巡检大屏「操作系统分布」环形图使用）
//
// 数据来源：资产管理（CMDB）Asset.Fields["操作系统版本"]，不是巡检采集的 data.os.name。
// 设计目标：未来在 CMDB 里新增任何操作系统的资产，大屏分布都能自动、合理地归类，
//          不需要改代码。
//
// 归一化分三级，命中即返回：
//  1. 自定义别名（环境变量 ASSET_OS_ALIAS 注入，运维可自行扩展，优先级最高）
//  2. 内置家族规则表（osFamilyRules，覆盖国内外主流发行版，顺序敏感）
//  3. 通用归一化兜底（未收录的新 OS：剥离版本号/括号/架构/噪音词后自动成类）
//     例："TencentOS Server 3.1 (Final)" -> "TencentOS"
//        "Arch Linux 6.6.7-zen1"       -> "Arch Linux"
//        "星辰操作系统 V2"              -> "星辰操作系统"
//     这样即便是一个从未见过的 OS，也会在饼图里独立成一块，而不是混进「其他」。
//
// 新增内置 OS 只需在 osFamilyRules 里追加一行（注意：特化关键词要排在泛化关键词之前，
// 例如 openKylin 必须排在 kylin 之前，否则会被 kylin 抢先命中）。
// ============================================================================

// osFamilyRule 内置 OS 家族规则
type osFamilyRule struct {
	label string   // 归一化后展示名
	keys  []string // 识别关键词（大小写不敏感）
}

// osFamilyRules 顺序敏感：特化 / 长关键词在前，泛化 / 短关键词在后
var osFamilyRules = []osFamilyRule{
	// —— 国产操作系统 ——
	{"华为 HCE", []string{"hce", "华为欧拉", "huawei cloud euler"}},
	{"中标麒麟", []string{"neokylin", "中标麒麟"}},
	{"openKylin", []string{"openkylin"}},
	{"银河麒麟", []string{"kylin", "麒麟"}},
	{"统信 UOS", []string{"uos", "统信"}},
	{"Deepin", []string{"deepin", "深度操作系统"}},
	{"openEuler", []string{"openeuler", "euleros", "欧拉"}},
	{"Anolis OS", []string{"anolis", "龙蜥"}},
	{"OpenCloudOS", []string{"opencloudos"}},
	{"TencentOS", []string{"tencentos", "tlinux"}},
	{"Aliyun Linux", []string{"aliyun linux", "alinux", "aliyun"}},
	{"红旗 Linux", []string{"红旗", "redflag"}},
	{"中兴新支点", []string{"新支点", "cgs linux"}},

	// —— RHEL 系 ——
	{"Rocky Linux", []string{"rocky"}},
	{"AlmaLinux", []string{"almalinux", "alma linux"}},
	{"CentOS", []string{"centos", "cent os"}},
	{"RHEL", []string{"rhel", "red hat", "redhat"}},
	{"Fedora", []string{"fedora"}},
	{"Oracle Linux", []string{"oracle linux"}},
	{"Amazon Linux", []string{"amazon linux", "amzn"}},

	// —— Debian / Ubuntu 系 ——
	{"Ubuntu", []string{"ubuntu"}},
	{"Debian", []string{"debian"}},
	{"Kali Linux", []string{"kali"}},

	// —— SUSE 系 ——
	{"openSUSE", []string{"opensuse"}},
	{"SUSE", []string{"sles", "suse"}},

	// —— 其它 Linux ——
	{"Alpine", []string{"alpine"}},
	{"Arch Linux", []string{"arch linux", "archlinux", "manjaro"}},
	{"Gentoo", []string{"gentoo"}},
	{"Slackware", []string{"slackware"}},

	// —— 非 Linux ——
	{"Windows", []string{"windows", "win server", "windows server"}},
	{"FreeBSD", []string{"freebsd"}},
	{"OpenBSD", []string{"openbsd"}},
	{"macOS", []string{"macos", "mac os", "darwin"}},
	{"AIX", []string{"aix"}},
	{"HP-UX", []string{"hp-ux"}},
	{"Solaris", []string{"solaris", "sunos"}},
}

// osMatcher 预编译后的匹配器：ASCII 关键词走边界正则（避免 uos/hce 之类短词误伤），
// 中文关键词走 Contains。
type osMatcher struct {
	label string
	res   []*regexp.Regexp
	plain []string
}

func isASCIIKey(s string) bool {
	for _, r := range s {
		if r > 127 {
			return false
		}
	}
	return true
}

var osMatchers = buildOSMatchers()

func buildOSMatchers() []osMatcher {
	out := make([]osMatcher, 0, len(osFamilyRules))
	for _, r := range osFamilyRules {
		m := osMatcher{label: r.label}
		for _, k := range r.keys {
			lk := strings.ToLower(k)
			// 短 ASCII 关键词（hce / uos / rhel / kylin / suse 等）必须按词边界匹配，
			// 否则 "openkylin" 会被 "kylin" 抢走、"UOServer" 会被 "uos" 误伤；
			// 多词组合（"red hat" / "huawei cloud euler"）与长词（centos / almalinux）
			// 本身已足够特定，直接子串匹配，避免边界规则把合法写法卡掉。
			// 注意：阈值取 8 而不是 6 —— "alinux" 是 "almalinux" 的子串，这类短词一旦走
			// 子串匹配就会误伤同族发行版。
			if isASCIIKey(k) && !strings.Contains(k, " ") && len(k) < 8 {
				// 左边界：非字母数字（或串首）；右边界：非字母（或串尾）。
				// 右侧允许数字，保证 "HCE2.0" / "kylinv10" 这类紧挨版本号的写法也能命中。
				m.res = append(m.res, regexp.MustCompile(`(^|[^a-z0-9])`+regexp.QuoteMeta(lk)+`([^a-z]|$)`))
			} else {
				m.plain = append(m.plain, lk)
			}
		}
		out = append(out, m)
	}
	return out
}

// osAliasEnv 自定义别名映射（运维可通过环境变量扩展，无需改代码）：
// ASSET_OS_ALIAS='{"tencentos":"TencentOS Server","hce":"华为 HCE"}'
// 键为小写关键词（子串匹配），值为展示名。
var osAliasEnv = parseOSAliasEnv(os.Getenv("ASSET_OS_ALIAS"))

func parseOSAliasEnv(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	m := map[string]string{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil
	}
	return m
}

// simplifyOS 把资产「操作系统版本」字段归一化到 OS 家族级类别。
// 返回 "" 表示资产未登记 OS（调用方会用「未登记」归类）。
func simplifyOS(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	lower := strings.ToLower(s)

	// 1) 自定义别名（按 key 长度降序，长词优先，保证特化规则先命中）
	if len(osAliasEnv) > 0 {
		keys := make([]string, 0, len(osAliasEnv))
		for k := range osAliasEnv {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
		for _, k := range keys {
			if k != "" && strings.Contains(lower, strings.ToLower(k)) {
				if v := strings.TrimSpace(osAliasEnv[k]); v != "" {
					return v
				}
			}
		}
	}

	// 2) 内置家族规则表
	for _, m := range osMatchers {
		for _, re := range m.res {
			if re.MatchString(lower) {
				return m.label
			}
		}
		for _, p := range m.plain {
			if strings.Contains(lower, p) {
				return m.label
			}
		}
	}

	// 3) 通用归一化兜底：未收录的新 OS 也能独立成类
	if v := normalizeUnknownOS(s); v != "" {
		return v
	}
	return "其他"
}

var (
	reParen      = regexp.MustCompile(`[\(（【][^)）】]*[\)）】]`) // 括号及其内容
	reBracket    = regexp.MustCompile(`[\[［][^\]］]*[\]］]`)   // 方括号及其内容
	reVersionTok = regexp.MustCompile(`^[vV]?[0-9]+[0-9A-Za-z.\-_]*$`)
	reTailVer    = regexp.MustCompile(`[vV]?[0-9]+(\.[0-9A-Za-z]+)*$`)
	reSP         = regexp.MustCompile(`^[sS][pP][0-9]+$`)
)

// osNoiseWords 噪音词：仅在删除后仍有剩余 token 时才会被丢弃，
// 避免把 "Server" 这类纯噪音输入删成空串。
var osNoiseWords = map[string]bool{
	"server": true, "enterprise": true, "standard": true, "desktop": true,
	"datacenter": true, "release": true, "lts": true, "edition": true,
	"gnu/linux": true, "gnu": true, "final": true, "stream": true,
	"advanced": true, "linux": false, // linux 保留：Amazon Linux / Arch Linux 需要它
	"x86_64": true, "amd64": true, "aarch64": true, "arm64": true,
	"i386": true, "i686": true, "ppc64le": true, "loongarch64": true,
	"64-bit": true, "32-bit": true, "64bit": true, "32bit": true,
}

// normalizeUnknownOS 对未收录的操作系统做通用归一化，输出稳定的家族名。
// 例："TencentOS Server 3.1 (Final)" -> "TencentOS"
//
//	"Arch Linux 6.6.7-zen1"       -> "Arch Linux"
//	"星辰操作系统 V2"              -> "星辰操作系统"
func normalizeUnknownOS(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	// 1) 去括号内容
	s = reParen.ReplaceAllString(s, " ")
	s = reBracket.ReplaceAllString(s, " ")
	// 2) 常见分隔符统一成空格（保留 '/' 由噪音词处理）
	s = strings.NewReplacer(",", " ", ";", " ", "_", " ", "　", " ").Replace(s)

	tokens := strings.Fields(s)
	kept := make([]string, 0, len(tokens))
	for _, t := range tokens {
		lt := strings.ToLower(t)
		if reVersionTok.MatchString(t) || reSP.MatchString(t) {
			continue // 版本号 / SP4
		}
		if osNoiseWords[lt] {
			continue // 噪音词（如 Server / Enterprise），"linux" 不在删除集合里
		}
		// 去掉尾部版本号（中文粘连场景："星辰操作系统V2"）
		if v := reTailVer.ReplaceAllString(t, ""); v != "" {
			t = v
		}
		t = strings.Trim(t, " .-/")
		if t == "" {
			continue
		}
		kept = append(kept, t)
	}

	// 噪音词清理：若丢弃噪音词后 token 为空，则回退到未过滤的 token（不要把名字删光）；
	// 但回退后若整体仍只是版本号（如 "2023"），说明这条登记信息无有效内容，交给「其他」。
	if len(kept) == 0 {
		for _, t := range tokens {
			if !reVersionTok.MatchString(t) && !reSP.MatchString(t) {
				kept = append(kept, t)
			}
		}
	}
	if len(kept) == 0 {
		return ""
	}

	// 3) 只保留前 2 个 token，避免 "SUSE Linux Enterprise Server" 这类超长图例
	if len(kept) > 2 {
		kept = kept[:2]
	}
	out := strings.TrimSpace(strings.Join(kept, " "))
	out = strings.Trim(out, " .-/")
	if out == "" {
		return ""
	}
	// 4) 长度保护：超长图例会撑破环形图布局
	runes := []rune(out)
	if len(runes) > 24 {
		out = string(runes[:24]) + "…"
	}
	return out
}
