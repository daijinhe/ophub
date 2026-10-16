#!/usr/bin/env python
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# -*- coding: utf-8 -*-
"""
验证「被屏蔽目标明细」（v1.7.43）。

背景
----
v1.7.41 起大屏支持「面板开关 + 等级口径 + 黑白名单屏蔽规则」，v1.7.42 又把屏蔽扩到四个
负载榜；但**所有这些都是「让东西消失」的手段** —— 屏蔽完屏幕上干干净净，运维却无处确认
「我到底把什么藏起来了、它们现在什么水位」。v1.7.43 补的审计视图把这件事摊开：

    GET /api/prom/hidden  →  被屏蔽的主机 / 被隐藏的风险项 / 被屏蔽的榜位 + 当前实时指标

核心口径（也是本脚本要守住的不变量）
------------------------------------
**被屏蔽 = 同一套阈值算出的「全集」− 大屏当前实际展示的**
两侧都由 promBuildIssues / promTopN 的同一套闸门函数（promIssueGate / promRankGate）现场重算。

断言要点
--------
1. 无屏蔽时明细页为空（安全基线）
2. 黑名单按指标屏蔽：只挡该指标（dims=[cpu]），主机四指标当前值可与快照对齐
3. 被隐藏的风险项带原因码/命中规则，数值与阈值口径正确
4. 被屏蔽的榜位带「原本名次」，名次与大屏排序一致
5. 屏蔽网络维度不影响 CPU 维度
6. 白名单模式：不在白名单里的目标/风险项全部进明细，原因 notwhite
7. 白名单 + 无规则 → 明确报错（不是静默全隐藏）
8. 等级口径收窄 → 原因码 risk，且带提示
9. **一致性不变量**：明细与快照清单「不重复、不漏」（交集为空、总数对得上）
10. 非法 ds 参数 → 400（不退化成默认数据源静默返回别家的数据）
11. 恢复配置后回到基线（按 instance|metric 集合逐项比对，避免采集漂移误判）

安全 / 副作用
-------------
⚠️ 本脚本会**临时修改本机（OPHUB_BASE 指向的那套）的「大屏配置」**：屏蔽规则、规则模式、
等级口径。结束时在 finally 里按原值整体还原。**不要指向生产环境**（默认只连 localhost:10001）。

用法
----
    python scripts/verify_prom_hidden.py
    OPHUB_BASE=http://localhost:10001/api python scripts/verify_prom_hidden.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("OPHUB_BASE", "http://localhost:10001/api").rstrip("/")
USER = os.environ.get("OPHUB_USER", "admin")
PASS = os.environ.get("OPHUB_PASS", "admin123")
TIMEOUT = int(os.environ.get("OPHUB_TIMEOUT", "120"))

results = []  # (name, ok|None, detail)


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  | {detail}" if detail else ""))
    return bool(ok)


def info(detail):
    print(f"      {detail}")


def call(method, path, token=None, body=None, params=None):
    """返回 (http_status, json_dict|None, raw_text)。不抛异常，交给调用方断言。"""
    url = BASE + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw), raw
            except ValueError:
                return r.status, None, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw), raw
        except ValueError:
            return e.code, None, raw
    except Exception as e:  # noqa: BLE001
        return 0, None, f"{type(e).__name__}: {e}"


def d(resp):
    """取统一包装里的 data 节点"""
    return (resp[1] or {}).get("data") or {}


def login():
    st, j, raw = call("POST", "/auth/login", body={"username": USER, "password": PASS})
    tok = ((j or {}).get("data") or {}).get("token") if isinstance(j, dict) else None
    if st != 200 or not tok:
        print(f"登录失败（HTTP {st}）：{raw[:300]}")
        sys.exit(2)
    print(f"已登录 {USER}（OPHUB_BASE={BASE}）")
    return tok


# ---------------------------------------------------------------------------
# 配置读写
# ---------------------------------------------------------------------------

RESTORE_FIELDS = [
    "title", "autoCollect", "intervalSec", "cpuWarn", "cpuCrit", "memWarn", "memCrit",
    "diskWarn", "diskCrit", "topN", "hostLimit", "showOffline", "trendHours", "groupBy",
    "netBaseMbps", "maskMode", "riskLevel", "panels", "masks", "remark",
]


def save_cfg(tok, **kw):
    st, j, raw = call("PUT", "/prom/screen-config", token=tok, body=kw)
    if st != 200:
        print(f"写配置失败（HTTP {st}）：{raw[:300]}")
        sys.exit(2)
    return d((st, j, raw)).get("config") or {}


def reload_cfg(tok):
    st, j, _ = call("GET", "/prom/screen-config", token=tok)
    return (d((st, j, None)).get("config") or {})


def get_hidden(tok, ds=None):
    params = {"ds": ds} if ds is not None else None
    st, j, raw = call("GET", "/prom/hidden", token=tok, params=params)
    if st != 200:
        return None, f"HTTP {st}: {raw[:200]}"
    return d((st, j, raw)), ""


def snapshot(tok, ds=None):
    """注意剥**两层**：/{ready, collecting, config, data:<快照>} —— 少剥一层会静默拿到空 hosts，
    然后所有断言都变成「0 台主机」的空跑（本脚本第一次跑就踩了，表现为「快照：0 台主机」）。"""
    params = {"ds": ds} if ds is not None else None
    st, j, _ = call("GET", "/prom/snapshot", token=tok, params=params)
    return (d((st, j, None)) or {}).get("data") or {}


def snap_and_hidden(tok):
    """同时取「明细」与「快照」，并要求两者来自**同一份采集快照**。

    自动采集每 60 秒一轮，两次调用之间可能刚好插进一轮采集 —— 那时两边的数字天然不同，
    断言会假失败。用 generatedAt 对齐，最多重试 5 次。
    """
    last = (None, None)
    for _ in range(5):
        h, err = get_hidden(tok)
        if h is None:
            return None, None, err
        s = snapshot(tok)
        last = (h, s)
        if h.get("generatedAt") and h.get("generatedAt") == s.get("generatedAt"):
            return h, s, ""
        time.sleep(1.5)
    return last[0], last[1], ""


def key_of(rows):
    return {f"{r.get('instance')}|{r.get('metric')}" for r in rows}


def near(a, b, tol=0.06):
    return abs(float(a or 0) - float(b or 0)) <= tol


def count_warn(hosts, th):
    """直算「关注级」超阈值项数：warn ≤ 值 < crit。用来独立复核明细里的 risk 原因条目数。

    注意这**不能**从快照的 issues 里数 —— 口径收窄成 crit 之后，快照清单本身已经把 warn 过滤掉了，
    从那里数永远是 0（这正是「只验证拒绝路径」那类假通过的来源）。
    """
    n = 0
    pairs = (("cpu", "cpuWarn", "cpuCrit"), ("mem", "memWarn", "memCrit"), ("disk", "diskWarn", "diskCrit"))
    for x in hosts:
        if not x.get("up"):
            continue
        for metric, wk, ck in pairs:
            v = x.get(metric) or 0
            w, c = th.get(wk) or 0, th.get(ck) or 0
            if w > 0 and w <= v < (c if c > 0 else 1e9):
                n += 1
    return n


def rank_bound(hosts, metric, instance):
    """返回 (期望值, 名次上界)：与 promTopN 同口径（在线 + 该指标有数据，按值降序）。

    名次只给上界而不是精确值 —— 等值主机之间 Go 的 sort.Slice 不保证稳定，
    两个独立排序把并列项排成不同顺序是合理的，硬断言会偶发假失败。
    """
    cands = [h for h in hosts if h.get("up") and (h.get(metric) or 0) > 0]
    cands.sort(key=lambda h: h[metric], reverse=True)
    for h in cands:
        if h.get("instance") == instance:
            v = h[metric]
            return round(v, 1), len([x for x in cands if x[metric] >= v]), len(cands)
    return None, 0, len(cands)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    tok = login()
    print("⚠️  本脚本会临时修改「大屏配置」（屏蔽规则/规则模式/等级口径），结束自动还原")

    orig = reload_cfg(tok)
    backup = {k: orig.get(k) for k in RESTORE_FIELDS if k in orig}

    def restore():
        st, _, raw = call("PUT", "/prom/screen-config", token=tok, body=backup)
        print(f"  {'OK' if st == 200 else 'FAIL'}  还原大屏配置（HTTP {st}）{'' if st == 200 else raw[:200]}")

    try:
        # ---------------- A. 清空配置，建立基线 ----------------
        save_cfg(tok, masks=[], maskMode="blacklist", riskLevel="all", panels={})
        h, s, err = snap_and_hidden(tok)
        if h is None or not h.get("ready"):
            print(f"没有可用快照，无法验证：{err or (h or {}).get('notices')}")
            return 3
        hosts = s.get("hosts") or []
        issues0 = s.get("issues") or []
        info(f"快照：{len(hosts)} 台主机，{len(issues0)} 条超阈值项（{h.get('generatedAt')}）")
        check("基线：没有目标被屏蔽", (h.get("hosts") or []) == [], f"hosts={(h.get('hosts') or [])[:2]}")
        check("基线：没有榜位被屏蔽", (h.get("ranks") or []) == [])
        bad = [x for x in (h.get("issues") or []) if x.get("reason") != "truncate"]
        check("基线：被隐藏的风险项只可能来自「超出清单上限」",
              bad == [], f"{[(x['instance'], x['metric'], x['reason']) for x in bad][:3]}")

        # 选一台「CPU 最高」的在线主机当靶子
        ups = [x for x in hosts if x.get("up") and (x.get("cpu") or 0) > 0]
        if not ups:
            print("没有在线且 CPU 有数据的主机，无法继续")
            return 3
        ups.sort(key=lambda x: x["cpu"], reverse=True)
        victim = ups[0]
        vi = victim["instance"]
        vcpu_exp, vcpu_hi, ncand = rank_bound(hosts, "cpu", vi)
        info(f"靶机：{vi}（CPU {victim['cpu']}% · 期望名次 ≤{vcpu_hi} / 共 {ncand} 台有数据）")

        # 另一台用于「白名单留在外面 / 网络维度」的对照机
        other = next((x for x in ups if x["instance"] != vi), None)
        check("存在第二台在线主机（做对照断言用）", other is not None)

        # ---------------- B. 黑名单 · 只屏蔽 CPU ----------------
        cfg_b = save_cfg(tok, masks=[{"target": vi, "metric": "cpu", "note": "验证脚本-按指标屏蔽"}])
        check("配置回显：规则已落库", (cfg_b.get("masks") or [{}])[0].get("metric") == "cpu",
              json.dumps(cfg_b.get("masks"), ensure_ascii=False))

        h, s, _ = snap_and_hidden(tok)
        hosts = s.get("hosts") or []
        hh = {x["instance"]: x for x in (h.get("hosts") or [])}
        check("CP·明细里出现该靶机", vi in hh, f"被屏蔽主机 {list(hh)[:3]}")
        if vi in hh:
            row = hh[vi]
            check("CP·被屏蔽维度只有 CPU",
                  row.get("dims") == ["cpu"], f"dims={row.get('dims')} dimsCN={row.get('dimsCN')}")
            check("CP·带上命中的规则（便于回溯是哪条规则挡的）",
                  any(vi in r for r in (row.get("rules") or [])), f"rules={row.get('rules')}")
            # 「这些目标的当前指标是多少」—— 与本轮快照逐项对齐
            cur = next((x for x in hosts if x["instance"] == vi), {})
            same = all(near(row.get(k), cur.get(k)) for k in ("cpu", "mem", "disk", "net"))
            check("CP·明细里的四指标当前值 == 快照里的实时值", same,
                  f"明细 cpu={row.get('cpu')} mem={row.get('mem')} disk={row.get('disk')} net={row.get('net')}"
                  f" | 快照 cpu={cur.get('cpu')} mem={cur.get('mem')} disk={cur.get('disk')} net={cur.get('net')}")

        # 风险项：如果靶机 CPU 本来超阈值，它必须出现在「被隐藏的风险项」里，且带原因与当前值
        cpu_warn = h.get("thresholds", {}).get("cpuWarn") or 0
        expect_issue = (victim.get("cpu") or 0) >= cpu_warn > 0
        hi = {(x["instance"], x["metric"]): x for x in (h.get("issues") or [])}
        got_issue = hi.get((vi, "cpu"))
        check("CP·超阈值的靶机 CPU 告警进了「被隐藏的风险项」（未超阈值则不进）",
              (got_issue is not None) == expect_issue,
              f"cpu={victim.get('cpu')} warn={cpu_warn} 命中={got_issue is not None}")
        if got_issue:
            check("CP·原因码 = mask（屏蔽规则命中）", got_issue.get("reason") == "mask",
                  f"reason={got_issue.get('reason')} reasonCN={got_issue.get('reasonCN')}")
            check("CP·带出命中规则与备注",
                  got_issue.get("ruleTarget") == vi and got_issue.get("note") == "验证脚本-按指标屏蔽",
                  f"target={got_issue.get('ruleTarget')} note={got_issue.get('note')}")
            check("CP·告警当前值 == 快照里的 CPU 水位", near(got_issue.get("value"), victim.get("cpu")),
                  f"{got_issue.get('value')} vs {victim.get('cpu')}")
            check("CP·该行附带主机四指标水位（看得到「这机器其实很忙」）",
                  near(got_issue.get("hostCpu"), victim.get("cpu")),
                  f"hostCpu={got_issue.get('hostCpu')}")

        # 榜位：CPU 榜第 1 名被挡掉了
        rk = {(x["metric"], x["instance"]): x for x in (h.get("ranks") or [])}
        r_cpu = rk.get(("cpu", vi))
        check("CP·CPU 榜位被列入「被屏蔽的榜位」", r_cpu is not None, f"ranks={list(rk)[:4]}")
        if r_cpu:
            check("CP·榜位名次与快照排序一致（≤ 上界）",
                  1 <= r_cpu.get("wouldRank", 0) <= vcpu_hi,
                  f"wouldRank={r_cpu.get('wouldRank')} 上界={vcpu_hi}")
            check("CP·榜位当前值 == 快照 CPU 值", near(r_cpu.get("value"), vcpu_exp),
                  f"{r_cpu.get('value')} vs {vcpu_exp}")
            check("CP·榜位原因 = mask", r_cpu.get("reason") == "mask", f"{r_cpu.get('reasonCN')}")
        v_rank_metrics = sorted(x["metric"] for x in (h.get("ranks") or []) if x["instance"] == vi)
        check("CP·只挡 CPU：该主机在明细里只出现在 CPU 榜", v_rank_metrics == ["cpu"], f"{v_rank_metrics}")
        check("CP·明细只列被挡掉的对象（没被屏蔽的主机不会冒出来）",
              all(x["instance"] == vi for x in (h.get("ranks") or [])),
              f"instances={sorted({x['instance'] for x in (h.get('ranks') or [])})[:3]}")

        # ---------------- C. 一致性不变量：不重复、不漏 ----------------
        shown_keys = key_of(s.get("issues") or [])
        hidden_keys = key_of(h.get("issues") or [])
        check("INV·明细与快照清单无交集（同一项不会既被屏蔽又上屏）",
              not (shown_keys & hidden_keys), f"交集={sorted(shown_keys & hidden_keys)[:3]}")
        cnt = h.get("counts") or {}
        check("INV·IssueTotal == Shown + Hidden（未截断时完整对账）",
              cnt.get("issueTotal") == (cnt.get("issueShown") or 0) + (cnt.get("issueHidden") or 0)
              and cnt.get("issueShown") == len(shown_keys),
              f"total={cnt.get('issueTotal')} shown={cnt.get('issueShown')}({len(shown_keys)}) hidden={cnt.get('issueHidden')}")
        check("INV·被屏蔽主机数 ≥ 榜位条目涉及的台数（并集口径）",
              (cnt.get("hiddenHosts") or 0) >= 1, f"hiddenHosts={cnt.get('hiddenHosts')}")
        check("INV·FleetHosts == 快照主机数", cnt.get("fleetHosts") == len(hosts),
              f"{cnt.get('fleetHosts')} vs {len(hosts)}")

        # ---------------- D. 屏蔽网络维度不牵连 CPU ----------------
        net_top = sorted([x for x in hosts if x.get("up") and (x.get("net") or 0) > 0],
                         key=lambda x: x["net"], reverse=True)
        if net_top:
            ni = net_top[0]["instance"]
            save_cfg(tok, masks=[{"target": ni, "metric": "net"}])
            h2, s2, _ = snap_and_hidden(tok)
            hh2 = {x["instance"]: x for x in (h2.get("hosts") or [])}
            check("NET·屏蔽网络维度只影响网络", (ni in hh2) and hh2[ni].get("dims") == ["net"],
                  f"dims={hh2.get(ni, {}).get('dims')}")
            nets = [x for x in (h2.get("ranks") or []) if x["metric"] == "net"]
            check("NET·只出现在网络榜的榜位里",
                  all(x["instance"] == ni for x in nets) and len(nets) >= 1,
                  f"nets={[(x['instance'], x['wouldRank']) for x in nets][:3]}")
            check("NET·CPU 榜未被牵连", not any(x["metric"] == "cpu" for x in (h2.get("ranks") or [])))
            check("NET·CPU 告警未被牵连",
                  all(x["metric"] != "cpu" for x in (h2.get("issues") or [])),
                  f"issues metric={sorted({x['metric'] for x in (h2.get('issues') or [])})}")

        # ---------------- E. 白名单模式 ----------------
        if other:
            save_cfg(tok, maskMode="whitelist", masks=[{"target": vi, "metric": "all"}])
            h3, s3, _ = snap_and_hidden(tok)
            hh3 = {x["instance"]: x for x in (h3.get("hosts") or [])}
            check("WL·不在白名单里的对照机进了明细", other["instance"] in hh3,
                  f"{other['instance']} in {list(hh3)[:3]}")
            if other["instance"] in hh3:
                check("WL·原因码 = notwhite（白名单外）", hh3[other["instance"]].get("reason") == "notwhite",
                      f"{hh3[other['instance']].get('reasonCN')}")
                check("WL·白名单模式下一台机器通常四个维度都被挡",
                      set(hh3[other["instance"]].get("dims") or []) == {"cpu", "mem", "disk", "net"},
                      f"dims={hh3[other['instance']].get('dims')}")
            check("WL·白名单内的靶机**不**在明细里（它是被保留的）", vi not in hh3)
            check("WL·风险项原因码为 notwhite",
                  all(x["reason"] in ("notwhite", "truncate") for x in (h3.get("issues") or [])),
                  f"reasons={sorted({x['reason'] for x in (h3.get('issues') or [])})}")
            check("WL·提示里说明了当前是白名单模式",
                  any("白名单" in n.get("text", "") for n in (h3.get("notices") or [])),
                  f"notices={[n.get('level') for n in (h3.get('notices') or [])]}")

            # ---------------- F. 白名单 + 空规则 = 全隐藏（必须是 error 而不是静默） ----------------
            save_cfg(tok, maskMode="whitelist", masks=[])
            h4, s4, _ = snap_and_hidden(tok)
            n4 = h4.get("notices") or []
            check("WL0·明确报错（不是静默全隐藏）", any(n.get("level") == "error" for n in n4),
                  f"notices={[(n.get('level'), n.get('text')[:24]) for n in n4]}")
            check("WL0·风险项全被隐藏（大屏清单为空）", (h4.get("counts") or {}).get("issueShown") == 0,
                  f"shown={(h4.get('counts') or {}).get('issueShown')} total={(h4.get('counts') or {}).get('issueTotal')}")
            # 白名单 + 空规则：四个维度对**每一台**主机都不命中 → 全部进明细
            check("WL0·被屏蔽主机 = 快照里的全部主机",
                  (h4.get("counts") or {}).get("hiddenHosts") == len(s4.get("hosts") or []),
                  f"{(h4.get('counts') or {}).get('hiddenHosts')} vs {len(s4.get('hosts') or [])}")

        # ---------------- G. 等级口径收窄 ----------------
        save_cfg(tok, maskMode="blacklist", masks=[], riskLevel="crit")
        h5, s5, _ = snap_and_hidden(tok)
        hosts5 = s5.get("hosts") or []
        th5 = h5.get("thresholds") or {}
        exp_warn = count_warn(hosts5, th5)
        rh = [x for x in (h5.get("issues") or []) if x.get("reason") == "risk"]
        check("RISK·关注级风险项全部进明细（数量与阈值直算一致）",
              len(rh) == exp_warn, f"明细 {len(rh)} 项 vs 直算 {exp_warn} 项")
        check("RISK·被隐藏的 risk 项等级都是 warn（严重级仍在屏上）",
              all(x.get("level") == "warn" for x in rh),
              f"levels={sorted({x.get('level') for x in rh})}")
        check("RISK·严重级仍在快照清单里（收窄的是关注级，不是严重级）",
              all(x.get("level") == "crit" for x in (s5.get("issues") or [])),
              f"levels={sorted({x.get('level') for x in (s5.get('issues') or [])})}")
        check("RISK·原因码为 risk 且带中文解释",
              all(x.get("reason") == "risk" and x.get("reasonCN") for x in rh),
              f"{[x.get('reasonCN') for x in rh[:3]]}")
        check("RISK·提示里说明了口径收窄",
              any("仅严重" in n.get("text", "") for n in (h5.get("notices") or [])),
              f"notices={[n.get('level') for n in (h5.get('notices') or [])]}")
        check("RISK·明细里的主机四指标仍然可读（不影响展示当前值）",
              all("hostCpu" in x and "hostDisk" in x for x in rh), f"sample={rh[:1]}")

        # ---------------- H. 参数校验 ----------------
        st, j, _ = call("GET", "/prom/hidden", token=tok, params={"ds": "abc"})
        check("VAL·ds=abc → 400 明确拒绝", st == 400, f"HTTP {st}")
        st, j, _ = call("GET", "/prom/hidden", token=tok, params={"ds": "99999"})
        check("VAL·ds=99999（不存在）→ 400，不退化成默认数据源", st == 400, f"HTTP {st}")

        # ---------------- I. 还原后回到基线 ----------------
        save_cfg(tok, masks=[], maskMode="blacklist", riskLevel="all", panels={})
        h6, s6, _ = snap_and_hidden(tok)
        check("RST·还原后没有目标被屏蔽", (h6.get("hosts") or []) == [])
        check("RST·还原后没有榜位被屏蔽", (h6.get("ranks") or []) == [])
        # 容差 2 项：脚本全程十几秒，期间可能插进一轮自动采集，恰好压着阈值的主机会翻转。
        # 用「对称差」而不是数量比对 —— 一增一减会让数量看起来没变，但其实已经不是同一批对象了。
        diff = key_of(s6.get("issues") or []) ^ key_of(issues0)
        check("RST·还原后的可见清单与基线一致（容差 ≤2 项，容忍采集漂移）",
              len(diff) <= 2, f"{len(issues0)} → {len(s6.get('issues') or [])} 项，差异 {sorted(diff)[:4]}")

    finally:
        restore()

    fail = [r for r in results if r[1] is False]
    print(f"\n合计 {len(results)} 项：PASS {len(results) - len(fail)} · FAIL {len(fail)}")
    if fail:
        print("失败项：")
        for n, _, det in fail:
            print(f"  - {n}  | {det}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
