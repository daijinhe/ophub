#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
probe_n9e.py —— 夜莺 v8 历史告警接口（GET /api/n9e/alert-his-events/list）拉取验证

用途：验证「按时间分片 + 分页」拉取 90 天历史告警的可行性与耗时。
夜莺在跨大时间窗口（实测 90 天 ≈ 23s，30 天 ≈ 1.1s）时有明显性能断崖，
因此必须切片拉取。

用法：
  N9E_BASE=http://n9e.internal.example:9999 N9E_TOKEN=xxx python scripts/probe_n9e.py --days 90 --chunk 30
  ... --dump out.json     # 落盘全量样本
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("N9E_BASE", "http://n9e.internal.example:9999").rstrip("/")
TOKEN = os.environ.get("N9E_TOKEN", "")
API = "/api/n9e/alert-his-events/list"


def fetch_page(stime, etime, page, limit, timeout=180):
    """拉一页；返回 (list, total)。鉴权头是 X-User-Token（实测 v8 只认这个）。"""
    url = "%s%s?p=%d&limit=%d&stime=%d&etime=%d" % (BASE, API, page, limit, stime, etime)
    req = urllib.request.Request(url, headers={"X-User-Token": TOKEN, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    d = json.loads(raw.decode("utf-8"))
    dat = d.get("dat") or {}
    return dat.get("list") or [], int(dat.get("total") or 0)


def fetch_chunk(stime, etime, page_size=5000, verbose=True):
    """把一个时间片内的全部记录拉完（自动翻页）。"""
    out, page, total = [], 1, None
    while True:
        lst, tot = fetch_page(stime, etime, page, page_size)
        if total is None:
            total = tot
        out.extend(lst)
        if verbose:
            print("      p=%d 本页=%d 累计=%d / total=%d" % (page, len(lst), len(out), total))
        if len(lst) < page_size or len(out) >= total:
            break
        page += 1
        if page > 200:  # 安全阀，防止死循环
            print("      ⚠️ 翻页超过 200 页，提前中止", file=sys.stderr)
            break
    return out, (total or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90, help="回溯天数")
    ap.add_argument("--chunk", type=int, default=30, help="每个时间片的跨度（天）")
    ap.add_argument("--page-size", type=int, default=5000)
    ap.add_argument("--dump", default="", help="把全量数据写入该 JSON 文件")
    args = ap.parse_args()

    if not TOKEN:
        print("请设置环境变量 N9E_TOKEN", file=sys.stderr)
        return 2

    now = int(time.time())
    start_all = now - args.days * 86400
    chunk_sec = args.chunk * 86400
    print("目标：%s 的最近 %d 天（%d 天/片）" % (BASE, args.days, args.chunk))

    all_rows = []
    # 整体 total（用于交叉校验分片是否有重复/遗漏）
    t0 = time.time()
    try:
        _, grand_total = fetch_page(start_all, now, 1, 1)
        t_overall = time.time() - t0
        print("  整体 total=%d（单次查询耗时 %.1fs —— 这就是不分片时的代价）" % (grand_total, t_overall))
    except Exception as e:
        print("  整体查询失败：%s" % e, file=sys.stderr)
        grand_total = None

    t_start = time.time()
    s = start_all
    idx = 0
    while s < now:
        e = min(s + chunk_sec, now)
        idx += 1
        print("  [片 %d] %s ~ %s" % (
            idx,
            time.strftime("%Y-%m-%d %H:%M", time.localtime(s)),
            time.strftime("%Y-%m-%d %H:%M", time.localtime(e)),
        ))
        tc = time.time()
        try:
            rows, tot = fetch_chunk(s, e, args.page_size)
        except Exception as ex:
            print("      拉取失败：%s" % ex, file=sys.stderr)
            rows, tot = [], 0
        all_rows.extend(rows)
        print("      → %d 条（total=%d）耗时 %.1fs" % (len(rows), tot, time.time() - tc))
        s = e

    dur = time.time() - t_start
    print()
    print("═" * 60)
    print("分片拉取完成：%d 条，耗时 %.1fs" % (len(all_rows), dur))
    if grand_total is not None:
        diff = len(all_rows) - grand_total
        flag = "一致 ✓" if abs(diff) <= 5 else "不一致 ⚠️（差 %+d）" % diff
        print("与整体 total %d 比对：%s" % (grand_total, flag))
    if all_rows:
        ids = [r.get("id") for r in all_rows]
        print("去重后条数：%d（重复 %d 条）" % (len(set(ids)), len(ids) - len(set(ids))))
        # 关键字段完整度检查
        keys = ["id", "rule_name", "severity", "trigger_time", "recover_time",
                "is_recovered", "group_name", "cluster", "target_ident", "tags"]
        print("字段覆盖：")
        for k in keys:
            n = sum(1 for r in all_rows if r.get(k) not in (None, "", [], 0))
            print("   %-16s 非空 %d/%d" % (k, n, len(all_rows)))
    if args.dump:
        with io.open(args.dump, "w", encoding="utf-8") as f:
            json.dump(all_rows, f, ensure_ascii=False, indent=1)
        print("已写入 %s" % args.dump)
    return 0


if __name__ == "__main__":
    sys.exit(main())
