#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实目标机批量校准实测：跨区域 / 跨架构抽样，逐台 SSH 采集并打印比对结果。"""
import json
import urllib.error
import urllib.request

BASE = "http://localhost:8088/api"


def call(method, path, token=None, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:300]


def main():
    st, res = call("POST", "/auth/login", body={"username": "admin", "password": "admin123"})
    tok = res["data"]["token"]
    st, res = call("GET", "/assets?page=1&size=200", tok)
    assets = res["data"]["list"]
    print("资产总数: %d" % len(assets))

    # 按 (网络区域, 操作系统版本) 去重抽样，最多 6 台，覆盖不同操作系统
    picked, seen = [], set()
    for a in assets:
        f = a.get("fields") or {}
        if not a.get("ip") or not (f.get("密码") or f.get("普通用户密码")):
            continue
        picked.append(a)
        if len(picked) >= int(__import__("os").environ.get("MAX", "12")):
            break

    ok, fail = 0, 0
    for a in picked:
        f = a["fields"]
        print("\n" + "=" * 108)
        print("资产 #%s  %s  %s  [%s / %s]" % (a["id"], a["ip"], f.get("操作系统版本"), f.get("所属网络区域"), f.get("CPU类型")))
        st, res = call("POST", "/assets/%s/calibrate" % a["id"], tok, {})
        if st != 200 or res.get("code") != 0:
            fail += 1
            print("  ✗ 采集失败: %s" % str(res.get("msg"))[:200])
            continue
        d = res["data"]
        ok += 1
        print("  SSH %s   耗时 %sms   %s" % (d["ssh"], d["durationMs"], ("warning: " + d["warning"]) if d.get("warning") else ""))
        print("  %-12s %-18s %-18s %-6s %s" % ("校准项", "导入信息", "实测信息", "结果", "备注"))
        diff = 0
        for it in d["items"]:
            if it["diff"]:
                diff += 1
            print("  %-12s %-18s %-18s %-6s %s" % (
                it["label"], it["imported"] or "(空)", it["detected"] or "(空)",
                "不一致" if it["diff"] else "一致",
                (it.get("hint") or it.get("raw") or "")[:60]))
        print("  --> 检出差异 %d 项" % diff)

    print("\n" + "=" * 108)
    print("汇总：成功 %d 台 / 失败 %d 台（共抽样 %d 台）" % (ok, fail, len(picked)))


if __name__ == "__main__":
    main()
