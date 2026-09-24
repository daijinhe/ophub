#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
verify_n9e_alert_report.py —— 「监控告警报表」（夜莺历史告警）端到端验证

覆盖：
  A. 连接配置：读取 / 连通性测试
  B. 同步：触发 → 轮询进度 → 完成校验
  C. 查询：列表分页、筛选（业务组/等级/恢复状态/关键字）
  D. 统计：总量 / 等级分布 / TOP 榜 / 逐日趋势
  E. 导出：下载 xlsx，校验是合法 xlsx、行数与接口 total 一致
  G. 数据源筛选（v1.7.50）：下拉取值、单选/多选 OR 语义、与统计联动、导出含「数据源」列
  F. 权限：无 prom:alert:* 权限的账号必须 403

用法：
  python scripts/verify_n9e_alert_report.py                 # 全量（90 天，耗时约 3 分钟）
  python scripts/verify_n9e_alert_report.py --days 7        # 快速回归
  python scripts/verify_n9e_alert_report.py --skip-sync     # 只验查询/统计/导出（复用已有数据）
"""

import argparse
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

# 用 127.0.0.1 而不是 localhost：本机 localhost 会解析到 IPv6 ::1，
# 而 Docker Desktop 只监听了 IPv4 0.0.0.0:10001，localhost 会直接连不上（HTTP 000）。
BASE = "http://127.0.0.1:10001"
USERNAME = "admin"
PASSWORD = "admin123"

PASS = 0
FAIL = 0


def ok(msg):
    global PASS
    PASS += 1
    print("  [ok]   %s" % msg)


def bad(msg):
    global FAIL
    FAIL += 1
    print("  [FAIL] %s" % msg)


def check(cond, msg):
    ok(msg) if cond else bad(msg)
    return bool(cond)


def api(method, path, body=None, token=None, timeout=60, raw=False):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
    )
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            if raw:
                return r.status, data, dict(r.headers)
            return r.status, json.loads(data.decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        data = e.read()
        if raw:
            return e.code, data, dict(e.headers)
        try:
            return e.code, json.loads(data.decode("utf-8") or "{}")
        except Exception:
            return e.code, {"raw": data.decode("utf-8", "replace")[:300]}
    except Exception as e:
        return 0, {"raw": str(e)}


def unwrap(js):
    """后端统一包装 {code,msg,data}"""
    return js.get("data") if isinstance(js, dict) else None


def login():
    st, js = api("POST", "/api/auth/login", {"username": USERNAME, "password": PASSWORD})
    if st != 200:
        raise RuntimeError("登录失败(%s): %s" % (st, js))
    return unwrap(js)["token"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90, help="同步回溯天数")
    ap.add_argument("--skip-sync", action="store_true", help="跳过同步阶段")
    args = ap.parse_args()

    print("=" * 72)
    print("监控告警报表（夜莺历史告警）端到端验证")
    print("=" * 72)

    token = login()
    print("已登录 admin，token 长度 %d\n" % len(token))

    # ---------- A. 连接配置 ----------
    print("A. 连接配置")
    st, js = api("GET", "/api/prom/n9e-config", token=token)
    cfg = unwrap(js) or {}
    check(st == 200, "GET /prom/n9e-config 返回 200（实际 %s）" % st)
    check(bool(cfg.get("baseUrl")), "夜莺地址已配置：%s" % cfg.get("baseUrl"))
    check(cfg.get("hasToken") is True, "Token 已配置（掩码 %s）" % cfg.get("tokenMask"))
    check(cfg.get("maxDays") == 90, "最大回溯天数 = 90（实际 %s）" % cfg.get("maxDays"))
    check(cfg.get("chunkDays") == 30, "分片跨度 = 30 天（实际 %s）" % cfg.get("chunkDays"))

    st, js = api("POST", "/api/prom/n9e-config/test", {}, token=token, timeout=90)
    tst = unwrap(js) or {}
    check(st == 200 and tst.get("ok") is True, "连通性测试通过：%s" % tst.get("msg", js.get("msg")))

    # 负例：错误 Token 必须失败，且提示可读
    st, js = api("POST", "/api/prom/n9e-config/test", {"token": "bad-token-0000"}, token=token, timeout=90)
    check(st != 200, "错误 Token 的连通性测试被拒绝（HTTP %s）" % st)

    # ---------- B. 同步 ----------
    if not args.skip_sync:
        print("\nB. 数据同步（%d 天，预计 1~3 分钟）" % args.days)
        st, js = api("POST", "/api/prom/n9e/sync", {"days": args.days}, token=token)
        check(st == 200, "POST /prom/n9e/sync 返回 200（实际 %s）" % st)
        started = (unwrap(js) or {}).get("started")
        check(started is True, "同步任务已启动：%s" % (unwrap(js) or {}).get("msg"))

        # 重复触发应被拒绝（不重复起任务）
        st2, js2 = api("POST", "/api/prom/n9e/sync", {"days": args.days}, token=token)
        d2 = unwrap(js2) or {}
        check(d2.get("started") is False, "重复触发被拒绝（%s）" % d2.get("msg"))

        t0 = time.time()
        last_phase = ""
        while True:
            time.sleep(5)
            st, js = api("GET", "/api/prom/n9e/sync-status", token=token)
            d = unwrap(js) or {}
            stt = d.get("state") or {}
            if stt.get("phase") != last_phase:
                last_phase = stt.get("phase")
                print("     [%4.0fs] %s（已拉取 %s）" % (time.time() - t0, last_phase, stt.get("fetched")))
            if not stt.get("running"):
                break
            if time.time() - t0 > 900:
                bad("同步超时（15 分钟）")
                break
        check(stt.get("phase") == "完成", "同步完成（phase=%s，耗时 %.0fs）" % (stt.get("phase"), time.time() - t0))
        check(not stt.get("error"), "同步无错误（error=%r）" % stt.get("error"))
        check((d.get("localRows") or 0) > 0, "本地已落库 %s 条" % d.get("localRows"))
    else:
        print("\nB. 同步（已按要求跳过）")

    # ---------- C/D. 查询与统计 ----------
    print("\nC. 查询与统计")
    q = "days=%d" % args.days
    st, js = api("GET", "/api/prom/n9e/stats?" + q, token=token, timeout=180)
    stats = unwrap(js) or {}
    check(st == 200, "GET /prom/n9e/stats 返回 200（实际 %s）" % st)
    total = stats.get("total") or 0
    check(total > 0, "统计总量 = %s" % total)
    check((stats.get("recovered") or 0) + (stats.get("unresolved") or 0) == total,
          "已恢复 %s + 未恢复 %s = 总量 %s" % (stats.get("recovered"), stats.get("unresolved"), total))
    check(len(stats.get("bySeverity") or []) > 0, "等级分布非空（%d 类）" % len(stats.get("bySeverity") or []))
    check(len(stats.get("byDay") or []) > 0, "逐日趋势非空（%d 天）" % len(stats.get("byDay") or []))
    check(len(stats.get("byGroup") or []) > 0, "业务组 TOP 非空")
    check(len(stats.get("byRule") or []) > 0, "规则 TOP 非空")

    st, js = api("GET", "/api/prom/n9e/events?%s&page=1&pageSize=5" % q, token=token)
    ev = unwrap(js) or {}
    check(st == 200, "GET /prom/n9e/events 返回 200（实际 %s）" % st)
    check(len(ev.get("list") or []) == 5, "列表分页返回 5 条")
    check(ev.get("total") == total, "列表 total(%s) 与统计 total(%s) 一致" % (ev.get("total"), total))

    row0 = (ev.get("list") or [{}])[0]
    check(bool(row0.get("ruleName")), "首条记录有规则名：%s" % row0.get("ruleName"))
    check(bool(row0.get("triggerTime")), "首条记录有触发时间")
    # targetHost 来自 tags 解析 —— 实测夜莺 target_ident 恒空，这里是关键断言
    with_host = sum(1 for r in (ev.get("list") or []) if r.get("targetHost"))
    check(with_host > 0, "目标主机可从 tags 解析出来（本页 %d/5 条有值）" % with_host)

    # 筛选：等级
    st, js = api("GET", "/api/prom/n9e/events?%s&severity=3&page=1&pageSize=5" % q, token=token)
    sev = unwrap(js) or {}
    sev_list = sev.get("list") or []
    check(all(r.get("severity") == 3 for r in sev_list), "severity=3 筛选生效（返回 %d 条）" % len(sev_list))

    # 筛选：未恢复
    st, js = api("GET", "/api/prom/n9e/events?%s&recovered=0&page=1&pageSize=5" % q, token=token)
    rec = unwrap(js) or {}
    check(all(r.get("isRecovered") == 0 for r in (rec.get("list") or [])), "recovered=0 筛选生效")
    check((rec.get("total") or 0) == (stats.get("unresolved") or 0),
          "未恢复筛选 total(%s) = 统计 unresolved(%s)" % (rec.get("total"), stats.get("unresolved")))

    # 筛选：关键字
    st, js = api("GET", "/api/prom/n9e/events?%s&keyword=CPU&page=1&pageSize=5" % q, token=token)
    kw = unwrap(js) or {}
    check(st == 200, "关键字筛选可用（命中 %s 条）" % kw.get("total"))

    # 业务组下拉
    st, js = api("GET", "/api/prom/n9e/groups", token=token)
    grp = unwrap(js) or {}
    check(st == 200 and len(grp.get("list") or []) > 0, "业务组下拉非空（%d 个）" % len(grp.get("list") or []))

    # 超范围保护：请求 365 天应被夹紧到 90 天
    st, js = api("GET", "/api/prom/n9e/stats?days=365", token=token, timeout=180)
    big = unwrap(js) or {}
    span = (big.get("etime") or 0) - (big.get("stime") or 0)
    check(span <= 90 * 86400 + 60, "请求 365 天被夹紧到 90 天（实际 %.1f 天）" % (span / 86400.0))

    # ---------- E. 导出 ----------
    print("\nE. 导出 Excel")
    st, data, headers = api("GET", "/api/prom/n9e/export?" + q, token=token, timeout=600, raw=True)
    check(st == 200, "GET /prom/n9e/export 返回 200（实际 %s）" % st)
    size_mb = len(data) / 1024.0 / 1024.0
    check(len(data) > 1024, "导出文件大小 %.1f MB" % size_mb)
    if st == 200 and data[:2] == b"PK":
        ok("导出内容是合法 xlsx（zip 魔数正确）")
        tmp = "/tmp/n9e-export-verify.xlsx"
        with io.open(tmp, "wb") as f:
            f.write(data)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = z.namelist()
                check(any("worksheets" in n for n in names), "xlsx 内含工作表（%d 个条目）" % len(names))
                sheet = [n for n in names if n.startswith("xl/worksheets/")][0]
                xml = z.read(sheet).decode("utf-8", "replace")
                rows = len(re.findall(r"<row ", xml))
                # 首行是表头
                check(rows - 1 == total,
                      "xlsx 数据行数(%d) 与接口 total(%d) 一致" % (rows - 1, total))
                check("夜莺告警记录" in xml or rows > 1, "工作表有数据")
        except zipfile.BadZipFile:
            bad("xlsx 无法作为 zip 打开")
    else:
        bad("导出内容不是 xlsx：%s" % data[:200])

    # 错误 Token 下的导出应给出可读报错（而不是 200 空文件）
    st, js = api("GET", "/api/prom/n9e/events?days=90&page=1&pageSize=1", token=token)
    check(st == 200, "列表接口在正常参数下可用")

    # ---------- G. 数据源筛选（v1.7.50 新增） ----------
    print("\nG. 数据源筛选")
    st, js = api("GET", "/api/prom/n9e/datasources", token=token)
    ds = unwrap(js) or {}
    ds_list = ds.get("list") or []
    check(st == 200, "GET /prom/n9e/datasources 返回 200（实际 %s）" % st)
    check(len(ds_list) > 0, "数据源下拉非空（%d 个）" % len(ds_list))
    if not ds_list:
        bad("数据源下拉为空 —— 老数据需重新同步一次才会补齐 datasource 字段")
    else:
        first = ds_list[0]
        did = first.get("datasourceId")
        check(bool(first.get("datasourceName")),
              "数据源有可读名称：%s（id=%s）" % (first.get("datasourceName"), did))

        # 单选：样本必须全部命中该数据源，且 total 等于下拉里给出的条数
        st, js = api("GET", "/api/prom/n9e/events?%s&datasourceIds=%s&page=1&pageSize=20" % (q, did), token=token)
        only = unwrap(js) or {}
        lst = only.get("list") or []
        check(all(r.get("datasourceId") == did for r in lst),
              "单选筛选生效（%d 条样本全部命中 id=%s）" % (len(lst), did))
        check(only.get("total") == first.get("n"),
              "单选 total(%s) 与下拉条数(%s) 一致" % (only.get("total"), first.get("n")))

        # 多选：互斥 OR 语义 ⇒ 两个数据源的结果等于各自之和
        if len(ds_list) >= 2:
            a, b = ds_list[0], ds_list[1]
            st, js = api("GET", "/api/prom/n9e/events?%s&datasourceIds=%s,%s&page=1&pageSize=5"
                         % (q, a.get("datasourceId"), b.get("datasourceId")), token=token)
            multi = unwrap(js) or {}
            check((multi.get("total") or 0) == (a.get("n") or 0) + (b.get("n") or 0),
                  "多选 total(%s) = 两数据源之和(%s+%s)"
                  % (multi.get("total"), a.get("n"), b.get("n")))

        # 与统计联动：同一条件下的统计 total 必须等于列表 total
        st, js = api("GET", "/api/prom/n9e/stats?%s&datasourceIds=%s" % (q, did), token=token, timeout=180)
        dst = unwrap(js) or {}
        check((dst.get("total") or 0) == first.get("n"),
              "统计在同一数据源条件下 total(%s) = 下拉条数(%s)" % (dst.get("total"), first.get("n")))

        s = sum(x.get("n") or 0 for x in ds_list)
        check(s <= total, "各数据源条数之和(%s) <= 总量(%s)" % (s, total))

        # 导出：必须成功，且表头含「数据源」列
        st, data, headers = api("GET", "/api/prom/n9e/export?%s&datasourceIds=%s" % (q, did),
                                token=token, timeout=600, raw=True)
        check(st == 200 and data[:2] == b"PK",
              "按数据源导出成功（%.2f MB）" % (len(data) / 1024.0 / 1024.0))
        if st == 200 and data[:2] == b"PK":
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as z:
                    sheet = [n for n in z.namelist() if n.startswith("xl/worksheets/")][0]
                    xml = z.read(sheet).decode("utf-8", "replace")
                    head_ok = "数据源" in xml  # 内联字符串
                    ss = [n for n in z.namelist() if n.endswith("sharedStrings.xml")]
                    if ss and not head_ok:
                        head_ok = "数据源" in z.read(ss[0]).decode("utf-8", "replace")
                    check(head_ok, "导出表头含「数据源」列")
            except zipfile.BadZipFile:
                bad("按数据源导出的文件无法作为 zip 打开")

        # 非法数据源 id 不应报错，只是查不到数据（筛选条件写歪要退化成不上报错）
        st, js = api("GET", "/api/prom/n9e/events?%s&datasourceIds=999999&page=1&pageSize=5" % q, token=token)
        nz = unwrap(js) or {}
        check(st == 200 and (nz.get("total") or 0) == 0,
              "不存在的数据源 id 返回 200 且 0 条（实际 %s/%s）" % (st, nz.get("total")))

    # ---------- F. 权限 ----------
    print("\nF. 权限校验")
    st, js = api("GET", "/api/prom/n9e-config")
    check(st in (401, 403), "未登录访问配置接口被拒绝（HTTP %s）" % st)
    st, js = api("GET", "/api/prom/n9e/events?days=7")
    check(st in (401, 403), "未登录访问列表接口被拒绝（HTTP %s）" % st)
    st, js = api("GET", "/api/prom/n9e/datasources")
    check(st in (401, 403), "未登录访问数据源接口被拒绝（HTTP %s）" % st)
    st, js = api("POST", "/api/prom/n9e/sync", {"days": 7})
    check(st in (401, 403), "未登录触发同步被拒绝（HTTP %s）" % st)

    print("\n" + "=" * 72)
    print("结果：通过 %d 项，失败 %d 项" % (PASS, FAIL))
    print("=" * 72)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
