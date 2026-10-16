#!/usr/bin/env python3
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# -*- coding: utf-8 -*-
"""
夜莺历史告警「筛选参数」对照探针（只读，不改任何数据）

目的：把夜莺原生历史告警页的 6 个筛选控件对应的**真实参数名与取值语义**
逐条实测出来，并与平台本地库的统计做对照，避免"看着像对、其实漏了"。

夜莺前端 bundle 里挖到的权威映射（v8.0.0，AlertHisEvents 页面）：
    Object.assign({range},
        datasource_ids  → 数据源（逗号分隔多选）
        severity        → 告警级别
        query           → 模糊搜索规则和标签
        {bgid}          → 业务组（⚠️ 夜莺 API 单值：逗号分隔会 400、重复参数取最后一个）
        rule_prods      → 监控类型（逗号分隔多选，metric/host/logging）
        is_recovered    → 事件类别（0=Triggered 1=Recovered）
    ) + p + limit + stime + etime

用法：
    python scripts/probe_n9e_filters.py            # 用默认 7 天窗口
    python scripts/probe_n9e_filters.py --days 3
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

BASE = os.environ.get("N9E_BASE", "http://n9e.internal.example:9999")
TOKEN = os.environ.get("N9E_TOKEN", "e2ac78ce-9838-49ab-bb91-bbe2d6963fba")
PG_CONTAINER = os.environ.get("PG_CONTAINER", "ophub-postgres")


def n9e_total(stime, etime, extra=""):
    """取夜莺 total。超时/失败返回 'TIMEOUT'。"""
    url = "%s/api/n9e/alert-his-events/list?p=1&limit=1&stime=%d&etime=%d%s" % (
        BASE, stime, etime, extra)
    req = urllib.request.Request(url, headers={"X-User-Token": TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=95) as r:
            js = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return "TIMEOUT" if "timed out" in str(e).lower() else "ERR"
    if js.get("err"):
        return "ERR:%s" % js["err"][:40]
    return (js.get("dat") or {}).get("total")


def local_total(where=""):
    """本地库同窗口条数（默认 90 天窗口，与平台页面口径一致）。"""
    sql = "select count(*) from n9e_alert_events where trigger_time >= extract(epoch from now())::bigint - 90*86400"
    if where:
        sql += " and " + where
    out = subprocess.run(
        ["docker", "exec", PG_CONTAINER, "psql", "-U", "ophub", "-d", "ophub", "-tAc", sql],
        capture_output=True, text=True)
    try:
        return int(out.stdout.strip())
    except Exception:
        return "ERR:%s" % out.stderr.strip()[:60]


def local_kv(col, extra_where=""):
    sql = ("select %s, count(*) from n9e_alert_events "
           "where trigger_time >= extract(epoch from now())::bigint - 90*86400" % col)
    if extra_where:
        sql += " and " + extra_where
    sql += " group by 1 order by 2 desc"
    out = subprocess.run(
        ["docker", "exec", PG_CONTAINER, "psql", "-U", "ophub", "-d", "ophub", "-tAc", sql],
        capture_output=True, text=True)
    rows = {}
    for line in out.stdout.strip().splitlines():
        if "|" in line:
            k, v = line.rsplit("|", 1)
            rows[k.strip()] = int(v)
    return rows


def hr(title):
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7, help="夜莺侧对照窗口（默认 7 天，越小越快）")
    args = ap.parse_args()

    now = int(time.time())
    stime = now - args.days * 86400
    etime = now
    print("夜莺 %s   窗口: 近 %d 天" % (BASE, args.days))
    print("本地库窗口: 近 90 天（平台页面口径）")

    # ---------- 1. 业务组 bgid ----------
    hr("1. 业务组 —— 夜莺参数 bgid（单值）  vs  本地库 group_id")
    req = urllib.request.Request(BASE + "/api/n9e/busi-groups?limit=500",
                                 headers={"X-User-Token": TOKEN})
    groups = []
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            groups = json.loads(r.read().decode("utf-8")).get("dat") or []
    except Exception as e:
        print("  拉业务组失败:", e)
    loc = local_kv("group_id")
    print("  %-28s %-8s %-10s %-10s" % ("业务组(id/name)", "夜莺", "本地库", "一致"))
    for g in sorted(groups, key=lambda x: x.get("id", 0)):
        gid = g.get("id")
        n9 = n9e_total(stime, etime, "&bgid=%d" % gid)
        lv = loc.get(str(gid), 0)
        # 本地是全 90 天，夜莺是近 N 天：只判断「本地有数据时夜莺也应有」
        flag = ""
        if isinstance(n9, int):
            flag = "本地>=夜莺" if lv >= n9 else "!! 本地 < 夜莺"
        else:
            flag = str(n9)
        print("  %-28s %-8s %-10s %-10s" % ("%s %s" % (gid, g.get("name")), n9, lv, flag))
    print("\n  ⚠️ 多值测试：bgid=1,3（夜莺 API 单值；页面查的是本地库，多选走 group_id IN）")
    print("     bgid=1,3     ->", n9e_total(stime, etime, "&bgid=1,3"))
    print("     bgid=1&bgid=3 ->", n9e_total(stime, etime, "&bgid=1&bgid=3"))

    # ---------- 2. 监控类型 rule_prods ----------
    hr("2. 监控类型 —— 夜莺参数 rule_prods（逗号分隔多选）")
    print("  基线                      ->", n9e_total(stime, etime))
    for v in ["metric", "host", "logging", "anomaly", "loki"]:
        print("  rule_prods=%s%s-> %s" % (v, " " * (16 - len(v)), n9e_total(stime, etime, "&rule_prods=" + v)))
    print("  rule_prods=metric,logging ->", n9e_total(stime, etime, "&rule_prods=metric,logging"))
    # 对照：单数 rule_prod 是否被忽略
    print("  ⚠️ 对照 rule_prod=metric（单数，前端不用）->", n9e_total(stime, etime, "&rule_prod=metric"))
    print("\n  本地库 rule_prod 分布（若无该列会报错，属预期）：")
    print("   ", local_kv("rule_prod"))

    # ---------- 3. 告警级别 severity ----------
    hr("3. 告警级别 —— 夜莺参数 severity（1=S1 Critical 2=S2 Warning 3=S3 Info）")
    for v in [1, 2, 3]:
        print("  severity=%d -> %s" % (v, n9e_total(stime, etime, "&severity=%d" % v)))
    print("  本地库 severity 分布:", local_kv("severity"))

    # ---------- 4. 事件类别 is_recovered ----------
    hr("4. 事件类别 —— 夜莺参数 is_recovered（0=Triggered 1=Recovered）")
    for v in [0, 1]:
        print("  is_recovered=%d -> %s" % (v, n9e_total(stime, etime, "&is_recovered=%d" % v)))
    print("  本地库 is_recovered 分布:", local_kv("is_recovered"))

    # ---------- 5. 数据源 datasource_ids ----------
    hr("5. 数据源 —— 夜莺参数 datasource_ids（逗号分隔多选）")
    req = urllib.request.Request(BASE + "/api/n9e/datasource/brief",
                                 headers={"X-User-Token": TOKEN})
    dss = []
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            dss = json.loads(r.read().decode("utf-8")).get("dat") or []
    except Exception as e:
        print("  拉数据源失败:", e)
    locds = local_kv("datasource_id")
    print("  %-30s %-8s %-10s" % ("数据源(id/name)", "夜莺", "本地库"))
    for d in sorted(dss, key=lambda x: x.get("id", 0))[:6]:
        did = d.get("id")
        print("  %-30s %-8s %-10s" % ("%s %s" % (did, d.get("name")),
                                      n9e_total(stime, etime, "&datasource_ids=%d" % did),
                                      locds.get(str(did), 0)))

    # ---------- 6. 模糊搜索 query ----------
    hr("6. 模糊搜索 —— 夜莺参数 query（搜规则标题和事件标签）")
    for kw in ["instance", "department", "政务"]:
        q = urllib.parse.quote(kw)
        print("  query=%-12s -> %s" % (kw, n9e_total(stime, etime, "&query=" + q)))

    hr("结论速查")
    print("  · 业务组 = bgid（**夜莺 API 单值**，多值会报错或被静默忽略）；平台查本地库所以支持多选")
    print("  · 监控类型 = rule_prods（复数、逗号分隔）；单数 rule_prod 会被静默忽略")
    print("  · 告警级别 = severity（1 最严重）；事件类别 = is_recovered")
    print("  · 数据源 = datasource_ids；模糊搜索 = query")


if __name__ == "__main__":
    main()
