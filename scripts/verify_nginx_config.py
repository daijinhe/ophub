#!/usr/bin/env python3
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# -*- coding: utf-8 -*-
"""
配置管理（nginx 配置文件管理）端到端验证。

安全约定：
  - 扫描流程只读，不会修改目标机任何文件。
  - CRUD 闭环验证使用 /tmp/ophub_nginx_test_<ts>.conf 测试文件，
    不触碰真实 nginx 配置；结束后连同远端文件一并删除。
"""
import json
import os
import sys
import time

import requests

BASE = "http://localhost:10001/api"
USER, PASS = "admin", "admin123"

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  | {detail}" if detail else ""))


def data_or_none(r):
    try:
        j = r.json()
        return j.get("data"), j.get("code", 0), j.get("msg", "")
    except Exception:
        return None, -1, f"HTTP {r.status_code}"


def main():
    s = requests.Session()
    r = s.post(f"{BASE}/auth/login", json={"username": USER, "password": PASS}, timeout=15)
    token = r.json()["data"]["token"]
    s.headers["Authorization"] = f"Bearer {token}"

    # 1) 扫描范围（资产清单）
    r = s.get(f"{BASE}/config/scan/scope", timeout=15)
    scope, _, _ = data_or_none(r)
    assets = [a for a in scope["assets"] if a.get("ip")]
    check("scan/scope 资产清单", len(assets) > 0, f"共 {len(scope['assets'])} 台，含 IP {len(assets)} 台")
    if not assets:
        print("没有可扫描资产，终止")
        sys.exit(1)

    # 2) 逐台试扫（只读），挑一台 SSH 可达的主机做后续 CRUD
    #    可用 NGINXCFG_ASSET_ID=<id> 直接指定目标机（如一次性 SSH 靶机），跳过不可达的真实资产
    forced = os.environ.get("NGINXCFG_ASSET_ID")
    if forced:
        assets = [a for a in assets if str(a["id"]) == str(forced)]
        if not assets:
            print(f"NGINXCFG_ASSET_ID={forced} 不在资产清单中")
            sys.exit(1)
    target, found, conn_errs = None, [], []
    for a in assets:
        r = s.post(f"{BASE}/config/scan", json={"assetId": a["id"]}, timeout=120)
        scan, code, msg = data_or_none(r)
        if scan is None:
            conn_errs.append(f"{a['name']}: {msg[:50]}")
            continue
        items = scan.get("items", [])
        conn_fail = [i for i in items if "连接/探测目标机失败" in (i.get("error") or "")]
        if conn_fail:
            conn_errs.append(f"{a['name']}: {conn_fail[0]['error'][:60]}")
            continue
        # SSH 可达（无论是否装了 nginx）
        target = a
        found = [i for i in items if not i.get("error")]
        no_nginx = [i for i in items if "未检测到 nginx" in (i.get("error") or "")]
        check(
            f"scan 单台扫描（{a['name']} {a['ip']}）",
            True,
            f"发现 {scan['foundCount']} 个配置" + ("；该机未安装 nginx" if no_nginx and not found else ""),
        )
        for it in found:
            check(f"  扫描到 {it['path']}（{it['kind']}，{it['size']}B）", bool(it["content"] or it["content"] == ""))
        break
    if target is None:
        check("存在 SSH 可达资产", False, "；".join(conn_errs)[:200])
        print(f"\n===== {len(results) - len([x for x in results if not x[1]])}/{len(results)} 通过 =====")
        sys.exit(1)

    # 3) 若扫描到内容，导入第一个（真实配置纳管，只存缓存不写远端）
    imported_real = None
    if found:
        it = found[0]
        r = s.post(
            f"{BASE}/config/import",
            json={"items": [{"assetId": it["assetId"], "path": it["path"], "kind": it["kind"],
                             "content": it["content"], "md5": it["md5"],
                             "assetName": it["assetName"], "host": it["host"]}]},
            timeout=30,
        )
        d, _, _ = data_or_none(r)
        check("import 导入扫描结果", d and d["created"] == 1, f"created={d and d['created']} skipped={d and d['skipped']}")
        imported_real = it["path"]
        # 重复导入应跳过
        r = s.post(
            f"{BASE}/config/import",
            json={"items": [{"assetId": it["assetId"], "path": it["path"], "kind": it["kind"]}]},
            timeout=30,
        )
        d, _, _ = data_or_none(r)
        check("import 重复导入去重", d and d["skipped"] == 1)

    # 4) CRUD 闭环（/tmp 测试文件，不碰真实配置）
    test_path = f"/tmp/ophub_nginx_test_{int(time.time())}.conf"
    body = "# ophub nginx config test\n"
    r = s.post(f"{BASE}/config", json={"assetId": target["id"], "path": test_path, "kind": "other", "content": body}, timeout=30)
    rec, code, msg = data_or_none(r)
    cid = rec.get("id") if rec else None
    check("create 新增纳管", bool(cid), f"id={cid}")
    r2 = s.post(f"{BASE}/config", json={"assetId": target["id"], "path": test_path, "kind": "other"}, timeout=30)
    _, code2, msg2 = data_or_none(r2)
    check("create 重复路径被拒", code2 != 0, msg2[:40])

    content_v2 = body + "server {\n  listen 18080;\n  return 200 'ophub-test-ok';\n}\n"
    r = s.post(f"{BASE}/config/{cid}/sync", json={"content": content_v2}, timeout=120)
    d, code, msg = data_or_none(r)
    check(
        "sync 保存并写入远端",
        code == 0,
        f"nginx -t: valid={d.get('valid') if d else '-'} out={str(d.get('validateOutput') if d else msg)[:70]!r}",
    )

    r = s.post(f"{BASE}/config/{cid}/pull", json={}, timeout=120)
    d, code, msg = data_or_none(r)
    check("pull 拉取回读一致", d and d["content"] == content_v2 and d["status"] == "synced", f"status={d['status'] if d else msg[:40]}")

    r = s.put(f"{BASE}/config/{cid}", json={"kind": "conf.d"}, timeout=30)
    d, _, _ = data_or_none(r)
    check("update 修改类型", d and d["kind"] == "conf.d")

    # 列表 + 过滤
    r = s.get(f"{BASE}/config", params={"keyword": "ophub_nginx_test"}, timeout=30)
    lst, _, _ = data_or_none(r)
    check("list 关键字过滤", any(x["id"] == cid for x in lst["list"]), f"命中 {len(lst['list'])} 条")
    check("list 统计结构", all(k in lst["stats"] for k in ("total", "synced", "modified", "error")))

    # 5) 删除（含远端）
    r = s.delete(f"{BASE}/config/{cid}", params={"deleteRemote": "true"}, timeout=60)
    d, _, _ = data_or_none(r)
    check("delete 删除记录+远端", d and d.get("deleted") is True and d.get("remoteDeleted") is True, str(d))
    r = s.get(f"{BASE}/config/{cid}", timeout=30)
    _, code, _ = data_or_none(r)
    check("delete 记录已不存在", code != 0)

    # 6) 汇总
    r = s.get(f"{BASE}/config", timeout=30)
    stats, _, _ = data_or_none(r)
    extra = f"（真实配置已纳管: {imported_real}）" if imported_real else "（该机未检出 nginx，扫描机制正常）"
    print(f"\n统计: {json.dumps(stats, ensure_ascii=False)} {extra}")

    fails = [x for x in results if not x[1]]
    print(f"\n===== {len(results) - len(fails)}/{len(results)} 通过 =====")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
