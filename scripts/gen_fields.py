#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 从「平台录入模板（终极模板·只读）」自动生成前后端字段定义（单一数据源）
# 模板是权威数据源，本脚本只读取不修改；新增/删减字段以模板「录入信息」sheet 为准
import openpyxl, os, sys, json, re

# 路径基于本脚本位置推导（scripts/ 的上级即项目根），避免硬编码盘符/用户名导致 FileNotFoundError
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "资源清单模板.xlsx")
BACKEND = os.path.join(ROOT, "backend", "fields.go")
FRONTEND = os.path.join(ROOT, "frontend", "src", "api", "fields.ts")

# ---- 8 大类分组（展示顺序即此顺序）----
# 2026-09-14 按用户要求重排：ELB相关信息 → 中间件和数据库信息 → 项目人员信息 → NAS相关信息 → 其他网络信息 → 资源申请信息
# （项目人员信息由原 03 位下移到 05 位，其他网络信息由原 05 位下移到 07 位，中间件和数据库信息上移到 04 位）
GROUPS = [
    "资源基本信息",
    "用户密码管理",
    "ELB相关信息",
    "中间件和数据库信息",
    "项目人员信息",
    "NAS相关信息",
    "其他网络信息",
    "资源申请信息",
]

# 每组字段（按产品要求的顺序；label 对应 Excel 表头，key 自动生成）
# 说明：模板中不存在、但历史一直存在的字段（如资源申请信息整组、虚拟机名称、环境等）
#       仍在此处声明，脚本会以 label 本身作为 key 保留，保证详情展示与历史一致。
GROUP_FIELDS = {
    "资源基本信息": [
        # 2026-09-07 调整：ERP系统名称 置顶 + 项目简称 紧随其后（原 01 组首位「虚拟机名称」下移至 08 资源申请信息）
        "ERP系统名称", "项目简称",
        "虚拟机IPv4", "虚拟机EIP-IPv4", "云平台版本",
        "所属网络区域", "所属中心", "环境", "业务环境", "操作系统版本",
        # 硬件规格连排：CPU类型 → CPU核数 → 内存 → 系统盘 → 数据盘
        "CPU类型", "CPU核数", "内存（GB）", "系统盘（GB）",
        "数据盘1（GB）", "数据盘2（GB）", "数据盘3（GB）", "数据盘4（GB）", "数据盘5（GB）",
        "VDC", "安全组", "用途",
        # 2026-09-14 用户要求：业务访问地址（模板中暂无对应表头 → 走下方 fallback，
        # key = label 本身）保留字段定义，可在资产编辑表单手工填写并落库。
        "业务内网访问地址", "业务外网访问地址",
        # 2026-09-17 用户要求下线：业务应用端口 / 业务应用访问地址 / 业务系统账号 / 业务系统密码。
        # 前两个存在于模板表头 → 必须同时登记进 SKIP_KEYS，否则会被「模板有但分组未列」
        # 的兜底分支重新追加回来；后两个本就不在模板里，从本组移除即可。
    ],
    "用户密码管理": [
        "普通用户", "普通用户密码", "超级管理员用户", "超级管理员用户密码", "SSH端口",
        "用户名", "密码",
    ],
    "项目人员信息": [
        "项目技术负责人", "项目经理", "开发人员", "运维负责人",
    ],
    "ELB相关信息": [
        "ELB名称", "ELB对应端口号", "后端服务器对应端口",
        "ELB-IPv4", "ELBEIP-IPv4", "ELB-IPv6",
    ],
    "其他网络信息": [
        "负载IP", "商密IP", "国密网关分配IP", "端口",
        "VPC", "子网", "子网2", "子网3", "子网4", "子网5",
        "IPv4网段", "IPv4网段2", "IPv4网段3", "IPv4网段4", "IPv4网段5",
        "IPv6网段", "IPv6网段2", "IPv6网段3", "IPv6网段4", "IPv6网段5",
        "虚拟机IPv6", "云账号", "分发区域",
        # 模板中第二处「备注 / 密码」（key 带 _2 后缀，按出现顺序区分）
        "备注_2", "密码_2",
    ],
    "NAS相关信息": [
        "NAS名称", "NAS空间大小(GB)", "虚拟机NAS名称", "虚拟机NAS路径",
    ],
    "中间件和数据库信息": [
        "中间件信息",
    ],
    "资源申请信息": [
        "申请日期", "申请人", "申请人部门", "单位名称", "归属一级单位", "归属二级单位",
        "项目技术负责人", "技术负责人联系电话", "厅局应用负责人", "厅局负责人联系电话",
        "资源使用时间起", "资源使用时间止", "紧急程度", "当前是否封网", "申请类型",
        "系统所属网络区域", "是否需要国产化", "项目性质", "项目类型", "项目年份",
        "紧急说明", "申请说明",
        "项目规划资源使用量 - vCPU(核)", "项目规划资源使用量 - 内存（GB）",
        "项目规划资源使用量 - 硬盘(GB)", "项目规划资源使用量 - 互联网/政务外网IP",
        "项目规划资源使用量 - 其他资源",
        "已申请资源使用量 - vCPU(核)", "已申请资源使用量 - 内存（GB）",
        "已申请资源使用量 - 硬盘(GB)", "已申请资源使用量 - 互联网/政务外网IP",
        "已申请资源使用量 - 其他资源",
        "本次申请总量 - vCPU(核)", "本次申请总量 - 内存（GB）",
        "本次申请总量 - 硬盘(GB)", "本次申请总量 - 互联网/政务外网IP",
        "本次申请总量 - 其他资源",
        "归属部门", "应用系统名称", "应用归属单位", "项目名称", "功能类别",
        "自定义主机名", "虚拟机责任人", "联系方式",
        "是否需要NAS", "是否商密使用", "虚拟机是否需要EIP-IPV4", "虚拟机是否需要IPV6",
        "是否需要ELB（4层负载均衡）", "ELB是否需要EIP-IPV4", "ELB是否需要IPV6",
        "是否访问互联网", "是否被互联网访问", "是否访问政务外网", "是否被政务外网访问",
        "是否经过WAF（全网开放）", "政务外网IP服务范围", "备注",
        # 2026-09-07 调整：从 01 资源基本信息下移至 08 资源申请信息
        "虚拟机名称",
    ],
}

# 多分组字段：label 出现在多个展示分组
MULTI_GROUPS = {
    "项目技术负责人": ["项目人员信息", "资源申请信息"],
}

# 主分组（编辑表单分组顺序唯一）：默认第一个出现处；这里强制指定
PRIMARY_GROUP = {
    "项目技术负责人": "项目人员信息",
}

# 特殊列：表头是说明文字，不作为字段
SKIP_LABEL_PREFIX = "后面信息需要自行填写"

# 模板中「移动后遗留」的重复表头的 _N 副本：以第一个出现处为准，后续副本在此登记忽略。
# 背景：2026-09-09 用户把「业务环境」移到「环境」之后，旧位置列一度残留导致表头出现两次，
#       会生成 业务环境_2 幽灵字段、且导入时同一字段被拆成两份。该残留列已于同日删除，
#       故当前为空集合；若模板再次出现重复表头，把对应的 _N key 加进来即可。
# 注意：backend/excel.go 侧已有通用兜底（同一 key 已有非空值时，空值不覆盖），两者互补。
# 2026-09-17 用户要求下线「业务应用端口 / 业务应用访问地址」：这两个字段在模板里有表头，
# 只从 GROUP_FIELDS 移除的话，会被下方「模板中有但分组未列」的兜底分支重新生成回来，
# 因此必须登记在此抑制（效果：详情 / 列表 / 编辑表单 / 列设置 / 导入均不再出现）。
SKIP_KEYS = {"业务应用端口", "业务应用访问地址"}

# 隐藏字段（按 key）：定义与存储保留，但在资产列表/详情/编辑表单/列设置/批量修改中一律不展示。
# 背景（2026-09-11 用户要求）：「用户密码管理」(02) 中的「用户名」「密码」为历史遗留字段，
#       终极模板中已无对应表头（不会被导入），故不再展示；模板文件保持不动。
#       注意 key 精确匹配，故 (05) 其他网络信息的「密码_2」不受影响。
HIDDEN_KEYS = {"用户名", "密码"}

# 允许「下拉选择 + 自定义输入」的字段（按 key）：保留既有下拉形式，同时可在下拉底部输入并保存自定义值。
# 背景（2026-09-11 用户要求）：资源基本信息的「业务环境」实际取值可能超出内置三项（前端/后端/数据库）。
ALLOW_CUSTOM_KEYS = {"业务环境"}

# 下拉选项
FIELD_OPTIONS = {
    "所属中心": ["主中心", "备中心"],
    "环境": ["开发环境", "测试环境", "生产环境", "商密环境"],
    "业务环境": ["前端", "后端", "数据库"],
    "所属网络区域": ["互联网", "政务外网"],
    # 云平台版本：与云厂商规格命名保持一致（2*8 / 830 / 651）
    "云平台版本": ["2*8", "830", "651"],
    # CPU 架构：与 `uname -m` 输出对齐，便于巡检/部署侧直接比对
    "CPU类型": ["x86_64", "aarch64"],
    "紧急程度": ["普通", "紧急", "特急"],
    "当前是否封网": ["是", "否"],
    "申请类型": ["资源新增", "资源变更", "资源释放", "其他"],
    "系统所属网络区域": ["互联网", "政务外网"],
    "是否需要国产化": ["是", "否"],
    "是否商密使用": ["是", "否"],
    "是否需要NAS": ["是", "否"],
    "虚拟机是否需要EIP-IPV4": ["是", "否"],
    "虚拟机是否需要IPV6": ["是", "否"],
    "是否需要ELB（4层负载均衡）": ["是", "否"],
    "ELB是否需要EIP-IPV4": ["是", "否"],
    "ELB是否需要IPV6": ["是", "否"],
    "是否访问互联网": ["是", "否"],
    "是否被互联网访问": ["是", "否"],
    "是否访问政务外网": ["是", "否"],
    "是否被政务外网访问": ["是", "否"],
    "是否经过WAF（全网开放）": ["是", "否"],
}

# ---- 中间件与数据库 ----
MIDDLEWARE_TYPES = ["nginx", "php", "jdk", "es", "redis", "kafka", "其他"]
MIDDLEWARE_FIELDS = [
    ("name", "实例名称"),
    ("installPath", "安装路径"),
    ("configPath", "配置文件路径"),
    ("codePath", "代码存放路径"),
    ("port", "端口"),
    ("accessUrl", "访问地址"),
    ("innerDomain", "内网域名"),
    ("publicDomain", "公网域名"),
    ("keyInfo", "关键信息"),
    ("hasCert", "是否有证书", ["是", "否"]),
    ("certPath", "证书存放位置"),
    ("certExpire", "证书到期时间"),
    ("password", "密码"),
]

# 资产列表默认关键列（key）
# 注意：「环境」在模板中位于「操作系统版本」之后，必须列在这里，否则重新生成时
#       会从 KeyColumns 丢失（历史 Go 文件含该列、TS 丢失即由此产生的不一致）。
KEY_LABELS = ["应用系统名称", "虚拟机IPv4", "所属网络区域", "CPU核数", "内存（GB）",
              "数据盘1（GB）", "操作系统版本", "环境", "业务环境", "归属部门", "用途"]


# ============ 读取模板表头 ============
headers = None
if os.path.exists(TEMPLATE):
    try:
        wb = openpyxl.load_workbook(TEMPLATE, data_only=True)
        # 终极模板优先读「录入信息」sheet（资产信息主表），否则取第一个 sheet
        ws_name = "录入信息" if "录入信息" in wb.sheetnames else wb.sheetnames[0]
        ws = wb[ws_name]
        headers = [c.value for c in ws[1]]
        headers = [str(h).strip() for h in headers if h is not None and str(h).strip() != ""]
    except Exception as e:
        print("读取模板失败：", e)
if not headers:
    raise SystemExit("未读取到模板表头，请检查文件路径")

# 生成唯一 key（重复表头按出现顺序追加 _N）
keys, seen = [], {}
for h in headers:
    if h.startswith(SKIP_LABEL_PREFIX):
        keys.append(None)  # 占位，后面跳过
        continue
    k = seen.get(h, 0)
    if k == 0:
        seen[h] = 1
        keys.append(h)
    else:
        seen[h] = k + 1
        keys.append(f"{h}_{k + 1}")

# 构建 label → [key] 索引
label_index = {}
for h, k in zip(headers, keys):
    if k is None:
        continue
    label_index.setdefault(h, []).append(k)


def group_of(label):
    """字段主分组"""
    if label in PRIMARY_GROUP:
        return PRIMARY_GROUP[label]
    for g in GROUPS:
        if label in GROUP_FIELDS.get(g, []):
            return g
    return GROUPS[0]


def group_of_key(kk):
    """按 key 计算分组（含 _N 后缀的重复 key）"""
    return PRIMARY_GROUP.get(kk) or group_of(kk)


def groups_of(label):
    """展示分组列表"""
    return MULTI_GROUPS.get(label) or [group_of(label)]


def groups_of_key(kk):
    """按 key 计算展示分组列表"""
    return MULTI_GROUPS.get(kk) or [group_of_key(kk)]


# 按分组顺序排字段（含重复 label 的 _2 key 精确匹配）
ordered = []  # (key, label)
seen_key = set()
for g in GROUPS:
    for item in GROUP_FIELDS.get(g, []):
        # item 可能是 "备注_2" 这种带后缀 key（模板中重复出现的表头）
        if "_" in item and item in keys:
            if item not in seen_key:
                ordered.append((item, item.split("_")[0]))
                seen_key.add(item)
            continue
        # 普通 label，从模板表头中取 key（跳过被抑制的重复副本）
        cands = [k for k in label_index.get(item, []) if k not in SKIP_KEYS]
        got = False
        for k in cands:
            if k not in seen_key:
                ordered.append((k, item))
                seen_key.add(k)
                got = True
                break
        # 模板不含该表头（如「资源申请信息」整组、虚拟机名称、环境、用户名等历史字段）：
        # 仍按历史保留字段定义，key=item，label 去掉 _N 后缀
        # （「中间件信息」为合成字段，由下方统一追加，此处跳过避免重复）
        if not got and item != "中间件信息" and item not in seen_key:
            lbl = item.rsplit("_", 1)[0] if re.match(r"^.+_\d+$", item) else item
            ordered.append((item, lbl))
            seen_key.add(item)
# 兜底：模板中有但分组未列的字段，归入默认组（不应发生，仅防御）
for h, k in zip(headers, keys):
    if k is not None and k not in seen_key and k not in SKIP_KEYS:
        ordered.append((k, h))
        seen_key.add(k)

# 中间件特殊字段（作为固定字段定义输出，前端单独渲染）
ordered.append(("中间件信息", "中间件和数据库信息"))

# 关键列
key_keys = []
for kl in KEY_LABELS:
    cands = label_index.get(kl, [])
    for kk in cands:
        if kk not in key_keys:
            key_keys.append(kk)
            break
if not key_keys:
    key_keys = [ordered[0][0]]

# ============ 生成 Go ============
go = []
go.append("package main\n")
go.append("// 本文件由 scripts/gen_fields.py 从「平台录入模板（终极模板·只读）」自动生成，请勿手动修改。\n")
go.append("// FieldDef 描述一个 CMDB 字段")
go.append("type FieldDef struct {")
_struct_rows = [
    ("Key", "string", "", ""),
    ("Label", "string", "", ""),
    ("Group", "string", "主分组（编辑表单用）", ""),
    ("Groups", "[]string", "展示分组（默认=[Group]）", "omitempty"),
    ("Options", "[]string", "", "omitempty"),
    ("Type", "string", "middleware 等特殊渲染", "omitempty"),
    ("Hidden", "bool", "前端不展示（列表/详情/表单/列设置/批量修改）", "omitempty"),
    ("AllowCustom", "bool", "下拉选项之外允许自定义输入", "omitempty"),
]
# 生成 gofmt 风格对齐的字段行（名字列 / 类型列 / tag 列 / 注释列统一对齐）
_w_name = max(len(r[0]) for r in _struct_rows)
_w_type = max(len(r[1]) for r in _struct_rows)
_len_tag = [len("`json:\"%s\"`" % (r[0][0].lower() + r[0][1:] + ("," + r[3] if r[3] else ""))) for r in _struct_rows]
_w_tag = max(_len_tag)
for _i, (_n, _t, _c, _o) in enumerate(_struct_rows):
    _key = _n[0].lower() + _n[1:]
    _tag = '`json:"%s"`' % (_key + ("," + _o if _o else ""))
    _line = "\t" + _n.ljust(_w_name) + " " + _t.ljust(_w_type) + " " + _tag.ljust(_w_tag)
    if _c:
        _line += " // " + _c
    go.append(_line.rstrip())
go.append("}\n")
go.append("// FieldGroups 字段分组顺序（详情展示顺序）")
go.append("var FieldGroups = []string{")
for name in GROUPS:
    go.append(f'\t"{name}",')
go.append("}\n")
go.append("// FieldDefs 全部字段定义（按分组顺序）")
go.append("var FieldDefs = []FieldDef{")
for kk, hh in ordered:
    if kk == "中间件信息":
        go.append(f'\t{{Key: "{kk}", Label: "{hh}", Group: "中间件和数据库信息", Groups: []string{{"中间件和数据库信息"}}, Type: "middleware"}},')
        continue
    gs = groups_of_key(kk)
    gostr = "[]string{" + ", ".join(f'"{g}"' for g in gs) + "}"
    opts = FIELD_OPTIONS.get(hh)
    extra = ""
    if kk in HIDDEN_KEYS:
        extra += ", Hidden: true"
    if kk in ALLOW_CUSTOM_KEYS:
        extra += ", AllowCustom: true"
    if opts:
        goopts = "[]string{" + ", ".join(f'"{o}"' for o in opts) + "}"
        go.append(f'\t{{Key: "{kk}", Label: "{hh}", Group: "{group_of_key(kk)}", Groups: {gostr}, Options: {goopts}{extra}}},')
    else:
        go.append(f'\t{{Key: "{kk}", Label: "{hh}", Group: "{group_of_key(kk)}", Groups: {gostr}{extra}}},')
go.append("}\n")
go.append("// KeyColumns 资产列表默认展示的关键列（key）")
go.append("var KeyColumns = []string{")
for kk in key_keys:
    go.append(f'\t"{kk}",')
go.append("}\n")
go.append("// MiddlewareTypes 中间件类型（第7类 中间件和数据库信息）")
go.append("var MiddlewareTypes = []string{")
for t in MIDDLEWARE_TYPES:
    go.append(f'\t"{t}",')
go.append("}\n")
go.append("// MiddlewareFieldDefs 中间件实例的通用字段（key 为英文，label 为中文）")
go.append("var MiddlewareFieldDefs = []FieldDef{")
for mf in MIDDLEWARE_FIELDS:
    if len(mf) == 3:
        opts = mf[2]
        goopts = "[]string{" + ", ".join(f'"{o}"' for o in opts) + "}"
        go.append(f'\t{{Key: "{mf[0]}", Label: "{mf[1]}", Options: {goopts}}},')
    else:
        go.append(f'\t{{Key: "{mf[0]}", Label: "{mf[1]}"}},')
go.append("}\n")
with open(BACKEND, "w", encoding="utf-8") as f:
    f.write("\n".join(go))
print("wrote", BACKEND, "fields:", len(ordered), "groups:", len(GROUPS))

# ============ 生成 TS ============
ts = []
ts.append("// 本文件由 scripts/gen_fields.py 从「平台录入模板（终极模板·只读）」自动生成，请勿手动修改\n")
ts.append("export interface FieldDef {")
ts.append("  key: string;")
ts.append("  label: string;")
ts.append("  group: string;")
ts.append("  groups?: string[];")
ts.append("  options?: string[];")
ts.append("  type?: string;")
ts.append("  /** 前端不展示（列表/详情/表单/列设置/批量修改） */")
ts.append("  hidden?: boolean;")
ts.append("  /** 下拉选项之外允许自定义输入 */")
ts.append("  allowCustom?: boolean;")
ts.append("}\n")
ts.append("export const FieldGroups: string[] = [")
for name in GROUPS:
    ts.append(f'  "{name}",')
ts.append("];\n")
ts.append("export const FieldDefs: FieldDef[] = [")
for kk, hh in ordered:
    if kk == "中间件信息":
        ts.append(f'  {{ key: "{kk}", label: "{hh}", group: "中间件和数据库信息", groups: ["中间件和数据库信息"], type: "middleware" }},')
        continue
    gs = groups_of_key(kk)
    gstr = json.dumps(gs, ensure_ascii=False)
    opts = FIELD_OPTIONS.get(hh)
    extra = ""
    if kk in HIDDEN_KEYS:
        extra += ", hidden: true"
    if kk in ALLOW_CUSTOM_KEYS:
        extra += ", allowCustom: true"
    if opts:
        ts.append(f'  {{ key: "{kk}", label: "{hh}", group: "{group_of_key(kk)}", groups: {gstr}, options: {json.dumps(opts, ensure_ascii=False)}{extra} }},')
    else:
        ts.append(f'  {{ key: "{kk}", label: "{hh}", group: "{group_of_key(kk)}", groups: {gstr}{extra} }},')
ts.append("];\n")
ts.append("export const KeyColumns: string[] = [")
for kk in key_keys:
    ts.append(f'  "{kk}",')
ts.append("];\n")
ts.append("export const MiddlewareTypes: string[] = [")
for t in MIDDLEWARE_TYPES:
    ts.append(f'  "{t}",')
ts.append("];\n")
ts.append("export const MiddlewareFieldDefs: FieldDef[] = [")
for mf in MIDDLEWARE_FIELDS:
    if len(mf) == 3:
        ts.append(f'  {{ key: "{mf[0]}", label: "{mf[1]}", group: "中间件和数据库信息", options: {json.dumps(mf[2], ensure_ascii=False)} }},')
    else:
        ts.append(f'  {{ key: "{mf[0]}", label: "{mf[1]}", group: "中间件和数据库信息" }},')
ts.append("];\n")
with open(FRONTEND, "w", encoding="utf-8") as f:
    f.write("\n".join(ts))
print("wrote", FRONTEND, "keycols:", len(key_keys), "middleware types:", len(MIDDLEWARE_TYPES))
