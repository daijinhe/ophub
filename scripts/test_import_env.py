#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端验证：用新版「平台录入模板」导入 Excel，检查 环境 / 业务环境 字段映射是否正确。
- 环境：新模板新增列，应正常写入字段 key=环境
- 业务环境：新模板出现两次（第 12 列新位置 + 第 33 列遗留副本），
  平台应只保留一个 key=业务环境，不产生 业务环境_2 幽灵字段
"""
import json, os, sys, urllib.request, urllib.error, urllib.parse, uuid
import openpyxl

BASE = "http://127.0.0.1:8088/api"
TMPL = r"D:/User/Administrator/Desktop/平台录入模板.xlsx"
OUT = r"D:/User/Administrator/Desktop/ophub/.workbuddy/tmp/import_test.xlsx"
TEST_IP = "192.0.2.99"
TEST_NAME = "导入测试-环境字段"


def req(path, method="GET", body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def multipart(path, fields, file_field, file_path, token):
    boundary = "----wb" + uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    fn = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        content = f.read()
    body += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{fn}\"\r\n"
        f"Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"
    ).encode()
    body += content + f"\r\n--{boundary}--\r\n".encode()
    r = urllib.request.Request(BASE + path, data=bytes(body), method="POST")
    r.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


# ---------- 1. 造测试文件（保留模板表头 + 公式，清掉示例行，写 1 行测试数据）----------
wb = openpyxl.load_workbook(TMPL)  # 不启用 data_only，保留公式
ws = wb["录入信息"]
headers = {}
for c in ws[1]:
    if c.value is not None and str(c.value).strip() != "":
        headers[str(c.value).strip()] = c.column
# 清空示例数据行（保留第 1 行表头）
for row in range(2, ws.max_row + 1):
    for c in range(1, ws.max_column + 1):
        ws.cell(row=row, column=c).value = None

vals = {
    "归属部门": "测试部",
    "应用系统名称": TEST_NAME,
    "虚拟机IPv4": TEST_IP,
    "环境": "生产环境",
    "业务环境": "后端java",
    "所属网络区域": "互联网",
    "所属中心": "主中心",
    "操作系统版本": "openEuler 20.03",
    "CPU类型": "aarch64",
    "CPU核数": 8,
    "内存（GB）": 16,
    "系统盘（GB）": 50,
    "数据盘1（GB）": 200,
}
missing = [k for k in vals if k not in headers]
if missing:
    print("模板缺少列:", missing)
for k, v in vals.items():
    ws.cell(row=2, column=headers[k], value=v)
wb.save(OUT)
print(f"测试文件已生成: {OUT}  (表头 {len(headers)} 列)")

# ---------- 2. 登录 ----------
st, lg = req("/auth/login", "POST", {"username": "admin", "password": "admin123"})
tok = lg["data"]["token"]
print("login:", st)

# ---------- 3. 字段定义检查 ----------
st, f = req("/fields", token=tok)
fdefs = f["data"]["fields"]
env = next((x for x in fdefs if x["key"] == "环境"), None)
be = [x for x in fdefs if x["key"].startswith("业务环境")]
print(f"字段定义: 环境={env['label'] if env else None}  业务环境keys={[x['key'] for x in be]}")
idx_env = next((i for i, x in enumerate(fdefs) if x["key"] == "环境"), -1)
idx_be = next((i for i, x in enumerate(fdefs) if x["key"] == "业务环境"), -1)
print(f"顺序: 环境 idx={idx_env}  业务环境 idx={idx_be}  {'✅ 环境在前' if 0 <= idx_env < idx_be else '❌ 顺序错误'}")
print(f"幽灵字段 业务环境_2: {'❌ 存在' if any(x['key']=='业务环境_2' for x in fdefs) else '✅ 无'}")
print(f"总字段数: {len(fdefs)}")

# ---------- 4. 导入 ----------
st, r = multipart("/assets/import", {"categoryId": "1"}, "file", OUT, tok)
print("import:", st, r)

# ---------- 5. 校验入库结果 ----------
st, a = req(f"/assets?keyword={urllib.parse.quote(TEST_NAME)}", token=tok)
items = a.get("data", {}).get("list", [])
hit = next((x for x in items if x.get("ip") == TEST_IP), None)
if not hit:
    print("❌ 未找到导入的测试资产")
    sys.exit(1)
flds = hit.get("fields", {}) or {}
print("\n--- 导入结果 fields ---")
for k in ("环境", "业务环境", "归属部门", "应用系统名称", "虚拟机IPv4", "CPU类型"):
    print(f"  {k:12s} = {flds.get(k)!r}")
ghost = [k for k in flds if k.startswith("业务环境_")]
print(f"  幽灵 key: {ghost if ghost else '✅ 无'}")

ok = flds.get("环境") == "生产环境" and flds.get("业务环境") == "后端java" and not ghost
print("\n结论:", "✅ 通过" if ok else "❌ 失败")

# ---------- 5b. 回归场景：只填新位置「业务环境」+ 重复列之后的列，旧重复列留空 ----------
# 新模板「业务环境」同时出现在第 13(M) 与第 35(AI) 列。若只填 M、且填了 AI 之后的列（如 用途 AZ=52），
# 行会被撑长到 AI 之后，AI 的空值曾把 M 的值覆盖成空串。此处固化该回归场景。
from openpyxl.utils import get_column_letter

dup_cols = [c.column for c in ws[1]
            if c.value is not None and str(c.value).strip() == "业务环境"]
print(f"\n模板中「业务环境」出现在列: {[get_column_letter(c) for c in dup_cols]}")
if len(dup_cols) >= 2:
    for row in range(2, ws.max_row + 1):
        for c in range(1, ws.max_column + 1):
            ws.cell(row=row, column=c).value = None
    ws.cell(row=2, column=headers["应用系统名称"], value="覆盖测试-用途")
    ws.cell(row=2, column=headers["虚拟机IPv4"], value="192.0.2.98")
    ws.cell(row=2, column=headers["环境"], value="生产环境")
    ws.cell(row=2, column=headers["业务环境"], value="后端java")       # 只填第一个（新位置）
    if "用途" in headers:
        ws.cell(row=2, column=headers["用途"], value="测试用途")        # 撑长行，越过重复列
    wb.save(OUT)
    st, r = multipart("/assets/import", {"categoryId": "1"}, "file", OUT, tok)
    st, a = req("/assets?keyword=" + urllib.parse.quote("覆盖测试-用途"), token=tok)
    hit2 = next((x for x in a.get("data", {}).get("list", []) if x.get("ip") == "192.0.2.98"), None)
    f2 = hit2.get("fields", {}) if hit2 else {}
    got = f2.get("业务环境")
    print(f"回归: 业务环境 = {got!r}  {'✅ 未被空重复列覆盖' if got == '后端java' else '❌ 被覆盖'}")
    if hit2 and hit2.get("id"):
        req(f"/assets/{hit2['id']}", "DELETE", token=tok)
    ok = ok and got == "后端java"

# ---------- 6. 清理测试资产 ----------
if hit.get("id"):
    st, d = req(f"/assets/{hit['id']}", "DELETE", token=tok)
    print("cleanup:", st, d.get("msg", ""))
