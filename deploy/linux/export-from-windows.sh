#!/usr/bin/env bash
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# export-from-windows.sh —— 在 Win11 的 Git Bash 里导出「数据迁移包」
#
# 为什么不用宿主机目录挂载来 tar 卷：Git Bash 下 /d/xxx 与 D:\xxx 的路径转换
# 很容易踩坑（MSYS 转换、反斜杠转义）。这里一律走
#   docker exec 在容器内打包  ->  docker cp 拷到宿主机
# 完全不碰宿主机路径挂载，最稳。
#
# 用法（项目根目录执行）：
#   bash deploy/linux/export-from-windows.sh
# 产物在 dist/migrate/ 下。

set -euo pipefail

# ⚠️ 必须关掉 Git Bash 的 MSYS 路径转换：
#    否则 `docker exec ... -f /var/tmp/x.dump` 这类参数里的 POSIX 路径会被改写成
#    C:/Users/<你>/AppData/Local/Temp/... 再传给 docker.exe，
#    容器里没有这个 Windows 路径 -> "pg_dump: could not open output file"。
#    （用 bash 跑有时不触发、用 sh 跑必触发，所以直接全局关掉最稳）
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "${BASH_SOURCE[0]}")/../.."     # 定位到仓库根

ROOT="$(pwd)"
OUT="$ROOT/dist/migrate"
mkdir -p "$OUT"

# docker.exe 是 Windows 程序，给它 Windows 形态的路径最保险
# （Git Bash 的 pwd -W 直接输出 D:/xxx；真 Linux 上没有 -W，退回 pwd）
OUT_W="$(pwd -W 2>/dev/null || printf '%s' "$ROOT")"
OUT_W="$OUT_W/dist/migrate"

info() { printf '\033[36m[export]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# 从 .env 读值（顺手去掉可能的 CR，避免变量里混进 \r）
envval() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r' || true; }

DB_USER="$(envval DB_USER)"; DB_USER="${DB_USER:-ophub}"
DB_NAME="$(envval DB_NAME)"; DB_NAME="${DB_NAME:-ophub}"

for c in ophub-postgres ophub-backend; do
  docker inspect "$c" >/dev/null 2>&1 || die "容器 $c 不在运行，先确认本地平台是起来的（docker ps）"
done

echo
info "输出目录：$OUT"
echo

# ---------- 1. PostgreSQL ----------
info "1/5 导出数据库 $DB_NAME（自定义格式 -Fc）…"
docker exec ophub-postgres rm -f /var/tmp/ophub.dump
docker exec ophub-postgres pg_dump -U "$DB_USER" -Fc -f /var/tmp/ophub.dump "$DB_NAME"
docker cp ophub-postgres:/var/tmp/ophub.dump "$OUT_W/ophub.dump"
docker exec ophub-postgres rm -f /var/tmp/ophub.dump
ok "ophub.dump"

# ---------- 2~4. 三个持久卷 ----------
# backend-data   : known_hosts.json（SSH 主机指纹库）、其它运行时数据
# backend-uploads: 上传的 Excel 等文件
# ansible-data   : /etc/ansible 配置
for pair in "backend-data:/data" "backend-uploads:/app/uploads" "ansible-data:/etc/ansible"; do
  vol="${pair%%:*}"; path="${pair##*:}"
  info "导出卷 $vol（容器内 $path）…"
  docker exec ophub-backend rm -f "/var/tmp/$vol.tgz"
  docker exec ophub-backend tar czf "/var/tmp/$vol.tgz" -C "$path" .
  docker cp "ophub-backend:/var/tmp/$vol.tgz" "$OUT_W/$vol.tgz"
  docker exec ophub-backend rm -f "/var/tmp/$vol.tgz"
  ok "$vol.tgz"
done

# ---------- 5. 加密密钥（最关键） ----------
info "5/5 导出 PWD_ENC_KEY（SSH 密码解密密钥）…"
k="$(envval PWD_ENC_KEY)"
[ -n "$k" ] || die ".env 里读不到 PWD_ENC_KEY，导出中止"
printf '%s\n' "$k" > "$OUT/PWD_ENC_KEY.txt"
ok "PWD_ENC_KEY.txt"

# ---------- 汇总 ----------
echo
echo "  ── 产物清单 ────────────────────────────────"
for f in ophub.dump backend-data.tgz backend-uploads.tgz ansible-data.tgz PWD_ENC_KEY.txt; do
  printf '    %-24s %s\n' "$f" "$(du -h "$OUT/$f" 2>/dev/null | cut -f1)"
done
echo "  ────────────────────────────────────────────"
echo
echo "  目录：$OUT"
echo
echo "  下一步：把整个 dist/migrate 目录拷到 Linux 服务器（U 盘 / scp / 共享目录都行）"
echo "  ⚠️  PWD_ENC_KEY.txt 是解密密钥，拷完记得在服务器上 chmod 600，用完删掉"
echo
