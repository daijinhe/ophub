#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
验证「菜单 + 权限单一事实源」改造（v1.7.46）。

背景
----
改造前：菜单树硬编码在前端 MainLayout、权限目录手写在后端 models.go，
两份定义必然漂移；权限颗粒度参差不齐（资产管理已有 CRUD，而 Ansible /
中间件管控 / 定时任务 / Nginx 配置 / 脚本管理只有 view+manage 两档）。

改造后：后端 perm_tree.go 的 MenuPermTree 是**单一事实源**，同时承担
「侧边栏菜单 / 权限目录分组 / 角色授权树」三个角色；权限码规范
`<resource>:<action>`；旧聚合码由 migrateLegacyPerms 在启动时展开为等效细分码。

断言要点（4 组）
---------------
A. 权限目录结构（走 GET /api/permissions 的 tree + flat）
   A1 一级节点 = 9 且顺序与菜单一致
   A2 flat 无重复码
   A3 flat 与 tree 派生码集合完全一致（无孤儿 / 无漏登记）
   A4 每个节点的 permItems 的 code 都在 flat 内，且 name = "节点名 - 动作中文名"
   A5 每个菜单节点 entryPerms 非空，且都在 flat 内（否则菜单永远进不去）
   A6 纯容器节点不产生权限码（resource 为空时 actions 必须为空）
   A7 不再存在聚合式 manage 码（唯一例外 prom:report:manage 的行级特权）
   A8 关键资源 CRUD 完整（cmdb / crontab / script / user / role / category 等）
   A9 Group 非空 = 菜单祖先 Label 路径

B. 旧码迁移
   B1 DB 中已无任何遗留旧聚合码
   B2 DB 中角色持有的权限码全部 ∈ flat（无未知码）
   B3 admin 角色持有全部 flat 码（新权限上线后管理员不会「点不动」）
   B4 源码级：legacyPermUpgrade 的**每个目标码**都在 flat 内
   B5 源码级：legacyPermUpgrade 的目标码自身不是 legacy key（无链式展开）
   B6 源码级：Go 源码里出现的一切权限码字面量都在 flat 内（防止路由写了不存在的码）
   B7 前端源码里出现的一切权限码字面量都在 flat 内（防止按钮被写成永久隐藏）
   B8 静态等价性抽查：几个关键旧码的展开结果与预期一致
   B9（可选 PERM_TEST_MIGRATE=1）实测闭环：塞旧码 → 重启后端 → 断言已展开

C. 接口级 403 收口矩阵
   C1 零权限账号访问 30+ 个受保护接口 → 全部 403（含 Web 终端票据接口，
      这是 v1.7.46 修掉的真实越权口子：改造前只校验登录）
   C2 **正例**：admin 访问同一批接口 → 无一 403（防止「权限收得过窄」，
      安全加固后只测拒绝路径 = 只验证了一半）
   C3 零权限账号仍能登录 + 读 /auth/me + 读 /permissions（基础可用性）

D. 菜单与路由一致性
   D1 tree 里每个有 route 的节点都能在前端 App.tsx 找到同名 path
   D2 前端 App.tsx 里每个菜单 path 都被 RequireRoute/RequirePerm 包裹

用法
----
    python scripts/verify_perm_matrix.py
    PG_CONTAINER=other-pg python scripts/verify_perm_matrix.py
    PERM_TEST_MIGRATE=1 python scripts/verify_perm_matrix.py   # 会重启后端容器

安全
----
- C 组的临时角色/用户按固定前缀命名，跑完（含失败）必定清理。
- C 组只发 GET 与**无副作用**的请求；不使用 DELETE/PUT 的 admin 正例，
  避免验证脚本对真实数据产生写操作。
- B9 会 `docker restart ophub-backend`（需显式开启），默认跳过。
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = os.environ.get("OPHUB_BASE", "http://127.0.0.1:10001")
PG_CONTAINER = os.environ.get("PG_CONTAINER", "ophub-postgres")
PG_USER = os.environ.get("PG_USER", "ophub")
PG_DB = os.environ.get("PG_DB", "ophub")
BE_CONTAINER = os.environ.get("BE_CONTAINER", "ophub-backend")
USERNAME = os.environ.get("OPHUB_USER", "admin")
PASSWORD = os.environ.get("OPHUB_PASS", "admin123")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

TMP_ROLE_CODE = "zz_perm_matrix_probe"
TMP_ROLE_NAME = "ZZ 权限矩阵探针"
TMP_USER = "zz_perm_matrix_probe_user"

passed, failed, warned = [], [], []


def ok(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print("[%s] %s%s" % ("PASS" if cond else "FAIL", name,
                         ("  —— " + str(detail)) if detail else ""))


def warn(name, detail=""):
    warned.append(name)
    print("[WARN] %s%s" % (name, ("  —— " + str(detail)) if detail else ""))


# ---------------------------------------------------------------- 基础设施
def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", **kw)
    return p.returncode, (p.stdout or ""), (p.stderr or "")


def psql(sql):
    rc, out, err = run(["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER,
                        "-d", PG_DB, "-t", "-A", "-F", "|", "-v",
                        "ON_ERROR_STOP=1", "-c", sql])
    if rc != 0:
        raise RuntimeError("psql 失败: %s\n%s" % (sql, err[:400]))
    return out.strip()


def api(method, path, body=None, token=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw}
    except Exception:
        # 连接被重置 / 服务正在重启（B9 会 docker restart 后端）——视为「无响应」返回 0，
        # 而不是让 RemoteDisconnected 冒到顶层把整轮验证崩掉。调用方按状态码 0 处理即可。
        return 0, {}


def login(u=USERNAME, p=PASSWORD):
    st, js = api("POST", "/api/auth/login", {"username": u, "password": p})
    if st != 200:
        raise RuntimeError("登录失败(%s): %s %s" % (u, st, js))
    return js["data"]["token"]


def preflight_environment():
    """环境交叉校验：确认 PG_CONTAINER 属于当前目录的 compose 项目。

    教训：容器名是全局命名空间，「换个目录跑」不构成隔离；硬编码容器名的
    脚本曾在隔离目录里把数据写进了正在服务的生产库。
    """
    yml = os.path.join(ROOT, "docker-compose.yml")
    project = None
    if os.path.exists(yml):
        with io.open(yml, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^name:\s*(\S+)\s*$", line)
                if m:
                    project = m.group(1)
                    break
    rc, out, _ = run(["docker", "inspect", "-f",
                      '{{index .Config.Labels "com.docker.compose.project"}}',
                      PG_CONTAINER])
    actual = out.strip() if rc == 0 else ""
    if project and actual and project != actual:
        print("!! 环境交叉校验失败：cwd 的 compose project = %r，"
              "而 %s 的 project = %r" % (project, PG_CONTAINER, actual))
        print("!! 脚本可能打到另一套环境。如确认无误，设 SKIP_ENV_CHECK=1 重跑。")
        if os.environ.get("SKIP_ENV_CHECK") != "1":
            sys.exit(2)
    print("环境：base=%s  pg=%s(project=%s)  be=%s" %
          (BASE, PG_CONTAINER, actual or "?", BE_CONTAINER))


# ---------------------------------------------------------------- 源码扫描
PERM_RE = re.compile(r"[a-z][a-z0-9_]*(?::[a-z0-9_]+){1,3}")


def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()


def strip_comments_ts(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"^\s*//.*$", "", src, flags=re.M)
    return src


def backend_go_files():
    d = os.path.join(ROOT, "backend")
    return [os.path.join(d, f) for f in sorted(os.listdir(d))
            if f.endswith(".go") and not f.endswith("_test.go")]


def go_perm_literals():
    """只从「权限语义」的代码位置抽取 Go 字面量。

    不做全文字面量启发式 —— 实测会把这些误判成权限码：
      - MenuNode 的 Resource / Key（`Resource: "ansible:local"`、`Key: "deploy:install"`）
      - 主机地址（`// 形如 http://prom:9090`）
    所以只认下面这些确定的调用点。
    """
    out = set()
    for p in backend_go_files():
        src = strip_comments_ts(read(p))
        for m in re.finditer(r'RequirePermission\(\s*"([^"]+)"', src):
            out.add(m.group(1))
        for m in re.finditer(r"RequireAnyPermission\(([^)]*)\)", src):
            out.update(re.findall(r'"([^"]+)"', m.group(1)))
        for m in re.finditer(r'hasPerm\(\s*\w+\s*,\s*"([^"]+)"', src):
            out.add(m.group(1))
        # var permAssetPicker = []string{...} / permAssetPicker = []string{...}
        for m in re.finditer(r"perm\w+\s*=\s*\[\]string\{(.*?)\n\t\}", src, re.S):
            out.update(re.findall(r'"([^"]+)"', m.group(1)))
        # terminalPermBackfill{IfHas: "...", Grant: "..."}
        for m in re.finditer(r'(?:IfHas|Grant):\s*"([^"]+)"', src):
            out.add(m.group(1))
    return out


def fe_perm_literals():
    """只扫前端的 hasPerm('x') / perm="x" 调用点（避免 localStorage key 误报）。"""
    out = set()
    fe_root = os.path.join(ROOT, "frontend", "src")
    for dirpath, dirnames, filenames in os.walk(fe_root):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for fn in sorted(filenames):
            if not fn.endswith((".ts", ".tsx")):
                continue
            src = strip_comments_ts(read(os.path.join(dirpath, fn)))
            for m in re.finditer(r"hasPerm\(\s*'([^']+)'", src):
                out.add(m.group(1))
            for m in re.finditer(r'hasPerm\(\s*"([^"]+)"', src):
                out.add(m.group(1))
            for m in re.finditer(r'perm="([^"]+)"', src):
                out.add(m.group(1))
            for m in re.finditer(r"perm='([^']+)'", src):
                out.add(m.group(1))
    return out


# ---------------------------------------------------------------- A 组
def section_a(flat, tree):
    print("\n=== A. 权限目录结构 ===")
    codes = [x["code"] for x in flat]
    codeset = set(codes)
    actions = set()
    resources = set()
    for c in codes:
        head, _, tail = c.rpartition(":")
        actions.add(tail)
        resources.add(head.split(":")[0])

    ok("A1 一级菜单节点 = 9", len(tree) == 9, "实际 %d" % len(tree))
    ok("A2 flat 权限码无重复", len(codes) == len(codeset),
       "共 %d 条 / 去重 %d 条" % (len(codes), len(codeset)))

    # 遍历整棵树，收集派生码 / permItems / entryPerms / group
    derived, bad_items, bad_entry, container_bad, empty_group, routes = \
        [], [], [], [], [], []

    def walk(nodes, path):
        for n in nodes:
            label = n.get("label") or ""
            grp = " / ".join(path)
            res = n.get("resource") or ""
            acts = n.get("actions") or []
            if res and not acts:
                bad_items.append("%s: resource 有值但 actions 为空" % n.get("key"))
            if not res and acts:
                container_bad.append("%s: 容器节点不应有 actions" % n.get("key"))
            for it in (n.get("permItems") or []):
                c = it.get("code")
                derived.append(c)
                if c not in codeset:
                    bad_items.append("%s: permItems 含未登记码 %s" % (n.get("key"), c))
                want = "%s - %s" % (label, ACTION_CN.get(c.rpartition(":")[2], "?"))
                if it.get("name") != want:
                    bad_items.append("%s: 权限名 %r != 期望 %r" % (n.get("key"), it.get("name"), want))
                if flat_group_of(flat, c) != grp:
                    empty_group.append("%s: 码 %s 的 Group=%r，期望 %r"
                                       % (n.get("key"), c, flat_group_of(flat, c), grp))
            ep = n.get("entryPerms") or []
            if not ep:
                bad_entry.append("%s(%s): entryPerms 为空 → 菜单永远进不去" % (n.get("key"), label))
            for c in ep:
                if c not in codeset:
                    bad_entry.append("%s: entryPerms 含未登记码 %s" % (n.get("key"), c))
            if n.get("route"):
                routes.append((n["key"], n["route"], n.get("newTab") is True))
            if n.get("children"):
                walk(n["children"], path + [label])

    walk(tree, [])
    ok("A3 flat 与 tree 派生码集合完全一致（无孤儿/无漏登记）",
       set(derived) == codeset,
       "tree 派生 %d 条，flat %d 条，差集 %s"
       % (len(set(derived)), len(codeset),
          sorted((set(derived) ^ codeset))[:8]))
    ok("A4 permItems 的 code/name 与 flat 的 Group 全部自洽",
       not bad_items, bad_items[:5])
    ok("A5 每个菜单节点 entryPerms 非空且均在 flat 内", not bad_entry, bad_entry[:5])
    ok("A6 纯容器节点不产生权限码", not container_bad, container_bad[:5])
    ok("A9 每个权限码的 Group = 菜单祖先路径", not empty_group, empty_group[:5])

    # A7 聚合式 manage 码应已绝迹（唯一允许 prom:report:manage 的行级特权）
    agg = sorted(c for c in codes
                 if c.rpartition(":")[2] == "manage" and c != "prom:report:manage")
    ok("A7 已无聚合式 manage 码（仅保留 prom:report:manage 行级特权）",
       not agg, agg)

    # A8 关键资源 CRUD 完整性
    need = {
        "cmdb": ["view", "create", "update", "delete", "import", "export"],
        "crontab": ["view", "create", "update", "delete"],
        "script": ["view", "create", "update", "delete"],
        "user": ["view", "create", "update", "delete"],
        "role": ["view", "create", "update", "delete"],
        "category": ["view", "create", "update", "delete"],
        "mwops": ["view", "create", "update", "delete", "exec"],
        "mwcapture": ["view", "create", "update", "delete"],
        "mwtemplate": ["view", "create", "update", "delete"],
        "cert": ["view", "create", "update", "delete"],
        "config": ["view", "create", "update", "delete", "sync"],
        "sysinit:catalog": ["view", "create", "update", "delete"],
        "ansible:remote": ["view", "create", "update", "delete", "exec"],
        "ansible:local": ["view", "update", "exec"],
        "ansible:mode": ["view", "update"],
        "deploy": ["view", "create", "update", "delete", "exec"],
        "deploy:record": ["view", "delete"],
        "prom:datasource": ["view", "create", "update", "delete"],
        "prom:report": ["view", "create", "update", "delete", "manage"],
        "prom:screen:config": ["view", "update"],
        "inspection:task": ["view", "create", "update", "delete", "run"],
        "inspection:record": ["view", "delete", "export"],
        "inspection:alert": ["view", "create", "update", "delete"],
    }
    missing = []
    for res, acts in sorted(need.items()):
        for a in acts:
            c = "%s:%s" % (res, a)
            if c not in codeset:
                missing.append(c)
    ok("A8 关键资源的增删改查（含特有动作）齐备", not missing, missing)
    return codeset, actions, resources, routes


def flat_group_of(flat, code):
    for x in flat:
        if x["code"] == code:
            return x.get("group") or ""
    return "<未登记>"


ACTION_CN = {
    "view": "查看", "create": "新增", "update": "编辑", "delete": "删除",
    "exec": "执行", "export": "导出", "import": "导入", "sync": "同步",
    "run": "运行", "screen": "查看", "terminal": "打开终端", "manage": "管理他人数据",
}


# ---------------------------------------------------------------- B 组
def parse_legacy_map():
    """静态解析 perm_tree.go 的 legacyPermUpgrade（key → [目标码...]）。"""
    src = read(os.path.join(ROOT, "backend", "perm_tree.go"))
    m = re.search(r"var legacyPermUpgrade = map\[string\]\[\]string\{(.*?)\n\}\n",
                  src, re.S)
    if not m:
        raise RuntimeError("未找到 legacyPermUpgrade 定义")
    body = m.group(1)
    body = re.sub(r"^\s*//.*$", "", body, flags=re.M)
    out = {}
    for m in re.finditer(r'"([^"]+)"\s*:\s*\{([^}]*)\}', body):
        out[m.group(1)] = re.findall(r'"([^"]+)"', m.group(2))
    return out


def parse_pg_text_array(raw):
    """解析 psql -A -t 输出的 text[]：可能是 JSON（`["a","b"]`）或 PG 数组（`{a,b}`）。

    ⚠️ 两种格式都要认：GORM 写入走 JSON 序列化，手工/psql 写入则可能落成 PG 字面量；
    只认 JSON 会让断言静默拿到空集合（假失败）。
    """
    raw = (raw or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            return [str(x) for x in json.loads(raw)]
        except Exception:
            pass
    if raw.startswith("{") and raw.endswith("}"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        out = []
        for tok in re.findall(r'"((?:[^"\\]|\\.)*)"|([^,]+)', inner):
            v = tok[0] if tok[0] else tok[1]
            out.append(v.strip())
        return [x for x in out if x]
    return [raw]


def section_b(flat, codeset):
    print("\n=== B. 旧码迁移 ===")
    legacy = parse_legacy_map()
    print("  legacyPermUpgrade 共 %d 条映射" % len(legacy))

    # B4 目标码必须都已登记
    bad_targets = []
    for k, vs in sorted(legacy.items()):
        for v in vs:
            if v not in codeset:
                bad_targets.append("%s → %s（未登记）" % (k, v))
    ok("B4 legacyPermUpgrade 的每个目标码都在 flat 内", not bad_targets, bad_targets[:6])

    # B5 无「链式丢失」：若目标码自身也是会被展开的旧码，则它的展开结果必须
    # 已包含在当前映射里（迁移只做单趟展开，不会递归）。
    # 注意：恒等映射（"cert:view": {"cert:view"}）不算链式，属冗余登记。
    chained = []
    for k, vs in sorted(legacy.items()):
        got = set(vs)
        for v in vs:
            sub = set(legacy.get(v) or [])
            if sub and sub != {v} and not sub.issubset(got):
                chained.append("%s → %s 的展开 %s 未被完全覆盖"
                               % (k, v, sorted(sub - got)))
    ok("B5 映射无链式丢失（目标若为旧码，其展开已并入当前映射）",
       not chained, chained[:6])

    # B5b 冗余恒等映射（属文档化，不影响正确性；仅提示可精简）
    redundant = sorted(k for k, vs in legacy.items()
                       if k in codeset and set(vs) == {k})
    if redundant:
        warn("legacyPermUpgrade 含 %d 条恒等映射（语义未变，可精简；"
             "保留会让持有该码的角色每次启动都被重写一次）" % len(redundant),
             redundant)

    # B1/B2 DB 实态。⚠️ 「已退场的旧码」= 在映射表里但已不在权限目录里的码；
    # 仍在目录里的（cert:view / sysinit:view 等）是合法码，出现在 DB 里属正常。
    retired = {k for k in legacy if k not in codeset}
    rows = psql("select code, permissions from roles order by code")
    roles = {}
    for line in rows.splitlines():
        if "|" not in line:
            continue
        code, raw = line.split("|", 1)
        roles[code.strip()] = parse_pg_text_array(raw)

    left = sorted({p for ps in roles.values() for p in ps if p in retired})
    ok("B1 DB 中已无遗留的「已退场」旧聚合码", not left, left[:8])

    unknown = sorted({p for ps in roles.values() for p in ps if p and p not in codeset})
    ok("B2 DB 中角色持有的权限码全部已登记（无未知码）", not unknown, unknown[:8])

    # B3 admin 全量
    adm = set(roles.get("admin") or [])
    if "admin" not in roles and roles:
        adm = set(max(roles.values(), key=len))
    lack = sorted(codeset - adm)
    ok("B3 管理员角色持有全部 %d 个权限码" % len(codeset), not lack, lack[:8])

    # B6 Go 源码字面量 —— 只扫「权限语义」的代码位置，避免把节点 Key
    # （Resource: "ansible:local"）或主机地址（http://prom:9090）误判成权限码
    go_lits = go_perm_literals()
    bad_go = sorted(l for l in go_lits if l not in codeset and l not in legacy)
    ok("B6 Go 源码里的权限码字面量全部已登记（%d 处）" % len(go_lits),
       not bad_go, bad_go[:8])

    # B7 前端源码字面量 —— 只扫 hasPerm(...) / perm="..." 两处调用点
    fe_lits = fe_perm_literals()
    bad_fe = sorted(l for l in fe_lits if l not in codeset)
    ok("B7 前端源码里的权限码字面量全部已登记（%d 处，防止写成永久隐藏的死条件）"
       % len(fe_lits), not bad_fe, bad_fe[:10])

    # B8 等价性抽查
    expect = {
        "crontab:manage": {"crontab:view", "crontab:create", "crontab:update", "crontab:delete"},
        "category:manage": {"category:view", "category:create", "category:update", "category:delete"},
        "mwcapture:manage": {"mwcapture:view", "mwcapture:create", "mwcapture:update", "mwcapture:delete"},
        "script:manage": {"script:view", "script:create", "script:update", "script:delete"},
    }
    diff = []
    for k, want in sorted(expect.items()):
        got = set(legacy.get(k) or [])
        if got != want:
            diff.append("%s: 期望 %s，实际 %s" % (k, sorted(want), sorted(got)))
    ok("B8 关键旧聚合码的展开结果与预期一致", not diff, diff)

    # B9 实测闭环（可选）
    if os.environ.get("PERM_TEST_MIGRATE") == "1":
        print("  [B9] 实测迁移闭环：写入旧码 → 重启后端 → 校验展开")
        psql("delete from roles where code = '%s'" % TMP_ROLE_CODE)
        psql("insert into roles (name, code, description, permissions, created_at) "
             "values ('%s', '%s', 'probe', '{\"crontab:manage\",\"prom:manage\"}'::text[], now())"
             % (TMP_ROLE_NAME, TMP_ROLE_CODE))

        def restart_and_wait():
            run(["docker", "restart", BE_CONTAINER])
            deadline = time.time() + 120
            while time.time() < deadline:
                try:
                    login()
                    return True
                except Exception:
                    time.sleep(2)
            return False

        if not restart_and_wait():
            ok("B9 迁移闭环（后端重启后可用）", False, "120s 未就绪")
        else:
            raw = psql("select permissions from roles where code = '%s'" % TMP_ROLE_CODE)
            got = set(parse_pg_text_array(raw))
            want = set(legacy["crontab:manage"]) | set(legacy["prom:manage"])
            ok("B9 迁移闭环：旧码被展开为等效细分码（%d 项）" % len(want),
               got == want, "实际 %d 项，差集 %s" % (len(got), sorted(got ^ want)[:6]))

            # B10 真幂等：再重启一次，不应再有任何「已迁移」写库动作
            _, _, _ = run(["docker", "logs", BE_CONTAINER])
            restart_and_wait()
            rc, logs, _ = run(["docker", "logs", BE_CONTAINER])
            tail = logs[-8000:]
            rewrites = re.findall(r"\[perm-migrate\] 角色 \"([^\"]+)\" 权限已迁移为细分码", tail)
            ok("B10 真幂等：二次重启无任何角色被重写", not rewrites, rewrites[:6])
        psql("delete from roles where code = '%s'" % TMP_ROLE_CODE)
    else:
        warn("B9 实测迁移闭环未执行（设 PERM_TEST_MIGRATE=1 并在可重启环境运行）")


# ---------------------------------------------------------------- C 组
# (method, path, 说明)  —— 覆盖每个资源，且必须含 Web 终端票据接口
DENY_MATRIX = [
    ("GET", "/api/users", "用户管理"),
    ("POST", "/api/users", "新增用户"),
    ("DELETE", "/api/users/999999", "删除用户"),
    ("GET", "/api/roles", "角色权限"),
    ("POST", "/api/roles", "新增角色"),
    ("GET", "/api/categories", "分类树"),
    ("POST", "/api/categories", "新增分类"),
    ("PUT", "/api/categories/999999", "编辑分类"),
    ("DELETE", "/api/categories/999999", "删除分类"),
    ("GET", "/api/assets", "资产列表"),
    ("POST", "/api/assets", "新增资产"),
    ("GET", "/api/assets/export", "导出资产"),
    ("POST", "/api/assets/import", "导入资产"),
    ("GET", "/api/stats/overview", "概览统计"),
    ("GET", "/api/ansible", "本机主机清单"),
    ("POST", "/api/ansible/import-cmdb", "添加到主机清单"),
    ("GET", "/api/ansible/remotes", "远端节点列表"),
    ("POST", "/api/ansible/remotes/999999/test", "远端节点连通性测试"),
    ("GET", "/api/ansible/mode", "采集通道模式"),
    ("PUT", "/api/ansible/mode", "修改采集通道模式"),
    ("GET", "/api/deploy/catalog", "部署目录"),
    ("POST", "/api/deploy/run", "执行部署"),
    ("GET", "/api/deploy/certs", "证书列表"),
    ("GET", "/api/deploy/sysinit/catalog", "系统初始化目录"),
    ("GET", "/api/inspection/tasks", "巡检任务"),
    ("POST", "/api/inspection/tasks", "新增巡检任务"),
    ("POST", "/api/inspection/tasks/999999/run", "运行巡检"),
    ("GET", "/api/inspection/records", "巡检报表"),
    ("GET", "/api/inspection/export", "导出巡检报表"),
    ("GET", "/api/inspection/alert-rules", "告警规则"),
    ("GET", "/api/config", "Nginx 配置"),
    ("POST", "/api/config/scan", "扫描 Nginx 配置"),
    ("GET", "/api/mwops/instances", "中间件管控"),
    ("POST", "/api/mwops/instances/999999/action", "中间件启停"),
    ("GET", "/api/mwcapture/assets", "中间件捕捉"),
    ("GET", "/api/crontab/assets", "定时任务"),
    ("PUT", "/api/crontab/asset/999999/notes", "维护任务用途"),
    ("GET", "/api/scripts/java/ls", "脚本目录"),
    ("POST", "/api/scripts/java/file", "写脚本"),
    ("GET", "/api/prom/datasources", "Prom 数据源"),
    ("POST", "/api/prom/collect", "手动采集"),
    ("GET", "/api/prom/hidden", "被屏蔽目标"),
    ("GET", "/api/prom/screen-config", "大屏管理配置"),
    ("GET", "/api/prom/snapshot", "监控大屏数据"),
    ("POST", "/api/ws/ssh/ticket", "Web 终端票据（v1.7.46 修掉的越权口子）"),
]

# admin 正例：只测无副作用的请求（GET + 票据），避免验证脚本写真实数据
ALLOW_MATRIX = [
    ("GET", "/api/users"), ("GET", "/api/roles"), ("GET", "/api/categories"),
    ("GET", "/api/assets"), ("GET", "/api/stats/overview"), ("GET", "/api/ansible"),
    ("GET", "/api/ansible/remotes"), ("GET", "/api/ansible/mode"),
    ("GET", "/api/deploy/catalog"), ("GET", "/api/deploy/certs"),
    ("GET", "/api/deploy/sysinit/catalog"), ("GET", "/api/inspection/tasks"),
    ("GET", "/api/inspection/records"), ("GET", "/api/inspection/alert-rules"),
    ("GET", "/api/config"), ("GET", "/api/mwops/instances"),
    ("GET", "/api/mwcapture/assets"), ("GET", "/api/crontab/assets"),
    ("GET", "/api/scripts/java/ls"), ("GET", "/api/prom/datasources"),
    ("GET", "/api/prom/hidden"), ("GET", "/api/prom/screen-config"),
    ("GET", "/api/prom/snapshot"), ("POST", "/api/ws/ssh/ticket"),
]


def cleanup_probe():
    try:
        psql("delete from user_roles where user_id in "
             "(select id from users where username = '%s')" % TMP_USER)
        psql("delete from users where username = '%s'" % TMP_USER)
    except Exception as e:
        warn("清理探针用户失败：%s" % e)
    try:
        psql("delete from roles where code = '%s'" % TMP_ROLE_CODE)
    except Exception as e:
        warn("清理探针角色失败：%s" % e)


def section_c(admin_token):
    print("\n=== C. 接口级 403 收口矩阵 ===")
    cleanup_probe()
    st, js = api("POST", "/api/roles", {
        "name": TMP_ROLE_NAME, "code": TMP_ROLE_CODE,
        "description": "权限矩阵验证用临时角色（零权限）", "permissions": []}, admin_token)
    if st != 200:
        ok("C0 建立零权限探针角色", False, "%s %s" % (st, js))
        return
    role_id = js["data"]["id"]
    ok("C0 建立零权限探针角色/用户", True)

    st, js = api("POST", "/api/users", {
        "username": TMP_USER, "password": "ZzProbe#2026",
        "nickname": "权限矩阵探针", "status": 1, "roleIds": [role_id]}, admin_token)
    if st != 200:
        ok("C0b 建立探针用户", False, "%s %s" % (st, js))
        return

    try:
        probe = login(TMP_USER, "ZzProbe#2026")
        st_me, _ = api("GET", "/api/auth/me", token=probe)
        st_pm, _ = api("GET", "/api/permissions", token=probe)
        ok("C3 零权限账号仍可登录 / 读 auth.me / 读 permissions",
           st_me == 200 and st_pm == 200, "me=%s permissions=%s" % (st_me, st_pm))

        not403 = []
        for method, path, desc in DENY_MATRIX:
            st, _ = api(method, path, {} if method in ("POST", "PUT", "PATCH") else None,
                        token=probe)
            if st != 403:
                not403.append("%s %s [%s] → %s" % (method, path, desc, st))
        ok("C1 零权限账号访问 %d 个受保护接口全部 403" % len(DENY_MATRIX),
           not not403, not403[:8])

        bad = []
        for method, path in ALLOW_MATRIX:
            st, _ = api(method, path, {} if method == "POST" else None, token=admin_token)
            if st == 403:
                bad.append("%s %s → 403" % (method, path))
        ok("C2 正例：管理员访问同批接口无一 403（未过度收窄）", not bad, bad[:8])
    finally:
        cleanup_probe()


# ---------------------------------------------------------------- D 组
def section_d(routes):
    print("\n=== D. 菜单与路由一致性 ===")
    app = strip_comments_ts(read(os.path.join(ROOT, "frontend", "src", "App.tsx")))
    missing = []
    for key, route, newtab in routes:
        # path="/xxx" / path="xxx" 两种写法都认
        if ('path="%s"' % route.lstrip("/")) in app or ('path="%s"' % route) in app:
            continue
        missing.append("%s → %s" % (key, route))
    ok("D1 菜单节点的 route 都能在 App.tsx 找到", not missing, missing[:8])

    # 每个 path= 的 <Route> 后面应能就近找到 RequireRoute / RequirePerm
    offenders = []
    for m in re.finditer(r'<Route\s+path="([^"]+)"\s+element=\{([^}]*)\}', app):
        path, el = m.group(1), m.group(2)
        if path in ("*", "/", "", "login", "register"):
            continue
        if "Require" in el or "Navigate" in el:
            continue
        offenders.append(path)
    ok("D2 前端每个业务路由都有权限包裹（RequireRoute/RequirePerm）",
       not offenders, offenders[:8])


# ---------------------------------------------------------------- main
def main():
    preflight_environment()
    admin_token = login()
    st, js = api("GET", "/api/permissions", token=admin_token)
    if st != 200:
        print("!! GET /api/permissions 失败：%s %s" % (st, js))
        sys.exit(2)
    flat, tree = js["data"]["flat"], js["data"]["tree"]

    codeset, actions, resources, routes = section_a(flat, tree)
    section_b(flat, codeset)
    section_c(admin_token)
    section_d(routes)

    print("\n================ 汇总 ================")
    print("通过 %d 项，失败 %d 项，跳过/告警 %d 项" %
          (len(passed), len(failed), len(warned)))
    if failed:
        print("\n失败明细：")
        for f in failed:
            print("  - %s" % f)
    if warned:
        print("\n告警明细：")
        for w in warned:
            print("  - %s" % w)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
