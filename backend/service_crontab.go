package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ============================================================================
// CRONTAB 核心逻辑（纯函数，无网络/无数据库依赖，便于单测）
//
// 设计口径（2026-09-16 收敛）：
//  1. **唯一数据源 = `crontab -l` 的输出**：平台执行 `crontab -l`（需要时
//     以 sudo 提到维护用户身份）拿到该用户 crontab 的真实内容，增删改同样
//     通过 crontab 自身安装回去。实测证据：某台 Jenkins 机器 /etc/crontab
//     只有发行版模板，而 `crontab -l`（root）里有 3 条真实任务 —— 只读
//     /etc/crontab 会漏报，故以 crontab -l 为准。
//     平台不存任务副本、不维护任务元数据表，看到的即机器上真实在跑的。
//  2. **逐行解析**：任务行（含被注释的禁用行）解析为结构化条目；注释行、
//     环境变量行、空行原样保留，平台不解释也不改动它们。
//     用户 crontab 的任务行**没有「运行用户」段**（整份 crontab 都属于
//     同一个用户）：`m h dom mon dow <command>`。
//  3. **禁用** = 注释掉任务行（`#` 紧贴 cron 表达式，如 `#0 1 * * * cmd`），
//     可无损还原为启用。
//  4. 命令里的 % 在 crontab 中有特殊含义（其后内容作为 stdin 送入），
//     下发时转义为 \%；接口回显时还原为用户原文。
// ============================================================================

// ---------------- cron 表达式校验 ----------------

type cronFieldDef struct {
	Name  string
	Min   int
	Max   int
	Names map[string]int // 月份 / 星期的英文缩写
}

var cronMacros = map[string]string{
	"@reboot":   "开机时执行",
	"@yearly":   "每年 1 月 1 日 00:00",
	"@annually": "每年 1 月 1 日 00:00",
	"@monthly":  "每月 1 日 00:00",
	"@weekly":   "每周日 00:00",
	"@daily":    "每天 00:00",
	"@midnight": "每天 00:00",
	"@hourly":   "每小时整点",
}

var (
	cronMonthNames = map[string]int{
		"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
	}
	cronDowNames = map[string]int{
		"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
	}
	cronFieldDefs = []cronFieldDef{
		{Name: "分钟", Min: 0, Max: 59},
		{Name: "小时", Min: 0, Max: 23},
		{Name: "日", Min: 1, Max: 31},
		{Name: "月", Min: 1, Max: 12, Names: cronMonthNames},
		{Name: "星期", Min: 0, Max: 7, Names: cronDowNames}, // 7 与 0 同为周日
	}
)

// cronSets 解析后的字段取值集合
type cronSets [5]map[int]bool

// validateCron 校验并规范化 cron 表达式（5 段：分 时 日 月 周，或 @ 宏）。
// 返回规范化后的表达式；非法时返回中文错误信息。
func validateCron(expr string) (string, error) {
	e := strings.Join(strings.Fields(strings.TrimSpace(expr)), " ")
	if e == "" {
		return "", fmt.Errorf("cron 表达式不能为空")
	}
	low := strings.ToLower(e)
	if strings.HasPrefix(low, "@") {
		if _, ok := cronMacros[low]; !ok {
			return "", fmt.Errorf("不支持的 @ 宏：%s（可用：@reboot / @hourly / @daily / @weekly / @monthly / @yearly）", e)
		}
		return low, nil
	}
	parts := strings.Fields(e)
	if len(parts) != 5 {
		return "", fmt.Errorf("cron 表达式应为 5 段（分 时 日 月 周），当前为 %d 段：%s", len(parts), e)
	}
	for i, p := range parts {
		if _, err := parseCronField(p, cronFieldDefs[i]); err != nil {
			return "", err
		}
	}
	return strings.Join(parts, " "), nil
}

// parseCronField 解析单个字段为取值集合。
// 支持 *、*/n、a、a-b、a-b/n、以及逗号分隔的组合；月/周支持英文缩写。
func parseCronField(raw string, def cronFieldDef) (map[int]bool, error) {
	set := map[int]bool{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, fmt.Errorf("%s 字段存在空的取值项：%s", def.Name, raw)
		}
		step := 1
		body := item
		if idx := strings.LastIndex(item, "/"); idx >= 0 {
			body = strings.TrimSpace(item[:idx])
			st := strings.TrimSpace(item[idx+1:])
			n, err := strconv.Atoi(st)
			if err != nil || n <= 0 {
				return nil, fmt.Errorf("%s 字段的步长不合法：%s", def.Name, item)
			}
			step = n
		}
		lo, hi := def.Min, def.Max
		switch {
		case body == "*":
			// 保持 Min~Max
		case strings.Contains(body, "-"):
			h := strings.SplitN(body, "-", 2)
			a, err1 := cronVal(h[0], def)
			b, err2 := cronVal(h[1], def)
			if err1 != nil || err2 != nil {
				return nil, fmt.Errorf("%s 字段的区间不合法：%s", def.Name, item)
			}
			if a > b {
				return nil, fmt.Errorf("%s 字段的区间起点大于终点：%s", def.Name, item)
			}
			lo, hi = a, b
		default:
			v, err := cronVal(body, def)
			if err != nil {
				return nil, err
			}
			if strings.Contains(item, "/") {
				// a/n 视为「从 a 到最大值，步长 n」
				lo = v
			} else {
				lo, hi = v, v
			}
		}
		for v := lo; v <= hi; v += step {
			if v < def.Min || v > def.Max {
				return nil, fmt.Errorf("%s 字段取值超出范围（%d-%d）：%s", def.Name, def.Min, def.Max, item)
			}
			// 星期 7 归一为 0（同为周日）
			if def.Name == "星期" && v == 7 {
				set[0] = true
			}
			set[v] = true
		}
	}
	if len(set) == 0 {
		return nil, fmt.Errorf("%s 字段未解析出任何有效取值：%s", def.Name, raw)
	}
	return set, nil
}

func cronVal(token string, def cronFieldDef) (int, error) {
	t := strings.TrimSpace(token)
	if def.Names != nil {
		if v, ok := def.Names[strings.ToLower(t)]; ok {
			return v, nil
		}
	}
	n, err := strconv.Atoi(t)
	if err != nil {
		return 0, fmt.Errorf("%s 字段取值不合法：%s（应为 %d-%d 的数字）", def.Name, token, def.Min, def.Max)
	}
	if n < def.Min || n > def.Max {
		return 0, fmt.Errorf("%s 字段取值超出范围（%d-%d）：%s", def.Name, def.Min, def.Max, token)
	}
	return n, nil
}

// parseCronSets 解析为集合；宏表达式返回 false（无法逐字段描述）
func parseCronSets(expr string) (cronSets, bool) {
	var sets cronSets
	e := strings.Join(strings.Fields(strings.TrimSpace(expr)), " ")
	if e == "" || strings.HasPrefix(e, "@") {
		return sets, false
	}
	parts := strings.Fields(e)
	if len(parts) != 5 {
		return sets, false
	}
	for i, p := range parts {
		s, err := parseCronField(p, cronFieldDefs[i])
		if err != nil {
			return sets, false
		}
		sets[i] = s
	}
	return sets, true
}

// fieldForm 字段的「简单形态」，用于生成人类可读描述
type fieldForm struct {
	Kind string // all / step / one / other
	Step int
	Val  int
	Vals []int
}

func analyzeField(raw string, def cronFieldDef) fieldForm {
	r := strings.TrimSpace(raw)
	if r == "*" {
		return fieldForm{Kind: "all"}
	}
	if strings.HasPrefix(r, "*/") {
		if n, err := strconv.Atoi(strings.TrimPrefix(r, "*/")); err == nil && n > 0 {
			return fieldForm{Kind: "step", Step: n}
		}
		return fieldForm{Kind: "other"}
	}
	// 形如 0-23/2 的「全区间带步长」，语义上等同于 */2
	if idx := strings.LastIndex(r, "/"); idx > 0 {
		body := strings.TrimSpace(r[:idx])
		if h := strings.SplitN(body, "-", 2); len(h) == 2 && !strings.Contains(body, ",") {
			a, e1 := cronVal(h[0], def)
			b, e2 := cronVal(h[1], def)
			n, e3 := strconv.Atoi(strings.TrimSpace(r[idx+1:]))
			if e1 == nil && e2 == nil && e3 == nil && a == def.Min && b == def.Max && n > 0 {
				return fieldForm{Kind: "step", Step: n}
			}
		}
	}
	if s, err := parseCronField(r, def); err == nil {
		vals := make([]int, 0, len(s))
		for v := range s {
			vals = append(vals, v)
		}
		sort.Ints(vals)
		if len(vals) == 1 {
			return fieldForm{Kind: "one", Val: vals[0], Vals: vals}
		}
		if len(vals) <= 7 && !strings.Contains(r, "-") && !strings.Contains(r, "*") {
			return fieldForm{Kind: "one", Val: -1, Vals: vals} // 逗号列举
		}
		return fieldForm{Kind: "other"}
	}
	return fieldForm{Kind: "other"}
}

var cronWeekdayCN = map[int]string{0: "周日", 1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六"}

// describeCron 生成中文可读描述。无法精确概括时返回「自定义计划」，
// 不做过度猜测（避免误导运维判断）。
func describeCron(expr string) string {
	e := strings.Join(strings.Fields(strings.TrimSpace(expr)), " ")
	if e == "" {
		return "未设置"
	}
	if strings.HasPrefix(e, "@") {
		if d, ok := cronMacros[strings.ToLower(e)]; ok {
			return d
		}
		return "自定义计划"
	}
	parts := strings.Fields(e)
	if len(parts) != 5 {
		return "自定义计划"
	}
	mn := analyzeField(parts[0], cronFieldDefs[0])
	hr := analyzeField(parts[1], cronFieldDefs[1])
	dm := analyzeField(parts[2], cronFieldDefs[2])
	mo := analyzeField(parts[3], cronFieldDefs[3])
	dw := analyzeField(parts[4], cronFieldDefs[4])
	if mn.Kind == "other" || hr.Kind == "other" || dm.Kind == "other" || mo.Kind == "other" || dw.Kind == "other" {
		return "自定义计划"
	}

	// 日期部分
	var date string
	switch {
	case dm.Kind == "all" && mo.Kind == "all" && dw.Kind == "all":
		date = "每天"
	case dm.Kind == "all" && mo.Kind == "all" && dw.Kind != "all":
		names := make([]string, 0, 8)
		for _, v := range dw.Vals {
			if n, ok := cronWeekdayCN[v%7]; ok {
				names = append(names, n)
			}
		}
		if len(names) == 0 {
			return "自定义计划"
		}
		date = "每" + strings.Join(names, "、")
	case mo.Kind == "all" && dm.Kind == "one" && dm.Val > 0 && dw.Kind == "all":
		date = fmt.Sprintf("每月 %d 日", dm.Val)
	case mo.Kind == "one" && dm.Kind == "one" && dm.Val > 0 && dw.Kind == "all":
		date = fmt.Sprintf("每年 %d 月 %d 日", mo.Val, dm.Val)
	case mo.Kind == "step" && dm.Kind == "all" && dw.Kind == "all":
		date = fmt.Sprintf("每 %d 个月", mo.Step)
	default:
		return "自定义计划"
	}

	// 时间部分
	var tm string
	switch {
	case hr.Kind == "all" && mn.Kind == "all":
		tm = "每分钟"
	case hr.Kind == "all" && mn.Kind == "step":
		tm = fmt.Sprintf("每 %d 分钟", mn.Step)
	case hr.Kind == "all" && mn.Kind == "one" && mn.Val == 0:
		tm = "每小时整点"
	case hr.Kind == "all" && mn.Kind == "one" && mn.Val > 0:
		tm = fmt.Sprintf("每小时第 %d 分", mn.Val)
	case hr.Kind == "step" && mn.Kind == "one":
		tm = fmt.Sprintf("每 %d 小时的第 %d 分", hr.Step, mn.Val)
	case hr.Kind == "one" && mn.Kind == "one":
		tm = fmt.Sprintf("%02d:%02d", hr.Val, mn.Val)
	case hr.Kind == "one" && mn.Kind == "step":
		tm = fmt.Sprintf("%02d 点起每 %d 分钟", hr.Val, mn.Step)
	case hr.Kind == "one" && mn.Kind == "all":
		tm = fmt.Sprintf("%02d 点内每分钟", hr.Val)
	default:
		return "自定义计划"
	}

	if tm == "每分钟" && date == "每天" {
		return "每分钟"
	}
	return date + " " + tm
}

// ---------------- crontab 逐行解析 / 渲染 ----------------

// 行类型
const (
	crontabLineTask     = "task"     // 启用的定时任务
	crontabLineDisabled = "disabled" // 被注释掉的定时任务（可一键恢复）
	crontabLineComment  = "comment"  // 普通注释 / 无法识别的行
	crontabLineEnv      = "env"      // 环境变量赋值（如 SHELL=/bin/bash）
	crontabLineBlank    = "blank"    // 空行
)

// crontabEntry 用户 crontab 的一行及其解析结果
type crontabEntry struct {
	LineNo   int    `json:"lineNo"` // 1-based 行号，修改/删除时用于定位
	Raw      string `json:"raw"`    // 原始行内容（定位 + 并发校验）
	Kind     string `json:"kind"`   // task / disabled / comment / env / blank
	Expr     string `json:"expr,omitempty"`
	Command  string `json:"command,omitempty"`
	Enabled  bool   `json:"enabled"`
	Describe string `json:"describe,omitempty"`
	// NoteKey 「用途」备注的存储键（由命令算出，见 crontabNoteKey）；
	// 只有单机视图会填，批量扫描不带备注。
	NoteKey string `json:"noteKey,omitempty"`
	// Purpose 人工填写的用途（平台侧备注，不写回目标机）
	Purpose string `json:"purpose,omitempty"`
}

// splitCrontabLines 把 crontab 原文切成行（保留空行与原始顺序）
func splitCrontabLines(text string) []string {
	if text == "" {
		return []string{}
	}
	body := strings.TrimSuffix(text, "\n")
	if body == "" {
		return []string{""}
	}
	return strings.Split(body, "\n")
}

// joinCrontabLines 还原为文本；crontab 惯例以换行结尾
func joinCrontabLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

// parseUserCrontabEntries 逐行解析整份用户 crontab（`crontab -l` 的输出）
func parseUserCrontabEntries(text string) []crontabEntry {
	lines := splitCrontabLines(text)
	out := make([]crontabEntry, 0, len(lines))
	for i, ln := range lines {
		out = append(out, parseUserCrontabLine(i+1, ln))
	}
	return out
}

// parseUserCrontabLine 解析用户 crontab 单行。
//
// 解析不出来的行按注释 / 环境变量 / 空行归类，原样保留（平台不解释也不改动）。
func parseUserCrontabLine(no int, line string) crontabEntry {
	e := crontabEntry{LineNo: no, Raw: line}
	if strings.TrimSpace(line) == "" {
		e.Kind = crontabLineBlank
		return e
	}
	// 任务行（含被注释的禁用行）
	if expr, cmd, enabled, ok := splitUserCronLine(line); ok {
		e.Expr = expr
		e.Command = unescapeCronPercent(cmd)
		e.Enabled = enabled
		e.Describe = describeCron(expr)
		if enabled {
			e.Kind = crontabLineTask
		} else {
			e.Kind = crontabLineDisabled
		}
		return e
	}
	trimmed := strings.TrimLeft(line, " \t")
	if !strings.HasPrefix(trimmed, "#") {
		// 环境变量行：NAME=value（NAME 不含空白）
		if idx := strings.Index(trimmed, "="); idx > 0 {
			name := strings.TrimSpace(trimmed[:idx])
			if name != "" && !strings.ContainsAny(name, " \t") {
				e.Kind = crontabLineEnv
				return e
			}
		}
	}
	e.Kind = crontabLineComment
	return e
}

// splitUserCronLine 拆解用户 crontab 的任务行 →
// (cron 表达式, 命令, 是否启用, 是否可解析)
//
// 形如 `0 1 * * * /bin/bash /data/backup.sh`；
// 禁用行 = 行首 # 紧贴同一格式（`#0 1 * * * /bin/bash a.sh`）；
// @ 宏行形如 `@reboot /bin/bash a.sh`。
//
// 判成任务行需同时满足两个条件：
//  1. 表达式能通过 validateCron（5 段合法 cron 或受支持的 @ 宏）
//  2. 以 # 开头时，`#` 必须**紧贴**表达式（平台写回的禁用行就是 `#` + 表达式）
//
// 条件 2 是挡住「说明性注释被误判成禁用任务」的关键：发行版自带模板里的
// man 手册图例（`# |  |  .---------- day of month (1 - 31)`、
// `# *  *  *  *  * user-name  command to be executed`）与人工写的
// `# 备份脚本` 这类注释，`#` 后面都带空白；而图例里的 `|` / `.----------`
// 本身也过不了 cron 校验，两道一起挡。
func splitUserCronLine(line string) (expr, cmd string, enabled, ok bool) {
	raw := line
	enabled = true
	trimmed := strings.TrimLeft(line, " \t")
	if strings.HasPrefix(trimmed, "#") {
		rest := trimmed[1:]
		// `#` 与表达式之间留了空白的，一律按普通注释处理（见上面的说明）
		if rest == "" || rest[0] == ' ' || rest[0] == '\t' {
			return "", "", false, false
		}
		enabled = false
		raw = rest
	}
	// 环境变量行 / 纯注释 不是任务行
	if first := strings.SplitN(raw, " ", 2)[0]; strings.Contains(first, "=") {
		return "", "", false, false
	}
	if strings.HasPrefix(raw, "@") {
		fields := strings.Fields(raw) // @宏 <命令>
		if len(fields) < 2 {
			return "", "", false, false
		}
		if _, err := validateCron(fields[0]); err != nil {
			return "", "", false, false
		}
		return fields[0], strings.Join(fields[1:], " "), enabled, true
	}
	fields := strings.Fields(raw) // 5 段表达式 + 命令
	if len(fields) < 6 {
		return "", "", false, false
	}
	expr = strings.Join(fields[:5], " ")
	if _, err := validateCron(expr); err != nil {
		return "", "", false, false
	}
	// 命令部分按原文切分，避免破坏命令内的空格 / 引号
	idx := fieldOffset(raw, 5)
	if idx <= 0 || idx >= len(raw) {
		return "", "", false, false
	}
	cmd = strings.TrimSpace(raw[idx:])
	if cmd == "" {
		return "", "", false, false
	}
	return expr, cmd, enabled, true
}

// fieldOffset 返回 raw 中「第 n 个字段（1-based）结束」处的字节下标。
// 与 strings.Fields 的口径一致（按空白切分），额外保留原文其余部分不动。
func fieldOffset(raw string, n int) int {
	cnt := 0
	for i := 0; i < len(raw); i++ {
		if raw[i] == ' ' || raw[i] == '\t' {
			continue
		}
		cnt++
		j := i
		for j < len(raw) && raw[j] != ' ' && raw[j] != '\t' {
			j++
		}
		i = j - 1
		if cnt == n {
			return j
		}
	}
	return -1
}

// ---------------- 用户 crontab 行解析 ----------------
//
// 数据源是 `crontab -l` 的输出：整份文件都属于同一个用户（维护用户，
// 默认 root），任务行形如 `m h dom mon dow <command>`，**没有运行用户段**。
// 文件里还可能有 SHELL=/bin/sh、PATH=... 这类环境变量行与说明性注释，都不是任务。
//
// 2026-09-16 收敛：`crontab -l` 是唯一来源；不再读 /etc/crontab、
// /etc/cron.d/* 与 /etc/cron.{hourly,daily,weekly,monthly}/*。

// escapeCronPercent 转义命令中的 %（crontab 里 % 是特殊字符），
// 已被 \ 转义过的保持原样
func escapeCronPercent(cmd string) string {
	var sb strings.Builder
	prev := byte(0)
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		if c == '%' && prev != '\\' {
			sb.WriteByte('\\')
		}
		sb.WriteByte(c)
		prev = c
	}
	return sb.String()
}

// unescapeCronPercent 还原命令中的 \%
func unescapeCronPercent(cmd string) string {
	return strings.ReplaceAll(cmd, `\%`, `%`)
}

// renderUserCronLine 生成用户 crontab 里一条任务行的文本。
// 格式：`<5 段表达式或 @宏> <命令>`；
// 禁用时行首加 #，可被 parseUserCrontabLine 无损还原。
func renderUserCronLine(expr, command string, enabled bool) string {
	body := strings.Join(strings.Fields(expr), " ") + " " + escapeCronPercent(command)
	if !enabled {
		return "#" + body
	}
	return body
}

// locateLine 按「行号 + 原始内容」在行数组中定位目标行。
// 行号越界或内容不匹配都视为定位失败（远端 crontab 已被改动），交给调用方报错。
func locateLine(lines []string, lineNo int, oldRaw string) (int, error) {
	idx := lineNo - 1
	if idx < 0 || idx >= len(lines) {
		return -1, fmt.Errorf("目标行不存在（第 %d 行），目标机 crontab 可能已被改动，请刷新后重试", lineNo)
	}
	if lines[idx] != oldRaw {
		return -1, fmt.Errorf("第 %d 行内容已变化，为避免覆盖他人改动请刷新后重试", lineNo)
	}
	return idx, nil
}

// normalizeCronTask 规范化新增/编辑入参（表达式 + 命令）
func normalizeCronTask(expr, command string) (string, string, error) {
	e, err := validateCron(expr)
	if err != nil {
		return "", "", err
	}
	// crontab 一行一条任务，命令里的换行/回车会破坏结构
	cmd := strings.ReplaceAll(command, "\r", "")
	cmd = strings.ReplaceAll(cmd, "\n", " ")
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return "", "", fmt.Errorf("请填写要执行的命令 / 脚本")
	}
	if len([]rune(cmd)) > 3000 {
		return "", "", fmt.Errorf("命令过长（最多 3000 字符）")
	}
	return e, cmd, nil
}

// ---------------- 读取结果判定 ----------------

// isNoCrontabNotice 判断 `crontab -l` 的 stderr 是否为「该用户还没有 crontab」。
//
// 这是**跨发行版不一致**的一处，实测两种形态：
//
//	cronie / vixie-cron / dcron（Huawei Cloud EulerOS 2.0、AlmaLinux 8.9、CentOS 7+）
//	  $ crontab -l ; echo $?
//	  no crontab for root                       # 走 stderr
//	  1
//
//	busybox（Alpine 系）
//	  $ crontab -l ; echo $?
//	  crontab: can't open 'root': No such file or directory
//	  1
//
// 两种都不是错误：目标机只是还没有这份 crontab，平台应当显示「0 条任务」并允许新增。
// 注意 `crontab: user 'x' unknown` 这类「用户不存在」**不算**，那是真的配置有问题。
func isNoCrontabNotice(s string) bool {
	l := strings.ToLower(strings.TrimSpace(s))
	if l == "" {
		return false
	}
	if strings.Contains(l, "no crontab for") {
		return true
	}
	// busybox：crontab: can't open 'root': No such file or directory
	if strings.Contains(l, "crontab") &&
		(strings.Contains(l, "can't open") || strings.Contains(l, "cannot open")) &&
		strings.Contains(l, "no such file") {
		return true
	}
	return false
}

// isCrontabMissingNotice 判断是否为目标机没装 crontab 命令。
func isCrontabMissingNotice(s string) bool {
	l := strings.ToLower(s)
	return strings.Contains(l, "crontab: not found") ||
		strings.Contains(l, "crontab: command not found") ||
		strings.Contains(l, "command not found") && strings.Contains(l, "crontab")
}
