#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「所有虚拟机信息采集点统一走 Ansible 控制节点」端到端验证。

覆盖 5 个采集点（全部经 AnsibleRunner，不再直连目标机）：
  1. 资源校准     POST /assets/:id/calibrate        —— 重点验多行 KEY=VALUE 解析（曾被 ansible 压行转义打坏）
  2. 定时任务     GET  /crontab/asset/:id | POST /crontab/scan
  3. 中间件捕捉   POST /mwcapture/run  | GET /mwcapture/asset/:id?raw=1   —— 9KB 脚本走 -m script
  4. Nginx 配置   POST /config/scan
  5. 中间件运维   POST /mwops/instances/:id/check | GET /mwops/instances/:id/configs

用法：
  python scripts/verify_ansible_migration.py                 # 全量
  python scripts/verify_ansible_migration.py --only mwcapture,mwops
  python scripts/verify_ansible_migration.py --assets 116

设计要点（踩坑记录）：
  - GetMwCapture 默认不返回 raw（大文本），必须带 ?raw=1，否则 raw 恒空 → 误判「@@SEC 段数=0」。
  - CheckMwOpsInstance 响应是 {instance, probe, ok}，状态在 data.instance.status，
    探测明细在 data.probe；不是顶层 data.status。
  - 先做「控制节点 → 目标机」可达性预检：目标机 22 端口不通时，采集失败属环境问题，
    计为 SKIP 而不是 FAIL，避免把环境问题误报成代码回归。
"""
import argparse
import json
import sys
import time

import requests

BASE = "http://localhost:10001/api"
USER, PASS = "admin", "admin123"
STRICT = False          # --strict：预检不通过也照常硬判（禁止 SKIP）

# 默认验证目标。116 = 互联网区（AlmaLinux8.9/x86_64），84 = 政务外网区（HCE2.0/aarch64）
DEFAULT_ASSETS = [(116, "互联网/AlmaLinux8.9/x86_64"), (84, "政务外网/HCE2.0/aarch64")]

results = []  # (name, state, detail)；state ∈ PASS / FAIL / SKIP


def check(name, ok, detail="", env=False):
    """env=True 表示该断言依赖真实目标机可达；不可达时计 SKIP 而非 FAIL。

    注意：SKIP 是为了不让「环境问题」冒充「代码回归」，因此必须显式
    传 env=False 的断言（协议层、解析层）在任何情况下都是硬 FAIL。
    需要严格模式（禁止 SKIP）时用 --strict。
    """
    state = "PASS" if ok else ("SKIP" if (env and not STRICT) else "FAIL")
    results.append((name, state, detail))
    print("  [%s] %s%s" % (state, name, ("  | " + str(detail)) if detail else ""))


def summarize(envs=None):
    print("=" * 78)
    counts = {}
    for _, s, _ in results:
        counts[s] = counts.get(s, 0) + 1
    print("### 汇总：%d 通过 / %d 失败 / %d 环境不可达跳过"
          % (counts.get("PASS", 0), counts.get("FAIL", 0), counts.get("SKIP", 0)))
    for n, s, d in results:
        if s != "PASS":
            print("   %-4s %s  %s" % (s, n, d))
    if envs:
        bad = {k: v[1] for k, v in envs.items() if not v[0]}
        if bad:
            print("### 环境不可达资产（这些资产上的采集失败属环境问题，非代码回归）：")
            for aid, why in sorted(bad.items()):
                print("   #%-4s %s" % (aid, why))
    return counts.get("FAIL", 0)


def _shq(s):
    """单引号安全包裹（预检命令经控制节点 shell 执行，密码含 ] [ } 等特殊字符）。"""
    return "'" + str(s).replace("'", "'\\''") + "'"


class Api:
    def __init__(self):
        self.s = requests.Session()
        self.token = self.s.post(BASE + "/auth/login",
                                 json={"username": USER, "password": PASS},
                                 timeout=30).json()["data"]["token"]
        self.s.headers["Authorization"] = "Bearer " + self.token

    def call(self, method, path, payload=None, timeout=300):
        try:
            r = self.s.request(method, BASE + path, json=payload, timeout=timeout)
            try:
                return r.json(), None
            except ValueError:
                return None, "HTTP %d（非 JSON 响应）" % r.status_code
        except Exception as e:
            return None, "%s: %s" % (type(e).__name__, e)

    def get(self, p, **kw):
        return self.call("GET", p, **kw)

    def post(self, p, payload=None, **kw):
        return self.call("POST", p, payload, **kw)


# --------------------------------------------------------------------------- 预检

def preflight(api, assets):
    """对每台资产做「端口 + 凭据」双判定，决定采集失败算环境问题还是代码问题。

    env_ok=True 的资产才做严格断言；否则该资产的采集断言降级为 SKIP 并给出原因：
      - 端口不通        → 目标机 sshd 不可达
      - 端口通但认证失败 → CMDB 里登记的用户名/密码已失效（数据问题）
    """
    print("=" * 78)
    print("### 预检：控制节点 → 目标机（端口 + 凭据）")
    remotes = (api.get("/ansible/remotes")[0] or {}).get("data", {}).get("list") or []
    if not remotes:
        print("    !! 未配置任何 ansible 控制节点，采集必然失败")
        return {aid: (False, "未配置控制节点") for aid, _ in assets}, remotes
    for r in remotes:
        print("    控制节点 id=%s %s @%s:%s user=%s status=%s"
              % (r.get("id"), r.get("name"), r.get("host"), r.get("port"),
                 r.get("user"), r.get("status")))

    envs = {}
    for aid, desc in assets:
        d, _ = api.get("/assets/%d" % aid, timeout=60)
        f = ((d or {}).get("data") or {}).get("fields") or {}
        ip = (f.get("虚拟机IPv4") or "").strip()
        port = int(f.get("SSH端口") or 22)
        user = (f.get("普通用户") or "").strip()
        pwd = f.get("普通用户密码") or ""
        zone = (f.get("所属网络区域") or "").strip()

        # 端口探测（优先资产登记的 SSH 端口，再兜底 22）
        probe = ('for p in %d 22; do timeout 4 bash -c "echo > /dev/tcp/%s/$p" '
                 '2>/dev/null && { echo OPEN:$p; break; }; done; echo DONE' % (port, ip))
        # 凭据探测（sshpass 不在则只报端口结论）
        auth = ('command -v sshpass >/dev/null 2>&1 || { echo NO_SSHPASS; exit 0; }; '
                'timeout 15 sshpass -p %s ssh -o StrictHostKeyChecking=no '
                '-o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p %d %s@%s '
                '"echo AUTH_OK" 2>&1 | tail -1' % (_shq(pwd), port, _shq(user), ip))

        opened, authed, names = False, False, []
        for r in remotes:
            out, _ = api.post("/ansible/remotes/%s/exec" % r.get("id"),
                              {"command": probe}, timeout=90)
            so = ((out or {}).get("data") or {}).get("stdout") or ""
            if "OPEN:" in so:
                opened = True
                names.append(r.get("name"))
                o2, _ = api.post("/ansible/remotes/%s/exec" % r.get("id"),
                                 {"command": auth}, timeout=90)
                s2 = ((o2 or {}).get("data") or {}).get("stdout") or ""
                if "AUTH_OK" in s2:
                    authed = True
                    break

        if authed:
            reason = "OK"
        elif opened:
            reason = "SSH %d 端口通，但 %s@%s 认证失败（CMDB 凭据已失效）" % (port, user, ip)
        else:
            reason = "SSH 端口 %d/22 均不通（目标机不可达）" % port
        envs[aid] = (authed, reason)
        print("    资产 #%-4s %-38s ip=%-16s zone=%-8s 端口=%s 认证=%s | %s"
              % (aid, desc[:38], ip, zone or "-", "开" if opened else "闭",
                 "过" if authed else "不过", reason))
    return envs, remotes


# --------------------------------------------------------------------------- 采集点

def calibrate(api, aid, desc, reachable):
    print("=" * 78)
    print("### 采集点 1/5 资源校准 #%d（%s）" % (aid, desc))
    d, err = api.post("/assets/%d/calibrate" % aid, {}, timeout=240)
    if err or not d or d.get("code") != 0:
        check("calibrate #%d 执行" % aid, False, str(d)[:300] + " " + str(err), env=not reachable)
        return
    got = {}
    for it in d["data"]["items"]:
        got[it["key"]] = it["detected"]
        print("    %-14s 实测=%-22s 原始=%s" % (it["key"], it["detected"], (it.get("raw") or "")[:70]))
    # 关键：ansible 曾把目标机 stdout 的换行压成字面 \n，导致整串 KEY=VALUE 错位
    bad = {k: v for k, v in got.items() if "\\n" in (v or "")}
    check("calibrate #%d 无转义残留" % aid, not bad, repr(bad)[:200])
    expect = {116: [("CPU核数", "4"), ("CPU类型", "x86_64"), ("操作系统版本", "almalinux8.9"),
                    ("内存（GB）", "16"), ("系统盘（GB）", "100"), ("数据盘1（GB）", "300")],
              84: [("CPU核数", "4"), ("CPU类型", "aarch64"), ("操作系统版本", "hce2.0")]}
    for k, v in expect.get(aid, []):
        check("calibrate #%d %s=%s" % (aid, k, v), got.get(k) == v, repr(got.get(k)))


def crontab_read(api, aid, desc, reachable):
    print("=" * 78)
    print("### 采集点 2/5 定时任务读取 #%d（%s）" % (aid, desc))
    d, err = api.get("/crontab/asset/%d?refresh=1" % aid, timeout=180)
    if err or not d or d.get("code") != 0:
        check("crontab read #%d" % aid, False, str(d)[:300] + " " + str(err), env=not reachable)
        return
    v = d["data"]
    print("    host=%s user=%s mode=%s source=%s 任务数=%s 其他行=%s noCrontab=%s"
          % (v.get("host"), v.get("user"), v.get("runMode"), v.get("source"),
             v.get("taskCount"), len(v.get("others") or []), v.get("noCrontab")))
    for t in (v.get("tasks") or [])[:5]:
        print("      [%s] %s %s" % (t.get("lineNo"), t.get("expr"), (t.get("command") or "")[:60]))
    content = v.get("content") or ""
    dirty = [x for x in ["CHANGED", "=> {", "__OPHUB_DI__", "\\n"] if x in content]
    check("crontab #%d 无 ansible 包装残留" % aid, not dirty, "命中=%s %s" % (dirty, repr(content[:100])))
    check("crontab #%d hash 非空" % aid, bool(v.get("hash")))


def crontab_scan(api):
    print("=" * 78)
    print("### 采集点 2b 定时任务批量扫描（全部资产，经 ansible 控制节点）")
    d, err = api.post("/crontab/scan", {}, timeout=900)
    if err or not d or d.get("code") != 0:
        check("crontab scan 执行", False, str(d)[:300] + " " + str(err))
        return
    x = d["data"]
    print("    扫描=%s 成功=%s 有任务主机=%s 任务总数=%s 失败=%s"
          % (x["scanned"], x["okCount"], x["taskHostCount"], x["taskTotal"], x["errorCount"]))
    for it in x["list"][:16]:
        print("      #%-4s %-44s %-8s %s"
              % (it["assetId"], (it.get("assetName") or "")[:44], it["status"],
                 (it.get("message") or "")[:64]))
    check("scan 有成功主机", x["okCount"] > 0, "okCount=%d" % x["okCount"])
    dirty = [it["assetId"] for it in x["list"] if it["status"] == "ok"
             and any(m in (it.get("content") or "") for m in ("CHANGED", "=> {", "__OPHUB_DI__", "\\n"))]
    check("scan 成功项内容无包装残留", not dirty, "dirty=%s" % dirty)


def mwcapture(api, aid, desc, reachable):
    print("=" * 78)
    print("### 采集点 3/5 中间件捕捉 #%d（%s）— 9KB 脚本走 -m script" % (aid, desc))
    d, err = api.post("/mwcapture/run", {"assetIds": [aid]}, timeout=300)
    if err or not d or d.get("code") != 0:
        check("mwcapture #%d 执行" % aid, False, str(d)[:300] + " " + str(err), env=not reachable)
        return
    for rec in d["data"]["list"]:
        print("    status=%s types=%s dur=%sms err=%s"
              % (rec.get("status"), rec.get("mwTypes"), rec.get("durationMs"), (rec.get("error") or "")[:80]))
        check("mwcapture #%d 未 failed" % aid, rec.get("status") != "failed", rec.get("status"), env=not reachable)
        check("mwcapture #%d 识别到中间件" % aid, len(rec.get("mwTypes") or []) > 0, rec.get("mwTypes"))
    # raw 必须显式请求（?raw=1），否则接口不返回
    g, gerr = api.get("/mwcapture/asset/%d?raw=1" % aid, timeout=60)
    if gerr or not g or not (g.get("data") or {}).get("exists"):
        check("mwcapture #%d 详情可读" % aid, False, str(gerr))
        return
    raw = g["data"].get("raw") or ""
    items = g["data"].get("items") or []
    print("    raw=%d 字节  @@SEC 段=%d  items=%d" % (len(raw), raw.count("@@SEC:"), len(items)))
    for it in items[:6]:
        print("      - %s %s" % (it.get("type"), (it.get("installPath") or it.get("port") or "")[:60]))
    check("mwcapture #%d @@SEC 段可解析" % aid, raw.count("@@SEC:") > 3,
          "段数=%d raw=%d字节" % (raw.count("@@SEC:"), len(raw)), env=not reachable)
    check("mwcapture #%d raw 无 ansible 包装残留" % aid,
          "CHANGED" not in raw[:200] and "=> {" not in raw[:200], repr(raw[:80]))


def nginx_scan(api, aid, desc, reachable):
    print("=" * 78)
    print("### 采集点 4/5 Nginx 配置扫描 #%d（%s）" % (aid, desc))
    d, err = api.post("/config/scan", {"assetId": aid}, timeout=300)
    if err or not d or d.get("code") != 0:
        check("nginx scan #%d 执行" % aid, False, str(d)[:400] + " " + str(err), env=not reachable)
        return
    items = d["data"].get("list") or d["data"].get("items") or []
    print("    发现 %d 个配置文件" % len(items))
    for it in items[:8]:
        print("      %-48s kind=%-6s size=%s err=%s"
              % (it.get("path"), it.get("kind"), it.get("size"), (it.get("error") or "")[:60]))
    ok = [i for i in items if not i.get("error")]
    check("nginx scan 有成功项", len(ok) > 0, "%d/%d" % (len(ok), len(items)), env=not reachable)
    if ok:
        c0 = ok[0].get("content") or ""
        check("nginx 内容无包装残留", "CHANGED" not in c0 and "\\n" not in c0, repr(c0[:100]))


def mwops(api, aid, reachable):
    print("=" * 78)
    print("### 采集点 5/5 中间件运维（mwops）状态探测 / 配置文件（经 ansible）")
    d, err = api.get("/mwops/instances", timeout=120)
    if err or not d:
        check("mwops 实例列表", False, str(err))
        return
    print("    既有实例 %d 个" % len((d["data"].get("list") or [])))

    # 临时建一个手动实例用于端到端验证，跑完即删（不污染数据）
    created, cerr = api.post("/mwops/instances",
                             {"mwType": "nginx", "assetId": aid, "remark": "E2E临时-可删"}, timeout=60)
    if cerr or not created or created.get("code") != 0:
        check("mwops 临时实例创建", False, str(created)[:200] + str(cerr), env=not reachable)
        return
    iid = created["data"]["id"]
    print("    临时实例 id=%s" % iid)
    try:
        r, e = api.post("/mwops/instances/%d/check" % iid, {}, timeout=240)
        if e or not r or r.get("code") != 0:
            check("mwops check", False, str(r)[:300] + str(e), env=not reachable)
        else:
            dd = r["data"]
            inst = dd.get("instance") or {}     # ← 状态在这里，不在顶层
            probe = dd.get("probe") or {}
            print("    check ok=%s status=%s text=%s via=%s pids=%s dirs=%s ver=%s"
                  % (dd.get("ok"), inst.get("status"), (inst.get("statusText") or "")[:70],
                     probe.get("via"), probe.get("pids"), probe.get("dirs"),
                     (probe.get("verRaw") or "")[:40]))
            check("mwops check 有确定状态", inst.get("status") not in (None, "", "unknown"),
                  str(inst.get("status")), env=not reachable)
        g, ge = api.get("/mwops/instances/%d/configs" % iid, timeout=240)
        if ge or not g or g.get("code") != 0:
            check("mwops configs", False, str(g)[:300] + str(ge), env=not reachable)
        else:
            files = g["data"].get("list") or g["data"].get("files") or []
            print("    配置文件候选 %d 个，存在 %d 个"
                  % (len(files), len([f for f in files if f.get("exists")])))
            for f in files[:6]:
                print("      %-52s exists=%s size=%s" % (f.get("path"), f.get("exists"), f.get("size")))
            check("mwops 配置文件可列", len(files) > 0, "%d 个" % len(files))
    finally:
        _, de = api.call("DELETE", "/mwops/instances/%d" % iid, timeout=60)
        print("    清理临时实例：%s" % (de or "ok"))


# --------------------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="",
                    help="只跑指定采集点（逗号分隔）：calibrate,crontab,mwcapture,nginx,mwops")
    ap.add_argument("--assets", default="",
                    help="只验证指定资产 id（逗号分隔），默认 116,84")
    ap.add_argument("--skip-preflight", action="store_true", help="跳过控制节点可达性预检")
    ap.add_argument("--strict", action="store_true",
                    help="严格模式：预检不通过的资产也硬判 FAIL（不降级为 SKIP），用于排查代码回归")
    args = ap.parse_args()

    global STRICT
    STRICT = args.strict

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    def want(x):
        return (not only) or (x in only)

    if args.assets:
        ids = [int(x) for x in args.assets.split(",") if x.strip()]
        assets = [(i, dict(DEFAULT_ASSETS).get(i, "自定义资产")) for i in ids]
    else:
        assets = DEFAULT_ASSETS

    api = Api()
    if args.skip_preflight:
        envs = {aid: (True, "预检已跳过") for aid, _ in assets}
    else:
        envs, _ = preflight(api, assets)

    def ok(aid):
        return envs.get(aid, (True, ""))[0]

    for aid, desc in assets:
        if want("calibrate"):
            calibrate(api, aid, desc, ok(aid))
    for aid, desc in assets:
        if want("crontab"):
            crontab_read(api, aid, desc, ok(aid))
    if want("crontab"):
        crontab_scan(api)
    for aid, desc in assets:
        if want("mwcapture"):
            mwcapture(api, aid, desc, ok(aid))
    for aid, desc in assets:
        if want("nginx"):
            nginx_scan(api, aid, desc, ok(aid))
    if want("mwops"):
        mwops(api, assets[0][0], ok(assets[0][0]))

    return 1 if summarize(envs) else 0


if __name__ == "__main__":
    t0 = time.time()
    rc = main()
    print("耗时 %.1fs" % (time.time() - t0))
    sys.exit(rc)
