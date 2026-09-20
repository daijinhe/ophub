# -*- coding: utf-8 -*-
"""
定时任务（crontab）端到端回归 —— 自足靶机版，不碰任何真实资产

数据源口径（2026-09-16 收敛）：
  平台**只认一条数据源** —— 在目标机上以归属用户身份执行 `crontab -l`。
  旧口径（/etc/crontab、/etc/cron.d/*、/etc/cron.{hourly,daily,...}/*）已整体删除：
  /etc/crontab 只反映发行版模板与 manual 里的系统级约定，看不到用户真实在跑的任务，
  实测漏报严重（同一台机器 crontab -l 有 3 条真实任务，/etc/crontab 里一条都没有）。

  由此带来两个格式差异，本脚本专门覆盖：
    · 用户 crontab 的任务行**没有「运行用户」段**：`m h dom mon dow <cmd>`
      （运行用户就是这份 crontab 的归属用户）
    · 「该用户还没有 crontab」不再是一个错误状态，而是 `noCrontab: true`

跑法（本目录即靶机构建上下文）：

    # 1) 构建 + 启动靶机（挂到平台 compose 网络，容器名 = 资产 IP）
    NET=$(docker inspect ophub-backend --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
    docker build -t ophub-sshd-crontab:latest .
    docker run -d --name crontab-probe --network "$NET" ophub-sshd-crontab:latest

    # 2) 跑验证（会自建 2 个【临时】资产并在最后提示删除）
    python e2e_crontab_user.py

    # 3) 靶机状态被改过时先重置基线（脚本内也会自动重置）
    docker exec crontab-probe sh -c 'crontab /tmp/base.crontab; \
      rm -rf /root/.ophub_crontab /home/ituser/.ophub_crontab /tmp/.ophub_crontab'

    # 4) 清理
    docker rm -f crontab-probe; docker rmi -f ophub-sshd-crontab:latest

靶机刻意做成「会踩坑 / 会被误读」的样子：
  - /etc/crontab 里埋了诱饵任务 `0 9 * * * root /bin/echo decoy-etc-crontab`
    → 旧口径会把它读出来，新口径必须**一条都读不到**（这是「旧口径已删除」的硬证据）
  - /etc/cron.d/myapp 同理：既不该被读，也不该被改
  - ituser 自己的 crontab：平台的写入绝不能跑到别人头上
  - 基线里带 man 手册图例（`.-- day of month` 与 `*  *  *  *  * command ...`）
    与「# 紧贴表达式」的禁用任务、带空格注释的示例 —— 都不是任务
  - 基线里带旧格式注释诱饵 `# 0 4 * * * root /bin/echo old-format-decoy`
    → 注释永不生效，但断言它没被当成任务

覆盖：
 1. 读取：source = crontab -l；旧口径字段已删除；任务行无 user 段；
         只解析出真实任务（图例 / 注释 / 环境变量 / 空行都不算）
 2. 新增 / 编辑 / 禁用 / 启用 / 删除，每步都核对远端 `crontab -l` 真实输出
 3. 特殊字符（%）转义：远端是 \\%，平台读回是 %
 4. 新增+删除往返后与基线逐字节一致（sha256 相等）
 5. 冲突保护：错误 hash、以及「平台外手工改 crontab」都必须被拒且零改动
 6. 无 crontab 分支：crontab -r 之后读到 noCrontab=true，新增任务会自动创建这份 crontab
 7. 提权失败（非 sudoers 用户）：明确报错，且远端 crontab 零改动
 8. 全程 /etc/crontab（含诱饵）、/etc/cron.d/myapp、ituser 的 crontab 逐字节未变
 9. 写入后 spool 文件属主权限不变；备份份数 = 写入次数
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:10001/api"
PROBE = "crontab-probe"
HOST = PROBE  # 用容器名当 IP：容器重建后 IP 会变，名字不变

# busybox（Alpine）的 crontab 落盘位置；`crontab -l` 就是 cat 它
SPOOL = "/var/spool/cron/crontabs/root"
# 平台的备份 / 锁目录挂在提权后 shell 的 $HOME 下，不同 sudo 配置下 $HOME 可能是
# root 的也可能是调用者的，逐个探测而不是猜一个
BKUPDIR_CANDS = [
    "/root/.ophub_crontab/backup",
    "/home/ituser/.ophub_crontab/backup",
    "/tmp/.ophub_crontab/backup",
]

results = []
writes = 0  # 成功落盘的写入次数，用于核对备份份数


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  ✅ " if ok else "  ❌ ") + name + (("  → " + detail) if detail and not ok else ""))


def req(path, method="GET", body=None, tok=None):
    """发请求；顺带统计「成功落盘的 crontab 写操作」次数，用于核对备份份数"""
    global writes
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if tok:
        r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=180) as resp:
            out = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            out = json.loads(raw)
        except Exception:
            out = {"code": e.code, "msg": raw}
    if method in ("POST", "PUT", "DELETE") and "/crontab/asset/" in path and out.get("code") == 0:
        writes += 1
    return out


def sh(cmd):
    """在靶机上执行，返回 stdout（stderr 合并），保留原始换行"""
    p = subprocess.run(["docker", "exec", PROBE, "sh", "-c", cmd],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return (p.stdout or "") + (p.stderr or "")


def sha(path_or_cmd):
    """文件或命令输出的 sha256（只取哈希）"""
    if path_or_cmd.startswith("/"):
        raw = sh("sha256sum %s" % path_or_cmd)
    else:
        raw = sh("%s | sha256sum" % path_or_cmd)
    return raw.strip().split()[0]


def remote_crontab():
    """远端此刻真实的用户 crontab（平台看到的同一份东西）"""
    return sh("crontab -l 2>/dev/null")


def live_sha():
    """远端此刻的 crontab 指纹（与平台 hash 口径一致：crontab -l 的逐字节原文）"""
    return sha("crontab -l 2>/dev/null")


def same_range(path, n):
    """远端 path 的前 n 行是否与基线前 n 行逐字节一致（用 diff，避免空串/换行导致长度不等误判）"""
    sh("sed -n '1,%dp' %s > /tmp/_cur" % (n, path))
    sh("sed -n '1,%dp' /tmp/base.crontab > /tmp/_base" % n)
    return "SAME" in sh("diff /tmp/_cur /tmp/_base >/dev/null 2>&1 && echo SAME || echo DIFF")


def owner_mode(path):
    return sh("stat -c '%%U:%%G %%a' %s 2>/dev/null || ls -l %s" % (path, path)).strip()


def backup_dir():
    for d in BKUPDIR_CANDS:
        n = sh("ls -1 %s 2>/dev/null | wc -l" % d).strip()
        if n not in ("", "0"):
            return d
    return BKUPDIR_CANDS[0]


def backup_count():
    d = backup_dir()
    return d, sh("ls -1 %s 2>/dev/null | wc -l" % d).strip()


def reset_baseline():
    sh("crontab /tmp/base.crontab")
    # 备份目录也清掉，让「首份备份 = 写前状态」的断言有意义
    sh("rm -rf /root/.ophub_crontab /home/ituser/.ophub_crontab /tmp/.ophub_crontab")


tok = req("/auth/login", "POST", {"username": "admin", "password": "admin123"})["data"]["token"]

# 借一台现有资产的分类，保证字段模板一致
existing = req("/assets?pageSize=1", tok=tok)["data"]
first = (existing.get("list") or existing.get("items") or [])[0]
cat_id = first["categoryId"]
print("使用分类 categoryId=%s（参考资产 %s）" % (cat_id, first.get("name")))

created = []


def make_asset(tag, ssh_user, ssh_pass, admin_pass):
    body = {
        "categoryId": cat_id,
        "name": "【临时】定时任务验证机-%s" % tag,
        "fields": {
            "虚拟机名称": "【临时】定时任务验证机-%s" % tag,
            "虚拟机IPv4": HOST,
            "SSH端口": "22",
            "用户名": ssh_user,
            "密码": ssh_pass,
            "超级管理员用户": "root",
            "超级管理员用户密码": admin_pass,
            "所属网络区域": "互联网",
        },
    }
    r = req("/assets", "POST", body, tok)
    if r.get("code") != 0:
        print("创建资产失败：", r)
        sys.exit(1)
    aid = r["data"]["id"]
    created.append(aid)
    return aid


A = make_asset("ituser", "ituser", "Ituser@Test123", "Ituser@Test123")
B = make_asset("nopriv", "nopriv", "Nopriv@Test123", "Nopriv@Test123")
print("临时资产：A(ituser,可提权)=%d  B(nopriv,不可提权)=%d\n" % (A, B))

# ---------------------------------------------------------------- 0 基线快照
reset_baseline()
base_live = live_sha()                       # crontab -l 原文（平台口径）
base_spool = sha(SPOOL)                      # spool 文件本体
base_etc = sha("/etc/crontab")               # 含诱饵，全程不得变
base_crond = sha("/etc/cron.d/myapp")
base_other_user = sha("/var/spool/cron/crontabs/ituser")
print("基线：crontab -l=%s…  spool=%s…  /etc/crontab=%s…  other-user=%s…\n"
      % (base_live[:12], base_spool[:12], base_etc[:12], base_other_user[:12]))

# ---------------------------------------------------------------- 1 读取
print("[1] 读取解析")
v = req("/crontab/asset/%d" % A, tok=tok)["data"]
check("数据源 = crontab -l", str(v.get("source", "")).endswith("crontab -l"), str(v.get("source")))
check("归属用户 root + sudo 提权", v.get("user") == "root" and v.get("runMode") == "sudo",
      "%s/%s" % (v.get("user"), v.get("runMode")))
check("旧口径字段已删除（systemTaskCount / systemTasks / sysPath）",
      all(k not in v for k in ("systemTaskCount", "systemTasks", "sysPath")),
      str([k for k in ("systemTaskCount", "systemTasks", "sysPath") if k in v]))
check("有 crontab（noCrontab=false / crontabAvailable=true）",
      v.get("noCrontab") is False and v.get("crontabAvailable") is True,
      "noCrontab=%s available=%s" % (v.get("noCrontab"), v.get("crontabAvailable")))
check("任务 3 条（2 启用 + 1 禁用）",
      (v["taskCount"], v["enabledCount"], v["disabledCount"]) == (3, 2, 1),
      "task=%s en=%s dis=%s" % (v["taskCount"], v["enabledCount"], v["disabledCount"]))
check("任务行不含「运行用户」段（用户 crontab 格式）",
      all("user" not in t for t in v["tasks"]),
      str(sorted(v["tasks"][0].keys()) if v["tasks"] else []))
check("others 非空（环境变量/注释/空行单独归类）", len(v["others"]) > 0, str(len(v["others"])))
check("环境变量行被识别为 env", any(o["kind"] == "env" for o in v["others"]),
      str([o.get("raw", "")[:24] for o in v["others"] if o["kind"] == "env"]))

want_cmds = {"/bin/echo nightly-backup", "/bin/echo every-5min", "/bin/echo disabled-task"}
check("三条任务命令与基线一致", {t["command"] for t in v["tasks"]} == want_cmds,
      str({t["command"] for t in v["tasks"]}))
raww = [t["raw"] for t in v["tasks"]]
legend = [r for r in raww if ".--" in r or "|" in r or "user-name" in r]
check("man 手册图例 0 条被当成任务", len(legend) == 0, str(legend))
check("带空格注释掉的示例不算任务", not any("commented-example" in r for r in raww),
      str([r for r in raww if "commented-example" in r]))
check("旧格式注释诱饵不算任务", not any("old-format-decoy" in r for r in raww),
      str([r for r in raww if "old-format-decoy" in r]))
dis = [t for t in v["tasks"] if "disabled-task" in t["command"]]
check("「# 紧贴表达式」的行识别为禁用任务",
      len(dis) == 1 and dis[0]["enabled"] is False and dis[0]["kind"] == "disabled",
      str(dis))
check("平台 hash = 远端 crontab -l 的 sha256",
      v["hash"] == live_sha(), "api=%s live=%s" % (v["hash"][:12], live_sha()[:12]))

# 新口径最直接的证据：/etc/crontab 里埋的诱饵一条都不该出现
check("★ 不再读 /etc/crontab（诱饵 decoy-etc-crontab 一条都读不到）",
      "decoy-etc-crontab" not in v["content"], v["content"][-160:])
check("★ 也不再读 /etc/cron.d/*（cron-d-task 读不到）",
      "cron-d-task" not in v["content"], "content 含 cron-d-task=%s" % ("cron-d-task" in v["content"]))
check("★ 不误读其它用户的 crontab（ituser-own-task 读不到）",
      "ituser-own-task" not in v["content"], "content 含 ituser-own-task=%s" % ("ituser-own-task" in v["content"]))

# ---------------------------------------------------------------- 2 新增
print("\n[2] 新增任务")
r = req("/crontab/asset/%d/tasks" % A, "POST",
        {"hash": v["hash"], "expr": "30 4 * * 1-5",
         "command": "/bin/bash /data/scripts/e2e.sh >> /var/log/e2e.log 2>&1"},
        tok)
check("新增返回成功", r.get("code") == 0, str(r))
check("已备份写入前的 crontab", bool((r.get("data") or {}).get("backup")),
      str((r.get("data") or {}).get("backup")))
v2 = req("/crontab/asset/%d" % A, tok=tok)["data"]
rc = remote_crontab()
check("远端 crontab -l 出现新任务行", "/bin/bash /data/scripts/e2e.sh" in rc, rc[-200:])
check("远端新任务行没有「运行用户」段",
      "30 4 * * 1-5 /bin/bash /data/scripts/e2e.sh" in rc, rc[-200:])
check("任务数 3 → 4", v2["taskCount"] == 4, str(v2["taskCount"]))
check("基线前 17 行逐字节未变", same_range(SPOOL, 17),
      sh("sed -n '1,17p' %s; echo ---; sed -n '1,17p' /tmp/base.crontab" % SPOOL))
check("写入后 spool 属主权限仍为 root:root 600",
      owner_mode(SPOOL).endswith("root:root 600"), owner_mode(SPOOL))

# ---------------------------------------------------------------- 3 编辑
print("\n[3] 编辑任务")
new_line = [t for t in v2["tasks"] if "e2e.sh" in (t.get("command") or "")][0]
r = req("/crontab/asset/%d/tasks" % A, "PUT",
        {"hash": v2["hash"], "lineNo": new_line["lineNo"], "oldRaw": new_line["raw"],
         "expr": "45 5 * * *", "command": "/bin/bash /data/scripts/e2e-v2.sh"},
        tok)
check("编辑返回成功", r.get("code") == 0, str(r))
v3 = req("/crontab/asset/%d" % A, tok=tok)["data"]
rc = remote_crontab()
check("远端出现新内容", "e2e-v2.sh" in rc and rc.count("/bin/bash /data/scripts/e2e-v2.sh") == 1)
check("远端旧内容消失", "e2e.sh" not in rc.replace("e2e-v2.sh", ""))
check("远端表达式已更新", "45 5 * * * /bin/bash /data/scripts/e2e-v2.sh" in rc, rc[-160:])
check("相邻任务行未被影响",
      "0 2 * * * /bin/echo nightly-backup" in rc and "*/5 * * * * /bin/echo every-5min" in rc)
edited_line = [t for t in v3["tasks"] if "e2e-v2.sh" in (t.get("command") or "")][0]

# ---------------------------------------------------------------- 4 禁用/启用
print("\n[4] 禁用 / 启用")
r = req("/crontab/asset/%d/tasks" % A, "PUT",
        {"hash": v3["hash"], "lineNo": edited_line["lineNo"], "oldRaw": edited_line["raw"],
         "expr": edited_line["expr"],
         "command": edited_line["command"], "enabled": False}, tok)
check("禁用返回成功", r.get("code") == 0, str(r))
rc = remote_crontab()
check("远端该行被 # 注释且紧贴表达式",
      "#45 5 * * * /bin/bash /data/scripts/e2e-v2.sh" in rc, rc[-160:])
v4 = req("/crontab/asset/%d" % A, tok=tok)["data"]
d = [t for t in v4["tasks"] if "e2e-v2.sh" in (t.get("command") or "")][0]
check("平台仍识别为任务且 enabled=false", d["enabled"] is False and d["kind"] == "disabled", str(d))
check("禁用计数 1 → 2", v4["disabledCount"] == 2, str(v4["disabledCount"]))

r = req("/crontab/asset/%d/tasks" % A, "PUT",
        {"hash": v4["hash"], "lineNo": d["lineNo"], "oldRaw": d["raw"],
         "expr": d["expr"], "command": d["command"], "enabled": True}, tok)
check("启用返回成功", r.get("code") == 0, str(r))
rc = remote_crontab()
check("远端该行已取消注释", "45 5 * * * /bin/bash /data/scripts/e2e-v2.sh" in rc
      and "#45 5" not in rc, rc[-160:])
v5 = req("/crontab/asset/%d" % A, tok=tok)["data"]

# ---------------------------------------------------------------- 5 特殊字符
print("\n[5] 特殊字符（% 转义）")
r = req("/crontab/asset/%d/tasks" % A, "POST",
        {"hash": v5["hash"], "expr": "0 6 * * *",
         "command": "date +%Y-%m-%d >> /tmp/d.log"}, tok)
check("含 % 的新增成功", r.get("code") == 0, str(r))
rc = remote_crontab()
check("远端写成转义形式 \\%", "date +\\%Y-\\%m-\\%d" in rc, rc[-160:])
v6 = req("/crontab/asset/%d" % A, tok=tok)["data"]
pct = [t for t in v6["tasks"] if "d.log" in (t.get("command") or "")][0]
check("平台读回未转义原文", pct["command"] == "date +%Y-%m-%d >> /tmp/d.log", pct["command"])

# ---------------------------------------------------------------- 6 冲突保护
print("\n[6] 冲突保护（必须被拒且零改动）")
before = live_sha()
r = req("/crontab/asset/%d/raw" % A, "PUT",
        {"hash": "deadbeef" * 8, "content": "0 0 * * * /bin/echo HACKED\n"}, tok)
check("错误 hash 被拒绝", r.get("code") != 0, str(r)[:200])
check("文件零改动", live_sha() == before)

# 平台外手工改 crontab（模拟别人在机器上改）→ 平台侧的 cmp 冲突检测必须拦住
stale_hash = v6["hash"]
sh("crontab -l 2>/dev/null > /tmp/_manual && printf '0 7 * * * /bin/echo manual-edit\\n' >> /tmp/_manual && crontab /tmp/_manual")
r = req("/crontab/asset/%d/tasks" % A, "POST",
        {"hash": stale_hash, "expr": "0 8 * * *", "command": "/bin/echo should-not-land"}, tok)
check("平台外改动后写入被拒（cmp 冲突检测）", r.get("code") != 0, str(r)[:220])
check("提示可操作（「已被改动…请刷新」）", "已被改动" in json.dumps(r, ensure_ascii=False), str(r)[:220])
check("手工改动未被覆盖（manual-edit 仍在，should-not-land 未写入）",
      "manual-edit" in remote_crontab() and "should-not-land" not in remote_crontab())
# 还原手工改动，继续后续用例
sh("crontab -l 2>/dev/null | grep -v manual-edit > /tmp/_undo && crontab /tmp/_undo")
v6b = req("/crontab/asset/%d?refresh=1" % A, tok=tok)["data"]
check("还原后平台重读内容与手工改动前一致", v6b["content"] == v6["content"],
      "hash=%s vs %s" % (v6b["hash"][:12], v6["hash"][:12]))

# ---------------------------------------------------------------- 7 删除 + 往返一致
print("\n[7] 删除，并验证「新增+删除」往返回到基线")
v7 = req("/crontab/asset/%d" % A, tok=tok)["data"]
for cmd_kw in ("e2e-v2.sh", "d.log"):
    t = [x for x in v7["tasks"] if cmd_kw in (x.get("command") or "")][0]
    r = req("/crontab/asset/%d/tasks" % A, "DELETE",
            {"hash": v7["hash"], "lineNo": t["lineNo"], "oldRaw": t["raw"]}, tok)
    check("删除 %s 成功" % cmd_kw, r.get("code") == 0, str(r))
    v7 = req("/crontab/asset/%d" % A, tok=tok)["data"]
check("往返后 crontab -l 与基线逐字节一致", live_sha() == base_live,
      "now=%s base=%s\n%s" % (live_sha()[:12], base_live[:12], remote_crontab()))
check("spool 文件与基线逐字节一致", sha(SPOOL) == base_spool)
check("任务数回到 3", v7["taskCount"] == 3, str(v7["taskCount"]))
bd, bc = backup_count()
check("备份目录产生了备份文件", bc not in ("", "0"), "%s → %s" % (bd, sh("ls -la %s 2>&1" % bd)))
check("首份备份 = 写前基线（sha256 相等）",
      sha("%s/$(ls -1 %s | head -1)" % (bd, bd)) == base_live if bc not in ("", "0") else False,
      sh("ls -1 %s | head -1" % bd))
check("备份份数 = 写入次数（同秒连续写入不互相覆盖）",
      bc == str(writes),
      "备份 %s 份 / 写入 %d 次\n%s" % (bc, writes, sh("ls -l %s" % bd)))
check("写入后 spool 属主权限仍为 root:root 600",
      owner_mode(SPOOL).endswith("root:root 600"), owner_mode(SPOOL))
leftover = sh("ls -a /home/ituser/.ophub_crontab/ /root/.ophub_crontab/ 2>/dev/null")
check("无锁 / 临时文件残留",
      "lock" not in leftover and ".new" not in leftover and ".old" not in leftover, leftover)

# ---------------------------------------------------------------- 8 无 crontab 分支
print("\n[8] 没有 crontab：noCrontab 分支（旧口径下这里是「文件不存在」错误）")
sh("crontab -r 2>/dev/null")
raw_list = sh("crontab -l 2>&1; echo RC=$?")
check("靶机 crontab -l 已确认为「无 crontab」形态",
      "can't open" in raw_list or "no crontab" in raw_list, raw_list.strip()[:160])
v8 = req("/crontab/asset/%d?refresh=1" % A, tok=tok)["data"]
check("平台读到 noCrontab=true（不是报错）", v8.get("noCrontab") is True, str(v8.get("noCrontab")))
check("任务 0 条且内容为空", v8["taskCount"] == 0 and v8["content"] == "",
      "task=%s content=%r" % (v8["taskCount"], v8["content"]))
check("hash 为「空内容」的指纹（写回可继续）", len(v8["hash"]) == 64, v8["hash"][:12])

r = req("/crontab/asset/%d/tasks" % A, "POST",
        {"hash": v8["hash"], "expr": "0 1 * * *", "command": "/bin/echo created-from-empty"}, tok)
check("在「没有 crontab」的机器上新增成功（自动创建这份 crontab）", r.get("code") == 0, str(r))
rc = remote_crontab()
check("远端确实被创建出这份 crontab", "created-from-empty" in rc, rc[-160:])
v9 = req("/crontab/asset/%d?refresh=1" % A, tok=tok)["data"]
check("重读后 noCrontab 变回 false 且任务 1 条",
      v9.get("noCrontab") is False and v9["taskCount"] == 1,
      "noCrontab=%s task=%s" % (v9.get("noCrontab"), v9["taskCount"]))

# 把最后一条也删掉 → 平台应改为 `crontab -r`（不是安装空文件）
last = v9["tasks"][0]
r = req("/crontab/asset/%d/tasks" % A, "DELETE",
        {"hash": v9["hash"], "lineNo": last["lineNo"], "oldRaw": last["raw"]}, tok)
check("删除最后一条任务成功", r.get("code") == 0, str(r))
v10 = req("/crontab/asset/%d?refresh=1" % A, tok=tok)["data"]
check("删光后回到 noCrontab=true（走 crontab -r，不是安装空文件）",
      v10.get("noCrontab") is True, "noCrontab=%s" % v10.get("noCrontab"))

# 还原基线，继续后面的用例
reset_baseline()
v11 = req("/crontab/asset/%d?refresh=1" % A, tok=tok)["data"]
check("重置基线后内容与初始基线一致", v11["content"] == remote_crontab(), "hash=%s" % v11["hash"][:12])

# ---------------------------------------------------------------- 9 提权失败
print("\n[9] 提权失败（nopriv 不在 sudoers）")
vb = req("/crontab/asset/%d" % B, tok=tok)
check("读取被明确拒绝", vb.get("code") != 0, str(vb)[:200])
check("报错点明提权与 crontab",
      "提权失败" in json.dumps(vb, ensure_ascii=False)
      and "crontab" in json.dumps(vb, ensure_ascii=False), str(vb)[:300])
before = live_sha()
r = req("/crontab/asset/%d/tasks" % B, "POST",
        {"hash": "x", "expr": "0 1 * * *", "command": "/bin/echo nope"}, tok)
check("无权限时新增被拒绝", r.get("code") != 0, str(r)[:200])
check("无权限时远端 crontab 零改动", live_sha() == before)

# ---------------------------------------------------------------- 10 不误伤 / 不误读
print("\n[10] 旧口径来源不被改、不再被读")
check("/etc/crontab（含诱饵）逐字节未变", sha("/etc/crontab") == base_etc)
check("/etc/cron.d/myapp 逐字节未变", sha("/etc/cron.d/myapp") == base_crond)
check("ituser 的 crontab 逐字节未变", sha("/var/spool/cron/crontabs/ituser") == base_other_user)
vf = req("/crontab/asset/%d?refresh=1" % A, tok=tok)["data"]
check("最终读取的内容即远端 crontab -l",
      vf["content"] == remote_crontab() and vf["hash"] == live_sha(),
      "api=%s live=%s" % (vf["hash"][:12], live_sha()[:12]))

# ---------------------------------------------------------------- 清理
# 脚本可重复跑：临时资产用完即删，靶机 crontab 回到基线
reset_baseline()
if created:
    rc_clean = req("/assets/batch", "DELETE", {"ids": created}, tok)
    print("\n清理临时资产 %s → code=%s" % (created, rc_clean.get("code")))

# ---------------------------------------------------------------- 汇总
print("\n================ 汇总 ================")
bad = [r for r in results if not r[1]]
print("共 %d 项，通过 %d，失败 %d" % (len(results), len(results) - len(bad), len(bad)))
for name, _, detail in bad:
    print("  FAIL:", name, "|", detail[:200])
print("ASSET_IDS=%s" % ",".join(str(i) for i in created))
sys.exit(1 if bad else 0)
