#!/usr/bin/env bash
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# setup-scripts-dir.sh —— 在主机建脚本根目录 + 把 SCRIPT_HOST_ROOT 写进 .env
#
# 为什么需要这个脚本：
#   平台跑在容器里，「本机模式」看到的路径 = 容器内路径；要看到主机的脚本目录
#   必须由 docker-compose.yml 的 backend.volumes 把主机路径挂进去。
#   v1.7.9 起 compose 默认挂 /data/jenkins_home/scripts/Java_Start_Stop_SH，
#   但 .env 里 SCRIPT_HOST_ROOT 没显式写时，docker compose 变量兜底成「与 compose
#   字符串同字面量」，不一定从 .env 注入到 backend 进程环境。后端读不到这个值
#   时会用 Go 常量 defaultScriptRoot，对得上还好、对不上就空。
#
#   这个脚本统一两件事：① 建主机目录；② 把 SCRIPT_HOST_ROOT 写进 .env。
#
# 用法（在 /opt/ophub 里跑）：
#   bash deploy/linux/setup-scripts-dir.sh                       # 默认 /data/jenkins_home/scripts/Java_Start_Stop_SH
#   bash deploy/linux/setup-scripts-dir.sh /custom/scripts_dir   # 自定义
#
# ⚠️ 改完 .env 必须重启 backend 才会生效：
#       docker compose up -d --no-build backend

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

ROOT="${1:-/data/jenkins_home/scripts/Java_Start_Stop_SH}"

C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'; C_RESET='\033[0m'
info() { printf "${C_INFO}[setup]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit 1; }

[ -f .env ] || die "当前目录没有 .env（请 cd 到 /opt/ophub）"

# 1. 建主机目录（已存在则不动）
if [ -d "$ROOT" ]; then
  cnt="$(ls -A "$ROOT" | wc -l)"
  ok "目录已存在：$ROOT（里面 $cnt 个条目 —— 应该能看到你的服务目录，如 China Mobile）"
else
  mkdir -p "$ROOT"
  ok "已建目录：$ROOT"
fi

# 2. 把 SCRIPT_HOST_ROOT 写进 .env（让 docker compose 与后端进程都读到这个值）
if grep -q "^SCRIPT_HOST_ROOT=" .env; then
  cur="$(grep -m1 '^SCRIPT_HOST_ROOT=' .env | cut -d= -f2- | tr -d '\r')"
  if [ "$cur" != "$ROOT" ]; then
    sed -i.bak "s|^SCRIPT_HOST_ROOT=.*|SCRIPT_HOST_ROOT=$ROOT|" .env
    ok ".env SCRIPT_HOST_ROOT 已更新：$cur → $ROOT"
  else
    ok ".env SCRIPT_HOST_ROOT 已经指向 $ROOT"
  fi
else
  echo "SCRIPT_HOST_ROOT=$ROOT" >> .env
  ok ".env 末尾追加 SCRIPT_HOST_ROOT=$ROOT"
fi

# 3. 提示后续动作
echo
info "接下来（一次即可）："
echo "    docker compose up -d --no-build backend"
echo
echo "  backend 重启后会读 .env，把 $ROOT 挂进容器。"
echo "  进平台 → Java 启停脚本管理 → 刷新，应该能看到 China Mobile 等服务目录。"
echo
echo "  如果还是空，常见原因："
echo "    1) .env 改了没重启 backend —— 上面那条必须跑"
echo "    2) 主机目录权限问题 —— chmod 755 $ROOT 兜底"
echo "    3) compose 里挂载路径与 .env 不一致 —— 对照 docker-compose.yml 的 SCRIPT_HOST_ROOT 行"
echo