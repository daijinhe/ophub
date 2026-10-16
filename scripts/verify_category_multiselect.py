#!/usr/bin/env python
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# -*- coding: utf-8 -*-
"""
验证「巡检任务 - 按分类」支持任意层级单选/多选（v1.7.28）。

背景
----
改造前 scopeType=category 只认单个 categoryId，多选无从表达；改造后统一写
categoryIds（数组），并保留历史 categoryId 的读取兼容。范围解析 = 每个根分类
展开为「自身 + 全部子孙」，多个根之间做并集去重。

断言要点
--------
1. 从 level-1 根选 → 含全部子孙资产（子树展开）
2. 从 level-3 叶子选 → 只含该叶子资产（任意层级可选）
3. 跨层级多选 → 并集（叶 + 叶）
4. 父级与其子孙同时选 → 去重，不重复计数
5. 历史字段 categoryId（单选）仍能正确解析（向后兼容）
6. 「按分类」但一个分类都没给 → 400 明确拒绝，不退化成全量资产
7. 列表接口回传 categoryIds，供前端编辑态回填

安全
----
夹具资产一律**不带 IP**（虚拟机IPv4 为空）→ 采集分支直接判失败，不会发起任何
SSH/ansible 连接，不会触碰真实机器。夹具分类/资产/任务在结束时全部清理。

用法
----
    python scripts/verify_category_multiselect.py
    PG_CONTAINER=my-postgres python scripts/verify_category_multiselect.py
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("OPHUB_BASE", "http://localhost:10001")
PG_CONTAINER = os.environ.get("PG_CONTAINER", "ophub-postgres")
PG_USER = os.environ.get("PG_USER", "ophub")
PG_DB = os.environ.get("PG_DB", "ophub")
USERNAME = os.environ.get("OPHUB_USER", "admin")
PASSWORD = os.environ.get("OPHUB_PASS", "admin123")

PREFIX = "ZZ_SCOPE_TEST"
passed, failed = [], []


def ok(name, cond, detail=""):
    (passed if cond else failed).append(name)
    mark = "PASS" if cond else "FAIL"
    print("[%s] %s%s" % (mark, name, ("  —— " + str(detail)) if detail else ""))


def psql(sql):
    """执行 SQL，返回 stdout。用 psql -t -A + | 分隔，便于解析。"""
    cmd = ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB,
           "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError("psql 失败: %s\n%s" % (sql, (p.stderr or "")[:400]))
    return (p.stdout or "").strip()


def api(method, path, body=None, token=None):
    """返回 (status, json)。非 2xx 也正常返回，由调用方断言。"""
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw}


def login():
    st, js = api("POST", "/api/auth/login",
                 {"username": USERNAME, "password": PASSWORD})
    if st != 200:
        raise RuntimeError("登录失败: %s %s" % (st, js))
    return js["data"]["token"]


# ---------------------------------------------------------------- 夹具
def build_fixture():
    """建一棵可控小树：Z(level1) → {A(level2) → A1(level3), B(level2)}，资产全无 IP。

    期望根 Z 的子树资产数 = Z 直挂 1 + A1 的 2 + B 的 3 = 6
    """
    cleanup_fixture()  # 防上次中断残留

    def mkcat(name, parent=None):
        st, js = api("POST", "/api/categories",
                     {"name": name, "parentId": parent, "sort": 9999}, TOKEN)
        if st != 200:
            raise RuntimeError("建分类失败 %s: %s" % (name, js))
        return js["data"]["id"]

    z = mkcat(PREFIX)
    a = mkcat(PREFIX + "_A", z)
    a1 = mkcat(PREFIX + "_A1", a)
    b = mkcat(PREFIX + "_B", z)

    # 资产：fields 里显式把 虚拟机IPv4 置空 → 采集走「资产缺少 IP」分支，零网络行为
    def mkasset(name, cat, n):
        for i in range(n):
            psql("insert into assets (category_id, name, ip, fields, created_by) "
                 "values (%d, '%s_%d', '', '{\"虚拟机IPv4\": \"\", \"ERP系统名称\": \"%s\"}'::jsonb, 1)"
                 % (cat, name, i + 1, name))

    mkasset(PREFIX + "_z_direct", z, 1)
    mkasset(PREFIX + "_a1", a1, 2)
    mkasset(PREFIX + "_b", b, 3)
    return {"Z": z, "A": a, "A1": a1, "B": b}


def cleanup_fixture():
    """按前缀删：任务 → 记录/结果 → 资产 → 分类（子先父后，靠 path 长度倒序）。"""
    psql("delete from inspection_results where task_id in "
         "(select id from inspection_tasks where name like '%s%%')" % PREFIX)
    psql("delete from inspection_records where task_id in "
         "(select id from inspection_tasks where name like '%s%%')" % PREFIX)
    psql("delete from inspection_tasks where name like '%s%%'" % PREFIX)
    psql("delete from assets where name like '%s%%'" % PREFIX)
    # 分类要按层级从深到浅删（子节点指向父节点的外键关系），psql 单条 delete
    # 不支持 order by → 循环删「没有子节点的」那一层，最多 6 轮足够。
    for _ in range(6):
        left = psql("select count(*) from categories where name like '%s%%'" % PREFIX)
        if left == "0":
            break
        psql("delete from categories where name like '%s%%' and id not in "
             "(select distinct parent_id from categories where parent_id is not null)" % PREFIX)


def run_and_count(task_id, timeout=20):
    """触发巡检并读回 record.totalAssets（该值在采集前就落库，无需等采集跑完）。"""
    st, js = api("POST", "/api/inspection/tasks/%d/run" % task_id, {}, TOKEN)
    if st != 200:
        return None, "run 返回 %s %s" % (st, js)
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, js = api("GET", "/api/inspection/records?taskId=%d&size=1" % task_id,
                     token=TOKEN)
        lst = (((js or {}).get("data") or {}).get("list") or [])
        if lst:
            return lst[0].get("totalAssets"), None
        time.sleep(0.4)
    return None, "超时未生成巡检记录"


def mktask(name, scope="category", cat_ids=None, legacy_cat=None, raw_cats=None):
    body = {"name": PREFIX + "_" + name, "scopeType": scope, "freq": "manual",
            "metrics": [], "scheduleEnabled": False}
    if cat_ids is not None:
        body["categoryIds"] = cat_ids
    if legacy_cat is not None:
        body["categoryId"] = legacy_cat
    if raw_cats is not None:
        body["categoryIds"] = raw_cats
    return api("POST", "/api/inspection/tasks", body, TOKEN)


def main():
    global TOKEN
    TOKEN = login()
    print("登录成功，开始建夹具…")
    T = build_fixture()
    print("夹具分类: %s\n" % T)

    try:
        # --- 1. level-1 根：子树全展开 ---
        st, js = mktask("rootZ", cat_ids=[T["Z"]])
        ok("新建：按分类 + categoryIds=[level1根] 成功", st == 200, st)
        cnt, err = run_and_count(js["data"]["id"]) if st == 200 else (None, "创建失败")
        ok("level-1 根分类展开为整棵子树（期望 6 台）", cnt == 6, "实际 %s %s" % (cnt, err or ""))

        # --- 2. level-3 叶子：只取自己 ---
        st, js = mktask("leafA1", cat_ids=[T["A1"]])
        cnt, err = run_and_count(js["data"]["id"]) if st == 200 else (None, "创建失败")
        ok("任意层级：level-3 叶子分类只取自身资产（期望 2 台）", cnt == 2,
           "实际 %s %s" % (cnt, err or ""))

        # --- 3. 跨层级多选：A1(level3) + B(level2) ---
        st, js = mktask("multiCross", cat_ids=[T["A1"], T["B"]])
        cnt, err = run_and_count(js["data"]["id"]) if st == 200 else (None, "创建失败")
        ok("跨层级多选并集：A1(2) + B(3) = 5 台", cnt == 5, "实际 %s %s" % (cnt, err or ""))

        # --- 4. 父级 + 其子孙同时选：必须去重 ---
        st, js = mktask("dedup", cat_ids=[T["Z"], T["A1"]])
        cnt, err = run_and_count(js["data"]["id"]) if st == 200 else (None, "创建失败")
        ok("父级与其子孙同时选中不重复计数（期望仍是 6 台）", cnt == 6,
           "实际 %s %s" % (cnt, err or ""))

        # --- 5. 向后兼容：只传历史单选 categoryId ---
        st, js = mktask("legacy", cat_ids=None, legacy_cat=T["Z"])
        cnt, err = run_and_count(js["data"]["id"]) if st == 200 else (None, "创建失败")
        ok("历史单选字段 categoryId 仍可解析（期望 6 台）", cnt == 6,
           "实际 %s %s" % (cnt, err or ""))

        # --- 6. 校验：按分类却一个分类都没给 → 400，绝不退化成全量 ---
        st, js = mktask("empty", cat_ids=[])
        ok("按分类但未选任何分类 → 400 拒绝（不退化成全量资产）", st == 400,
           "实际 %s %s" % (st, (js or {}).get("msg")))

        # --- 7. 列表回传 categoryIds（编辑态回填用） ---
        st, js = api("GET", "/api/inspection/tasks", token=TOKEN)
        rows = [r for r in ((js.get("data") or {}).get("list") or [])
                if r.get("name", "").startswith(PREFIX)]
        by_name = {r["name"]: r for r in rows}
        cross = by_name.get(PREFIX + "_multiCross")
        ok("列表接口回传 categoryIds 且为多值", bool(cross) and cross.get("categoryIds") == [T["A1"], T["B"]],
           cross.get("categoryIds") if cross else "未找到任务")
        legacy = by_name.get(PREFIX + "_legacy")
        ok("历史单选任务在列表里被归一成 categoryIds 单值",
           bool(legacy) and legacy.get("categoryIds") == [T["Z"]] and legacy.get("categoryId") in (None, 0),
           legacy.get("categoryIds") if legacy else "未找到任务")

        # --- 8. 落库检查：categoryIds 真的进了 JSON 列 ---
        raw = psql("select category_ids::text from inspection_tasks where name='%s_multiCross'"
                   % PREFIX)
        want_a = "[%d, %d]" % (T["A1"], T["B"])   # PG jsonb 输出逗号后带空格
        want_b = "[%d,%d]" % (T["A1"], T["B"])
        ok("categoryIds 已持久化到 inspection_tasks.category_ids", raw in (want_a, want_b), raw)

        # --- 9. 容错：antd TreeSelect(treeCheckStrictly) 回传的 {label,value} 对象数组 ---
        # 血案：treeCheckStrictly 下 onChange 给的是对象数组，后端只按 []uint 解析会整体失败，
        # 表现为「明明选好了分类，保存却报『必须至少选择一个有效分类』」。这里锁死兼容行为。
        # 用两个**不嵌套**的叶子（A1=2 台、B=3 台）→ 期望 5；只解析出第一个会是 2、只解析第二个会是 3，
        # 所以这个数字能真正区分「两个都解析到了」和「只解析到其中一个」。
        st, js = mktask("objForm", raw_cats=[{"label": "x", "value": T["A1"], "halfChecked": False},
                                            {"label": "y", "value": T["B"], "halfChecked": False}])
        ok("对象数组写法 [{label,value}] 建任务成功", st == 200, st)
        cnt, err = run_and_count(js["data"]["id"]) if st == 200 else (None, "创建失败")
        ok("对象数组写法两项都被解析（A1 2 台 + B 3 台 = 5 台）", cnt == 5,
           "实际 %s %s" % (cnt, err or ""))

        # --- 10. 容错：字符串数字 ["1","2"] ---
        st, js = mktask("strForm", raw_cats=[str(T["B"])])
        cnt, err = run_and_count(js["data"]["id"]) if st == 200 else (None, "创建失败")
        ok('字符串数字写法 ["%d"] 也可解析（期望 3 台）' % T["B"], st == 200 and cnt == 3,
           "实际 %s / %s" % (st, cnt))

    finally:
        cleanup_fixture()
        print("\n夹具已清理")

    print("\n===== 结果：%d 通过 / %d 失败 =====" % (len(passed), len(failed)))
    for f in failed:
        print("  ✗ " + f)
    return 0 if not failed else 1


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.exit(main())
