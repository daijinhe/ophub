#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Web 终端（WebSocket SSH）端到端验证脚本 —— 零第三方依赖。

背景 / 为什么需要它
====================
v1.7.0 安全加固给 WebSocket 加上了 Origin 白名单（wsCheckOrigin），但白名单在
ALLOW_WS_ORIGINS 为空时会回落到 CORS 的 ALLOW_ORIGINS（.env 默认 `*`），而当时是
**字面量**比较 —— `*` 永远不等于 `http://localhost:10001`。浏览器升级 WebSocket
必定携带 Origin，于是 100% 被 403 拒绝，表现为终端里
「[连接错误，请检查服务器连通性与资产凭证] + [连接已断开]」。

同时前端 fetchWsTicket 误读响应结构（读顶层 j.ticket，实际在 j.data.ticket），
导致拿不到一次性 ticket、静默降级回 `?token=` 老路径。

本脚本用裸 socket 手工实现 WebSocket 客户端，**显式带上浏览器才会发的 Origin 头**，
才能复现 / 防回归 —— curl 不带 Origin，永远掩盖这个 bug。

覆盖用例
========
  1. 无 Origin + 有效 ticket            → 期望 101
  2. Origin=<平台地址> + ticket（真实浏览器路径）→ 期望 101   ← 回归重点
  3. Origin=http://evil.com + ticket    → 期望 403（安全边界仍在）
  4. ticket 一次性：同一 ticket 复用     → 期望非 101
  5. Origin=<平台地址> + 老 ?token=      → 期望 101（过渡期兼容）
  6. 端到端：握手后跑 `echo <哨兵>`      → 期望回显哨兵（SSH 真通）

用法
====
  python scripts/ws_terminal_e2e.py                      # 默认 assetId=81, localhost:10001
  python scripts/ws_terminal_e2e.py --asset 183
  python scripts/ws_terminal_e2e.py --base http://asset-01.internal.example:10001
  python scripts/ws_terminal_e2e.py --skip-tty           # 只验握手，不跑命令

注意：Windows 下建议 `PYTHONIOENCODING=utf-8`。
"""

import argparse
import base64
import json
import os
import socket
import ssl
import sys
import urllib.parse
import urllib.request

SENTINEL = "__OPHUB_WS_E2E_OK__"

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"
results = []


def record(name, status, detail=""):
    results.append((name, status, detail))
    icon = {PASS: "[PASS]", FAIL: "[FAIL]", SKIP: "[SKIP]"}[status]
    print(f"{icon} {name}" + (f"  -- {detail}" if detail else ""))


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------
def _http(method, url, token=None, body=None, timeout=20):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    elif method == "POST":
        data = b""
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def login(base, user, pwd):
    st, j = _http("POST", base + "/api/auth/login", body={"username": user, "password": pwd})
    if st != 200 or j.get("code") != 0:
        raise SystemExit(f"登录失败: HTTP {st} {j}")
    return j["data"]["token"]


def get_ticket(base, token):
    st, j = _http("POST", base + "/api/ws/ssh/ticket", token=token)
    if st != 200 or j.get("code") != 0:
        raise SystemExit(f"取 ticket 失败: HTTP {st} {j}")
    # 平台统一包装：ticket 在 data 里（前端曾误读顶层 → 静默降级）
    tk = (j.get("data") or {}).get("ticket")
    if not tk:
        raise SystemExit(f"ticket 字段缺失（响应结构是不是又变了？）: {j}")
    return tk


# --------------------------------------------------------------------------
# 极简 WebSocket 客户端（RFC6455，仅实现本场景需要的部分）
# --------------------------------------------------------------------------
class WSClient:
    def __init__(self, host, port, path, origin=None, use_tls=False, timeout=15):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        if use_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            self.sock = ctx.wrap_socket(self.sock, server_hostname=host)
        self.timeout = timeout
        self.status_line = ""
        self.buf = b""
        self._handshake(host, port, path, origin, use_tls)

    def _handshake(self, host, port, path, origin, use_tls):
        key = base64.b64encode(os.urandom(16)).decode()
        netloc = host if port in (80, 443) else f"{host}:{port}"
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {netloc}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        if origin:
            lines.append("Origin: " + origin)
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        # 读响应头（可能分片）
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            raw += chunk
        head, _, rest = raw.partition(b"\r\n\r\n")
        self.buf = rest
        self.head = head.decode(errors="replace")
        self.status_line = self.head.split("\r\n")[0]
        self.upgraded = "101" in self.status_line

    @property
    def status_code(self):
        parts = self.status_line.split()
        return int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0

    def send_text(self, text):
        payload = text.encode()
        n = len(payload)
        header = bytearray([0x81])  # FIN + text
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += n.to_bytes(2, "big")
        else:
            header.append(0x80 | 127)
            header += n.to_bytes(8, "big")
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接被对端关闭")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_frame(self):
        """返回 (opcode, payload_bytes)。"""
        b0, b1 = self._recv_exact(2)
        opcode = b0 & 0x0F
        length = b1 & 0x7F
        if length == 126:
            length = int.from_bytes(self._recv_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._recv_exact(8), "big")
        if b1 & 0x80:  # 服务端不应加掩码，容错处理
            mask = self._recv_exact(4)
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(self._recv_exact(length)))
        else:
            data = self._recv_exact(length)
        return opcode, data

    def drain(self, seconds=6.0, stop_when=None):
        """收集若干秒内的文本输出；stop_when(text) 为真提前返回。"""
        import time

        collected = ""
        deadline = time.time() + seconds
        self.sock.settimeout(1.0)
        while time.time() < deadline:
            try:
                opcode, data = self.recv_frame()
            except socket.timeout:
                if stop_when and stop_when(collected):
                    break
                continue
            except ConnectionError:
                break
            if opcode == 0x1:
                collected += data.decode(errors="replace")
                if stop_when and stop_when(collected):
                    break
            elif opcode == 0x8:
                break
            elif opcode == 0x9:  # ping → pong
                self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
        return collected

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def try_handshake(base_url, path, origin, timeout=12):
    """返回 (status_code, status_line, client|None)。"""
    u = urllib.parse.urlparse(base_url)
    host = u.hostname
    port = u.port or (443 if u.scheme == "https" else 80)
    try:
        c = WSClient(host, port, path, origin=origin, use_tls=(u.scheme == "https"), timeout=timeout)
        return c.status_code, c.status_line, c
    except Exception as e:
        return 0, f"<连接异常 {e}>", None


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:10001", help="平台地址（默认 http://localhost:10001）")
    ap.add_argument("--asset", type=int, default=81, help="资产 ID（默认 81）")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="admin123")
    ap.add_argument("--origin", default=None, help="模拟浏览器 Origin（默认取 base 本身）")
    ap.add_argument("--skip-tty", action="store_true", help="只验握手，不跑 shell 命令")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    origin_good = args.origin or base  # 浏览器访问平台时 Origin 就是平台自身地址
    origin_bad = "http://evil.com"

    print(f"目标平台: {base}   资产ID: {args.asset}   模拟 Origin: {origin_good}\n")

    token = login(base, args.user, args.password)
    print("登录成功，已取得 JWT\n")

    # --- 用例 1：无 Origin + ticket -------------------------------------
    st, line, c = try_handshake(base, f"/api/ws/ssh?assetId={args.asset}&ticket={get_ticket(base, token)}", None)
    record("1) 无 Origin + ticket（CLI/探活）", PASS if st == 101 else FAIL, line)
    if c:
        c.close()

    # --- 用例 2：真实浏览器路径（Origin = 平台地址）---------------------
    st2, line2, c2 = try_handshake(
        base, f"/api/ws/ssh?assetId={args.asset}&ticket={get_ticket(base, token)}", origin_good
    )
    record("2) Origin=平台地址 + ticket（真实浏览器）", PASS if st2 == 101 else FAIL, line2)

    # --- 用例 3：跨站 Origin 必须被拒 -----------------------------------
    st3, line3, c3 = try_handshake(
        base, f"/api/ws/ssh?assetId={args.asset}&ticket={get_ticket(base, token)}", origin_bad
    )
    record("3) Origin=evil.com + ticket（应拒绝）", PASS if st3 == 403 else FAIL, line3)
    if c3:
        c3.close()

    # --- 用例 4：ticket 一次性 -----------------------------------------
    reused = get_ticket(base, token)
    st4a, _, ca = try_handshake(base, f"/api/ws/ssh?assetId={args.asset}&ticket={reused}", origin_good)
    if ca:
        ca.close()
    st4b, line4b, cb = try_handshake(base, f"/api/ws/ssh?assetId={args.asset}&ticket={reused}", origin_good)
    if cb:
        cb.close()
    record(
        "4) ticket 一次性（复用应失败）",
        PASS if (st4a == 101 and st4b != 101) else FAIL,
        f"首次={st4a} 复用={st4b}",
    )

    # --- 用例 5：老 ?token= 过渡兼容 -----------------------------------
    st5, line5, c5 = try_handshake(base, f"/api/ws/ssh?assetId={args.asset}&token={token}", origin_good)
    record("5) Origin=平台地址 + 老 ?token=", PASS if st5 == 101 else FAIL, line5)

    # --- 用例 6：端到端跑命令（真 SSH）---------------------------------
    if args.skip_tty:
        record("6) 端到端执行命令（--skip-tty 已跳过）", SKIP)
    elif c2 is None or st2 != 101:
        record("6) 端到端执行命令（握手未通过，无法继续）", SKIP)
    else:
        c2.send_text(json.dumps({"type": "resize", "cols": 120, "rows": 30}))
        banner = c2.drain(6.0, stop_when=lambda t: "SSH 连接失败" in t or "#" in t or "$" in t or "【" in t)
        if "SSH 连接失败" in banner:
            record("6) 端到端执行命令（SSH 层失败）", FAIL, banner.strip().splitlines()[-1][:160])
        else:
            c2.send_text(f"echo {SENTINEL}\r")
            out = c2.drain(12.0, stop_when=lambda t: SENTINEL in t)
            if SENTINEL in out:
                record("6) 端到端执行命令（真 SSH 回显）", PASS, "已收到哨兵回显")
            else:
                tail = " | ".join(out.strip().splitlines()[-3:])[:200]
                record("6) 端到端执行命令（未回显哨兵）", FAIL, tail or "无输出")
        c2.close()

    # --- 汇总 -----------------------------------------------------------
    print("\n" + "=" * 62)
    n_fail = sum(1 for _, s, _ in results if s == FAIL)
    n_skip = sum(1 for _, s, _ in results if s == SKIP)
    print(f"合计 {len(results)} 项：通过 {len(results) - n_fail - n_skip} / 失败 {n_fail} / 跳过 {n_skip}")
    print("=" * 62)
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
