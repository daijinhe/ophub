#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""定时任务（crontab）管理 —— 真实资产端到端回归测试（`crontab -l` 口径）

数据源口径（2026-09-16 收敛）：平台**只认一条数据源** —— 在目标机上以归属用户
身份执行 `crontab -l`。旧口径（/etc/crontab、/etc/cron.d/*、/etc/cron.{hourly,
daily,weekly,monthly}/*）已整体删除：/etc/crontab 只反映发行版模板，看不到用户
真实在跑的任务，实测漏报严重。

  - 任务行是标准用户 crontab 格式，**没有「运行用户」段**：`m h dom mon dow <cmd>`
    （运行用户就是这份 crontab 的归属用户）
  - 「该用户还没有 crontab」不再是错误，而是返回 `noCrontab: true`（0 条任务）
  - 读写统一以归属用户（默认 root）身份进行：
      · SSH 登录用户就是 root            → 直连读写
      · SSH 登录用户是普通用户 + sudo 可用 → sudo 提权
      · 提权失败                          → 明确报错，绝不去改别人的 crontab
  - 「无 crontab」的提示文案跨发行版不一致（cronie 是 `no crontab for X`，
    busybox 是 `crontab: can't open 'X': No such file or directory`），两种都必须
    识别为「尚无 crontab」而不是读取失败

本脚本打真实资产（需要若干台凭据正确的机器）；不依赖真实资产的自足靶机版本见
scripts/e2e-crontab/（Dockerfile + base.crontab + e2e_crontab_user.py）。

用法：
    python scripts/verify_crontab.py
    CRONTAB_ASSET_ID=120 python scripts/verify_crontab.py

环境变量：
    CRONTAB_BASE             API 基址（默认 http://localhost:10001/api）
    CRONTAB_ASSET_ID         主测资产（执行完整增删改查；建议用「管理员密码错」的机器）
    CRONTAB_ROOT_ASSET_ID    直连模式资产（SSH 用户 = root，只做读取断言）
    CRONTAB_ALT_ASSET_ID     未填「超级管理员用户密码」的资产（回退到 SSH 用户密码）
    CRONTAB_DENIED_ASSET_ID  提权必然失败的资产（断言被拒绝且不改动）
    CRONTAB_DECOY_TASK       只应存在于其它来源（/etc/crontab 等）的特征串，
                             断言它**不会**出现在读到的用户 crontab 里
"""

import os
import sys
import time

import requests

BASE = os.environ.get("CRONTAB_BASE", "http://localhost:10001/api")
USER, PASS = "admin", "admin123"

RESULTS = []


def ok(name, cond, extra=""):
    RESULTS.append((name, bool(cond)))
    line = f"  {'PASS' if cond else 'FAIL'}  {name}"
    if extra:
        line += f"  | {extra}"
    print(line, flush=True)


def head(title):
    print(f"\n--- {title} ---", flush=True)


def lines_of(content):
    """按行切分（与后端 splitCrontabLines 口径一致）"""
    if not content:
        return []
    body = content[:-1] if content.endswith("\n") else content
    return body.split("\n") if body else [""]


def main():
    s = requests.Session()
    r = s.post(f"{BASE}/auth/login", json={"username": USER, "password": PASS}, timeout=15)
    s.headers["Authorization"] = f"Bearer {r.json()['data']['token']}"

    # 登录状态校验：未授权的接口应 401
    anon = requests.get(f"{BASE}/crontab/assets", timeout=15)
    ok("未认证访问被拒绝", anon.status_code == 401, f"status={anon.status_code}")

    # ---------------------------------------------------------------- 选资产
    head("前置：选择目标资产")
    asset_id = os.environ.get("CRONTAB_ASSET_ID")
    if asset_id:
        asset_id = int(asset_id)
        ok("使用指定资产", True, f"assetId={asset_id}")
    else:
        lst = s.get(f"{BASE}/crontab/assets", timeout=20).json()["data"]["list"]
        ok("资产列表可读", len(lst) > 0, f"{len(lst)} 台")
        cands = [x for x in lst if "临时" in (x.get("assetName") or "") and x.get("ready")]
        if not cands:
            print("  !! 未找到可用的临时资产，请设置 CRONTAB_ASSET_ID", flush=True)
            return 1
        asset_id = cands[0]["assetId"]
        ok("命中临时资产", True, f"{cands[0]['assetName']} ({cands[0].get('sshHost')})")

    def get_view(aid=None):
        return s.get(f"{BASE}/crontab/asset/{aid or asset_id}", timeout=90).json()["data"]

    # ---------------------------------------------------------------- 读取
    head("1) 读取 root 用户的 crontab（提权口径）")
    v = get_view()
    orig_content, orig_hash = v["content"], v["hash"]
    orig_lines = lines_of(orig_content)

    ok("crontab 可用", v["crontabAvailable"])
    ok("归属用户 = root", v["user"] == "root", f"user={v['user']}")
    ok("提权方式已标注", v["runMode"] in ("direct", "sudo"), f"runMode={v['runMode']}")
    ok("数据源 = crontab -l", str(v.get("source", "")).endswith("crontab -l"),
       f"source={v.get('source')}")
    ok("旧口径字段已删除（systemTaskCount / systemTasks / sysPath）",
       all(k not in v for k in ("systemTaskCount", "systemTasks", "sysPath")),
       str([k for k in ("systemTaskCount", "systemTasks", "sysPath") if k in v]))
    ok("任务行不含「运行用户」段（用户 crontab 格式）",
       all("user" not in t for t in v["tasks"]),
       str(sorted(v["tasks"][0].keys()) if v["tasks"] else []))
    ok("「有无 crontab」用 noCrontab 布尔表达", isinstance(v.get("noCrontab"), bool),
       f"noCrontab={v.get('noCrontab')} taskCount={v['taskCount']}")
    decoy = os.environ.get("CRONTAB_DECOY_TASK", "run-parts /etc/cron")
    ok("未混入其它来源（/etc/crontab、/etc/cron.d/*、脚本目录）的内容", decoy not in orig_content,
       f"不含「{decoy}」")
    ok("计数自洽（taskCount = enabledCount + disabledCount）",
       v["taskCount"] == v["enabledCount"] + v["disabledCount"],
       f"{v['taskCount']} = {v['enabledCount']} + {v['disabledCount']}")
    task_lines = {t["lineNo"] for t in v["tasks"]}
    ok("非任务行被单独归类（与 tasks 的行号不重叠）",
       all(o["lineNo"] not in task_lines for o in v["others"]),
       f"tasks={len(v['tasks'])} others={len(v['others'])}")
    if v["others"]:
        ok("非任务行类型可识别", all(o["kind"] in ("comment", "env", "blank") for o in v["others"]),
           str(sorted({o["kind"] for o in v["others"]})))
    else:
        ok("非任务行类型可识别", True, "本机 crontab 里没有非任务行，跳过")

    # ---------------------------------------------------------------- 直连模式
    root_aid = os.environ.get("CRONTAB_ROOT_ASSET_ID")
    if root_aid:
        head("1b) 直连模式（SSH 用户 = root）")
        rv = get_view(int(root_aid))
        ok("直连读取成功", rv["crontabAvailable"])
        ok("直连归属用户 = root", rv["user"] == "root", f"user={rv['user']}")
        ok("直连模式 = direct", rv["runMode"] == "direct", f"runMode={rv['runMode']}")

    # ---------------------------------------------------------------- 提权失败
    alt_aid = os.environ.get("CRONTAB_ALT_ASSET_ID")
    if alt_aid:
        head("1d) 未填「超级管理员用户密码」：应回退到 SSH 用户密码提权")
        av = get_view(int(alt_aid))
        ok("提权读取成功", av["crontabAvailable"])
        ok("归属用户 = root", av["user"] == "root", f"user={av['user']}")
        ok("模式 = sudo", av["runMode"] == "sudo", f"runMode={av['runMode']}")
        ok("读到的是 root 的任务", decoy not in av["content"])

    denied_aid = os.environ.get("CRONTAB_DENIED_ASSET_ID")
    if denied_aid:
        head("1c) 提权必然失败的资产（不得改普通用户 crontab）")
        rr = s.get(f"{BASE}/crontab/asset/{denied_aid}", timeout=90)
        ok("读取被拒绝", rr.status_code >= 400, f"status={rr.status_code}")
        ok("错误信息提示提权", "提权" in rr.text, rr.text[:110].replace("\n", " "))
        ok("错误信息不含内部标识", "crontab-priv" not in rr.text)

    # ---------------------------------------------------------------- 性能
    head("1e) 性能：单机去重缓存 + 提权密码源记忆")
    t0 = time.time()
    rf1 = s.get(f"{BASE}/crontab/asset/{asset_id}", params={"refresh": 1}, timeout=90).json()["data"]
    live_ms = (time.time() - t0) * 1000
    ok("强制重连（refresh=1）返回最新内容", rf1["content"] == orig_content)
    ok("强制重连不标记为平台缓存", not rf1.get("cached"), f"cached={rf1.get('cached')}")
    ok("重连确实连了目标机（>50ms）", live_ms > 50, f"{live_ms:.0f}ms")
    ok("返回读取时间戳（前端据此判断新鲜度）",
       isinstance(rf1.get("readAtMs"), int) and rf1["readAtMs"] > 1_600_000_000_000,
       f"readAtMs={rf1.get('readAtMs')}")

    t0 = time.time()
    rf2 = s.get(f"{BASE}/crontab/asset/{asset_id}", timeout=90).json()["data"]
    hit_ms = (time.time() - t0) * 1000
    ok("15 秒内重复读取命中平台去重缓存", rf2.get("cached") is True, f"cached={rf2.get('cached')}")
    ok("命中缓存不重连目标机（<50ms）", hit_ms < 50, f"{hit_ms:.1f}ms")
    ok("缓存内容与远端一致", rf2["content"] == orig_content)
    print(f"    [参考] 重连 {live_ms:.0f}ms / 命中缓存 {hit_ms:.1f}ms", flush=True)

    # 提权密码源记忆的回归保护：密码源错的那台机器不能把「错误的密码源」记下来。
    # 曾经踩过的坑：解析出错时把一次失败的读取当成成功，于是把错误的提权前缀
    # 写进记忆，之后每一次读取都白等一轮失败认证（实测每次 4.5s）。
    head("1f) 提权密码源记忆：连续多次重连都必须成功且内容一致")
    for i in range(3):
        v = s.get(f"{BASE}/crontab/asset/{asset_id}", params={"refresh": 1}, timeout=90).json()["data"]
        ok(f"第 {i + 1} 次重连读取成功且内容一致", v["content"] == orig_content,
           f"taskCount={v['taskCount']}")

    # ---------------------------------------------------------------- 新增
    head("2) 新增定时任务 → 远端追加")
    r = s.post(f"{BASE}/crontab/asset/{asset_id}/tasks",
               json={"hash": orig_hash, "expr": "0 6 * * *", "command": "/bin/echo api-added", "enabled": True},
               timeout=90)
    ok("新增返回 200", r.status_code == 200, f"status={r.status_code}")
    body = r.json().get("data") or {}
    ok("远端确实变更", body.get("changed") is True)
    ok("已备份原 crontab", bool(body.get("backup")), str(body.get("backup")))

    v2 = get_view()
    ok("任务数 +1", v2["taskCount"] == v["taskCount"] + 1, f"{v['taskCount']} → {v2['taskCount']}")
    added = [t for t in v2["tasks"] if t["command"] == "/bin/echo api-added"]
    ok("新增行可定位", len(added) == 1)
    new_line = added[0]
    ok("原有行逐字节未变（前 %d 行）" % len(orig_lines),
       lines_of(v2["content"])[: len(orig_lines)] == orig_lines)
    ok("中文描述已生成", bool(new_line["describe"]), new_line.get("describe", ""))

    # ---------------------------------------------------------------- 编辑
    head("3) 编辑任务 → 内容替换且相邻行不受影响")
    before_edit = lines_of(v2["content"])
    r = s.put(f"{BASE}/crontab/asset/{asset_id}/tasks",
              json={"hash": v2["hash"], "lineNo": new_line["lineNo"], "oldRaw": new_line["raw"],
                    "expr": "30 6 * * *", "command": "/bin/echo api-edited", "enabled": True},
              timeout=90)
    ok("编辑返回 200", r.status_code == 200, f"status={r.status_code}")
    v3 = get_view()
    ok("任务数不变", v3["taskCount"] == v2["taskCount"], f"{v3['taskCount']}")
    after_edit = lines_of(v3["content"])
    idx = new_line["lineNo"] - 1
    ok("目标行已被替换", "api-edited" in after_edit[idx] and "api-added" not in after_edit[idx], after_edit[idx])
    ok("目标行以外完全一致",
       after_edit[:idx] + after_edit[idx + 1:] == before_edit[:idx] + before_edit[idx + 1:])
    ed = [t for t in v3["tasks"] if t["lineNo"] == new_line["lineNo"]][0]
    ok("表达式已更新", ed["expr"] == "30 6 * * *", ed["expr"])

    # ---------------------------------------------------------------- % 转义
    head("4) 命令含 % → 下发时转义、回显时还原")
    r = s.post(f"{BASE}/crontab/asset/{asset_id}/tasks",
               json={"hash": v3["hash"], "expr": "0 7 * * *", "command": "/bin/echo pct-%H-%M", "enabled": True},
               timeout=90)
    ok("新增含 % 任务成功", r.status_code == 200, f"status={r.status_code}")
    v4 = get_view()
    pct = [t for t in v4["tasks"] if "pct-" in (t["command"] or "")]
    ok("回显为原始形式", len(pct) == 1 and pct[0]["command"] == "/bin/echo pct-%H-%M",
       pct[0]["command"] if pct else "未找到")
    ok("远端存储为转义形式", r"pct-\%H-\%M" in v4["content"],
       [l for l in lines_of(v4["content"]) if "pct-" in l][0] if any("pct-" in l for l in lines_of(v4["content"])) else "")

    # ---------------------------------------------------------------- 禁用/启用
    head("5) 禁用 / 启用（注释任务行，无损还原）")
    target = pct[0]
    r = s.put(f"{BASE}/crontab/asset/{asset_id}/tasks",
              json={"hash": v4["hash"], "lineNo": target["lineNo"], "oldRaw": target["raw"],
                    "expr": target["expr"], "command": target["command"], "enabled": False},
              timeout=90)
    ok("禁用返回 200", r.status_code == 200, f"status={r.status_code}")
    v5 = get_view()
    row = lines_of(v5["content"])[target["lineNo"] - 1]
    ok("远端行已被注释", row.startswith("#"), row)
    dis = [t for t in v5["tasks"] if t["lineNo"] == target["lineNo"]][0]
    ok("被识别为已禁用", dis["enabled"] is False and dis["kind"] == "disabled")
    ok("禁用后仍可还原命令", dis["command"] == "/bin/echo pct-%H-%M", dis["command"])

    r = s.put(f"{BASE}/crontab/asset/{asset_id}/tasks",
              json={"hash": v5["hash"], "lineNo": dis["lineNo"], "oldRaw": dis["raw"],
                    "expr": dis["expr"], "command": dis["command"], "enabled": True},
              timeout=90)
    ok("启用返回 200", r.status_code == 200)
    v6 = get_view()
    row = lines_of(v6["content"])[dis["lineNo"] - 1]
    ok("远端行已取消注释", not row.startswith("#"), row)

    # ---------------------------------------------------------------- 冲突保护
    head("6) 并发保护：过期指纹应被拒绝且内容零改动")
    stale = s.put(f"{BASE}/crontab/asset/{asset_id}/tasks",
                  json={"hash": orig_hash, "lineNo": dis["lineNo"], "oldRaw": dis["raw"],
                        "expr": dis["expr"], "command": "echo should-not-happen", "enabled": True},
                  timeout=90)
    ok("过期指纹被拒绝", stale.status_code >= 400, f"status={stale.status_code}")
    ok("提示已被改动", "已被改动" in stale.text, stale.text[:100].replace("\n", " "))
    v7 = get_view()
    ok("内容零改动", v7["content"] == v6["content"])

    # ---------------------------------------------------------------- 定位校验
    head("7) 定位校验：错误行内容应被拒绝")
    bad = s.put(f"{BASE}/crontab/asset/{asset_id}/tasks",
                json={"hash": v7["hash"], "lineNo": dis["lineNo"], "oldRaw": "not-the-real-line",
                      "expr": dis["expr"], "command": "echo nope", "enabled": True},
                timeout=90)
    ok("内容不匹配被拒绝", bad.status_code >= 400, f"status={bad.status_code}")
    ok("内容仍零改动", get_view()["content"] == v7["content"])

    # ---------------------------------------------------------------- 删除
    head("8) 删除任务 → 其余行逐行一致")
    before_del = lines_of(v7["content"])
    each = [t for t in v7["tasks"] if "pct-" in (t["command"] or "")][0]
    r = s.request("DELETE", f"{BASE}/crontab/asset/{asset_id}/tasks",
                  json={"hash": v7["hash"], "lineNo": each["lineNo"], "oldRaw": each["raw"]}, timeout=90)
    ok("删除返回 200", r.status_code == 200, f"status={r.status_code}")
    v8 = get_view()
    after_del = lines_of(v8["content"])
    ok("行数 -1", len(after_del) == len(before_del) - 1, f"{len(before_del)} → {len(after_del)}")
    rest_ok = after_del[: each["lineNo"] - 1] == before_del[: each["lineNo"] - 1] and \
        after_del[each["lineNo"] - 1:] == before_del[each["lineNo"]:]
    ok("其余行逐行一致", rest_ok)
    ok("任务数 -1", v8["taskCount"] == v7["taskCount"] - 1,
       f"{v7['taskCount']} → {v8['taskCount']}")

    head("8b) 删除剩余新增任务 → 应与基线逐字节一致")
    each2 = [t for t in v8["tasks"] if t["command"] == "/bin/echo api-edited"][0]
    r = s.request("DELETE", f"{BASE}/crontab/asset/{asset_id}/tasks",
                  json={"hash": v8["hash"], "lineNo": each2["lineNo"], "oldRaw": each2["raw"]}, timeout=90)
    ok("删除返回 200", r.status_code == 200, f"status={r.status_code}")
    v8b = get_view()
    ok("任务数回到基线", v8b["taskCount"] == v["taskCount"],
       f"taskCount={v8b['taskCount']}（基线 {v['taskCount']}）")
    ok("内容与基线逐字节一致", v8b["content"] == orig_content, f"hash={v8b['hash'][:12]}")

    # ---------------------------------------------------------------- 原文保存
    head("9) 整份原文保存（高级编辑）")
    raw_new = v8b["content"].rstrip("\n") + "\n0 8 * * * /bin/echo raw-mode\n"
    r = s.put(f"{BASE}/crontab/asset/{asset_id}/raw", json={"hash": v8b["hash"], "content": raw_new}, timeout=90)
    ok("原文保存返回 200", r.status_code == 200, f"status={r.status_code}")
    v9 = get_view()
    ok("远端已新增该行", "/bin/echo raw-mode" in v9["content"])
    raw_back = v9["content"].replace("0 8 * * * /bin/echo raw-mode\n", "")
    r = s.put(f"{BASE}/crontab/asset/{asset_id}/raw", json={"hash": v9["hash"], "content": raw_back}, timeout=90)
    ok("原文还原返回 200", r.status_code == 200)
    v10 = get_view()
    ok("内容回到基线", v10["content"] == v8b["content"], f"hash={v10['hash'][:12]}")

    head("10) 参数校验")
    bad_expr = s.post(f"{BASE}/crontab/asset/{asset_id}/tasks",
                      json={"hash": v10["hash"], "expr": "99 99 * * *", "command": "echo x"}, timeout=60)
    ok("非法表达式被拒绝", bad_expr.status_code == 400, bad_expr.text[:90].replace("\n", " "))
    empty_cmd = s.post(f"{BASE}/crontab/asset/{asset_id}/tasks",
                       json={"hash": v10["hash"], "expr": "0 1 * * *", "command": "   "}, timeout=60)
    ok("空命令被拒绝", empty_cmd.status_code == 400, empty_cmd.text[:90].replace("\n", " "))
    ok("校验失败未产生副作用", get_view()["content"] == v10["content"])

    # ---------------------------------------------------------------- 批量扫描
    head("11) 批量扫描（root 用户口径）")
    rs = s.post(f"{BASE}/crontab/scan", json={}, timeout=600)
    ok("扫描接口返回 200", rs.status_code == 200, f"status={rs.status_code}")
    data = rs.json().get("data") or {}
    items = data.get("list") or []
    ok("扫描结果非空", len(items) > 0, f"{len(items)} 台")
    ok("扫描含统计字段", all(k in data for k in ("scanned", "okCount", "taskHostCount", "taskTotal")))
    ok("noCrontab 与 taskCount 自洽（没有 crontab 的一定是 0 条任务）",
       all((not x.get("noCrontab")) or x.get("taskCount", 0) == 0 for x in items),
       str([x["assetId"] for x in items if x.get("noCrontab") and x.get("taskCount")]))
    ok("扫描结果里不再有 nocmd 这种旧状态，且不返回旧口径字段",
       all(x.get("status") != "nocmd" for x in items)
       and all(not ({"systemTaskCount", "systemTasks", "sysPath"} & set(x)) for x in items),
       str(sorted({x.get("status") for x in items})))
    mine = [x for x in items if x["assetId"] == asset_id]
    ok("扫描命中主测资产", len(mine) == 1)
    if mine:
        m = mine[0]
        ok("扫描状态 = ok", m["status"] == "ok", m["status"])
        ok("扫描归属用户 = root", m["user"] == "root", m["user"])
        ok("扫描任务数一致", m["taskCount"] == v["taskCount"],
           f"taskCount={m['taskCount']}（基线 {v['taskCount']}）")
        ok("扫描带任务明细", len(m["tasks"]) == v["taskCount"], f"tasks={len(m['tasks'])}")
        ok("扫描带指纹（可继续写操作）", len(m["hash"]) == 64)
    if root_aid:
        ritems = [x for x in items if x["assetId"] == int(root_aid)]
        ok("扫描覆盖直连资产", len(ritems) == 1 and ritems[0]["status"] == "ok",
           ritems[0]["status"] if ritems else "缺失")
    if denied_aid:
        ditems = [x for x in items if x["assetId"] == int(denied_aid)]
        ok("扫描正确识别提权失败", len(ditems) == 1 and ditems[0]["status"] == "denied",
           ditems[0]["status"] if ditems else "缺失")

    # 指定 assetIds 的子集扫描
    sub = s.post(f"{BASE}/crontab/scan", json={"assetIds": [asset_id]}, timeout=180)
    sub_items = (sub.json().get("data") or {}).get("list") or []
    ok("指定资产扫描只返回该台", len(sub_items) == 1 and sub_items[0]["assetId"] == asset_id,
       f"{len(sub_items)} 台")

    ky = s.post(f"{BASE}/crontab/scan", json={"keyword": "%%%__不存在__%%%"}, timeout=180)
    ky_items = (ky.json().get("data") or {}).get("list") or []
    ok("关键字过滤生效", len(ky_items) == 0, f"{len(ky_items)} 台")

    # ---------------------------------------------------------------- 收尾
    head("12) 收尾：确认远端已回到基线")
    vf = get_view()
    ok("内容 = 基线", vf["content"] == orig_content, f"hash={vf['hash'][:12]}")
    ok("任务数 = 基线", vf["taskCount"] == v["taskCount"],
       f"taskCount={vf['taskCount']}（基线 {v['taskCount']}）")

    passed = sum(1 for _, c in RESULTS if c)
    total = len(RESULTS)
    print(f"\n===== 结果：{passed}/{total} 通过 =====", flush=True)
    fails = [n for n, c in RESULTS if not c]
    if fails:
        print("失败项：", flush=True)
        for n in fails:
            print(f"  - {n}", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"\n!! 脚本异常：{e}", flush=True)
        import traceback

        traceback.print_exc()
        sys.exit(2)
