package main

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"strings"
	"time"
)

// ============================================================================
// 巡检指标目录（八类，可扩展）
//   1. os      操作系统基础信息（含系统族/SELinux，兼容多发行版）
//   2. cpu     CPU 性能指标
//   3. mem     内存性能指标
//   4. disk    磁盘与存储（自动识别系统盘/数据盘/NAS，含 inode）
//   5. net     网络性能指标
//   6. proc    进程与服务（联动资产中间件信息判断核心进程存活）
//   7. svc     服务与中间件（纳管中间件数 / 核心进程 / 监听端口）
//   8. security 安全合规（防火墙 / SELinux / root 登录 / 失败登录 / 开放端口）
// 已适配发行版：CentOS 7 / AlmaLinux 8.9 / Ubuntu / 银河麒麟 V10 / 华为 HCE 2.0 / 华为 openEuler，
// 未来新增发行版只需在采集脚本的 OS 识别 case 中追加一行（可扩展）。
// 采集层（Ansible / 脚本）只负责把数据取回并组装为 JSON（与 set_fact 组装语义一致），
// 展示 / 报告 / 告警由平台解析后生成（采集与展示分离）。
// ============================================================================

// MetricCategory 指标分类
type MetricCategory struct {
	Key     string      `json:"key"`     // 分类键
	Label   string      `json:"label"`   // 中文名
	Metrics []MetricDef `json:"metrics"` // 该分类下指标
}

// MetricDef 可采集指标定义
type MetricDef struct {
	Category  string  `json:"category"`  // 所属分类
	Key       string  `json:"key"`       // 派生扁平指标键
	Label     string  `json:"label"`     // 中文名
	Unit      string  `json:"unit"`      // 单位
	Kind      string  `json:"kind"`      // number | string | percent
	Warn      float64 `json:"warn"`      // 告警阈值（百分比/数值类）
	Crit      float64 `json:"crit"`      // 严重阈值
	Note      string  `json:"note"`      // 关注点 / 阈值说明
	IsPercent bool    `json:"isPercent"` // 是否为百分比（用于聚合与阈值）
}

// 八类指标分组（详细分类，可扩展）
var MetricGroups = []MetricCategory{
	{
		Key: "os", Label: "操作系统基础信息",
		Metrics: []MetricDef{
			{Category: "os", Key: "os_hostname", Label: "主机名", Unit: "", Kind: "string"},
			{Category: "os", Key: "os_name", Label: "操作系统", Unit: "", Kind: "string"},
			{Category: "os", Key: "os_family", Label: "系统族", Unit: "", Kind: "string", Note: "rhel/debian/euler/kylin 等，用于兼容与统计"},
			{Category: "os", Key: "os_version", Label: "系统版本", Unit: "", Kind: "string"},
			{Category: "os", Key: "os_arch", Label: "系统架构", Unit: "", Kind: "string", Note: "x86_64 / aarch64"},
			{Category: "os", Key: "os_kernel", Label: "内核版本", Unit: "", Kind: "string", Note: "记录归档，用于版本合规审计"},
			{Category: "os", Key: "os_timezone", Label: "时区", Unit: "", Kind: "string"},
			{Category: "os", Key: "selinux_status", Label: "SELinux状态", Unit: "", Kind: "string", Note: "Enforcing/Disabled，安全合规参考"},
			{Category: "os", Key: "ntp_offset_ms", Label: "NTP偏差(ms)", Unit: "ms", Kind: "number", Warn: 1000, Note: "与 NTP 偏差 > 1000ms 需告警"},
			{Category: "os", Key: "uptime_days", Label: "运行时长(天)", Unit: "天", Kind: "number", Warn: 200, Note: "超过 200 天建议计划重启(补丁更新)"},
			{Category: "os", Key: "boot_time", Label: "最近启动时间", Unit: "", Kind: "string"},
		},
	},
	{
		Key: "cpu", Label: "CPU 性能指标",
		Metrics: []MetricDef{
			{Category: "cpu", Key: "cpu_model", Label: "CPU型号", Unit: "", Kind: "string", Note: "记录归档"},
			{Category: "cpu", Key: "cpu_cores", Label: "CPU核心数", Unit: "核", Kind: "number", Note: "用于计算负载参考"},
			{Category: "cpu", Key: "cpu_usage", Label: "CPU整体使用率", Unit: "%", Kind: "percent", Warn: 70, Crit: 85, IsPercent: true, Note: "持续>70%需关注，>85%告警"},
			{Category: "cpu", Key: "cpu_iowait", Label: "I/O等待", Unit: "%", Kind: "percent", Warn: 10, IsPercent: true, Note: "持续>10%说明磁盘是瓶颈"},
			{Category: "cpu", Key: "cpu_per_core_max", Label: "单核最高使用率", Unit: "%", Kind: "percent", Warn: 100, IsPercent: true, Note: "存在单核打满(100%)而整体空闲需关注"},
			{Category: "cpu", Key: "cpu_load_ratio", Label: "负载率(load1/核心数)", Unit: "%", Kind: "percent", Warn: 70, Crit: 100, IsPercent: true, Note: "相对核心数的负载水位，>70%关注，>100%过载"},
			{Category: "cpu", Key: "load1", Label: "系统负载(1m)", Unit: "", Kind: "number"},
			{Category: "cpu", Key: "load5", Label: "系统负载(5m)", Unit: "", Kind: "number"},
			{Category: "cpu", Key: "load15", Label: "系统负载(15m)", Unit: "", Kind: "number"},
		},
	},
	{
		Key: "mem", Label: "内存性能指标",
		Metrics: []MetricDef{
			{Category: "mem", Key: "mem_total_gb", Label: "物理内存总量", Unit: "GB", Kind: "number", Note: "记录归档"},
			{Category: "mem", Key: "mem_used_gb", Label: "内存已用", Unit: "GB", Kind: "number"},
			{Category: "mem", Key: "mem_available_gb", Label: "可用内存", Unit: "GB", Kind: "number", Note: "低于总量20%需关注"},
			{Category: "mem", Key: "mem_cache_gb", Label: "缓存/缓冲", Unit: "GB", Kind: "number", Note: "buff/cache，用于判断内存压力"},
			{Category: "mem", Key: "mem_usage", Label: "内存使用率", Unit: "%", Kind: "percent", Warn: 80, Crit: 90, IsPercent: true, Note: ">80%需关注，>90%告警"},
			{Category: "mem", Key: "swap_total_gb", Label: "Swap总量", Unit: "GB", Kind: "number"},
			{Category: "mem", Key: "swap_used_gb", Label: "Swap已用", Unit: "GB", Kind: "number"},
			{Category: "mem", Key: "swap_usage", Label: "Swap使用率", Unit: "%", Kind: "percent", Warn: 1, Crit: 10, IsPercent: true, Note: ">0%需关注(物理内存不足)，>10%告警"},
		},
	},
	{
		Key: "disk", Label: "磁盘与存储",
		Metrics: []MetricDef{
			{Category: "disk", Key: "disk_system_usage", Label: "系统盘使用率", Unit: "%", Kind: "percent", Warn: 75, Crit: 80, IsPercent: true, Note: "<75%，超80%紧急告警"},
			{Category: "disk", Key: "disk_system_inode_usage", Label: "系统盘inode使用率", Unit: "%", Kind: "percent", Warn: 75, Crit: 80, IsPercent: true, Note: "inode 耗尽会导致无法新建文件"},
			{Category: "disk", Key: "disk_system_total_gb", Label: "系统盘容量", Unit: "GB", Kind: "number"},
			{Category: "disk", Key: "disk_data_max_usage", Label: "数据盘最高使用率", Unit: "%", Kind: "percent", Warn: 70, Crit: 80, IsPercent: true, Note: "<80%(数据库核心盘<70%)"},
			{Category: "disk", Key: "disk_data_inode_max_usage", Label: "数据盘最高inode使用率", Unit: "%", Kind: "percent", Warn: 70, Crit: 80, IsPercent: true},
			{Category: "disk", Key: "disk_data_count", Label: "数据盘数量", Unit: "块", Kind: "number"},
			{Category: "disk", Key: "disk_nas_max_usage", Label: "NAS最高使用率", Unit: "%", Kind: "percent", Warn: 75, Crit: 80, IsPercent: true, Note: "NAS 挂载"},
		},
	},
	{
		Key: "net", Label: "网络性能指标",
		Metrics: []MetricDef{
			{Category: "net", Key: "net_bandwidth_max_pct", Label: "网卡带宽最高使用率", Unit: "%", Kind: "percent", Warn: 70, IsPercent: true, Note: "带宽使用率>70%需关注"},
			{Category: "net", Key: "packet_loss_pct", Label: "丢包率", Unit: "%", Kind: "percent", Warn: 0.1, IsPercent: true, Note: ">0.1%需关注"},
			{Category: "net", Key: "tcp_retrans_pct", Label: "TCP重传率", Unit: "%", Kind: "percent", Warn: 1, IsPercent: true, Note: "异常升高说明网络质量差"},
			{Category: "net", Key: "tcp_established", Label: "TCP ESTABLISHED", Unit: "", Kind: "number"},
			{Category: "net", Key: "tcp_time_wait", Label: "TCP TIME_WAIT", Unit: "", Kind: "number", Warn: 2000, Note: "过高需调整内核参数"},
			{Category: "net", Key: "tcp_syn_recv", Label: "TCP SYN_RECV", Unit: "", Kind: "number", Warn: 50, Note: "可能为 SYN 泛洪"},
			{Category: "net", Key: "tcp_close_wait", Label: "TCP CLOSE_WAIT", Unit: "", Kind: "number", Warn: 200, Note: "连接泄漏信号"},
			{Category: "net", Key: "listen_port_count", Label: "监听端口数", Unit: "", Kind: "number", Note: "业务监听端口数量，异常增减需关注"},
			{Category: "net", Key: "conn_total", Label: "TCP连接总数", Unit: "", Kind: "number"},
		},
	},
	{
		Key: "proc", Label: "进程与服务",
		Metrics: []MetricDef{
			{Category: "proc", Key: "total_proc", Label: "总进程数", Unit: "", Kind: "number", Note: "异常突增可能为 fork 炸弹"},
			{Category: "proc", Key: "zombie_count", Label: "僵尸进程数", Unit: "", Kind: "number", Crit: 1, Note: "必须为 0，存在即告警"},
			{Category: "proc", Key: "core_proc_total", Label: "核心进程总数", Unit: "", Kind: "number", Note: "来自资源清单中间件信息"},
			{Category: "proc", Key: "core_proc_down", Label: "核心进程未运行数", Unit: "", Kind: "number", Note: "任一核心进程未运行即告警"},
		},
	},
	{
		Key: "svc", Label: "服务与中间件",
		Metrics: []MetricDef{
			{Category: "svc", Key: "svc_mw_count", Label: "纳管中间件数", Unit: "", Kind: "number", Note: "来自资源清单中间件信息"},
			{Category: "svc", Key: "svc_core_total", Label: "核心进程总数", Unit: "", Kind: "number"},
			{Category: "svc", Key: "svc_core_down", Label: "核心进程未运行数", Unit: "", Kind: "number", Crit: 1, Note: "任一核心进程未运行即告警"},
			{Category: "svc", Key: "svc_listen_ports", Label: "关键端口监听数", Unit: "", Kind: "number", Note: "核心服务监听端口数量"},
		},
	},
	{
		Key: "security", Label: "安全合规",
		Metrics: []MetricDef{
			{Category: "security", Key: "sec_firewall", Label: "防火墙状态", Unit: "", Kind: "string", Note: "firewalld/iptables 是否启用"},
			{Category: "security", Key: "sec_selinux", Label: "SELinux", Unit: "", Kind: "string", Note: "Enforcing/Permissive/Disabled"},
			{Category: "security", Key: "sec_root_login", Label: "root远程登录", Unit: "", Kind: "string", Note: "PermitRootLogin 配置"},
			{Category: "security", Key: "sec_ssh_fail_24h", Label: "近24h失败SSH登录", Unit: "次", Kind: "number", Warn: 20, Note: "疑似暴力破解需关注"},
			{Category: "security", Key: "sec_open_ports", Label: "开放端口数", Unit: "", Kind: "number", Warn: 0, Note: "开放端口数量，过多增加暴露面"},
		},
	},
}

// FlatMetricDefs 扁平化全部指标（用于导出列 / 告警遍历）
func FlatMetricDefs() []MetricDef {
	out := make([]MetricDef, 0)
	for _, g := range MetricGroups {
		out = append(out, g.Metrics...)
	}
	return out
}

// knownFlatKeys 所有扁平指标键集合（用于旧记录兼容）
var knownFlatKeys = func() map[string]bool {
	m := map[string]bool{}
	for _, d := range FlatMetricDefs() {
		m[d.Key] = true
	}
	return m
}()

// 中间件类型 -> 进程判定特征（用于核心进程存活检测，联动资源清单中间件信息）
var mwProcPatterns = map[string][]string{
	"nginx":         {"nginx"},
	"宝兰德bws310":     {"BWS310", "bws", "baolaner"},
	"jdk":           {"java"},
	"php":           {"php-fpm", "php"},
	"redis":         {"redis-server", "redis"},
	"mysql":         {"mysqld", "mysql"},
	"elasticsearch": {"elasticsearch"},
	"logstash":      {"logstash"},
	"kafka":         {"kafka"},
	"rocketmq":      {"mqbroker", "mqnamesrv", "rocketmq"},
	"rabbitmq":      {"rabbitmq", "beam.smp", "epmd"},
	"其他":            {},
}

// MwProcExpect 期望检测的核心进程
type MwProcExpect struct {
	Type string   `json:"type"`
	Pats []string `json:"pats"`
}

// middlewareToExpects 把中间件类型列表转为进程检测期望
func middlewareToExpects(types []string) []MwProcExpect {
	out := []MwProcExpect{}
	seen := map[string]bool{}
	for _, t := range types {
		if seen[t] {
			continue
		}
		seen[t] = true
		if pats, ok := mwProcPatterns[t]; ok && len(pats) > 0 {
			out = append(out, MwProcExpect{Type: t, Pats: pats})
		}
	}
	return out
}

// DefaultCategories 默认采集全部六类
func DefaultCategories() []string {
	out := make([]string, 0, len(MetricGroups))
	for _, g := range MetricGroups {
		out = append(out, g.Key)
	}
	return out
}

// CategoryLabel 返回分类中文名
func CategoryLabel(key string) string {
	for _, g := range MetricGroups {
		if g.Key == key {
			return g.Label
		}
	}
	return key
}

// ============================================================================
// 告警阈值目录（可被告警规则按「项目/应用系统/资产」覆盖）
// ============================================================================

// ThresholdDef 一项可自定义的告警阈值
type ThresholdDef struct {
	Key   string  `json:"key"`   // 阈值项标识（多数与 MetricDef.Key 同名）
	Label string  `json:"label"` // 中文名
	Unit  string  `json:"unit"`  // 单位
	Kind  string  `json:"kind"`  // percent | number | ratio
	Warn  float64 `json:"warn"`  // 默认预警阈值
	Crit  float64 `json:"crit"`  // 默认严重阈值（0 = 默认不判严重）
	Note  string  `json:"note"`  // 说明
}

// alertExtraThresholds 不在百分比目录内、但同样需要可配置的阈值项。
// 默认值与 evalAlertsWithProfile 内的历史硬编码保持一致；调整默认值只改这里。
var alertExtraThresholds = []ThresholdDef{
	{Key: "ntp_offset_ms", Label: "系统时间与NTP偏差", Unit: "ms", Kind: "number", Warn: 1000, Note: "按绝对值比较"},
	{Key: "uptime_days", Label: "运行时长", Unit: "天", Kind: "number", Warn: 200, Note: "超过该天数建议计划重启（补丁更新）"},
	{Key: "load1_ratio", Label: "系统负载(1m)占核心数比例", Unit: "%", Kind: "ratio", Warn: 70, Crit: 100, Note: "load1 ÷ 核心数 × 100"},
	{Key: "sec_ssh_fail_24h", Label: "近24h失败SSH登录", Unit: "次", Kind: "number", Warn: 20, Note: "疑似暴力破解，请核查安全日志"},
	{Key: "disk_usage", Label: "磁盘使用率（逐盘·系统盘与NAS）", Unit: "%", Kind: "percent", Warn: 75, Crit: 80, Note: "每个挂载点单独判定"},
	{Key: "disk_data_usage", Label: "磁盘使用率（逐盘·数据盘）", Unit: "%", Kind: "percent", Warn: 70, Crit: 80, Note: "每个数据盘挂载点单独判定"},
}

// AlertThresholdDefs 返回全部可自定义阈值项 = 目录内百分比指标 + 特殊阈值项
func AlertThresholdDefs() []ThresholdDef {
	out := make([]ThresholdDef, 0, 40)
	seen := map[string]bool{}
	for _, d := range FlatMetricDefs() {
		if !d.IsPercent || seen[d.Key] {
			continue
		}
		seen[d.Key] = true
		out = append(out, ThresholdDef{
			Key: d.Key, Label: d.Label, Unit: d.Unit, Kind: "percent",
			Warn: d.Warn, Crit: d.Crit, Note: d.Note,
		})
	}
	for _, d := range alertExtraThresholds {
		if seen[d.Key] {
			continue
		}
		seen[d.Key] = true
		out = append(out, d)
	}
	return out
}

// ThOverride 阈值覆盖项（nil = 该级别沿用默认值；crit 显式设为 0 = 关闭严重级别判定）
type ThOverride struct {
	Warn *float64 `json:"warn"`
	Crit *float64 `json:"crit"`
}

// AlertProfile 一次告警评估所用的阈值与屏蔽配置；为 nil 表示沿用全部默认且不屏蔽。
// 由命中该资产的若干条 InspectionAlertRule 合并而来（见 resolveAlertProfile）。
type AlertProfile struct {
	Overrides map[string]ThOverride
	Muted     map[string]bool
	MuteAll   bool
	HitRules  []string // 命中的规则名（用于排查「为什么这条告警没了」）
}

// thr 取某阈值项的生效阈值：先取目录默认，再被规则覆盖
func (p *AlertProfile) thr(key string, defWarn, defCrit float64) (float64, float64) {
	if p != nil {
		if o, ok := p.Overrides[key]; ok {
			if o.Warn != nil {
				defWarn = *o.Warn
			}
			if o.Crit != nil {
				defCrit = *o.Crit
			}
		}
	}
	return defWarn, defCrit
}

// muted 该阈值项是否被规则屏蔽（既不产生告警、也不计入统计与趋势）
func (p *AlertProfile) muted(key string) bool {
	if p == nil || len(p.Muted) == 0 {
		return false
	}
	return p.Muted[key]
}

// thrText 阈值文本化（整数不带小数位，便于写入告警说明）
func thrText(v float64) string {
	if v == math.Trunc(v) {
		return fmt.Sprintf("%.0f", v)
	}
	return fmt.Sprintf("%v", v)
}

// ============================================================================
// 采集脚本（通过 Ansible 在目标机执行，最终由 python 组装为单一 JSON）
// ============================================================================

// collectorScriptTemplate 采集器脚本（EXPECTED 占位符在 buildCollectScript 中注入）
const collectorScriptTemplate = `#!/bin/bash
set +e
# ===== 巡检采集器 v2：采集六类指标，统一输出 JSON（与 ansible set_fact 组装语义一致）=====
EXPECTED='__EXPECTED__'

# ---------- 1. 操作系统基础信息 ----------
OS_HOSTNAME=$(hostname 2>/dev/null || echo "")
# 发行版识别：优先读 /etc/os-release，兼容 CentOS7/Alma8.9/Ubuntu/麒麟V10/华为HCE2.0/openEuler 等
OS_ID=$( ( . /etc/os-release 2>/dev/null; echo "${ID:-unknown}" ) )
case "$OS_ID" in
  centos) OS_PRETTY="CentOS" ;;
  rhel) OS_PRETTY="Red Hat Enterprise Linux" ;;
  almalinux) OS_PRETTY="AlmaLinux" ;;
  rocky) OS_PRETTY="Rocky Linux" ;;
  kylin|neokylin) OS_PRETTY="银河麒麟 Kylin V10" ;;
  hce) OS_PRETTY="华为 HCE 2.0" ;;
  openeuler|euler) OS_PRETTY="华为 openEuler" ;;
  ubuntu) OS_PRETTY="Ubuntu" ;;
  debian) OS_PRETTY="Debian" ;;
  uos|uniontech) OS_PRETTY="统信 UOS" ;;
  *) OS_PRETTY=$( (lsb_release -ds 2>/dev/null) || (grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"') || echo "unknown" ) ;;
esac
OS_NAME="$OS_PRETTY"
OS_VERSION=$( (lsb_release -rs 2>/dev/null) || (grep '^VERSION_ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"') || echo "")
# 系统族：用于兼容与统计（未来新增发行版只需在此 case 追加一行）
case "$OS_ID" in
  centos|rhel|rocky|almalinux|ol|fedora|anolis|kylin|neokylin) OS_FAMILY="rhel" ;;
  ubuntu|debian|linuxmint|uos|uniontech) OS_FAMILY="debian" ;;
  hce|openeuler|euler) OS_FAMILY="euler" ;;
  *) OS_FAMILY="other" ;;
esac
OS_ARCH=$(uname -m 2>/dev/null || echo "")
OS_KERNEL=$(uname -r 2>/dev/null || echo "")
OS_TZ=$( (cat /etc/timezone 2>/dev/null) || (timedatectl 2>/dev/null | awk -F': ' '/Time zone/{print $2}' | awk '{print $1}') || echo "")
NTP_OFFSET=$( (timedatectl show -p Offset --value 2>/dev/null) || echo "0")
UPTIME_DAYS=$(awk '{printf "%.2f", $1/86400}' /proc/uptime 2>/dev/null || echo "0")
BOOT_TIME=$(who -b 2>/dev/null | awk '{print $3, $4}' || echo "")
SELINUX=$( (getenforce 2>/dev/null) || echo "未安装")

# ---------- 2. CPU ----------
CPU_MODEL=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //' || echo "")
CPU_CORES=$(nproc 2>/dev/null || echo "1")
CPU_STATS=$(top -bn1 2>/dev/null | awk '/%Cpu/{idle=0;wa=0;for(i=1;i<=NF;i++){if($i=="id,")idle=$(i-1);if($i=="wa,")wa=$(i-1)};printf "%.1f %.1f",100-idle,wa;exit}' || echo "0 0")
CPU_USAGE=$(echo "$CPU_STATS" | awk '{print $1}')
CPU_IOWAIT=$(echo "$CPU_STATS" | awk '{print $2}')
LOAD1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "0")
LOAD5=$(awk '{print $2}' /proc/loadavg 2>/dev/null || echo "0")
LOAD15=$(awk '{print $3}' /proc/loadavg 2>/dev/null || echo "0")
CPU_BEFORE=$(awk '/^cpu[0-9]/{print $1,$2,$3,$4,$5,$6,$7,$8}' /proc/stat 2>/dev/null)

# ---------- 3. 内存 ----------
MEM_TOTAL_KB=$(free -k 2>/dev/null | awk '/^Mem:/{print $2}')
MEM_AVAIL_KB=$(free -k 2>/dev/null | awk '/^Mem:/{print $7}')
MEM_USED_KB=$(free -k 2>/dev/null | awk '/^Mem:/{print $3}')
MEM_CACHE_KB=$(free -k 2>/dev/null | awk '/^Mem:/{print $6}')
SWAP_TOTAL_KB=$(free -k 2>/dev/null | awk '/^Swap:/{print $2}')
SWAP_USED_KB=$(free -k 2>/dev/null | awk '/^Swap:/{print $3}')

# ---------- 4. 磁盘（df，排除伪文件系统，自动识别系统盘/数据盘/NAS）----------
DISK_TSV=""
while read dev total used avail pct mount; do
  [ -z "$mount" ] && continue
  fstype=$(findmnt -n -o FSTYPE -T "$mount" 2>/dev/null)
  [ -z "$fstype" ] && fstype="unknown"
  DISK_TSV="${DISK_TSV}${dev}	${mount}	${fstype}	${total}	${used}	${avail}	${pct}
"
done <<EOF
$(df -P -B1 -x tmpfs -x devtmpfs -x overlay -x udev -x proc -x sysfs -x cgroup -x squashfs -x iso9660 2>/dev/null | tail -n +2)
EOF

# inode 使用率（df -i，字段：Filesystem Inodes IUsed IFree IUse% Mounted）
INODE_TSV=""
while read dev total used avail pct mount; do
  [ -z "$mount" ] && continue
  INODE_TSV="${INODE_TSV}${mount}	${pct}
"
done <<EOF
$(df -iP -x tmpfs -x devtmpfs -x overlay -x udev -x proc -x sysfs -x cgroup -x squashfs -x iso9660 2>/dev/null | tail -n +2)
EOF

# ---------- 5. 网络（1 秒采样速率）----------
NET1=$(awk 'NR>2 && $1 !~ /lo:/{gsub(/:/," ",$1);print $1,$2,$10}' /proc/net/dev 2>/dev/null)
CPU_AFTER=$(awk '/^cpu[0-9]/{print $1,$2,$3,$4,$5,$6,$7,$8}' /proc/stat 2>/dev/null)
sleep 1
NET2=$(awk 'NR>2 && $1 !~ /lo:/{gsub(/:/," ",$1);print $1,$2,$10}' /proc/net/dev 2>/dev/null)
TCP_LINES=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk 'NR>1{print $4}')

# ---------- 6. 进程与服务 ----------
PROC_TOTAL=$(ps -e 2>/dev/null | wc -l)
PROC_ZOMBIE=$(ps -eo s 2>/dev/null | grep -c '^Z')
PROC_TOP=$(ps -eo pid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | awk 'NR>1 && NR<=10{print $1"|"$2"|"$3"|"$4}')

# ---------- 7. 安全合规（命令缺失时降级，不阻断采集）----------
SEC_FW=$( (systemctl is-active firewalld 2>/dev/null | grep -q active && echo "启用(firewalld)") || (iptables -L -n 2>/dev/null | tail -n +3 | grep -q . && echo "启用(iptables)") || echo "未启用" )
SEC_SELINUX=$(getenforce 2>/dev/null || echo "未安装")
SEC_ROOT=$( (grep -E '^PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1) || echo "unknown" )
SEC_SSH_FAIL=$( (timeout 5 journalctl -u ssh -u sshd --since "24 hours ago" 2>/dev/null | grep -c "Failed password") || echo 0 )
SEC_OPEN=$( (ss -lnt 2>/dev/null | tail -n +2 | wc -l) || echo 0 )
LISTEN_PORTS=$SEC_OPEN

export OS_HOSTNAME OS_NAME OS_VERSION OS_ARCH OS_KERNEL OS_TZ NTP_OFFSET UPTIME_DAYS BOOT_TIME SELINUX OS_ID OS_FAMILY OS_PRETTY CPU_MODEL CPU_CORES CPU_USAGE CPU_IOWAIT LOAD1 LOAD5 LOAD15 CPU_BEFORE CPU_AFTER MEM_TOTAL_KB MEM_AVAIL_KB MEM_USED_KB MEM_CACHE_KB SWAP_TOTAL_KB SWAP_USED_KB DISK_TSV INODE_TSV NET1 NET2 TCP_LINES PROC_TOTAL PROC_ZOMBIE PROC_TOP LISTEN_PORTS SEC_FW SEC_SELINUX SEC_ROOT SEC_SSH_FAIL SEC_OPEN EXPECTED

echo "INSPECTION_RESULT_JSON>>>"
PYY=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || echo python3)
eval "$PYY" - <<'PY'
import os, json, re, subprocess

def f(v, d=0.0):
    try:
        return float(v)
    except Exception:
        return d

def s(v, d=""):
    return v if v else d

def run(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return ""

os_d = {
    "hostname": s(os.environ.get("OS_HOSTNAME")),
    "name": s(os.environ.get("OS_NAME")),
    "id": s(os.environ.get("OS_ID")),
    "family": s(os.environ.get("OS_FAMILY")),
    "version": s(os.environ.get("OS_VERSION")),
    "arch": s(os.environ.get("OS_ARCH")),
    "kernel": s(os.environ.get("OS_KERNEL")),
    "timezone": s(os.environ.get("OS_TZ")),
    "selinux": s(os.environ.get("SELINUX")),
    "ntp_offset_ms": f(os.environ.get("NTP_OFFSET")),
    "uptime_days": f(os.environ.get("UPTIME_DAYS")),
    "boot_time": s(os.environ.get("BOOT_TIME")),
}

cores = int(f(os.environ.get("CPU_CORES"), 1)) or 1
cpu_d = {
    "model": s(os.environ.get("CPU_MODEL")),
    "cores": cores,
    "usage": f(os.environ.get("CPU_USAGE")),
    "iowait": f(os.environ.get("CPU_IOWAIT")),
        "load1": f(os.environ.get("LOAD1")),
        "load5": f(os.environ.get("LOAD5")),
        "load15": f(os.environ.get("LOAD15")),
        "load_ratio": round((f(os.environ.get("LOAD1")) / cores * 100), 1) if cores > 0 else 0.0,
        "per_core": [],
    }

before = {}
after = {}
for line in (os.environ.get("CPU_BEFORE") or "").splitlines():
    p = line.split()
    if len(p) >= 9:
        before[p[0]] = list(map(float, p[1:9]))
for line in (os.environ.get("CPU_AFTER") or "").splitlines():
    p = line.split()
    if len(p) >= 9:
        after[p[0]] = list(map(float, p[1:9]))
for k in before:
    if k in after:
        b, a = before[k], after[k]
        total = sum(a[i] - b[i] for i in range(8))
        idle = a[4] - b[4]
        busy = total - idle
        cpu_d["per_core"].append(round((busy / total * 100) if total > 0 else 0, 1))

mt = f(os.environ.get("MEM_TOTAL_KB"))
ma = f(os.environ.get("MEM_AVAIL_KB"))
mu = f(os.environ.get("MEM_USED_KB"))
mc = f(os.environ.get("MEM_CACHE_KB"))
st = f(os.environ.get("SWAP_TOTAL_KB"))
su = f(os.environ.get("SWAP_USED_KB"))
mem_d = {
    "total_gb": round(mt / 1048576.0, 1),
    "used_gb": round(mu / 1048576.0, 1),
    "available_gb": round(ma / 1048576.0, 1),
    "cache_gb": round(mc / 1048576.0, 1),
    "usage": round(mu / mt * 100, 1) if mt > 0 else 0.0,
    "swap_total_gb": round(st / 1048576.0, 1),
    "swap_used_gb": round(su / 1048576.0, 1),
    "swap_usage": round(su / st * 100, 1) if st > 0 else 0.0,
}

# inode 使用率映射（挂载点 -> 使用率%）
inode_map = {}
for line in (os.environ.get("INODE_TSV") or "").splitlines():
    if not line.strip():
        continue
    parts = line.split("\t")
    if len(parts) < 2:
        continue
    mp, ipct = parts[0], parts[1]
    inode_map[mp] = f("".join(ch for ch in ipct if ch.isdigit() or ch == "."))

disks = []
for line in (os.environ.get("DISK_TSV") or "").splitlines():
    if not line.strip():
        continue
    parts = line.split("\t")
    if len(parts) < 7:
        continue
    dev, mount, fstype, total, used, avail, pct = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
    # 磁盘角色：按设备名识别（真实环境：系统盘固定 vda，数据盘 vdb/vdc...，LVM 卷组同属系统盘）
    role = "data"
    if fstype in ("nfs", "nfs4", "cifs", "fuse.sshfs", "nfsd") or ":" in dev:
        role = "nas"
    elif re.match(r"^/dev/vd[b-z]", dev):
        role = "data"          # vdb / vdc / vdd ... 数据盘
    elif re.match(r"^/dev/vda", dev) or mount == "/":
        role = "system"        # vda 系列（vda1/vda2...）或根挂载 → 系统盘
    elif "/dev/mapper/" in dev and (mount == "/" or "home" in mount or "boot" in mount):
        role = "system"        # LVM 卷组（centos-root/centos-home 等）通常在系统盘 vda 上
    pctn = f("".join(ch for ch in pct if ch.isdigit() or ch == "."))
    disks.append({
        "device": dev, "mount": mount, "fstype": fstype, "role": role,
        "total_gb": round(f(total) / 1073741824.0, 1),
        "used_gb": round(f(used) / 1073741824.0, 1),
        "usage": pctn,
        "inode_usage": inode_map.get(mount, 0.0),
    })
disk_d = {"disks": disks}

interfaces = []
n1, n2 = {}, {}
for line in (os.environ.get("NET1") or "").splitlines():
    p = line.split()
    if len(p) >= 3:
        n1[p[0]] = (f(p[1]), f(p[2]))
for line in (os.environ.get("NET2") or "").splitlines():
    p = line.split()
    if len(p) >= 3:
        n2[p[0]] = (f(p[1]), f(p[2]))
for iface in n1:
    if iface in n2:
        rx = (n2[iface][0] - n1[iface][0]) * 8 / 1e6
        tx = (n2[iface][1] - n1[iface][1]) * 8 / 1e6
        if rx < 0:
            rx = 0.0
        if tx < 0:
            tx = 0.0
        speed = 1000.0
        try:
            sp = open("/sys/class/net/%s/speed" % iface).read().strip()
            if sp.isdigit() and int(sp) > 0:
                speed = float(sp)
        except Exception:
            pass
        bw = round((rx + tx) / speed * 100, 2) if speed > 0 else 0.0
        interfaces.append({"name": iface, "rx_mbps": round(rx, 2), "tx_mbps": round(tx, 2),
                           "speed_mbps": speed, "bandwidth_pct": bw, "rx_drop": 0, "tx_drop": 0})
net_d = {"interfaces": interfaces, "packet_loss_pct": 0.0, "tcp_states": {}, "tcp_retrans_pct": 0.0,
          "listen_port_count": int(f(os.environ.get("LISTEN_PORTS"))), "conn_total": 0}
states = {}
m = {"01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1", "05": "FIN_WAIT2",
     "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING"}
for st_hex in (os.environ.get("TCP_LINES") or "").split():
    name = m.get(st_hex.upper(), "OTHER")
    states[name] = states.get(name, 0) + 1
net_d["tcp_states"] = states
net_d["conn_total"] = sum(states.values())

procs = []
for line in (os.environ.get("PROC_TOP") or "").splitlines():
    p = line.split("|")
    if len(p) >= 4:
        procs.append({"name": p[1], "pid": int(f(p[0])), "cpu": f(p[2]), "mem": f(p[3])})
core = []
try:
    expected = json.loads(os.environ.get("EXPECTED") or "[]")
except Exception:
    expected = []
for item in expected:
    t = item.get("type")
    pats = item.get("pats", [])
    alive = False
    pid = None
    cpu = 0.0
    mem = 0.0
    for pat in pats:
        pat = pat.replace("'", "")
        out = run("pgrep -f '%s' | head -1" % pat)
        if out.strip():
            pid = int(out.strip().split()[0])
            pi = run("ps -p %d -o %%cpu,%%mem --no-headers 2>/dev/null" % pid)
            pp = pi.split()
            if len(pp) >= 2:
                cpu = f(pp[0])
                mem = f(pp[1])
            alive = True
            break
    core.append({"type": t, "pattern": (pats[0] if pats else ""), "alive": alive, "pid": pid, "cpu": cpu, "mem": mem})

proc_d = {"total": int(f(os.environ.get("PROC_TOTAL"))), "zombie": int(f(os.environ.get("PROC_ZOMBIE"))),
          "top": procs, "core": core, "mw_count": len(expected)}

security_d = {
    "firewall": s(os.environ.get("SEC_FW")),
    "selinux": s(os.environ.get("SEC_SELINUX")),
    "root_login": s(os.environ.get("SEC_ROOT")),
    "ssh_fail_24h": int(f(os.environ.get("SEC_SSH_FAIL"))),
    "open_ports": int(f(os.environ.get("SEC_OPEN"))),
}

result = {"os": os_d, "cpu": cpu_d, "mem": mem_d, "disk": disk_d, "net": net_d, "proc": proc_d, "security": security_d}
print(json.dumps(result, ensure_ascii=False))
PY
echo "<<<INSPECTION_RESULT_JSON"
`

// buildCollectScript 生成采集脚本（注入期望检测的核心进程）
func buildCollectScript(expected []MwProcExpect) string {
	b, _ := json.Marshal(expected)
	return strings.Replace(collectorScriptTemplate, "__EXPECTED__", string(b), 1)
}

// CollectAsset 采集单个资产资源信息
// 优先通过 ansible 控制节点执行采集脚本；任何失败均回退为模拟数据（source=simulated）
func CollectAsset(ip string, node *AnsibleRemote, sshUser, sshPass string, sshPort int, mwTypes []string) (map[string]interface{}, string, error) {
	script := buildCollectScript(middlewareToExpects(mwTypes))
	source := SrcSimulated
	data := map[string]interface{}{}

	if node != nil && ip != "" {
		client := node.ToSSHClient()
		targetUser := sshUser
		if targetUser == "" {
			targetUser = node.User
		}
		targetPass := sshPass
		if targetPass == "" {
			targetPass = node.Password
		}
		if sshPort == 0 {
			sshPort = node.Port
		}
		if sshPort == 0 {
			sshPort = 65181
		}
		enc := base64.StdEncoding.EncodeToString([]byte(script))
		ansibleCmd := fmt.Sprintf(
			`ansible %s -i %s, -m shell -a 'echo %s | base64 -d | bash' -u %s -e "ansible_ssh_pass=%s" -e "ansible_ssh_port=%d" -o 2>/dev/null`,
			shq(ip), shq(ip), enc, shq(targetUser), shq(targetPass), sshPort,
		)
		out, err := client.Run(ansibleCmd)
		if err == nil {
			if parsed, perr := parseInspectionJSON(out); perr == nil && len(parsed) > 0 {
				data = parsed
				source = SrcAnsible
			}
		}
	}

	if source == SrcSimulated {
		data = simulateData(ip, mwTypes)
	}
	return data, source, nil
}

// parseInspectionJSON 从采集输出中提取结构化 JSON
// 兼容两种来源：① 裸脚本输出（直接包含标记）；② Ansible 包装输出（结果 JSON 的 stdout 字段内为转义后的内容）
func parseInspectionJSON(out string) (map[string]interface{}, error) {
	startMarker := "INSPECTION_RESULT_JSON>>>"
	endMarker := "<<<INSPECTION_RESULT_JSON"
	tryJSON := func(s string) map[string]interface{} {
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(s), &m); err == nil {
			return m
		}
		return nil
	}
	between := func(s, a, b string) (string, bool) {
		i := strings.Index(s, a)
		if i < 0 {
			return "", false
		}
		rest := s[i+len(a):]
		j := strings.Index(rest, b)
		if j < 0 {
			return strings.TrimSpace(rest), true
		}
		return strings.TrimSpace(rest[:j]), true
	}

	// 1) 裸标记（脚本直接输出，无 ansible 包装）
	if body, ok := between(out, startMarker, endMarker); ok {
		if m := tryJSON(body); m != nil {
			return m, nil
		}
	}
	// 2) Ansible 包装：从结果 JSON 的 stdout 字段提取（处理转义）后再定位标记
	if stdout := extractJSONStringField(out, "stdout"); stdout != "" {
		if body, ok := between(stdout, startMarker, endMarker); ok {
			if m := tryJSON(body); m != nil {
				return m, nil
			}
		}
	}
	// 3) 兜底：取最后一个完整 JSON 对象
	if start := strings.LastIndex(out, "{"); start >= 0 {
		if end := strings.LastIndex(out, "}"); end >= start {
			if m := tryJSON(out[start : end+1]); m != nil {
				return m, nil
			}
		}
	}
	return nil, fmt.Errorf("未找到巡检 JSON 输出")
}

// extractJSONStringField 从 JSON 文本中提取指定字符串字段的内容（正确处理转义引号/换行）
func extractJSONStringField(s, key string) string {
	needle := `"` + key + `":"`
	i := strings.Index(s, needle)
	if i < 0 {
		return ""
	}
	i += len(needle)
	var b strings.Builder
	for i < len(s) {
		c := s[i]
		if c == '\\' && i+1 < len(s) {
			nxt := s[i+1]
			switch nxt {
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			default:
				b.WriteByte('\\')
				b.WriteByte(nxt)
			}
			i += 2
			continue
		}
		if c == '"' {
			break
		}
		b.WriteByte(c)
		i++
	}
	return b.String()
}

// ============================================================================
// 模拟数据（采集不可用时的稳定兜底，基于 IP 哈希保证同一资产数值稳定）
// ============================================================================

func simulateData(ip string, mwTypes []string) map[string]interface{} {
	seed := md5.Sum([]byte(ip + "::inspection"))
	r := rand.New(rand.NewSource(int64(seed[0])<<24 | int64(seed[1])<<16 | int64(seed[2])<<8 | int64(seed[3])))
	pick := func(min, max float64) float64 { return min + r.Float64()*(max-min) }

	// 支持的发行版（演示/模拟数据在范围内随机，便于验证多 OS 适配）
	oss := []struct {
		name, id, family, version, kernel, arch string
	}{
		{"CentOS Linux", "centos", "rhel", "7.9", "3.10.0-1160.el7.x86_64", "x86_64"},
		{"AlmaLinux", "almalinux", "rhel", "8.9", "4.18.0-372.el8.x86_64", "x86_64"},
		{"Ubuntu", "ubuntu", "debian", "22.04", "5.15.0-91-generic", "x86_64"},
		{"银河麒麟 Kylin V10", "kylin", "rhel", "V10", "4.19.90-23.10.ky10.x86_64", "aarch64"},
		{"华为 HCE 2.0", "hce", "euler", "2.0", "4.19.90-2102.2.0.hce2.x86_64", "x86_64"},
		{"华为 openEuler", "openeuler", "euler", "22.03", "5.10.0-60.18.0.50.oe2203.x86_64", "x86_64"},
	}
	o := oss[r.Intn(len(oss))]

	cores := []float64{2, 4, 8, 16, 32, 64}[r.Intn(6)]
	cpuUsage := round1(pick(5, 94))
	cpuIowait := round1(pick(0, 14))
	memTotal := round1(cores * 4 * pick(0.8, 1.6))
	memUsage := round1(pick(15, 92))
	swapUsage := 0.0
	if r.Float64() < 0.4 {
		swapUsage = round1(pick(0, 22))
	}
	diskSystem := round1(pick(20, 86))
	diskData := round1(pick(25, 92))
	diskNas := round1(pick(30, 88))
	uptime := round1(pick(1, 430))
	ntp := float64(0)
	if r.Float64() < 0.15 {
		ntp = round1(pick(50, 2600))
	}

	// 磁盘（模拟真实环境：系统盘 vda（LVM：/、/boot、/home）+ 数据盘 vdb（必有）/ vdc（较少）+ 可能 NAS）
	disks := []map[string]interface{}{
		{"device": "/dev/mapper/centos-root", "mount": "/", "fstype": "xfs", "role": "system",
			"total_gb": round1(pick(40, 60)), "used_gb": round1(diskSystem / 100 * pick(40, 60)), "usage": diskSystem},
		{"device": "/dev/vda1", "mount": "/boot", "fstype": "xfs", "role": "system",
			"total_gb": 1.0, "used_gb": round1(pick(0.2, 0.6)), "usage": round1(pick(20, 55))},
	}
	if r.Float64() < 0.6 {
		home := round1(pick(30, 50))
		disks = append(disks, map[string]interface{}{
			"device": "/dev/mapper/centos-home", "mount": "/home", "fstype": "xfs", "role": "system",
			"total_gb": home, "used_gb": round1(diskSystem / 100 * home), "usage": diskSystem,
		})
	}
	// 数据盘 vdb（必有）
	tot := round1(pick(200, 800))
	disks = append(disks, map[string]interface{}{
		"device": "/dev/vdb", "mount": "/data", "fstype": "xfs", "role": "data",
		"total_gb": tot, "used_gb": round1(diskData / 100 * tot), "usage": diskData,
	})
	// 数据盘 vdc（较少出现）
	if r.Float64() < 0.3 {
		tot2 := round1(pick(500, 2000))
		disks = append(disks, map[string]interface{}{
			"device": "/dev/vdc", "mount": "/data2", "fstype": "xfs", "role": "data",
			"total_gb": tot2, "used_gb": round1(diskData / 100 * tot2), "usage": diskData,
		})
	}
	if r.Float64() < 0.5 {
		tot := round1(pick(1000, 4000))
		disks = append(disks, map[string]interface{}{
			"device": "nas-server:/share", "mount": "/nas", "fstype": "nfs", "role": "nas",
			"total_gb": tot, "used_gb": round1(diskNas / 100 * tot), "usage": diskNas,
		})
	}
	// 模拟 inode 使用率（略高于容量使用率）
	for _, dk := range disks {
		if u, ok := dk["usage"].(float64); ok {
			dk["inode_usage"] = round1(math.Min(99, u+pick(-5, 10)))
		}
	}

	// 网络接口
	ifaces := []map[string]interface{}{}
	ifaceNames := []string{"eth0", "eth1", "bond0"}
	for _, name := range ifaceNames {
		if r.Float64() < 0.25 && name != "eth0" {
			continue
		}
		speed := 1000.0
		if r.Float64() < 0.3 {
			speed = 10000.0
		}
		rx := round1(pick(0, speed*0.6))
		tx := round1(pick(0, speed*0.4))
		ifaces = append(ifaces, map[string]interface{}{
			"name": name, "rx_mbps": rx, "tx_mbps": tx, "speed_mbps": speed,
			"bandwidth_pct": round1((rx + tx) / speed * 100), "rx_drop": 0, "tx_drop": 0,
		})
	}
	pl := 0.0
	if r.Float64() < 0.1 {
		pl = round1(pick(0.1, 1.2))
	}

	// 进程
	top := []map[string]interface{}{}
	commSamples := []string{"systemd", "nginx", "mysqld", "redis-server", "java", "python3", "dockerd"}
	for i := 0; i < 6; i++ {
		top = append(top, map[string]interface{}{
			"name": commSamples[r.Intn(len(commSamples))],
			"pid":  1000 + r.Intn(20000),
			"cpu":  round1(pick(0, 25)),
			"mem":  round1(pick(0, 12)),
		})
	}
	zombie := 0
	if r.Float64() < 0.1 {
		zombie = 1 + r.Intn(3)
	}

	// 核心进程（联动中间件类型）
	core := []map[string]interface{}{}
	for _, t := range mwTypes {
		pats := mwProcPatterns[t]
		if len(pats) == 0 {
			continue
		}
		alive := r.Float64() > 0.12
		pid := (*int)(nil)
		cpu := 0.0
		mem := 0.0
		if alive {
			p := 2000 + r.Intn(30000)
			pid = &p
			cpu = round1(pick(0.5, 30))
			mem = round1(pick(0.5, 18))
		}
		core = append(core, map[string]interface{}{
			"type": t, "pattern": pats[0], "alive": alive, "pid": pid, "cpu": cpu, "mem": mem,
		})
	}

	netStates := map[string]interface{}{"ESTABLISHED": r.Intn(400) + 20, "TIME_WAIT": r.Intn(800), "SYN_RECV": r.Intn(5), "CLOSE_WAIT": r.Intn(20), "LISTEN": r.Intn(30) + 5}
	netConn := 0.0
	for _, v := range netStates {
		if fv, ok := v.(int); ok {
			netConn += float64(fv)
		}
	}
	listenPorts := r.Intn(30) + 5

	return map[string]interface{}{
		"os": map[string]interface{}{
			"hostname":      fmt.Sprintf("host-%s", strings.ReplaceAll(ip, ".", "-")),
			"name":          o.name,
			"id":            o.id,
			"family":        o.family,
			"pretty":        fmt.Sprintf("%s %s", o.name, o.version),
			"version":       o.version,
			"arch":          o.arch,
			"kernel":        o.kernel,
			"timezone":      "Asia/Shanghai",
			"ntp_offset_ms": ntp,
			"uptime_days":   uptime,
			"boot_time":     time.Now().Add(-time.Duration(uptime*24) * time.Hour).Format("2006-01-02 15:04"),
			"selinux":       "enforcing",
		},
		"cpu": map[string]interface{}{
			"model":      "Intel(R) Xeon(R) Gold 6266C",
			"cores":      cores,
			"usage":      cpuUsage,
			"iowait":     cpuIowait,
			"load1":      round1(cpuUsage / 100 * cores * pick(0.3, 1.2)),
			"load5":      round1(cpuUsage / 100 * cores * pick(0.25, 1.0)),
			"load15":     round1(cpuUsage / 100 * cores * pick(0.2, 0.9)),
			"load_ratio": round1(cpuUsage * pick(0.3, 1.2)),
			"per_core":   perCore(r, cores, cpuUsage),
		},
		"mem": map[string]interface{}{
			"total_gb":      memTotal,
			"used_gb":       round1(memTotal * memUsage / 100),
			"available_gb":  round1(memTotal * (1 - memUsage/100)),
			"cache_gb":      round1(memTotal * (0.1 + 0.3*pick(0, 1))),
			"usage":         memUsage,
			"swap_total_gb": round1(memTotal * 0.5),
			"swap_used_gb":  round1(memTotal * 0.5 * swapUsage / 100),
			"swap_usage":    swapUsage,
		},
		"disk": map[string]interface{}{"disks": disks},
		"net": map[string]interface{}{
			"interfaces":        ifaces,
			"packet_loss_pct":   pl,
			"tcp_states":        netStates,
			"tcp_retrans_pct":   round1(pick(0, 1.5)),
			"listen_port_count": listenPorts,
			"conn_total":        netConn,
		},
		"proc": map[string]interface{}{
			"total":    int(pick(120, 600)),
			"zombie":   zombie,
			"top":      top,
			"core":     core,
			"mw_count": len(core),
		},
		"security": map[string]interface{}{
			"firewalld":      "running",
			"selinux":        "enforcing",
			"root_login":     true,
			"ssh_fail_24h":   r.Intn(30),
			"open_ports":     []string{"22", "80", "443"},
			"ssh_port":       65181,
			"sshd_config":    "ok",
			"last_ssh_login": time.Now().Add(-time.Duration(r.Intn(48)) * time.Hour).Format("2006-01-02 15:04"),
		},
	}
}

func perCore(r *rand.Rand, cores float64, usage float64) []float64 {
	out := []float64{}
	base := usage
	for i := 0; i < int(cores); i++ {
		v := round1(base + r.Float64()*40 - 15)
		if v < 0 {
			v = 0
		}
		if v > 100 {
			v = 100
		}
		out = append(out, v)
	}
	return out
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}

// toMapSlice 将可能是 []map[string]interface{} 或 []interface{} 的切片统一转换为 map 切片。
// 注意：Go 中具体类型的切片（如 []map[string]interface{}）无法直接断言为 []interface{}，
// 模拟数据走具体类型、真实 JSON 反序列化走 interface{}，两者都必须兼容。
func toMapSlice(v interface{}) []map[string]interface{} {
	switch t := v.(type) {
	case []map[string]interface{}:
		return t
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(t))
		for _, x := range t {
			if m, ok := x.(map[string]interface{}); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

// toFloatSlice 将可能是 []float64 或 []interface{} 的切片统一转换为 float64 切片。
func toFloatSlice(v interface{}) []float64 {
	switch t := v.(type) {
	case []float64:
		return t
	case []interface{}:
		out := make([]float64, 0, len(t))
		for _, x := range t {
			if f, ok := x.(float64); ok {
				out = append(out, f)
			}
		}
		return out
	}
	return nil
}

// resolveFlat 把结构化采集结果派生为扁平指标（兼容旧版扁平记录）
func resolveFlat(d map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for k, v := range d {
		if knownFlatKeys[k] {
			out[k] = v
		}
	}
	getMap := func(k string) map[string]interface{} {
		if m, ok := d[k].(map[string]interface{}); ok {
			return m
		}
		return nil
	}
	fnum := func(v interface{}) (float64, bool) {
		switch t := v.(type) {
		case float64:
			return t, true
		case int:
			return float64(t), true
		case int64:
			return float64(t), true
		}
		return 0, false
	}

	if m := getMap("os"); m != nil {
		out["os_hostname"] = m["hostname"]
		out["os_name"] = m["name"]
		out["os_id"] = m["id"]
		out["os_family"] = m["family"]
		out["os_version"] = m["version"]
		out["os_arch"] = m["arch"]
		out["os_kernel"] = m["kernel"]
		out["os_timezone"] = m["timezone"]
		out["selinux_status"] = m["selinux"]
		out["ntp_offset_ms"] = m["ntp_offset_ms"]
		out["uptime_days"] = m["uptime_days"]
		out["boot_time"] = m["boot_time"]
	}
	if m := getMap("cpu"); m != nil {
		out["cpu_model"] = m["model"]
		out["cpu_cores"] = m["cores"]
		out["cpu_usage"] = m["usage"]
		out["cpu_iowait"] = m["iowait"]
		out["cpu_load_ratio"] = m["load_ratio"]
		out["load1"] = m["load1"]
		out["load5"] = m["load5"]
		out["load15"] = m["load15"]
		if arr := toFloatSlice(m["per_core"]); arr != nil {
			max := 0.0
			for _, fv := range arr {
				if fv > max {
					max = fv
				}
			}
			out["cpu_per_core_max"] = max
		}
	}
	if m := getMap("mem"); m != nil {
		out["mem_total_gb"] = m["total_gb"]
		out["mem_used_gb"] = m["used_gb"]
		out["mem_available_gb"] = m["available_gb"]
		out["mem_cache_gb"] = m["cache_gb"]
		out["mem_usage"] = m["usage"]
		out["swap_total_gb"] = m["swap_total_gb"]
		out["swap_used_gb"] = m["swap_used_gb"]
		out["swap_usage"] = m["swap_usage"]
	}
	if m := getMap("disk"); m != nil {
		if arr := toMapSlice(m["disks"]); arr != nil {
			var sys, dataMax, nasMax, sysInode, dataInodeMax float64
			dataCnt, nasCnt := 0, 0
			for _, mm := range arr {
				usage, _ := fnum(mm["usage"])
				role, _ := mm["role"].(string)
				switch role {
				case "system":
					sys = usage
				case "data":
					if usage > dataMax {
						dataMax = usage
					}
					dataCnt++
				case "nas":
					if usage > nasMax {
						nasMax = usage
					}
					nasCnt++
				default:
					if usage > dataMax {
						dataMax = usage
					}
					dataCnt++
				}
				if iv, ok := fnum(mm["inode_usage"]); ok {
					switch role {
					case "system":
						sysInode = iv
					case "data":
						if iv > dataInodeMax {
							dataInodeMax = iv
						}
					}
				}
			}
			out["disk_system_usage"] = sys
			out["disk_system_inode_usage"] = sysInode
			out["disk_data_max_usage"] = dataMax
			out["disk_data_inode_max_usage"] = dataInodeMax
			out["disk_data_count"] = dataCnt
			out["disk_nas_max_usage"] = nasMax
			out["disk_nas_count"] = nasCnt
		}
	}
	if m := getMap("net"); m != nil {
		if arr := toMapSlice(m["interfaces"]); arr != nil {
			max := 0.0
			for _, mm := range arr {
				if v, ok := fnum(mm["bandwidth_pct"]); ok && v > max {
					max = v
				}
			}
			out["net_bandwidth_max_pct"] = max
		}
		out["packet_loss_pct"] = m["packet_loss_pct"]
		out["tcp_retrans_pct"] = m["tcp_retrans_pct"]
		out["listen_port_count"] = m["listen_port_count"]
		if ts, ok := m["tcp_states"].(map[string]interface{}); ok {
			for _, k := range []string{"ESTABLISHED", "TIME_WAIT", "SYN_RECV", "CLOSE_WAIT", "LISTEN"} {
				if v, ok := fnum(ts[k]); ok {
					out["tcp_"+strings.ToLower(k)] = v
				}
			}
			tot := 0.0
			for _, v := range ts {
				if fv, ok := fnum(v); ok {
					tot += fv
				}
			}
			out["tcp_total"] = tot
			out["conn_total"] = tot
		}
	}
	if m := getMap("proc"); m != nil {
		out["total_proc"] = m["total"]
		out["zombie_count"] = m["zombie"]
		if arr := toMapSlice(m["core"]); arr != nil {
			out["core_proc_total"] = len(arr)
			out["svc_core_total"] = len(arr)
			down := 0
			for _, mm := range arr {
				if a, ok := mm["alive"].(bool); ok && !a {
					down++
				}
			}
			out["core_proc_down"] = down
			out["svc_core_down"] = down
		}
		if v, ok := fnum(m["mw_count"]); ok {
			out["svc_mw_count"] = v
		}
	}
	if m := getMap("security"); m != nil {
		out["sec_firewall"] = m["firewall"]
		out["sec_selinux"] = m["selinux"]
		out["sec_root_login"] = m["root_login"]
		out["sec_ssh_fail_24h"] = m["ssh_fail_24h"]
		out["sec_open_ports"] = m["open_ports"]
	}
	return out
}

// evalAlerts 按目录默认阈值评估告警项（无规则场景，等价于 evalAlertsWithProfile(d, nil)）
func evalAlerts(d map[string]interface{}) []map[string]interface{} {
	return evalAlertsWithProfile(d, nil)
}

// evalAlertsWithProfile 按给定阈值/屏蔽配置评估告警项。
// profile == nil 时行为与历史版本一致（全部沿用目录默认阈值、不屏蔽任何项）。
func evalAlertsWithProfile(d map[string]interface{}, profile *AlertProfile) []map[string]interface{} {
	alerts := []map[string]interface{}{}
	if profile != nil && profile.MuteAll {
		// 该资产（或其所属项目/应用系统）已被规则整体屏蔽：不产生任何告警，
		// 也就不会进入大屏列表、分类统计与告警趋势
		return alerts
	}
	flat := resolveFlat(d)
	add := func(metric, key, level string, value interface{}, note string) {
		if profile.muted(key) {
			return
		}
		alerts = append(alerts, map[string]interface{}{
			"metric": metric, "key": key, "level": level, "value": value, "note": note,
		})
	}
	fnum := func(v interface{}) (float64, bool) {
		switch t := v.(type) {
		case float64:
			return t, true
		case int:
			return float64(t), true
		}
		return 0, false
	}

	// 百分比 / 数值阈值（来自目录，阈值可被规则覆盖）
	for _, def := range FlatMetricDefs() {
		if !def.IsPercent {
			continue
		}
		v, ok := fnum(flat[def.Key])
		if !ok {
			continue
		}
		warn, crit := profile.thr(def.Key, def.Warn, def.Crit)
		// 阈值被规则覆盖时，把生效值写进说明——否则用户改完阈值只看到「持续>70%需关注」的
		// 静态文案，无法判断这条告警是用哪套阈值判出来的
		note := def.Note
		if warn != def.Warn || crit != def.Crit {
			note = strings.TrimSpace(note) + fmt.Sprintf("（阈值已自定义：预警 %s，严重 %s）", thrText(warn), thrText(crit))
		}
		if crit > 0 && v >= crit {
			add(def.Label, def.Key, "critical", v, note)
		} else if warn > 0 && v >= warn {
			add(def.Label, def.Key, "warning", v, note)
		}
	}

	// NTP 偏差（按绝对值比较）
	if v, ok := fnum(flat["ntp_offset_ms"]); ok {
		warn, crit := profile.thr("ntp_offset_ms", 1000, 0)
		av := math.Abs(v)
		if crit > 0 && av >= crit {
			add("系统时间与NTP偏差", "ntp_offset_ms", "critical", v,
				fmt.Sprintf("偏差 %.1fms ≥ 严重阈值 %sms", av, thrText(crit)))
		} else if warn > 0 && av >= warn {
			add("系统时间与NTP偏差", "ntp_offset_ms", "warning", v,
				fmt.Sprintf("偏差 %.1fms ≥ 预警阈值 %sms", av, thrText(warn)))
		}
	}
	// 运行时长
	if v, ok := fnum(flat["uptime_days"]); ok {
		warn, crit := profile.thr("uptime_days", 200, 0)
		if crit > 0 && v >= crit {
			add("运行时长", "uptime_days", "critical", v,
				fmt.Sprintf("已达 %.1f 天，≥ 严重阈值 %s 天", v, thrText(crit)))
		} else if warn > 0 && v >= warn {
			add("运行时长", "uptime_days", "warning", v,
				fmt.Sprintf("已达 %.1f 天，超过 %s 天建议计划重启（补丁更新）", v, thrText(warn)))
		}
	}
	// 系统负载（1 分钟负载相对核心数）
	if c, ok := fnum(flat["cpu_cores"]); ok && c > 0 {
		if l, ok := fnum(flat["load1"]); ok {
			warn, crit := profile.thr("load1_ratio", 70, 100)
			ratio := l / c * 100
			note := fmt.Sprintf("负载 %.2f 为核心数(%s) 的 %.0f%%", l, thrText(c), ratio)
			if crit > 0 && ratio >= crit {
				add("系统负载(1m)", "load1", "critical", l, note+fmt.Sprintf("，≥ 严重阈值 %s%%", thrText(crit)))
			} else if warn > 0 && ratio >= warn {
				add("系统负载(1m)", "load1", "warning", l, note+fmt.Sprintf("，≥ 预警阈值 %s%%", thrText(warn)))
			}
		}
	}
	// 单核打满（仅预警级；严重级由上面的 cpu_per_core_max 百分比目录项用同一阈值判定，避免重复报严重）
	if v, ok := fnum(flat["cpu_per_core_max"]); ok {
		if warn, _ := profile.thr("cpu_per_core_max", 100, 0); warn > 0 && v >= warn {
			add("单核使用率", "cpu_per_core_max", "warning", v, "存在单核打满，整体可能空闲")
		}
	}
	// 逐盘告警（系统盘/NAS 与 数据盘用各自阈值）
	if m, ok := d["disk"].(map[string]interface{}); ok {
		if arr := toMapSlice(m["disks"]); arr != nil {
			for _, mm := range arr {
				usage, ok := fnum(mm["usage"])
				if !ok {
					continue
				}
				mount, _ := mm["mount"].(string)
				role, _ := mm["role"].(string)
				warn, crit := profile.thr("disk_usage", 75, 80)
				if role == "data" {
					warn, crit = profile.thr("disk_data_usage", 70, 80)
				}
				note := fmt.Sprintf("(%s盘 挂载点 %s)", role, mount)
				label := fmt.Sprintf("磁盘 %s", mount)
				if crit > 0 && usage >= crit {
					add(label, "disk_usage", "critical", usage, note)
				} else if warn > 0 && usage >= warn {
					add(label, "disk_usage", "warning", usage, note)
				}
			}
		}
	}
	// 核心进程存活（归入"服务与中间件"分类）
	if m, ok := d["proc"].(map[string]interface{}); ok {
		if arr := toMapSlice(m["core"]); arr != nil {
			for _, mm := range arr {
				alive, ok := mm["alive"].(bool)
				if ok && !alive {
					t, _ := mm["type"].(string)
					add("核心进程存活", "svc_core_down", "critical", 0, fmt.Sprintf("核心进程未运行: %s", t))
				}
			}
		}
	}
	// 近 24h 失败 SSH 登录（疑似暴力破解）
	if v, ok := fnum(flat["sec_ssh_fail_24h"]); ok {
		warn, crit := profile.thr("sec_ssh_fail_24h", 20, 0)
		if crit > 0 && v >= crit {
			add("近24h失败SSH登录", "sec_ssh_fail_24h", "critical", v,
				fmt.Sprintf("%s 次 ≥ 严重阈值 %s 次，请核查安全日志", thrText(v), thrText(crit)))
		} else if warn > 0 && v >= warn {
			add("近24h失败SSH登录", "sec_ssh_fail_24h", "warning", v,
				fmt.Sprintf("%s 次 ≥ 预警阈值 %s 次，疑似暴力破解", thrText(v), thrText(warn)))
		}
	}
	return alerts
}

// formatAlertLabel 生成告警文本标签
func formatAlertLabel(a map[string]interface{}) string {
	metric, _ := a["metric"].(string)
	level, _ := a["level"].(string)
	note, _ := a["note"].(string)
	if level == "critical" || level == "warning" {
		suffix := ""
		if note != "" {
			suffix = "（" + note + "）"
		}
		return metric + suffix
	}
	return metric
}

// alertLevel 取一组告警中的最高级别
func alertLevel(alerts []map[string]interface{}) string {
	level := "warning"
	for _, a := range alerts {
		if a["level"] == "critical" {
			return "critical"
		}
	}
	return level
}

// categoryOfAlert 返回告警所属分类（用于分类统计）
func categoryOfAlert(a map[string]interface{}) string {
	key, _ := a["key"].(string)
	for _, def := range FlatMetricDefs() {
		if def.Key == key {
			return def.Category
		}
	}
	// 非目录键（磁盘/核心进程等）按 metric 关键字归类
	metric, _ := a["metric"].(string)
	switch {
	case strings.Contains(metric, "磁盘"):
		return "disk"
	case strings.Contains(metric, "核心进程"):
		return "proc"
	case strings.Contains(metric, "负载") || strings.Contains(metric, "单核"):
		return "cpu"
	case strings.Contains(metric, "NTP") || strings.Contains(metric, "运行时长"):
		return "os"
	}
	return "other"
}
