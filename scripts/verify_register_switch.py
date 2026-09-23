#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
验证「公开注册开关 + 注册账号零权限」（v1.7.45）。

背景
----
v1.7.44 之前的注册开关是**启动时读环境变量** ALLOW_PUBLIC_REGISTER 决定绑哪个 handler：

    if !publicRegistrationAllowed() { api.POST("/auth/register", publicRegistrationDisabledHandler) }
    else                            { api.POST("/auth/register", Register) }

这意味着「开 / 关注册」必须改 env 并重启后端，页面上切不了。同时 Register 默认给新用户
绑 `member` 角色 —— 等于「谁都能自助注册并立刻拿到一批权限」。

v1.7.45 改了两件事：
  1. 开关落库（SystemSetting `auth.register.enabled`），在「系统管理 → 用户管理 → 注册设置」
     里随时切、**写完立即生效**；DB 没配过时回落 env（兼容老部署）。
  2. 自助注册的账号**不绑任何角色 = 零权限**，必须由管理员手动分配。

断言要点
--------
A. 基线：默认关闭，且管理端能看到 fromEnv=true（当前值来自环境变量）
B. 权限：注册开关的读 / 写都要 user:update（未登录 401，无权限用户 403）
C. 开启：PUT 后公开接口立刻变 true，管理端 fromEnv 变 false（改由页面控制）
D. **零权限**：新注册账号能登录，但 roles/perms 全空，且访问任何受权限保护的接口都是 403
E. 关闭：PUT false 后公开接口变 false，再注册被 403 **明确拒绝**；已注册账号仍能登录
F. 参数校验：allow 缺失 / 类型不对 → 400（用 *bool 区分「没传」与「显式 false」）
G. 清理：删除测试账号、开关恢复基线

安全 / 副作用
-------------
⚠️ 本脚本会**临时开启公开注册并创建两个测试账号**，结束时在 finally 里删除账号、把开关恢复
   基线值。**不要指向生产环境**（默认只连 localhost:10001）。

用法
----
    python scripts/verify_register_switch.py
    OPHUB_BASE=http://localhost:10001/api python scripts/verify_register_switch.py
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
TIMEOUT = int(os.environ.get("OPHUB_TIMEOUT", "60"))

STAMP = str(int(time.time()))
NEW_USER = "e2ereg" + STAMP          # D 组：开注册时创建
NEW_USER2 = "e2ereg" + STAMP + "b"   # E 组：关注册时尝试创建（应被拒）
NEW_PASS = "E2eReg#2026"

results = []  # (name, ok, detail)


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


def admin_login():
    st, j, raw = call("POST", "/auth/login", body={"username": USER, "password": PASS})
    tok = ((j or {}).get("data") or {}).get("token") if isinstance(j, dict) else None
    if st != 200 or not tok:
        print(f"登录失败（HTTP {st}）：{raw[:300]}")
        sys.exit(2)
    print(f"已登录 {USER}（OPHUB_BASE={BASE}）")
    return tok


# ---------------------------------------------------------------------------
# 开关读写
# ---------------------------------------------------------------------------

def public_allow():
    """公开接口：是否开放注册"""
    st, j, _ = call("GET", "/auth/register-allow")
    return st, bool(d((st, j, None)).get("allow"))


def admin_allow(tok):
    """管理端：{allow, fromEnv}"""
    st, j, _ = call("GET", "/system/register-allow", token=tok)
    return st, d((st, j, None))


def put_allow(tok, allow):
    return call("PUT", "/system/register-allow", token=tok, body={"allow": allow})


def do_register(username):
    return call(
        "POST",
        "/auth/register",
        body={"username": username, "password": NEW_PASS, "nickname": "E2E 注册测试"},
    )


def main():
    tok = admin_login()

    # ---------- A. 基线 ----------
    st0, allow0 = public_allow()
    st_a2, a0 = admin_allow(tok)
    base_allow = bool(a0.get("allow"))
    base_from_env = bool(a0.get("fromEnv"))
    check("A1 公开接口可匿名访问（登录页要能在未登录时判断）", st0 == 200, f"HTTP {st0}")
    check("A2 管理端读到开关", st_a2 == 200 and "allow" in a0, json.dumps(a0, ensure_ascii=False))
    if base_from_env:
        check(
            "A3 未在页面上配置过 → fromEnv=true（当前值回落环境变量）",
            True,
            f"allow={base_allow}",
        )
    else:
        info(
            f"A3 跳过 fromEnv 断言：DB 已有配置记录（allow={base_allow}, fromEnv=false）。"
            "本脚本结束时会写回同值，所以第二次起必然如此 —— 首次运行时应为 true"
        )
    check(
        "A4 公开接口与管理端口径一致（两处不能各说各话）",
        allow0 == base_allow,
        f"public={allow0} admin={base_allow}",
    )

    created = []  # 待清理的账号 (id, username)

    try:
        # ---------- B. 权限 ----------
        st, _, _ = call("PUT", "/system/register-allow", body={"allow": True})
        check("B1 未登录改开关 → 401", st == 401, f"HTTP {st}")
        st, _, _ = call("GET", "/system/register-allow")
        check("B2 未登录读管理端开关 → 401", st == 401, f"HTTP {st}")

        # ---------- C. 开启 ----------
        st, j, raw = put_allow(tok, True)
        check("C1 开启注册成功", st == 200 and bool(d((st, j, raw)).get("allow")), f"HTTP {st} {raw[:120]}")
        st, pub = public_allow()
        check("C2 公开接口**立即**变 true（不用重启后端）", pub is True, f"allow={pub}")
        _, a1 = admin_allow(tok)
        check(
            "C3 管理端 fromEnv 变 false（改由页面开关控制）",
            bool(a1.get("fromEnv")) is False,
            json.dumps(a1, ensure_ascii=False),
        )

        # ---------- D. 注册 + 零权限 ----------
        st, j, raw = do_register(NEW_USER)
        uid = int(d((st, j, raw)).get("id") or 0)
        check("D1 开启后可以注册", st == 200 and uid > 0, f"HTTP {st} id={uid} {raw[:120]}")
        if uid:
            created.append(uid)

        st, j, raw = call("POST", "/auth/login", body={"username": NEW_USER, "password": NEW_PASS})
        ntok = ((j or {}).get("data") or {}).get("token") if isinstance(j, dict) else None
        check("D2 新账号可以登录（注册被允许，不是账号被禁）", st == 200 and bool(ntok), f"HTTP {st}")

        if ntok:
            st, j, raw = call("GET", "/auth/me", token=ntok)
            me = d((st, j, raw))
            roles = me.get("roles") or []
            perms = me.get("perms") or []
            check("D3 **新账号角色为空**（不绑 member）", roles == [], f"roles={json.dumps(roles, ensure_ascii=False)}")
            check("D4 **新账号权限为空**（零权限）", perms == [], f"perms={json.dumps(perms, ensure_ascii=False)}")

            st, _, _ = call("GET", "/users", token=ntok)
            check("D5 零权限账号访问用户列表 → 403", st == 403, f"HTTP {st}")
            st, _, _ = call("GET", "/prom/hidden", token=ntok)
            check("D6 零权限账号访问被屏蔽目标 → 403", st == 403, f"HTTP {st}")
            st, _, _ = call("GET", "/system/register-allow", token=ntok)
            check("D7 零权限账号读注册开关 → 403（含写权限的读也不行）", st == 403, f"HTTP {st}")
            st, _, _ = call("PUT", "/system/register-allow", token=ntok, body={"allow": True})
            check("D8 零权限账号改注册开关 → 403", st == 403, f"HTTP {st}")
            st, _, _ = call("GET", "/assets", token=ntok)
            check("D9 零权限账号访问资产列表 → 403", st == 403, f"HTTP {st}")

        st, _, raw = do_register(NEW_USER)
        check("D10 重名注册 → 400", st == 400, f"HTTP {st} {raw[:120]}")

        # ---------- E. 关闭 ----------
        st, _, _ = put_allow(tok, False)
        check("E1 关闭注册成功", st == 200, f"HTTP {st}")
        _, pub = public_allow()
        check("E2 公开接口**立即**变 false", pub is False, f"allow={pub}")
        st, _, raw = do_register(NEW_USER2)
        check("E3 关闭后注册 → 403（明确拒绝，不是静默失败）", st == 403, f"HTTP {st}")
        check(
            "E4 关闭提示引导到「页面开关」而不是「改环境变量并重启」",
            "注册设置" in raw and "重启后端" not in raw,
            raw[:170],
        )
        st, j, _ = call("POST", "/auth/login", body={"username": NEW_USER, "password": NEW_PASS})
        check(
            "E5 已注册账号仍能登录（关的是注册入口，不是已有账号）",
            st == 200,
            f"HTTP {st}",
        )

        # ---------- F. 参数校验 ----------
        st, _, _ = call("PUT", "/system/register-allow", token=tok, body={})
        check("F1 缺 allow 字段 → 400", st == 400, f"HTTP {st}")
        st, _, _ = call("PUT", "/system/register-allow", token=tok, body={"allow": None})
        check("F2 allow=null → 400", st == 400, f"HTTP {st}")
        st, _, _ = call("PUT", "/system/register-allow", token=tok, body={"allow": "yes"})
        check("F3 allow 类型不对（字符串）→ 400", st == 400, f"HTTP {st}")
        st, _, _ = call("PUT", "/system/register-allow", token=tok, body={"allow": False})
        check("F4 显式传 false 必须被接受（*bool 区分「没传」与「显式 false」）", st == 200, f"HTTP {st}")

    finally:
        # ---------- G. 清理 ----------
        for uid in created:
            st, _, raw = call("DELETE", f"/users/{uid}", token=tok)
            check(f"G 清理测试账号 id={uid}", st in (200, 404), f"HTTP {st} {raw[:80]}")
        st, j, raw = put_allow(tok, base_allow)
        _, pub = public_allow()
        check(
            f"G 开关已恢复基线 allow={base_allow}",
            st == 200 and pub == base_allow,
            f"HTTP {st} public={pub}",
        )
        if base_from_env:
            info("基线值原本来自环境变量；清理后 DB 里留下了一条同值记录（行为等价，仅 fromEnv 变 false）")

    print()
    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"=== {passed} PASS / {failed} FAIL ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
