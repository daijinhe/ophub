# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# 系统初始化管理 —— 端到端实测脚本
# 覆盖：目录 13 项(带 group) / playbook 列表与校验(命中控制节点真实文件) /
#       自定义项出现在向导 / 内置删除墓碑+恢复 / 启用停用。
# 用法：python verify_sysinit_catalog.py
import json
import sys
import urllib.request

BASE = "http://localhost:10001/api"
USER, PASS = "admin", "admin123"

passed = 0
failed = 0


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"code": e.code, "msg": str(e), "data": None}


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}{('  -> ' + extra) if extra else ''}")
    else:
        failed += 1
        print(f"  FAIL  {name}{('  -> ' + extra) if extra else ''}")


def main():
    print("== 1. 登录 ==")
    r = call("POST", "/auth/login", {"username": USER, "password": PASS})
    tok = r.get("data", {}).get("token") if isinstance(r.get("data"), dict) else None
    check("登录获取 token", bool(tok))
    if not tok:
        print("登录失败，中止"); sys.exit(1)

    print("== 2. 目录列表(13 项 + 分组) ==")
    r = call("GET", "/deploy/sysinit/catalog", token=tok)
    d = r.get("data", {})
    lst = d.get("list", [])
    groups = d.get("groups", [])
    check("目录返回 13 项", len(lst) == 13, f"实际 {len(lst)}")
    check("分组非空", len(groups) > 0, f"groups={groups}")
    builtin = [x for x in lst if not x.get("custom")]
    custom = [x for x in lst if x.get("custom")]
    check("内置项全部带 group", all(x.get("group") for x in builtin), f"内置 {len(builtin)} 个")
    print("       分组清单:", groups)

    print("== 3. 控制节点 playbook 列表 ==")
    r = call("GET", "/deploy/sysinit/catalog/playbooks", token=tok)
    d = r.get("data", {})
    files = d.get("files", [])
    check("playbook 列表非空", len(files) > 0, f"count={d.get('count')}, node={d.get('node')}")
    print("       目录:", d.get("dir"), "| 节点:", d.get("node"))
    a_pb = files[0] if files else "yum-config/yum-config.yml"

    print("== 4. playbook 校验(命中控制节点真实文件) ==")
    r = call("POST", "/deploy/sysinit/catalog/check", {"playbook": a_pb}, token=tok)
    d = r.get("data", {})
    check("校验存在", d.get("exists") is True, f"{a_pb} exists={d.get('exists')}")
    check("头部预览非空", bool(d.get("head")), f"len={len(d.get('head') or '')}")
    # 故意校验一个不存在的
    r2 = call("POST", "/deploy/sysinit/catalog/check", {"playbook": "no-such/no-such.yml"}, token=tok)
    check("不存在的 playbook 报 exists=false", r2.get("data", {}).get("exists") is False)

    print("== 5. 自定义项 + 向导可见 ==")
    key = "verify_custom_test"
    payload = {
        "key": key, "label": "验证自定义项", "group": "基础配置",
        "playbook": a_pb, "desc": "e2e 自动校验", "varMode": "none",
        "osTypes": [], "cpuTypes": [], "orderNo": 99, "enabled": True,
    }
    r = call("POST", "/deploy/sysinit/catalog", payload, token=tok)
    check("自定义项创建成功", r.get("code") == 0, f"code={r.get('code')} msg={r.get('msg')}")
    new_id = (r.get("data") or {}).get("id")
    check("新建项 custom=true", (r.get("data") or {}).get("custom") is True)

    r = call("GET", "/deploy/sysinit/options", token=tok)
    tasks = (r.get("data") or {}).get("tasks", [])
    opt_groups = sorted({t.get("group") for t in tasks})
    check("向导选项含自定义项", any(t.get("key") == key for t in tasks), f"共 {len(tasks)} 项")
    print("       向导分组:", opt_groups)

    print("== 6. 启用/停用切换 ==")
    if new_id:
        r = call("PATCH", f"/deploy/sysinit/catalog/{new_id}/enabled", {"enabled": False}, token=tok)
        check("停用成功", (r.get("data") or {}).get("enabled") is False)
        r = call("PATCH", f"/deploy/sysinit/catalog/{new_id}/enabled", {"enabled": True}, token=tok)
        check("重新启用成功", (r.get("data") or {}).get("enabled") is True)

    print("== 7. 删除自定义项(物理删除) ==")
    if new_id:
        r = call("DELETE", f"/deploy/sysinit/catalog/{new_id}", token=tok)
        check("自定义项硬删除", (r.get("data") or {}).get("deleted") == "hard")
        # 删除后在列表里不应再出现
        r = call("GET", "/deploy/sysinit/catalog", token=tok)
        left = [x for x in (r.get("data") or {}).get("list", []) if x.get("id") == new_id]
        check("硬删除后列表无此行", len(left) == 0)

    print("== 8. 内置项删除墓碑 + 恢复 ==")
    target = next((x for x in builtin if not x.get("custom")), None)
    if target:
        tid = target.get("id")
        tkey = target.get("key")
        r = call("DELETE", f"/deploy/sysinit/catalog/{tid}", token=tok)
        check("内置项走墓碑", (r.get("data") or {}).get("deleted") == "tombstone")
        r = call("GET", "/deploy/sysinit/catalog", token=tok)
        gone = [x for x in (r.get("data") or {}).get("list", []) if x.get("id") == tid]
        check("默认列表不含墓碑项", len(gone) == 0)
        r = call("GET", "/deploy/sysinit/catalog?withDeleted=1", token=tok)
        tomb = [x for x in (r.get("data") or {}).get("list", []) if x.get("id") == tid]
        check("withDeleted 可见墓碑项(deleted=true)", tomb and tomb[0].get("deleted") is True)
        # 恢复
        r = call("POST", "/deploy/sysinit/catalog/sync", {"restore": True}, token=tok)
        check("同步恢复墓碑", (r.get("data") or {}).get("restored", 0) >= 1, f"restored={r.get('data',{}).get('restored')}")
        r = call("GET", "/deploy/sysinit/catalog", token=tok)
        back = [x for x in (r.get("data") or {}).get("list", []) if x.get("id") == tid]
        check("恢复后默认列表重新可见", len(back) == 1)

    print(f"\n结果: PASS={passed}  FAIL={failed}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
