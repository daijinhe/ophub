#!/usr/bin/env python3
"""mock_prom.py — 本地仿真 Prometheus（仅测试用）

模拟 Prometheus HTTP API 的只读子集，用于在没有真实 Prometheus 的环境里
端到端验证 云枢 OpsHub的「Prometheus 监控」模块：
  GET /api/v1/query?query=...           即时查询
  GET /api/v1/query_range?query=&start=&end=&step=   区间查询
  GET /api/v1/label/__name__/values     指标名列表
  GET /api/v1/status/buildinfo          版本信息

用法：python mock_prom.py [port]   （默认 9876）
按 Ctrl+C 停止。数据为静态仿真（6 台 node_exporter 主机 + 1 条告警）。
"""
import json
import math
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9876

# 6 台主机，第 6 台故意 down
INSTANCES = [
    ("198.51.100.11:9100", "web-prod-01"),
    ("198.51.100.12:9100", "web-prod-02"),
    ("198.51.100.21:9100", "app-prod-01"),
    ("198.51.100.22:9100", "app-prod-02"),
    ("198.51.100.31:9100", "db-prod-01"),
    ("198.51.100.99:9100", "legacy-old"),
]
UP_FLAGS = [1, 1, 1, 1, 1, 0]  # legacy-old 离线

# 业务标签（模拟 Prometheus target relabel 注入的 department/system/env/deployserver）
BIZ_LABELS = [
    {"department": "财务部", "system": "ERP系统", "env": "生产环境", "deployserver": "应用服务器"},
    {"department": "财务部", "system": "ERP系统", "env": "生产环境", "deployserver": "Web服务器"},
    {"department": "供应链部", "system": "WMS系统", "env": "生产环境", "deployserver": "应用服务器"},
    {"department": "供应链部", "system": "WMS系统", "env": "测试环境", "deployserver": "数据库服务器"},
    {"department": "信息技术部", "system": "OA系统", "env": "生产环境", "deployserver": "数据库服务器"},
    {"department": "信息技术部", "system": "遗留系统", "env": "测试环境", "deployserver": "应用服务器"},
]


def mlabels(i, **kw):
    """第 i 台主机的完整 metric 标签（instance + job + 业务标签）。"""
    inst, host = INSTANCES[i]
    d = {"instance": inst, "job": "node"}
    d.update(BIZ_LABELS[i])
    d.update(kw)
    return d

METRIC_NAMES = [
    "node_cpu_seconds_total",
    "node_memory_MemAvailable_bytes",
    "node_memory_MemTotal_bytes",
    "node_filesystem_avail_bytes",
    "node_filesystem_size_bytes",
    "node_load1",
    "node_uname_info",
    "node_network_receive_bytes_total",
    "node_network_send_bytes_total",
    "up",
    "ALERTS",
    "prometheus_build_info",
]

BASE = {"cpu": 35.0, "mem": 60.0, "disk": 55.0}


def cpu_base(i):
    return BASE["cpu"] + i * 4.0


def mem_base(i):
    return BASE["mem"] + i * 3.0


def disk_base(i):
    return min(92.0, BASE["disk"] + i * 6.0)


def wave(ts, period, amp):
    return amp * math.sin(2 * math.pi * ts / period)


def vec_value(kind, i, ts):
    """第 i 台主机在 ts 时刻 kind 指标的值（仿真曲线）。"""
    if kind == "cpu":
        return max(0.0, min(99.0, cpu_base(i) + wave(ts, 3600 * 3, 8.0)))
    if kind == "mem":
        return max(0.0, min(99.0, mem_base(i) + wave(ts, 3600 * 6, 4.0)))
    if kind == "disk":
        return max(0.0, min(99.0, disk_base(i) + wave(ts, 86400, 1.5)))
    return 0.0


def classify(query):
    q = query or ""
    if q.strip() == "up":
        return "up"
    if "ALERTS" in q:
        return "alerts"
    if "node_uname_info" in q:
        return "uname"
    if "node_cpu" in q:
        return "cpu"
    if "MemAvailable" in q:
        return "mem"
    if "node_filesystem_avail" in q:
        return "disk"
    if "label_values" in q or "__name__" in q:
        return "names"
    return "other"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-prom] %s\n" % (fmt % args))

    def _send(self, payload, code=200):
        b = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        query = (qs.get("query") or [""])[0]
        now = time.time()

        if u.path == "/api/v1/status/buildinfo":
            self._send({"status": "success", "data": {"version": "2.45.0-mock"}})
            return

        if u.path == "/api/v1/label/__name__/values":
            # 真实 Prometheus 的 data 节点直接就是字符串数组
            self._send({"status": "success", "data": METRIC_NAMES})
            return

        if u.path == "/api/v1/query":
            kind = classify(query)
            if kind == "up":
                result = [
                    {"metric": mlabels(i), "value": [now, str(v)]}
                    for i, v in enumerate(UP_FLAGS)
                ]
            elif kind == "alerts":
                result = [
                    {
                        "metric": {
                            "alertname": "HostHighCPU",
                            "alertstate": "firing",
                            "instance": INSTANCES[4][0],
                            "severity": "warning",
                            "description": "CPU usage > 90% for 5m (mock)",
                        },
                        "value": [now, "1"],
                    }
                ]
            elif kind == "uname":
                result = [
                    {"metric": mlabels(i, nodename=host), "value": [now, "1"]}
                    for i, (_, host) in enumerate(INSTANCES)
                ]
            elif kind in ("cpu", "mem", "disk"):
                result = [
                    {"metric": mlabels(i), "value": [now, "%.3f" % vec_value(kind, i, now)]}
                    for i in range(len(INSTANCES))
                    if UP_FLAGS[i] == 1
                ]
            else:
                result = [{"metric": {"__name__": query or "mock", "instance": INSTANCES[0][0]}, "value": [now, "1"]}]
            self._send({"status": "success", "data": {"resultType": "vector", "result": result}})
            return

        if u.path == "/api/v1/query_range":
            start = float((qs.get("start") or ["0"])[0])
            end = float((qs.get("end") or ["0"])[0])
            # step 兼容 Prometheus 两种写法：纯秒数（900）与时长（"900s"/"15m"）
            raw_step = (qs.get("step") or ["60"])[0]
            if raw_step.endswith("s"):
                raw_step = raw_step[:-1]
            try:
                step = float(raw_step)
            except ValueError:
                step = 60.0
            kind = classify(query)
            kinds = {"cpu", "mem", "disk"}
            if kind not in kinds:
                # up 等其它查询也给一份平线，避免前端报错
                kind = "cpu"
            series = []
            for i in range(len(INSTANCES)):
                if UP_FLAGS[i] == 0:
                    continue
                vals = []
                ts = start
                while ts <= end:
                    vals.append([ts, "%.3f" % vec_value(kind, i, ts)])
                    ts += step
                series.append({"metric": mlabels(i), "values": vals})
            self._send({"status": "success", "data": {"resultType": "matrix", "result": series}})
            return

        self._send({"status": "error", "error": "unknown endpoint (mock)"}, 404)


if __name__ == "__main__":
    print("mock prometheus listening on :%d" % PORT, flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
