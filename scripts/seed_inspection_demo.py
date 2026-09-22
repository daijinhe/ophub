#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
巡检「季度演示数据」生成器
================================================================

用途：给平台灌一整套**可复现**的模拟数据，用来验证季度报告 / 巡检大屏 /
报表导出在「真实量级」下的表现（列宽、行数、5MB 降级策略等）。

规模（默认）：30 个项目 × 10 台 = 300 台服务器，一个季度按周跑 12 次巡检
→ 3600 条 inspection_results + 数千条告警。

设计约定
------------------------------------------------------------------
1. **直接写库（SQL）**，不走 API：300×12 的数据量走 HTTP 会非常慢，
   且 results.data / results.alerts 是 JSONB，用 SQL 插入最直接。
2. **告警在生成时就算好**（Python 侧镜像 backend/inspect.go 的
   evalAlertsWithProfile），而不是留空等后端重算：
   - 后端读路径确实会按「当前规则」重算（rerouteAlerts），
   - 但记录列表 / 历史详情等地方读的是库里的快照，留空会显示成「无告警」。
   Python 侧与 Go 侧口径一致，两边对得上才说明数据是真的。
3. **数据全部打标**：资产挂在一个名为「模拟数据-<季度>」的独立分类树下，
   巡检任务名以「季度全量巡检（模拟-<季度>）」开头 —— 清理时按这两个标记删，
   不会误伤真实资产。
4. 时间轴是**真实季度日历**（默认 2026Q3，跑到今天为止），所以
   「按天趋势 / 资产趋势」Sheet 能画出真实的季度曲线。

用法
------------------------------------------------------------------
    python scripts/seed_inspection_demo.py                # 默认 2026Q3 / 30项目 / 300台 / 每周12次
    python scripts/seed_inspection_demo.py --runs 90 --freq daily
    python scripts/seed_inspection_demo.py --quarter 2026Q2
    python scripts/seed_inspection_demo.py --clean         # 只清理，不生成

注意：脚本通过 `docker cp` + `docker exec psql` 操作 **ophub-postgres** 容器，
Windows Git Bash 下请保证 docker.exe 在 PATH（或用 --docker 指定绝对路径）。
"""

import argparse
import json
import math
import os
import random
import subprocess
import sys
from datetime import date, datetime, timedelta

# ---------------------------------------------------------------------------
# 0. 基础配置
# ---------------------------------------------------------------------------

QUARTER_START_MONTH = {1: 1, 2: 4, 3: 7, 4: 10}

# 30 个项目：(应用系统名称, 项目简称, 归属部门)
PROJECTS = [
    ("政务服务一体化平台", "ZWFW", "政务云一部"),
    ("医保结算管理系统", "YBJS", "政务云一部"),
    ("社保公共服务平台", "SBGG", "政务云一部"),
    ("住房公积金管理系统", "ZFGJJ", "政务云一部"),
    ("不动产登记信息系统", "BDCDJ", "政务云一部"),
    ("市场监管综合平台", "SCJG", "政务云二部"),
    ("信用中国协同平台", "XYZG", "政务云二部"),
    ("工程建设项目审批系统", "GCJS", "政务云二部"),
    ("交通运输执法平台", "JTYS", "政务云二部"),
    ("公安视频图像平台", "GASP", "政务云二部"),
    ("应急指挥调度系统", "YJZH", "政务云三部"),
    ("网格化社会治理平台", "WGSH", "政务云三部"),
    ("数字城管执法平台", "SZCG", "政务云三部"),
    ("教育招生考试系统", "JYZS", "政务云三部"),
    ("卫生健康信息平台", "WSJK", "政务云三部"),
    ("民政综合业务系统", "MZZH", "数据资源部"),
    ("财政预算一体化系统", "CZYS", "数据资源部"),
    ("审计大数据分析平台", "SJFX", "数据资源部"),
    ("统计联网直报平台", "TJLW", "数据资源部"),
    ("宏观经济监测平台", "HGJJ", "数据资源部"),
    ("数据共享交换平台", "SJGX", "数据资源部"),
    ("电子证照库系统", "DZZZ", "网络安全部"),
    ("统一身份认证平台", "TYSF", "网络安全部"),
    ("电子印章管理系统", "DZYZ", "网络安全部"),
    ("政务协同办公系统", "ZWXT", "网络安全部"),
    ("门户网站群平台", "MHWZ", "应用运维部"),
    ("12345 热线受理平台", "RX12345", "应用运维部"),
    ("公共资源交易平台", "GGZY", "应用运维部"),
    ("营商环境评价系统", "YSHJ", "应用运维部"),
    ("智慧城市大脑平台", "ZHCS", "应用运维部"),
]

# 操作系统池（模拟真实政务云：CentOS7 存量最多，信创逐步替换）
OS_POOL = [
    ("CentOS Linux", "centos", "rhel", "7.9", "3.10.0-1160.el7.x86_64", "x86_64"),
    ("CentOS Linux", "centos", "rhel", "7.9", "3.10.0-1160.el7.x86_64", "x86_64"),
    ("AlmaLinux", "almalinux", "rhel", "8.9", "4.18.0-372.el8.x86_64", "x86_64"),
    ("AlmaLinux", "almalinux", "rhel", "8.9", "4.18.0-372.el8.x86_64", "x86_64"),
    ("Ubuntu", "ubuntu", "debian", "22.04", "5.15.0-91-generic", "x86_64"),
    ("银河麒麟 Kylin V10", "kylin", "rhel", "V10", "4.19.90-23.10.ky10.aarch64", "aarch64"),
    ("银河麒麟 Kylin V10", "kylin", "rhel", "V10", "4.19.90-23.10.ky10.aarch64", "aarch64"),
    ("华为 openEuler", "openeuler", "euler", "22.03", "5.10.0-60.18.0.50.oe2203.x86_64", "x86_64"),
    ("华为 HCE 2.0", "hce", "euler", "2.0", "4.19.90-2102.2.0.hce2.x86_64", "x86_64"),
]

# 角色 -> 中间件类型（用于核心进程存活检测）
ROLE_MW = {
    "前端": ["nginx", "jdk"],
    "后端": ["jdk", "redis"],
    "数据库": ["mysql", "redis"],
}

MW_PORTS = {"nginx": [80, 443], "jdk": [8080, 8081], "redis": [6379], "mysql": [3306]}

DEVELOPERS = ["张伟", "李娜", "王强", "刘洋", "陈静", "杨帆", "赵磊", "孙悦", "周涛", "吴敏"]
OPS_OWNERS = ["运维-徐斌", "运维-何超", "运维-马琳", "运维-郭鹏", "运维-林芳"]
PM_NAMES = ["王建国", "李晓东", "赵春梅", "孙立平", "钱志远"]
TECH_LEADS = ["陈思远", "刘tech", "黄文杰", "朱晓明", "胡海涛"]

# ---------------------------------------------------------------------------
# 1. 告警阈值目录（镜像 backend/inspect.go 的 FlatMetricDefs + alertExtraThresholds）
#    字段：key, label, warn, crit, note
# ---------------------------------------------------------------------------

PERCENT_DEFS = [
    ("cpu_usage", "CPU整体使用率", 70, 85, "持续>70%需关注，>85%告警"),
    ("cpu_iowait", "I/O等待", 10, 0, "持续>10%说明磁盘是瓶颈"),
    ("cpu_per_core_max", "单核最高使用率", 100, 0, "存在单核打满(100%)而整体空闲需关注"),
    ("cpu_load_ratio", "负载率(load1/核心数)", 70, 100, "相对核心数的负载水位，>70%关注，>100%过载"),
    ("mem_usage", "内存使用率", 80, 90, ">80%需关注，>90%告警"),
    ("swap_usage", "Swap使用率", 1, 10, ">0%需关注(物理内存不足)，>10%告警"),
    ("disk_system_usage", "系统盘使用率", 75, 80, "<75%，超80%紧急告警"),
    ("disk_system_inode_usage", "系统盘inode使用率", 75, 80, "inode 耗尽会导致无法新建文件"),
    ("disk_data_max_usage", "数据盘最高使用率", 70, 80, "<80%(数据库核心盘<70%)"),
    ("disk_data_inode_max_usage", "数据盘最高inode使用率", 70, 80, ""),
    ("disk_nas_max_usage", "NAS最高使用率", 75, 80, "NAS 挂载"),
    ("net_bandwidth_max_pct", "网卡带宽最高使用率", 70, 0, "带宽使用率>70%需关注"),
    ("packet_loss_pct", "丢包率", 0.1, 0, ">0.1%需关注"),
    ("tcp_retrans_pct", "TCP重传率", 1, 0, "异常升高说明网络质量差"),
]


def thr_text(v):
    if float(v).is_integer():
        return "%.0f" % v
    return ("%g" % v)


# ---------------------------------------------------------------------------
# 2. 工具函数
# ---------------------------------------------------------------------------


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def r1(v):
    """保留 1 位小数（与 Go 的 round1 同口径）"""
    return math.floor(v * 10 + 0.5) / 10.0


def sql_lit(s):
    """字符串 -> SQL 字面量（单引号转义）"""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def json_lit(obj):
    """Python 对象 -> SQL jsonb 字面量"""
    return sql_lit(json.dumps(obj, ensure_ascii=False, separators=(",", ":"))) + "::jsonb"


def ts_lit(dt):
    return sql_lit(dt.strftime("%Y-%m-%d %H:%M:%S"))


# ---------------------------------------------------------------------------
# 3. 资产建模
# ---------------------------------------------------------------------------


def build_hosts(rnd, projects, per_project, runs=12):
    """生成 300 台主机的静态画像（不随时间变化的部分）"""
    hosts = []
    idx = 0
    for pi, (sysname, code, dept) in enumerate(projects):
        # 每个项目：2~3 前端 + 4~5 后端 + 2~3 数据库
        roles = ["前端"] * 2 + ["后端"] * 5 + ["数据库"] * 3
        if per_project != 10:
            # 非默认台数时按比例铺
            roles = (["前端", "后端", "数据库"] * per_project)[:per_project]
        for hi, role in enumerate(roles):
            idx += 1
            ip = "10.205.%d.%d" % (100 + pi, 11 + hi)
            os_name, os_id, os_family, os_ver, kernel, arch = OS_POOL[rnd.randrange(len(OS_POOL))]
            cores = [4, 8, 8, 16, 16, 32][rnd.randrange(6)]
            mem_total = float([8, 16, 16, 32, 64][rnd.randrange(5)])
            if role == "数据库":
                mem_total = max(mem_total, 32.0)
            env = "生产环境" if rnd.random() < 0.72 else ("测试环境" if rnd.random() < 0.6 else "开发环境")

            # 健康档位：多数健康，少量亚健康，少数持续告警
            r = rnd.random()
            if r < 0.60:
                health = "healthy"
            elif r < 0.85:
                health = "watch"
            else:
                health = "problem"

            base = {
                "healthy": {"cpu": (8, 42), "mem": (28, 62), "sys": (25, 58), "data": (25, 62)},
                "watch": {"cpu": (40, 72), "mem": (58, 82), "sys": (55, 76), "data": (58, 79)},
                "problem": {"cpu": (68, 93), "mem": (78, 94), "sys": (72, 95), "data": (75, 96)},
            }[health]

            rand_in = lambda rg: rg[0] + rnd.random() * (rg[1] - rg[0])

            # 磁盘布局
            sys_total = float(rnd.choice([50, 50, 100, 100, 200]))
            data_total = float(rnd.choice([200, 500, 500, 1000, 2000]))
            disks_tpl = [
                {"device": "/dev/mapper/centos-root", "mount": "/", "fstype": "xfs", "role": "system",
                 "total_gb": sys_total},
                {"device": "/dev/vda1", "mount": "/boot", "fstype": "xfs", "role": "system",
                 "total_gb": 1.0},
                {"device": "/dev/vdb", "mount": "/data", "fstype": "xfs", "role": "data",
                 "total_gb": data_total},
            ]
            if rnd.random() < 0.30:
                disks_tpl.append({"device": "/dev/vdc", "mount": "/data2", "fstype": "xfs",
                                  "role": "data", "total_gb": float(rnd.choice([500, 1000, 2000]))})
            if rnd.random() < 0.40:
                disks_tpl.append({"device": "nas-server:/share", "mount": "/nas", "fstype": "nfs",
                                  "role": "nas", "total_gb": float(rnd.choice([1000, 2000, 4000]))})

            mw = ROLE_MW.get(role, ["jdk"])

            hosts.append({
                "idx": idx,
                "pi": pi,
                "sysname": sysname,
                "code": code,
                "dept": dept,
                "role": role,
                "ip": ip,
                "hostname": "%s-%s-%02d" % (code.lower(), {"前端": "web", "后端": "app", "数据库": "db"}[role], hi + 1),
                "os_name": os_name, "os_id": os_id, "os_family": os_family,
                "os_ver": os_ver, "kernel": kernel, "arch": arch,
                "cores": cores,
                "mem_total": mem_total,
                "env": env,
                "zone": "政务外网" if rnd.random() < 0.6 else "互联网",
                "center": "主中心" if rnd.random() < 0.7 else "备中心",
                "health": health,
                "cpu_base": rand_in(base["cpu"]),
                "mem_base": rand_in(base["mem"]),
                "sys_base": rand_in(base["sys"]),
                "data_base": rand_in(base["data"]),
                # 季度漂移：磁盘最容易缓慢增长，CPU/内存小幅波动
                "cpu_drift": rnd.uniform(-8, 8),
                "mem_drift": rnd.uniform(-6, 10),
                "disk_drift": rnd.uniform(2, 16) if rnd.random() < 0.35 else rnd.uniform(-4, 4),
                "swap_usage": r1(rnd.uniform(0, 25)) if rnd.random() < 0.35 else 0.0,
                "ntp_offset": r1(rnd.uniform(50, 2600)) if rnd.random() < 0.10 else 0.0,
                "uptime_start": rnd.uniform(5, 380),
                "ssh_fail_base": rnd.uniform(0, 12) if rnd.random() < 0.8 else rnd.uniform(15, 55),
                "zombie": 1 if rnd.random() < 0.04 else 0,
                "disks_tpl": disks_tpl,
                "mw": mw,
                # 少量机器出现「核心进程挂掉」（瞬时 1 次 / 或季度后段持续）
                "proc_down_runs": ([rnd.randrange(runs)] if rnd.random() < 0.05 else
                                   (list(range(max(1, runs // 2), runs)) if rnd.random() < 0.02 else [])),
                # 少量机器偶发采集失败
                "fail_runs": [rnd.randrange(runs)] if rnd.random() < 0.03 else [],
                "developer": DEVELOPERS[rnd.randrange(len(DEVELOPERS))],
                "ops_owner": OPS_OWNERS[rnd.randrange(len(OPS_OWNERS))],
                "pm": PM_NAMES[rnd.randrange(len(PM_NAMES))],
                "tech_lead": TECH_LEADS[rnd.randrange(len(TECH_LEADS))],
            })
    return hosts


# ---------------------------------------------------------------------------
# 4. 单次运行的采集数据 + 告警
# ---------------------------------------------------------------------------


def gen_result(rnd, h, run_i, runs, run_at):
    """生成一台机器一次巡检的 (status, data, alerts)"""
    t = run_i / float(max(1, runs - 1))  # 0..1 季度进度
    noise = lambda amp: rnd.uniform(-amp, amp)

    cpu_usage = r1(clamp(h["cpu_base"] + h["cpu_drift"] * t + noise(5), 1, 99))
    mem_usage = r1(clamp(h["mem_base"] + h["mem_drift"] * t + noise(4), 5, 99))
    sys_usage = r1(clamp(h["sys_base"] + h["disk_drift"] * t + noise(2), 5, 99))
    data_usage = r1(clamp(h["data_base"] + h["disk_drift"] * t * 1.2 + noise(2), 5, 99))

    cores = h["cores"]
    mem_total = h["mem_total"]
    load1 = r1(cpu_usage / 100.0 * cores * rnd.uniform(0.4, 1.15))
    swap_usage = h["swap_usage"]
    ntp = h["ntp_offset"] + noise(30) if h["ntp_offset"] else r1(abs(noise(60)))
    uptime = r1(h["uptime_start"] + t * 90.0)

    # 磁盘（使用率 + inode）
    disks = []
    for d in h["disks_tpl"]:
        if d["role"] == "system":
            u = sys_usage if d["mount"] == "/" else r1(clamp(sys_usage * 0.4 + noise(8), 3, 80))
        elif d["role"] == "data":
            u = r1(clamp(data_usage + noise(4), 3, 99))
        else:
            u = r1(clamp(data_usage * 0.9 + noise(6), 5, 95))
        disks.append({
            "device": d["device"], "mount": d["mount"], "fstype": d["fstype"], "role": d["role"],
            "total_gb": d["total_gb"],
            "used_gb": r1(d["total_gb"] * u / 100.0),
            "usage": u,
            "inode_usage": r1(clamp(u + rnd.uniform(-6, 8), 1, 99)),
        })

    sys_u = max([d["usage"] for d in disks if d["role"] == "system"])
    sys_inode = max([d["inode_usage"] for d in disks if d["role"] == "system"])
    data_u = max([d["usage"] for d in disks if d["role"] == "data"] or [0.0])
    data_inode = max([d["inode_usage"] for d in disks if d["role"] == "data"] or [0.0])
    nas_u = max([d["usage"] for d in disks if d["role"] == "nas"] or [0.0])

    # 网络
    speed = 10000.0 if rnd.random() < 0.3 else 1000.0
    rx = r1(rnd.uniform(0, speed * 0.35))
    tx = r1(rnd.uniform(0, speed * 0.25))
    bw = r1(clamp((rx + tx) / speed * 100, 0, 100))
    pl = r1(rnd.uniform(0.1, 1.5)) if rnd.random() < 0.06 else 0.0
    retrans = r1(rnd.uniform(0, 2.2)) if rnd.random() < 0.12 else r1(rnd.uniform(0, 0.6))

    est = rnd.randrange(60, 900)
    tw = rnd.randrange(0, 2600)
    syn = rnd.randrange(0, 8)
    cw = rnd.randrange(0, 60)
    listen = rnd.randrange(6, 32)
    tcp_states = {"ESTABLISHED": est, "TIME_WAIT": tw, "SYN_RECV": syn, "CLOSE_WAIT": cw,
                  "LISTEN": listen}
    conn_total = est + tw + syn + cw + listen

    # 核心进程
    core = []
    for mw in h["mw"]:
        alive = run_i not in h["proc_down_runs"]
        if alive and h["health"] == "problem" and rnd.random() < 0.02:
            alive = False
        core.append({
            "type": mw, "pattern": mw, "alive": alive,
            "pid": (rnd.randrange(2000, 30000) if alive else None),
            "cpu": r1(rnd.uniform(0.5, 28)) if alive else 0.0,
            "mem": r1(rnd.uniform(0.5, 16)) if alive else 0.0,
        })

    ssh_fail = int(max(0, h["ssh_fail_base"] + noise(6)))

    data = {
        "os": {
            "hostname": h["hostname"], "name": h["os_name"], "id": h["os_id"],
            "family": h["os_family"], "pretty": "%s %s" % (h["os_name"], h["os_ver"]),
            "version": h["os_ver"], "arch": h["arch"], "kernel": h["kernel"],
            "timezone": "Asia/Shanghai", "ntp_offset_ms": r1(ntp),
            "uptime_days": uptime,
            "boot_time": (run_at - timedelta(days=uptime)).strftime("%Y-%m-%d %H:%M"),
            "selinux": "Enforcing" if rnd.random() < 0.7 else "Disabled",
        },
        "cpu": {
            "model": "Intel(R) Xeon(R) Gold 6266C" if h["arch"] == "x86_64" else "Kunpeng 920",
            "cores": cores, "usage": cpu_usage, "iowait": r1(rnd.uniform(0, 14)),
            "load1": load1, "load5": r1(load1 * rnd.uniform(0.8, 1.0)),
            "load15": r1(load1 * rnd.uniform(0.6, 0.95)),
            "load_ratio": r1(load1 / cores * 100),
            "per_core": [r1(clamp(cpu_usage + noise(22), 0, 100)) for _ in range(min(cores, 16))],
        },
        "mem": {
            "total_gb": mem_total, "used_gb": r1(mem_total * mem_usage / 100.0),
            "available_gb": r1(mem_total * (1 - mem_usage / 100.0)),
            "cache_gb": r1(mem_total * rnd.uniform(0.05, 0.3)),
            "usage": mem_usage, "swap_total_gb": r1(mem_total * 0.5),
            "swap_used_gb": r1(mem_total * 0.5 * swap_usage / 100.0),
            "swap_usage": swap_usage,
        },
        "disk": {"disks": disks},
        "net": {
            "interfaces": [{"name": "eth0", "rx_mbps": rx, "tx_mbps": tx, "speed_mbps": speed,
                            "bandwidth_pct": bw, "rx_drop": 0, "tx_drop": 0}],
            "packet_loss_pct": pl, "tcp_states": tcp_states,
            "tcp_retrans_pct": retrans, "listen_port_count": listen, "conn_total": conn_total,
        },
        "proc": {
            "total": rnd.randrange(120, 620), "zombie": h["zombie"],
            "top": [{"name": rnd.choice(["systemd", "nginx", "mysqld", "java", "redis-server", "python3"]),
                     "pid": rnd.randrange(500, 30000), "cpu": r1(rnd.uniform(0, 30)),
                     "mem": r1(rnd.uniform(0, 14))} for _ in range(5)],
            "core": core, "mw_count": len(core),
        },
        "security": {
            "firewall": "启用(firewalld)" if rnd.random() < 0.8 else "未启用",
            "selinux": "Enforcing" if rnd.random() < 0.7 else "Disabled",
            "root_login": "no" if rnd.random() < 0.75 else "yes",
            "ssh_fail_24h": ssh_fail, "open_ports": listen,
            "ssh_port": 65181,
            "last_ssh_login": (run_at - timedelta(hours=rnd.randrange(1, 72))).strftime("%Y-%m-%d %H:%M"),
        },
    }

    flat = {
        "cpu_usage": cpu_usage, "cpu_iowait": data["cpu"]["iowait"],
        "cpu_per_core_max": max(data["cpu"]["per_core"]),
        "cpu_load_ratio": data["cpu"]["load_ratio"],
        "mem_usage": mem_usage, "swap_usage": swap_usage,
        "disk_system_usage": sys_u, "disk_system_inode_usage": sys_inode,
        "disk_data_max_usage": data_u, "disk_data_inode_max_usage": data_inode,
        "disk_nas_max_usage": nas_u,
        "net_bandwidth_max_pct": bw, "packet_loss_pct": pl, "tcp_retrans_pct": retrans,
        "ntp_offset_ms": data["os"]["ntp_offset_ms"], "uptime_days": uptime,
        "cpu_cores": cores, "load1": load1, "sec_ssh_fail_24h": ssh_fail,
    }

    status = "fail" if run_i in h["fail_runs"] else "ok"
    return status, data, eval_alerts(flat, disks, core)


def eval_alerts(flat, disks, core):
    """镜像 backend/inspect.go: evalAlertsWithProfile(d, nil)"""
    out = []

    def add(metric, key, level, value, note):
        out.append({"metric": metric, "key": key, "level": level, "value": value, "note": note})

    for key, label, warn, crit, note in PERCENT_DEFS:
        v = flat.get(key)
        if v is None:
            continue
        if crit > 0 and v >= crit:
            add(label, key, "critical", v, note)
        elif warn > 0 and v >= warn:
            add(label, key, "warning", v, note)

    # NTP 偏差（绝对值）
    v = flat.get("ntp_offset_ms") or 0.0
    av = abs(v)
    if av >= 1000:
        add("系统时间与NTP偏差", "ntp_offset_ms", "warning", v,
            "偏差 %.1fms ≥ 预警阈值 %sms" % (av, thr_text(1000)))

    # 运行时长
    if flat.get("uptime_days", 0) >= 200:
        add("运行时长", "uptime_days", "warning", flat["uptime_days"],
            "已达 %.1f 天，超过 %s 天建议计划重启（补丁更新）" % (flat["uptime_days"], thr_text(200)))

    # 负载（1m / 核心数）
    cores = flat.get("cpu_cores") or 1
    if cores > 0:
        ratio = flat["load1"] / cores * 100
        note = "负载 %.2f 为核心数(%s) 的 %.0f%%" % (flat["load1"], thr_text(cores), ratio)
        if ratio >= 100:
            add("系统负载(1m)", "load1", "critical", flat["load1"], note + "，≥ 严重阈值 100%")
        elif ratio >= 70:
            add("系统负载(1m)", "load1", "warning", flat["load1"], note + "，≥ 预警阈值 70%")

    # 单核打满
    if flat.get("cpu_per_core_max", 0) >= 100:
        add("单核使用率", "cpu_per_core_max", "warning", flat["cpu_per_core_max"],
            "存在单核打满，整体可能空闲")

    # 逐盘
    for d in disks:
        warn, crit = (70, 80) if d["role"] == "data" else (75, 80)
        note = "(%s盘 挂载点 %s)" % (d["role"], d["mount"])
        label = "磁盘 %s" % d["mount"]
        if crit > 0 and d["usage"] >= crit:
            add(label, "disk_usage", "critical", d["usage"], note)
        elif warn > 0 and d["usage"] >= warn:
            add(label, "disk_usage", "warning", d["usage"], note)

    # 核心进程存活
    for c in core:
        if not c["alive"]:
            add("核心进程存活", "svc_core_down", "critical", 0, "核心进程未运行: %s" % c["type"])

    # SSH 暴力破解
    if flat.get("sec_ssh_fail_24h", 0) >= 20:
        add("近24h失败SSH登录", "sec_ssh_fail_24h", "warning", flat["sec_ssh_fail_24h"],
            "%s 次 ≥ 预警阈值 20 次，疑似暴力破解" % thr_text(flat["sec_ssh_fail_24h"]))

    return out


# ---------------------------------------------------------------------------
# 5. SQL 生成
# ---------------------------------------------------------------------------


def build_run_times(start, end, freq, runs, today):
    """按频率排出季度内的巡检时刻"""
    times = []
    if freq == "daily":
        d = start
        while d <= end and d <= today and len(times) < runs:
            times.append(datetime(d.year, d.month, d.day, 2, 0))
            d += timedelta(days=1)
    elif freq == "monthly":
        for i in range(3):
            m = start.month + i
            y = start.year + (m - 1) // 12
            m = (m - 1) % 12 + 1
            d = date(y, m, 5)
            if d <= end and d <= today:
                times.append(datetime(y, m, 5, 2, 0))
    else:  # weekly：从季度内第一个周一开始
        d = start
        while d.weekday() != 0:
            d += timedelta(days=1)
        while d <= end and d <= today and len(times) < runs:
            times.append(datetime(d.year, d.month, d.day, 2, 0))
            d += timedelta(days=7)
    return times


def sql_values(rows, chunk=300):
    """把已拼好的 '(...)' 行按 chunk 切成多条 INSERT ... VALUES 的 VALUES 段"""
    out = []
    for i in range(0, len(rows), chunk):
        out.append(",\n".join(rows[i:i + chunk]))
    return out


def generate_sql(args, rnd):
    year, q = args.year, args.quarter
    tag = "%dQ%d" % (year, q)
    start = date(year, QUARTER_START_MONTH[q], 1)
    end = date(year + (QUARTER_START_MONTH[q] + 2) // 12,
               (QUARTER_START_MONTH[q] + 2) % 12 + 1, 1) - timedelta(days=1)
    today = date.today()
    run_times = build_run_times(start, end, args.freq, args.runs, today)
    if not run_times:
        print("[错误] 季度范围内没有可排的运行时间（%s ~ %s，今天 %s）" % (start, end, today))
        sys.exit(2)

    root_cat = "模拟数据-%s" % tag
    task_name = "季度全量巡检（模拟-%s）" % tag

    projects = PROJECTS[:args.projects] if args.projects <= len(PROJECTS) else PROJECTS
    hosts = build_hosts(rnd, projects, args.per_project, len(run_times))

    L = []
    a = L.append
    a("-- 巡检季度演示数据（由 scripts/seed_inspection_demo.py 生成，请勿手工编辑）")
    a("-- 季度=%s  项目=%d  主机=%d  运行次数=%d(%s)  随机种子=%d" %
      (tag, len(projects), len(hosts), len(run_times), args.freq, args.seed))
    a("BEGIN;")
    a("SET client_encoding = 'UTF8';")
    a("")
    a("-- ========== 清理同标记的旧演示数据（幂等） ==========")
    a("DELETE FROM inspection_results WHERE task_id IN (SELECT id FROM inspection_tasks WHERE name LIKE '季度全量巡检（模拟-%');")
    a("DELETE FROM inspection_records WHERE task_id IN (SELECT id FROM inspection_tasks WHERE name LIKE '季度全量巡检（模拟-%');")
    a("DELETE FROM inspection_tasks   WHERE name LIKE '季度全量巡检（模拟-%';")
    a("DELETE FROM assets WHERE category_id IN (")
    a("  SELECT id FROM categories WHERE name LIKE '模拟数据-%'")
    a("     OR parent_id IN (SELECT id FROM categories WHERE name LIKE '模拟数据-%'));")
    a("DELETE FROM categories WHERE parent_id IN (SELECT id FROM categories WHERE name LIKE '模拟数据-%');")
    a("DELETE FROM categories WHERE name LIKE '模拟数据-%';")
    a("")

    # ---- 分类树 ----
    a("-- ========== 分类树：%s（根） + %d 个项目 ==========" % (root_cat, len(projects)))
    a("CREATE TEMP TABLE _seed_cat AS")
    a("SELECT nextval('categories_id_seq') AS id, v.ord AS ord, v.pord AS pord, v.name AS name, v.lvl AS lvl")
    a("FROM (VALUES")
    vals = ["  (-1, NULL::bigint, %s, 1)" % sql_lit(root_cat)]
    for pi, (sysname, code, dept) in enumerate(projects):
        vals.append("  (%d, -1, %s, 2)" % (pi, sql_lit(sysname)))
    a(",\n".join(vals) + ") AS v(ord, pord, name, lvl);")
    a("INSERT INTO categories (id, parent_id, name, level, path, sort, created_at)")
    a("SELECT c.id, p.id, c.name, c.lvl,")
    a("       CASE WHEN p.id IS NULL THEN '/0/' || c.id ELSE '/0/' || p.id || '/' || c.id END,")
    a("       c.ord + 1, now()")
    a("FROM _seed_cat c LEFT JOIN _seed_cat p ON p.ord = c.pord;")
    a("")

    # ---- 资产 ----
    a("-- ========== 资产：%d 台 ==========" % len(hosts))
    a("CREATE TEMP TABLE _seed_asset AS")
    a("SELECT nextval('assets_id_seq') AS id, v.ord AS ord, v.cat AS cat, v.name AS name,")
    a("       v.ip AS ip, v.fields AS fields")
    a("FROM (VALUES")
    rows = []
    for h in hosts:
        fields = {
            "ERP系统名称": h["sysname"],
            "应用系统名称": h["sysname"],
            "项目简称": h["code"],
            "虚拟机IPv4": h["ip"],
            "虚拟机名称": h["hostname"],
            "自定义主机名": h["hostname"],
            "所属网络区域": h["zone"],
            "系统所属网络区域": h["zone"],
            "所属中心": h["center"],
            "环境": h["env"],
            "业务环境": h["role"],
            "操作系统版本": "%s %s" % (h["os_name"], h["os_ver"]),
            "CPU类型": h["arch"],
            "CPU核数": str(h["cores"]),
            "内存（GB）": str(int(h["mem_total"])),
            "系统盘（GB）": str(int(h["disks_tpl"][0]["total_gb"])),
            "数据盘1（GB）": str(int(h["disks_tpl"][2]["total_gb"])),
            "归属部门": h["dept"],
            "开发人员": h["developer"],
            "运维负责人": h["ops_owner"],
            "项目经理": h["pm"],
            "项目技术负责人": h["tech_lead"],
            "普通用户": "appuser",
            "SSH端口": "65181",
            "用途": "%s-%s节点" % (h["sysname"], h["role"]),
            "备注": "季度演示模拟数据 %s（非真实资产，可安全清理）" % tag,
            "中间件信息": [{"type": m, "name": m, "port": ",".join(str(p) for p in MW_PORTS.get(m, []))}
                           for m in h["mw"]],
        }
        name = "%s_%s_%s_%s" % (h["code"], h["env"], h["role"], h["ip"])
        rows.append("  (%d, %d, %s, %s, %s)" % (
            h["idx"], h["pi"], sql_lit(name), sql_lit(h["ip"]),
            sql_lit(json.dumps(fields, ensure_ascii=False, separators=(",", ":")))))
    a(",\n".join(rows) + ") AS v(ord, cat, name, ip, fields);")
    a("INSERT INTO assets (id, category_id, name, ip, fields, created_by, created_at, updated_at)")
    a("SELECT a.id, c.id, a.name, a.ip, a.fields::jsonb, 1, %s, %s" %
      (ts_lit(datetime.combine(start, datetime.min.time()) - timedelta(days=30)),
       ts_lit(datetime.combine(start, datetime.min.time()) - timedelta(days=30))))
    a("FROM _seed_asset a JOIN _seed_cat c ON c.ord = a.cat;")
    a("")

    # ---- 巡检任务 ----
    a("-- ========== 巡检任务 ==========")
    a("CREATE TEMP TABLE _seed_task AS")
    a("SELECT nextval('inspection_tasks_id_seq') AS id;")
    a("INSERT INTO inspection_tasks (id, name, scope_type, category_id, asset_ids, metrics, freq,")
    a("  interval_min, interval_hour, weekday, month_day, run_hour, run_minute,")
    a("  allow_simulated, ssh_user, ssh_pass, ssh_port, schedule_enabled, last_run_at, next_run_at,")
    a("  status, created_by, created_at, updated_at)")
    a("SELECT id, %s, 'all', NULL, '[]'::jsonb, %s, %s," %
      (sql_lit(task_name),
       json_lit(["os", "cpu", "mem", "disk", "net", "proc", "svc", "security"]),
       sql_lit(args.freq if args.freq in ("manual", "day", "week", "month", "quarter") else "week")))
    a("  0, 0, %d, 0, 2, %d," % (1 if args.freq == "weekly" else 0, rnd.randrange(0, 30)))
    a("  true, 'appuser', '', 65181, %s, %s, %s," %
      ("true" if args.freq != "manual" else "false",
       ts_lit(run_times[-1]), ts_lit(run_times[-1] + timedelta(days=7))))
    a("  'idle', 1, %s, %s" % (ts_lit(run_times[0] - timedelta(days=1)), ts_lit(run_times[-1])))
    a("FROM _seed_task;")
    a("")

    # ---- 巡检记录 ----
    a("-- ========== 巡检记录：%d 次 ==========" % len(run_times))
    a("CREATE TEMP TABLE _seed_rec AS")
    a("SELECT nextval('inspection_records_id_seq') AS id, v.ord AS ord, v.run_at::timestamp AS run_at")
    a("FROM (VALUES " + ",\n".join(
        "  (%d, %s)" % (i, ts_lit(rt)) for i, rt in enumerate(run_times)) + ") AS v(ord, run_at);")
    a("INSERT INTO inspection_records (id, task_id, task_name, run_at, status, total_assets, source, created_at)")
    a("SELECT r.id, t.id, %s, r.run_at, 'running', %d, %s, r.run_at FROM _seed_rec r, _seed_task t;" %
      (sql_lit(task_name), len(hosts), sql_lit(args.source)))
    a("")

    # ---- 逐次生成结果 ----
    a("-- ========== 巡检结果 + 告警 ==========")
    total_results = 0
    total_alerts = 0
    fail_total = 0
    cat_alerts = {}
    sum_cpu = sum_mem = sum_disk = 0.0
    cnt_ok = 0

    rec_stats = []
    for ri, rt in enumerate(run_times):
        ok = fail = 0
        s_cpu = s_mem = s_disk = 0.0
        n_ok = 0
        rows = []
        for h in hosts:
            status, data, alerts = gen_result(rnd, h, ri, len(run_times), rt)
            collected = rt + timedelta(minutes=(h["idx"] % 45), seconds=(h["idx"] % 60))
            if status == "ok":
                ok += 1
                s_cpu += data["cpu"]["usage"]
                s_mem += data["mem"]["usage"]
                s_disk += max([d["usage"] for d in data["disk"]["disks"]])
                n_ok += 1
                for al in alerts:
                    cat_alerts[al["key"]] = cat_alerts.get(al["key"], 0) + 1
            else:
                fail += 1
                data = {}
                alerts = []
            rows.append("  (%d, %d, %s, %s, %s, %s, %s, %s, %s, %s, %s)" % (
                ri, h["idx"], sql_lit(h["sysname"]), sql_lit(h["ip"]),
                sql_lit(h["dept"]), sql_lit(h["developer"]),
                sql_lit(status), sql_lit(args.source), ts_lit(collected),
                json_lit(data), json_lit(alerts)))
            total_results += 1
            total_alerts += len(alerts)

        for chunk in sql_values(rows, 400):
            a("INSERT INTO inspection_results (record_id, task_id, asset_id, asset_name, ip, department,")
            a("  developer, status, source, collected_at, data, alerts)")
            a("SELECT r.id, t.id, a.id, v.asset_name, v.ip, v.department, v.developer, v.status,")
            a("       v.source, v.collected_at::timestamp, v.data::jsonb, v.alerts::jsonb")
            a("FROM (VALUES")
            a(chunk)
            a(") AS v(rec_ord, asset_ord, asset_name, ip, department, developer, status, source, collected_at, data, alerts)")
            a("JOIN _seed_rec r ON r.ord = v.rec_ord")
            a("JOIN _seed_asset a ON a.ord = v.asset_ord")
            a("JOIN _seed_task t ON true;")
            a("")

        rec_stats.append((ri, rt, ok, fail, s_cpu, s_mem, s_disk, n_ok))
        fail_total += fail
        sum_cpu += s_cpu
        sum_mem += s_mem
        sum_disk += s_disk
        cnt_ok += n_ok

    # ---- 回填记录（成功/失败数、耗时、summary） ----
    a("-- ========== 回填记录统计 ==========")
    for ri, rt, ok, fail, s_cpu, s_mem, s_disk, n_ok in rec_stats:
        avg_cpu = r1(s_cpu / n_ok) if n_ok else 0.0
        avg_mem = r1(s_mem / n_ok) if n_ok else 0.0
        avg_disk = r1(s_disk / n_ok) if n_ok else 0.0
        status = "done" if fail == 0 else ("failed" if ok == 0 else "partial")
        summary = {"avgCpu": avg_cpu, "avgMem": avg_mem, "avgDisk": avg_disk,
                   "online": ok, "offline": fail, "categoryAlerts": {}}
        a("UPDATE inspection_records SET task_name=%s, total_assets=%d, success_count=%d, fail_count=%d," %
          (sql_lit(task_name), ok + fail, ok, fail))
        a("  duration_ms=%d, status=%s, source=%s, summary=%s" %
          (rnd.randrange(180000, 900000), sql_lit(status), sql_lit(args.source), json_lit(summary)))
        a("  WHERE id = (SELECT id FROM _seed_rec WHERE ord = %d);" % ri)
    a("")
    a("COMMIT;")
    a("")
    a("-- ========== 结果核对（人工看一眼即可） ==========")
    a("SELECT 'assets' AS t, count(*) AS n FROM assets WHERE category_id IN")
    a("  (SELECT id FROM categories WHERE name LIKE '模拟数据-%' OR parent_id IN (SELECT id FROM categories WHERE name LIKE '模拟数据-%'))")
    a("UNION ALL SELECT 'records', count(*) FROM inspection_records WHERE task_id IN (SELECT id FROM inspection_tasks WHERE name LIKE '季度全量巡检（模拟-%')")
    a("UNION ALL SELECT 'results', count(*) FROM inspection_results WHERE task_id IN (SELECT id FROM inspection_tasks WHERE name LIKE '季度全量巡检（模拟-%')")
    a("UNION ALL SELECT 'alerts', sum(jsonb_array_length(alerts)) FROM inspection_results WHERE task_id IN (SELECT id FROM inspection_tasks WHERE name LIKE '季度全量巡检（模拟-%');")

    stats = {
        "tag": tag, "start": start, "end": end, "runs": len(run_times),
        "projects": len(projects), "hosts": len(hosts),
        "results": total_results, "alerts": total_alerts, "fails": fail_total,
        "avgCpu": r1(sum_cpu / cnt_ok) if cnt_ok else 0,
        "avgMem": r1(sum_mem / cnt_ok) if cnt_ok else 0,
        "avgDisk": r1(sum_disk / cnt_ok) if cnt_ok else 0,
        "rootCat": root_cat, "taskName": task_name,
    }
    return "\n".join(L), stats


def clean_sql():
    return "\n".join([
        "-- 清理全部季度演示模拟数据（分类标记「模拟数据-*」+ 任务标记「季度全量巡检（模拟-*」）",
        "BEGIN;",
        "DELETE FROM inspection_results WHERE task_id IN (SELECT id FROM inspection_tasks WHERE name LIKE '季度全量巡检（模拟-%');",
        "DELETE FROM inspection_records WHERE task_id IN (SELECT id FROM inspection_tasks WHERE name LIKE '季度全量巡检（模拟-%');",
        "DELETE FROM inspection_tasks   WHERE name LIKE '季度全量巡检（模拟-%';",
        "DELETE FROM assets WHERE category_id IN (",
        "  SELECT id FROM categories WHERE name LIKE '模拟数据-%'",
        "     OR parent_id IN (SELECT id FROM categories WHERE name LIKE '模拟数据-%'));",
        "DELETE FROM categories WHERE parent_id IN (SELECT id FROM categories WHERE name LIKE '模拟数据-%');",
        "DELETE FROM categories WHERE name LIKE '模拟数据-%';",
        "COMMIT;",
    ])


# ---------------------------------------------------------------------------
# 6. 执行
# ---------------------------------------------------------------------------


def run_sql(docker, sql_text, tmp_name="seed_inspection_demo.sql"):
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".workbuddy", "tmp")
    local = os.path.abspath(local)
    if not os.path.isdir(local):
        os.makedirs(local)
    path = os.path.join(local, tmp_name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(sql_text)
    remote = "/var/tmp/" + tmp_name
    subprocess.check_call([docker, "cp", path, "ophub-postgres:" + remote])
    subprocess.check_call([docker, "exec", "ophub-postgres", "psql", "-U", "ophub", "-d", "ophub",
                           "-v", "ON_ERROR_STOP=1", "-f", remote])
    return path


def main():
    ap = argparse.ArgumentParser(description="巡检季度演示数据生成器")
    ap.add_argument("--year", type=int, default=date.today().year)
    ap.add_argument("--quarter", type=int, default=(date.today().month - 1) // 3 + 1, choices=[1, 2, 3, 4])
    ap.add_argument("--projects", type=int, default=30, help="项目数（默认 30）")
    ap.add_argument("--per-project", type=int, default=10, help="每个项目主机数（默认 10）")
    ap.add_argument("--freq", default="weekly", choices=["weekly", "daily", "monthly"], help="巡检频率")
    ap.add_argument("--runs", type=int, default=12, help="季度内运行次数上限")
    ap.add_argument("--source", default="simulated", choices=["simulated", "ansible"],
                    help="采集来源标记（默认 simulated=模拟，导出里显示「模拟」）")
    ap.add_argument("--seed", type=int, default=20260922, help="随机种子（相同种子产出相同数据）")
    ap.add_argument("--docker", default=os.environ.get("DOCKER_BIN", "docker"))
    ap.add_argument("--dry-run", action="store_true", help="只生成 SQL 不执行")
    ap.add_argument("--clean", action="store_true", help="只清理演示数据")
    args = ap.parse_args()

    if args.clean:
        print("[清理] 删除全部「模拟数据-*」分类资产与「季度全量巡检（模拟-*」任务数据 ...")
        run_sql(args.docker, clean_sql(), "clean_inspection_demo.sql")
        print("[完成] 演示数据已清理。")
        return

    rnd = random.Random(args.seed)
    sql_text, st = generate_sql(args, rnd)
    print("[生成] 季度=%s（%s ~ %s） 项目=%d 主机=%d 运行=%d 次（%s）" %
          (st["tag"], st["start"], st["end"], st["projects"], st["hosts"], st["runs"], args.freq))
    print("[生成] results=%d 条，alerts=%d 条，采集失败=%d 条，均值 CPU=%.1f%% 内存=%.1f%% 磁盘=%.1f%%" %
          (st["results"], st["alerts"], st["fails"], st["avgCpu"], st["avgMem"], st["avgDisk"]))

    if args.dry_run:
        p = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".workbuddy", "tmp"))
        if not os.path.isdir(p):
            os.makedirs(p)
        fp = os.path.join(p, "seed_inspection_demo.sql")
        with open(fp, "w", encoding="utf-8") as f:
            f.write(sql_text)
        print("[dry-run] SQL 已写到 %s（%.2f MB），未执行。" % (fp, len(sql_text.encode("utf-8")) / 1048576.0))
        return

    path = run_sql(args.docker, sql_text)
    print("[入库] SQL: %s（%.2f MB）" % (path, len(sql_text.encode("utf-8")) / 1048576.0))
    print("""
[完成] 演示数据已写入 ophub-postgres。
  · 分类树：%(rootCat)s（含 %(projects)d 个二级项目分类）
  · 巡检任务：%(taskName)s
  · 报表：智能巡检 → 巡检报表 → 季度报告导出（选 %(year)d 年 Q%(q)d）

清理：python scripts/seed_inspection_demo.py --clean
""" % {"rootCat": st["rootCat"], "taskName": st["taskName"], "projects": st["projects"],
        "year": args.year, "q": args.quarter})


if __name__ == "__main__":
    main()
