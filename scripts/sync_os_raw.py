#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量把资产「操作系统版本」同步为 /etc/os-release 的 ID + VERSION_ID 拼接值。

用途：资源校准默认已按「ID+版本号」写法比对（如 almalinux8.9 / hce2.0 / centos7），
此脚本用于一次性把存量资产刷成同一口径。
特性：
  - 只写「操作系统版本」这一个字段，其它校准项一律不动；
  - 先逐台 SSH 采集，采集失败的资产跳过并打印原因，不会写库；
  - 文本已一致（或标为一致）的资产不写库，幂等；
  - 支持 DRY=1 只预览不写库。

用法：
  PY=python.exe  # 任意 python3
  $PY scripts/sync_os_raw.py          # 实际同步
  DRY=1 $PY scripts/sync_os_raw.py    # 只预览
"""
import json
import os
import urllib.error
import urllib.request

BASE = "http://localhost:8088/api"
DRY = os.environ.get("DRY", "") not in ("", "0", "false")


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
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def main():
    st, res = call("POST", "/auth/login", body={"username": "admin", "password": "admin123"})
    token = res["data"]["token"]
    st, res = call("GET", "/assets?page=1&size=200", token)
    assets = res["data"]["list"]
    print("资产总数 %d，模式：%s\n" % (len(assets), "预览（不写库）" if DRY else "实际同步"))

    changed = skipped = failed = same = 0
    for a in assets:
        f = a.get("fields") or {}
        if not a.get("ip") or not (f.get("密码") or f.get("普通用户密码")):
            continue
        st, res = call("POST", "/assets/%s/calibrate" % a["id"], token, {})
        if st != 200 or res.get("code") != 0:
            failed += 1
            print("#%-4s %-16s ✗ 采集失败：%s" % (a["id"], a["ip"], str(res.get("msg"))[:70]))
            continue
        item = next((x for x in res["data"]["items"] if x["key"] == "操作系统版本"), None)
        if not item or not item["detected"]:
            skipped += 1
            print("#%-4s %-16s - 未采集到操作系统信息" % (a["id"], a["ip"]))
            continue
        if not item["diff"]:
            same += 1
            print("#%-4s %-16s = 已一致：%s" % (a["id"], a["ip"], item["detected"]))
            continue
        if DRY:
            changed += 1
            print("#%-4s %-16s → %s" % (a["id"], a["ip"], item["detected"]))
            print("        （原值 %s）" % item["imported"])
            continue
        st, res = call("POST", "/assets/%s/calibrate/apply" % a["id"], token,
                       {"fields": {"操作系统版本": item["detected"]}})
        if st == 200 and res.get("code") == 0:
            changed += 1
            print("#%-4s %-16s ✓ %s → %s" % (a["id"], a["ip"], item["imported"], item["detected"]))
        else:
            failed += 1
            print("#%-4s %-16s ✗ 写入失败：%s" % (a["id"], a["ip"], str(res.get("msg"))[:70]))

    print("\n汇总：改写 %d 台 / 已一致 %d 台 / 跳过 %d 台 / 失败 %d 台"
          % (changed, same, skipped, failed))


if __name__ == "__main__":
    main()
