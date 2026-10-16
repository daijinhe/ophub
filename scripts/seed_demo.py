#!/usr/bin/env python3
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# -*- coding: utf-8 -*-
"""造演示数据：10 条资产 + 1 个巡检任务 + 执行几次巡检。

用途：数据库被清空后快速恢复演示环境（大屏 / 批量编辑 / 巡检都需要数据）。
用法：python scripts/seed_demo.py [巡检次数]
"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:10001/api"


def req(path, method="GET", body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


ASSETS = [
    ("权责清单库", "192.0.2.4", "互联网", "主中心", "生产环境", "后端", "CentOS Linux 7.9", "x86_64", 8, 16, 50, 200, "研发-权责清单", "研发部"),
    ("资产盘点系统", "asset-01.internal.example", "互联网", "主中心", "生产环境", "数据库", "AlmaLinux 8.9", "x86_64", 16, 32, 100, 500, "研发-资产管理", "资产部"),
    ("合同管理系统", "192.0.2.185", "政务外网", "主中心", "生产环境", "后端", "openEuler 20.03", "aarch64", 8, 16, 50, 300, "研发-合同", "法务部"),
    ("内部门户", "192.0.2.100", "互联网", "备中心", "生产环境", "前端", "openEuler 20.03", "x86_64", 4, 8, 40, 100, "研发-门户", "综合部"),
    ("日志分析平台", "192.0.2.55", "互联网", "主中心", "生产环境", "后端", "CentOS Linux 7.9", "x86_64", 16, 32, 80, 1000, "研发-日志", "运维部"),
    ("OA办公系统", "192.0.2.66", "互联网", "主中心", "生产环境", "后端", "openEuler 20.03", "aarch64", 16, 32, 80, 400, "研发-OA", "综合部"),
    ("测试服务器-1", "192.0.2.1", "互联网", "主中心", "测试环境", "后端", "CentOS Linux 7.9", "x86_64", 4, 8, 40, 100, "研发-测试", "研发部"),
    ("开发服务器-1", "192.0.2.1", "互联网", "主中心", "开发环境", "后端", "Ubuntu 22.04", "x86_64", 4, 8, 40, 100, "研发-开发", "研发部"),
    ("麒麟信创", "192.0.2.1", "政务外网", "主中心", "生产环境", "数据库", "银河麒麟 V10", "aarch64", 16, 32, 80, 500, "研发-信创", "信创办"),
    ("华为 HCE", "192.0.2.2", "政务外网", "主中心", "生产环境", "后端", "HCE 2.0", "aarch64", 8, 16, 50, 200, "研发-信创", "信创办"),
]


def main():
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    st, lg = req("/auth/login", "POST", {"username": "admin", "password": "admin123"})
    if st != 200:
        print("登录失败", st, lg)
        return 1
    tok = lg["data"]["token"]

    st, cur = req("/assets", token=tok)
    d = cur.get("data", {})
    items = d.get("list", d) if isinstance(d, dict) else d
    if len(items) >= len(ASSETS):
        print(f"资产已存在 {len(items)} 条，跳过创建")
    else:
        ok = 0
        for name, ip, zone, center, env, be, osv, cpuv, cores, mem, sysd, datad, proj, dept in ASSETS:
            body = {
                "categoryId": 1, "name": name, "ip": ip,
                "fields": {
                    "ERP系统名称": name, "项目简称": name[:6], "虚拟机IPv4": ip,
                    "所属网络区域": zone, "所属中心": center, "环境": env, "业务环境": be,
                    "操作系统版本": osv, "CPU类型": cpuv, "CPU核数": cores, "内存（GB）": mem,
                    "系统盘（GB）": sysd, "数据盘1（GB）": datad, "用途": be,
                    "业务应用端口": "8080", "业务应用访问地址": f"http://{ip}:8080",
                    "普通用户": "opuser", "普通用户密码": "Op@2026!",
                    "超级管理员用户": "root", "超级管理员用户密码": "Root@2026!", "SSH端口": "65181",
                    "项目技术负责人": "张三", "项目经理": "李四", "开发人员": "王五",
                    "运维负责人": "赵六", "归属部门": dept, "项目名称": proj,
                },
            }
            st2, r2 = req("/assets", "POST", body, tok)
            if st2 == 200:
                ok += 1
            else:
                print("FAIL", name, st2, r2)
        print(f"创建资产 {ok}/{len(ASSETS)}")

    st, t = req("/inspection/tasks", "POST", {
        "name": "每日全量巡检", "scopeType": "all",
        "metrics": ["cpu", "mem", "disk", "net", "proc", "svc", "os", "security"],
        "freq": "manual", "sshPort": 65181, "scheduleEnabled": False,
    }, tok)
    tid = t["data"]["id"]
    print("巡检任务 id =", tid)
    for i in range(runs):
        st, r = req(f"/inspection/tasks/{tid}/run", "POST", {}, tok)
        print(f"  巡检 {i + 1}/{runs}:", r.get("msg", ""))
        time.sleep(2)

    st, dash = req("/inspection/dashboard", token=tok)
    data = dash.get("data", {})
    kpi = data.get("kpi", {})
    print(f"大屏：资产 {kpi.get('assetTotal')} / 主机 {kpi.get('hostTotal')} / "
          f"告警 {kpi.get('alertCrit')}严重+{kpi.get('alertWarn')}预警 / "
          f"趋势点 {len(data.get('trend', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
