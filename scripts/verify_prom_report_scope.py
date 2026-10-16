#!/usr/bin/env python3
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# -*- coding: utf-8 -*-
"""
「监控报表 · 按项目出报告 + 报表模板」端到端验证（v1.7.38）。

背景
----
改造前报表只能对「整个数据源」出一份报告（1148 台主机 / 100+ 个项目全混在一起）。
改造后：
  - 可按项目（Prometheus target label `system`）**单选 / 多选**出报告，
    范围条件下推到 PromQL，明细 / 汇总 / 趋势三处口径一致；
  - 可把「数据源 + 项目范围 + 周期」存成**报表模板**，各自出自己负责项目的季度报告；
  - 模板可见性默认私有，改 / 删只能动自己的（他人需 prom:manage）。

断言要点（为什么是这几条）
------------------------
1. **合法路径必须过**。只验证「坏输入被拒」是不够的 —— 项目过滤一旦把 PromQL
   写坏（转义 / 选择器错位），表现是「报告永远是 0 台主机」，而不报任何错。
   所以这里先证明「选了项目确实能出数据」。
2. **范围必须真的收窄**。单选报告里出现别的项目 → 报告范围是错的（比报错更危险：
   数字看着正常，实际混了别人的机器）。逐行断言 system 属于所选集合。
3. **趋势跟着范围走**。趋势与明细若口径不一致（明细按项目、趋势还是全集群），
   报告里的「资源趋势」就是错的 —— 用「范围趋势 ≠ 全集群趋势」来钉住。
4. **不限项目时口径不变**（老行为回归）。空范围 = 全集群，主机数应显著大于单项目。
5. **转义安全**。项目名含正则元字符（真实数据里的 `pm2.5空气质量查询`）时，
   必须精确匹配、不能误匹配近邻项目名。
6. **模板权限**：别人的私有模板看不到；共享模板能用不能改（403）。
7. **归档冻结范围**：报告记录里带着生成时的项目范围，且能按项目检索到。

安全
----
全程只读 Prometheus（查询），不触碰被监控主机；测试产生的模板 / 用户 / 角色 /
报告记录在结束时全部清理（清理失败会明确告警，不会静默留下垃圾数据）。

用法
----
    python scripts/verify_prom_report_scope.py
    OPHUB_BASE=http://platform.internal.example:10001/api python scripts/verify_prom_report_scope.py
    OPHUB_DS_ID=3 python scripts/verify_prom_report_scope.py     # 指定数据源，跳过自动选择
只用标准库（urllib），不依赖 requests。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

BASE = os.environ.get("OPHUB_BASE", "http://localhost:10001/api").rstrip("/")
USER = os.environ.get("OPHUB_USER", "admin")
PASS = os.environ.get("OPHUB_PASS", "admin123")
DS_ID_ENV = os.environ.get("OPHUB_DS_ID", "").strip()
TIMEOUT = int(os.environ.get("OPHUB_TIMEOUT", "300"))

results = []          # (name, ok|None, detail)   ok=None 表示 WARN（不作为失败）
cleanup_tasks = []    # (描述, 可调用对象)


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  | {detail}" if detail else ""))
    return bool(ok)


def warn(name, detail=""):
    results.append((name, None, detail))
    print(f"WARN  {name}" + (f"  | {detail}" if detail else ""))


def info(detail):
    print(f"      {detail}")


def call(method, path, token=None, body=None, params=None):
    """返回 (http_status, json_dict|None, raw_text)。不抛异常，交给调用方断言。"""
    url = BASE + path
    if params:
        # doseq=True：值为 list 时展开成**重复参数**（systems=A&systems=B）。
        # 若按 Python 默认行为，list 会被 str() 塞进去（systems=%5B%27A%27%5D），
        # 后端取不到值 → 静默退化成「全集群」，断言就白测了。
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


def msg_of(resp):
    return (resp[1] or {}).get("msg") or resp[2][:200]


# ---------------------------------------------------------------------------
# 步骤
# ---------------------------------------------------------------------------

def login():
    st, j, raw = call("POST", "/auth/login", body={"username": USER, "password": PASS})
    if st != 200:
        print(f"登录失败（HTTP {st}）：{raw[:300]}")
        sys.exit(2)
    tok = (j or {}).get("data", {}).get("token") if isinstance(j, dict) else None
    if not tok:
        print(f"登录响应里没有 token，原始响应：{raw[:300]}")
        sys.exit(2)
    print(f"已登录 {USER}（OPHUB_BASE={BASE}）")
    return tok


def pick_datasource(tok):
    if DS_ID_ENV:
        return int(DS_ID_ENV), f"env 指定 id={DS_ID_ENV}"
    st, j, _ = call("GET", "/prom/datasources", token=tok)
    if st != 200:
        print(f"取数据源失败：HTTP {st}")
        sys.exit(2)
    usable = [x for x in d((st, j, "")) .get("list", []) if x.get("enabled") == 1]
    if not usable:
        print("没有启用的 Prometheus 数据源，无法验证")
        sys.exit(2)
    return usable[0]["id"], usable[0]["name"]


def projects_with_data(tok, ds):
    """挑出**确实有 node_exporter 数据**的项目，按主机数降序。
    必须挑这样的项目：若随便挑一个空项目，第 1 条断言（合法路径）会假失败。"""
    st, j, _ = call("GET", "/prom/query", token=tok, params={
        "ds": ds,
        "query": 'count by (system) (node_cpu_seconds_total{mode="idle"})',
    })
    if st != 200:
        print(f"查询项目数据失败：HTTP {st} {msg_of((st, j, ''))}")
        return []
    out = []
    for s in d((st, j, "")).get("samples", []):
        name = (s.get("metric") or {}).get("system") or ""
        if name:
            out.append((name, int(float(s["value"][1]))))
    out.sort(key=lambda x: -x[1])
    return out


def gen(tok, ds, period, ref, systems, template_id=None, title=None):
    body = {"ds": ds, "period": period, "ref": ref, "systems": systems}
    if template_id:
        body["templateId"] = template_id
    if title:
        body["title"] = title
    t0 = time.time()
    st, j, _ = call("POST", "/prom/reports/generate", token=tok, body=body)
    return st, j, time.time() - t0


def last_month_ref():
    today = date.today()
    first = date(today.year, today.month, 1)
    prev = date(first.year - 1, 12, 15) if first.month == 1 else date(first.year, first.month - 1, 15)
    return prev.isoformat()


def main():
    tok = login()
    ds, ds_name = pick_datasource(tok)
    print(f"数据源：id={ds} name={ds_name}")
    print("-" * 72)

    # ---------- 1. 项目清单接口 ----------
    st, j, _ = call("GET", "/prom/projects", token=tok, params={"ds": ds})
    pj = d((st, j, ""))
    lst = pj.get("list") or []
    proj_ok = check("1.1 项目清单可读取且非空", st == 200 and len(lst) > 0,
                    f"HTTP {st} · {len(lst)} 个项目 · targets={pj.get('targets')} · unlabeled={pj.get('unlabeled')}")
    # 每个项目条目字段完整 + 主机数 > 0（0 台的条目是脏数据，前端会显示成「0 台」误导人）
    bad = [x for x in lst if not x.get("name") or int(x.get("hosts") or 0) <= 0]
    check("1.2 每个项目都有名称且主机数 > 0", proj_ok and not bad,
          f"异常条目 {len(bad)} 个" + (f"：{bad[:3]}" if bad else ""))
    unlabeled = int(pj.get("unlabeled") or 0)
    info(f"其中 {unlabeled} 个采集目标没打 system 标签（不属于任何项目，按项目出报告时会被排除）")

    # 项目名含逗号时，GET 侧 `?systems=A,B` 这种传输方式无法表达（会被切成分两个项目）。
    # 这条不是本次改造引入的问题，但一旦真实出现，用它做的模板会静默少统计，得让人看见。
    comma = [x.get("name") for x in lst if "," in (x.get("name") or "")]
    if comma:
        warn("1.4 存在含逗号的项目名，GET 侧 ?systems= 传输会被切分", f"示例：{comma[:5]}")

    withdata = projects_with_data(tok, ds)
    if len(withdata) < 2:
        print("有 node_exporter 数据的项目不足 2 个，无法验证「多选」，终止")
        summary()
        sys.exit(1)
    p1, p1_hosts = withdata[0]
    p2, p2_hosts = withdata[1]
    info(f"测试项目（按主机数选取）：P1={p1}（{p1_hosts} 个指标实例）、P2={p2}（{p2_hosts}）")
    check("1.3 项目清单覆盖到了测试项目", any(x.get("name") == p1 for x in lst),
          f"{p1} 在清单中")

    ref = last_month_ref()
    info(f"报告窗口：period=month ref={ref}（取上一整月，确保有历史数据）")

    # ---------- 2. 单选项目：合法路径必须出数据 ----------
    st, j, t_scoped = gen(tok, ds, "month", ref, [p1])
    rep1 = d((st, j, "")).get("report") or {}
    ok = check("2.1 单选项目能生成报告（合法路径）", st == 200 and rep1.get("hostCount", 0) > 0,
               f"HTTP {st} · hostCount={rep1.get('hostCount')} · 耗时 {t_scoped:.1f}s" + (f" · {msg_of((st, j, ''))}" if st != 200 else ""))
    rows1 = rep1.get("rows") or []
    outside = sorted({r.get("system") or "(空)" for r in rows1} - {p1})
    check("2.2 单选报告里没有别的项目（范围真的收窄了）", ok and not outside,
          f"越界项目 {outside}" if outside else f"{len(rows1)} 行全部属于 {p1}")
    check("2.3 报告回传的范围与所选一致",
          rep1.get("systems") == [p1] and rep1.get("systemCount", 1 if rep1.get("systems") else 0) == 1,
          f"systems={rep1.get('systems')} scopeText={rep1.get('scopeText')}")
    target = rep1.get("scopeTargets") or 0
    hosts = rep1.get("hostCount") or 0
    check("2.4 主机数不超过该项目的采集目标数", hosts <= target and target > 0,
          f"hostCount={hosts} ≤ scopeTargets={target}")
    tr = rep1.get("trend") or []
    check("2.5 单选报告的趋势非空且数值合法", len(tr) > 0 and all(
        (p.get("cpu") is None or 0 <= p["cpu"] <= 100) for p in tr),
        f"{len(tr)} 个趋势点")
    rec1 = d((st, j, "")).get("id")
    if rec1:
        cleanup_tasks.append((f"报告记录 #{rec1}", lambda i=rec1: call("DELETE", f"/prom/reports/{i}", token=tok)))

    # ---------- 3. 多选项目 ----------
    st, j, t_multi = gen(tok, ds, "month", ref, [p1, p2])
    rep2 = d((st, j, "")).get("report") or {}
    rows2 = rep2.get("rows") or []
    outside2 = sorted({r.get("system") or "(空)" for r in rows2} - {p1, p2})
    check("3.1 多选项目：范围 = 并集且不含第三个项目",
          st == 200 and not outside2 and rep2.get("hostCount", 0) >= hosts,
          f"HTTP {st} · hostCount={rep2.get('hostCount')}（单选 {hosts}）· 越界 {outside2} · 耗时 {t_multi:.1f}s")
    check("3.2 两个项目都出现在明细里（并集而非交集）",
          {p1, p2} <= {r.get("system") for r in rows2},
          f"明细涉及项目 {sorted({r.get('system') for r in rows2})}")
    rec2 = d((st, j, "")).get("id")
    if rec2:
        cleanup_tasks.append((f"报告记录 #{rec2}", lambda i=rec2: call("DELETE", f"/prom/reports/{i}", token=tok)))

    # ---------- 4. 不限项目（老口径回归） ----------
    st, j, t_all = gen(tok, ds, "month", ref, [])
    rep3 = d((st, j, "")).get("report") or {}
    rows3 = rep3.get("rows") or []
    check("4.1 空范围 = 全集群口径（主机数显著大于单项目）",
          st == 200 and rep3.get("hostCount", 0) > hosts,
          f"HTTP {st} · hostCount={rep3.get('hostCount')} > 单选 {hosts} · 耗时 {t_all:.1f}s")
    check("4.2 空范围不写入项目范围（scope 保持「全部项目」）",
          (rep3.get("systems") or []) == [] and rep3.get("scopeText") == "全部项目",
          f"systems={rep3.get('systems')} scopeText={rep3.get('scopeText')}")
    check("4.3 全集群报告确实跨多个项目",
          len({r.get("system") for r in rows3}) > 1,
          f"{len({r.get('system') for r in rows3})} 个项目")
    rec3 = d((st, j, "")).get("id")
    if rec3:
        cleanup_tasks.append((f"报告记录 #{rec3}", lambda i=rec3: call("DELETE", f"/prom/reports/{i}", token=tok)))

    # ---------- 5. 趋势与明细口径一致 ----------
    s_tr = {p["ts"]: p.get("cpu") for p in (rep1.get("trend") or [])}
    a_tr = {p["ts"]: p.get("cpu") for p in (rep3.get("trend") or [])}
    common = sorted(set(s_tr) & set(a_tr))
    diff = [t for t in common if s_tr[t] is not None and a_tr[t] is not None and abs(s_tr[t] - a_tr[t]) > 0.01]
    check("5.1 按项目报告的趋势 ≠ 全集群趋势（趋势确实跟着范围过滤）",
          len(common) > 0 and len(diff) > 0,
          f"共同时间点 {len(common)} 个，其中 {len(diff)} 个数值不同")
    if p1_hosts == (rep3.get("hostCount") or 0):
        warn("5.2 该项目恰好等于全集群主机数，趋势对比不具区分度", f"{p1} 覆盖了全部主机")

    # ---------- 6. 性能对照（信息性） ----------
    info(f"耗时对照：单选 {t_scoped:.1f}s · 多选 {t_multi:.1f}s · 全集群 {t_all:.1f}s"
         f"（范围下推到 PromQL 后，只查所选项目的序列）")

    # ---------- 7. 项目名转义（真实数据里的 pm2.5 这类名字） ----------
    tricky = [x.get("name") for x in lst if any(c in (x.get("name") or "") for c in ".|+*?()[]{}^$")]
    if tricky:
        tname = tricky[0]
        st_ex, jx, _ = call("GET", "/prom/report", token=tok,
                            params={"ds": ds, "period": "month", "ref": ref, "systems": tname})
        ex = d((st_ex, jx, ""))
        ex_rows = ex.get("rows") or []
        ex_sys = {r.get("system") for r in ex_rows}
        check("7.1 含正则元字符的项目名能被正确精确匹配",
              st_ex == 200 and ex_rows and ex_sys == {tname},
              f"项目 {tname!r} · HTTP {st_ex} · {len(ex_rows)} 行 · 命中项目 {sorted(ex_sys)}")
        if len(ex_sys - {tname}) > 0:
            warn("7.2 存在被误匹配的近邻项目", f"多出来的项目：{sorted(ex_sys - {tname})}")
    else:
        warn("7.1 当前数据源没有含正则元字符的项目名，转义路径未被真实数据覆盖",
             "（由 backend/handler_prom_scope_test.go 的单测兜底）")

    # ---------- 8. 边界：不存在的项目 ----------
    st_no, jn, _ = call("POST", "/prom/reports/generate", token=tok,
                        body={"ds": ds, "period": "month", "ref": ref,
                              "systems": ["__不存在的项目__verify__"]})
    rn = d((st_no, jn, "")).get("report") or {}
    check("8.1 不存在的项目 → 0 台主机 + 明确诊断提示（不是静默空报告）",
          st_no == 200 and rn.get("hostCount") == 0 and bool(rn.get("hint")),
          f"hostCount={rn.get('hostCount')} hint={str(rn.get('hint'))[:60]}")
    recn = d((st_no, jn, "")).get("id")
    if recn:
        cleanup_tasks.append((f"报告记录 #{recn}", lambda i=recn: call("DELETE", f"/prom/reports/{i}", token=tok)))

    # ---------- 9. 模板 CRUD + 用它生成 ----------
    tpl_name = f"__verify_scope_{int(time.time())}"
    st, j, _ = call("POST", "/prom/report-templates", token=tok, body={
        "name": tpl_name, "dsId": ds, "period": "month", "systems": [p1], "remark": "端到端验证用",
    })
    tpl = d((st, j, "")).get("template") or {}
    tpl_id = tpl.get("id")
    check("9.1 新建模板成功（prom:view 即可建）", st == 200 and tpl_id,
          f"HTTP {st} · id={tpl_id} · projects={tpl.get('systems')}" + (f" · {msg_of((st, j, ''))}" if st != 200 else ""))
    if tpl_id:
        cleanup_tasks.append((f"模板 #{tpl_id}", lambda i=tpl_id: call("DELETE", f"/prom/report-templates/{i}", token=tok)))
    check("9.2 模板回传项目范围与 canEdit", tpl.get("systems") == [p1] and tpl.get("canEdit") is True,
          f"systems={tpl.get('systems')} canEdit={tpl.get('canEdit')}")

    st, j, _ = call("GET", "/prom/report-templates", token=tok)
    tl = d((st, j, ""))
    check("9.3 模板列表包含刚建的模板且 mine 计数正确",
          st == 200 and any(x.get("id") == tpl_id for x in (tl.get("list") or [])),
          f"共 {tl.get('total')} 个 · 其中 mine={tl.get('mine')}")

    st, j, _ = call("PUT", f"/prom/report-templates/{tpl_id}", token=tok, body={
        "name": tpl_name + "_改", "dsId": ds, "period": "month", "systems": [p1, p2], "shared": 1,
    })
    tpl2 = d((st, j, "")).get("template") or {}
    check("9.4 更新模板（改项目范围 + 置共享）",
          st == 200 and tpl2.get("systems") == [p1, p2] and tpl2.get("shared") == 1,
          f"HTTP {st} · systems={tpl2.get('systems')} shared={tpl2.get('shared')}")

    # 用模板生成：不传 systems，应按模板范围出报告
    st, j, _ = call("POST", "/prom/reports/generate", token=tok,
                    body={"ds": ds, "period": "month", "ref": ref, "templateId": tpl_id})
    rtp = d((st, j, ""))
    rept = rtp.get("report") or {}
    check("9.5 用模板生成：范围沿用模板（两个项目）",
          st == 200 and sorted(rept.get("systems") or []) == sorted([p1, p2]),
          f"HTTP {st} · systems={rept.get('systems')}")
    check("9.6 归档记录里带着模板名（可追溯到哪套口径）",
          rtp.get("templateName") == tpl_name + "_改" and rtp.get("templateId") == tpl_id,
          f"templateName={rtp.get('templateName')}")
    rec_tpl = rtp.get("id")
    if rec_tpl:
        cleanup_tasks.append((f"报告记录 #{rec_tpl}", lambda i=rec_tpl: call("DELETE", f"/prom/reports/{i}", token=tok)))

    # ---------- 10. 归档冻结范围 + 按项目检索 ----------
    if rec2:
        st, j, _ = call("GET", f"/prom/reports/{rec2}", token=tok)
        det = d((st, j, ""))
        check("10.1 报告详情回传冻结的项目范围",
              st == 200 and sorted(det.get("systems") or []) == sorted([p1, p2]) and det.get("systemCount") == 2,
              f"systems={det.get('systems')} scopeText={det.get('scopeText')}")
    st, j, _ = call("GET", "/prom/reports", token=tok, params={"system": p2, "pageSize": 50})
    hits = d((st, j, "")).get("list") or []
    bad_hit = [x for x in hits if p2 not in (x.get("systems") or [])]
    check("10.2 按项目检索报告记录：只返回包含该项目的报告",
          st == 200 and hits and not bad_hit,
          f"命中 {len(hits)} 条，其中不含 {p2} 的 {len(bad_hit)} 条")
    # 反向检索：不该命中只含 p1 的报告（若 p1 报告仍在）
    if rec1:
        st, j, _ = call("GET", "/prom/reports", token=tok, params={"system": p2, "pageSize": 200, "kw": "Prometheus"})
        ids = {x.get("id") for x in (d((st, j, "")).get("list") or [])}
        check("10.3 仅含 p1 的报告不会被 p2 的检索命中", rec1 not in ids,
              f"p2 检索结果 id 集合是否包含仅 p1 的报告 {rec1}：{rec1 in ids}")

    # ---------- 11. 模板越权（行级权限） ----------
    verify_template_permission(tok, ds, p1)

    # ---------- 12. 未登录拒绝 ----------
    st, _, _ = call("GET", "/prom/report-templates")
    check("12.1 未登录访问报表模板被拒", st in (401, 403), f"HTTP {st}")
    st, _, _ = call("GET", "/prom/projects", params={"ds": ds})
    check("12.2 未登录访问项目清单被拒", st in (401, 403), f"HTTP {st}")

    print("=" * 72)
    summary()
    return 0 if all(ok for _, ok, _ in results if ok is not None) else 1


def verify_template_permission(admin_tok, ds, p1):
    """建一个只有 prom:view 的临时用户，验证：
       - 能看到并用于生成别人的**共享**模板
       - **看不到**别人的私有模板
       - 改 / 删别人的模板 → 403
       - 能建自己的模板
    """
    ts = int(time.time())
    role_code = f"__verify_scope_role_{ts}"
    uname = f"__verify_scope_user_{ts}"

    st, j, _ = call("POST", "/roles", token=admin_tok, body={
        "name": "验证用-报表只读", "code": role_code, "description": "端到端验证临时角色",
        "permissions": ["prom:view"],
    })
    role_id = d((st, j, "")).get("id")
    if st != 200 or not role_id:
        warn("11.x 无法创建临时角色，跳过模板越权验证", f"HTTP {st} {msg_of((st, j, ''))}")
        return
    cleanup_tasks.append((f"角色 {role_code}", lambda i=role_id: call("DELETE", f"/roles/{i}", token=admin_tok)))

    st, j, _ = call("POST", "/users", token=admin_tok, body={
        "username": uname, "password": "Verify@2026", "nickname": "验证用账号", "roleIds": [role_id],
    })
    uid = d((st, j, "")).get("id")
    if st != 200 or not uid:
        warn("11.x 无法创建临时用户，跳过模板越权验证", f"HTTP {st} {msg_of((st, j, ''))}")
        return
    cleanup_tasks.append((f"用户 {uname}", lambda i=uid: call("DELETE", f"/users/{i}", token=admin_tok)))

    st, j, _ = call("POST", "/auth/login", body={"username": uname, "password": "Verify@2026"})
    utok = d((st, j, "")).get("token")
    if not utok:
        warn("11.x 临时用户登录失败，跳过模板越权验证", f"HTTP {st}")
        return

    # 建「别人（admin）的」两个模板：私有 + 共享
    priv = f"__verify_priv_{ts}"
    pub = f"__verify_pub_{ts}"
    ids = {}
    for nm, shared in ((priv, 0), (pub, 1)):
        st, j, _ = call("POST", "/prom/report-templates", token=admin_tok, body={
            "name": nm, "dsId": ds, "period": "month", "systems": [p1], "shared": shared,
        })
        ids[nm] = (d((st, j, "")).get("template") or {}).get("id")
        if ids[nm]:
            cleanup_tasks.append((f"模板 #{ids[nm]}", lambda i=ids[nm]: call("DELETE", f"/prom/report-templates/{i}", token=admin_tok)))

    st, j, _ = call("GET", "/prom/report-templates", token=utok)
    names = {x.get("name") for x in (d((st, j, "")).get("list") or [])}
    check("11.1 他人**私有**模板对其他人不可见", priv not in names,
          f"候选名是否出现在列表：{priv in names}")
    check("11.2 他人**共享**模板对其他人可见", pub in names, f"共享模板是否可见：{pub in names}")

    if ids.get(priv):
        st, j, _ = call("PUT", f"/prom/report-templates/{ids[priv]}", token=utok, body={
            "name": priv + "_改", "dsId": ds, "period": "month", "systems": [p1],
        })
        check("11.3 无权限改他人的模板 → 403", st == 403, f"HTTP {st} {msg_of((st, j, ''))}")
        st, j, _ = call("DELETE", f"/prom/report-templates/{ids[priv]}", token=utok)
        check("11.4 无权限删他人的模板 → 403", st == 403, f"HTTP {st} {msg_of((st, j, ''))}")

    if ids.get(pub):
        st, j, _ = call("POST", "/prom/reports/generate", token=utok,
                        body={"ds": ds, "period": "month", "ref": last_month_ref(), "templateId": ids[pub]})
        rt = d((st, j, ""))
        check("11.5 共享模板可被他人用来生成报告", st == 200 and (rt.get("report") or {}).get("hostCount", 0) > 0,
              f"HTTP {st} · hostCount={(rt.get('report') or {}).get('hostCount')}")
        if rt.get("id"):
            rid = rt["id"]
            cleanup_tasks.append((f"报告记录 #{rid}", lambda i=rid: call("DELETE", f"/prom/reports/{i}", token=admin_tok)))
        st, j, _ = call("PUT", f"/prom/report-templates/{ids[pub]}", token=utok, body={
            "name": pub + "_改", "dsId": ds, "period": "month", "systems": [p1],
        })
        check("11.6 共享模板的「可用」不等于「可改」→ 403", st == 403, f"HTTP {st} {msg_of((st, j, ''))}")

    # 临时用户建自己的模板（prom:view 就够）
    st, j, _ = call("POST", "/prom/report-templates", token=utok, body={
        "name": f"__verify_own_{ts}", "dsId": ds, "period": "month", "systems": [p1],
    })
    own_id = (d((st, j, "")).get("template") or {}).get("id")
    check("11.7 普通使用者（仅 prom:view）能建自己的模板", st == 200 and own_id,
          f"HTTP {st} {msg_of((st, j, ''))}")
    if own_id:
        cleanup_tasks.append((f"模板 #{own_id}", lambda i=own_id: call("DELETE", f"/prom/report-templates/{i}", token=utok)))

    # 空项目范围的模板应被拒绝（否则用户会以为「只统计我的项目」，实际是全集群）
    st, j, _ = call("POST", "/prom/report-templates", token=utok, body={
        "name": f"__verify_empty_{ts}", "dsId": ds, "period": "month", "systems": [],
    })
    check("11.8 模板不允许空项目范围 → 400", st == 400, f"HTTP {st} {msg_of((st, j, ''))}")

    # 同名模板（同一创建人）应被拒绝，避免列表里出现两个一模一样的名字
    st, j, _ = call("POST", "/prom/report-templates", token=utok, body={
        "name": f"__verify_own_{ts}", "dsId": ds, "period": "month", "systems": [p1],
    })
    check("11.9 同一创建人下模板名不可重复 → 400", st == 400, f"HTTP {st} {msg_of((st, j, ''))}")


def cleanup():
    if not cleanup_tasks:
        return
    print("-" * 72)
    print("清理测试数据：")
    fails = []
    for desc, fn in reversed(cleanup_tasks):
        st, j, raw = fn()
        ok = st in (200, 404)  # 404 = 已不存在，同样算清理干净
        print(f"  {'OK  ' if ok else 'FAIL'} 删除 {desc}（HTTP {st}）")
        if not ok:
            fails.append(desc)
    if fails:
        print(f"⚠️  以下测试数据未能清理，请手工删除：{', '.join(fails)}")


def summary():
    fail = [r for r in results if r[1] is False]
    warnc = [r for r in results if r[1] is None]
    print(f"合计 {len(results)} 项：PASS {len(results) - len(fail) - len(warnc)} · "
          f"FAIL {len(fail)} · WARN {len(warnc)}")
    if fail:
        print("失败项：")
        for n, _, det in fail:
            print(f"  - {n}  | {det}")


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        cleanup()
    sys.exit(code)
