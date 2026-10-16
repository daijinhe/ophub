#!/usr/bin/env bash
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# upgrade-compose.sh —— 把部署目录里的 docker-compose.yml 让新版本生效
#
# 为什么需要这个脚本（v1.7.11+）：
#   服务器侧的 docker-compose.yml 是迁移时一次性拷过去的；迁移指南第 6 步只让改
#   .env 里的镜像版本号、不让同步 compose 文件。结果只要 compose 配置本身有变化
#   （如 v1.7.11 把 /etc/ansible 从命名卷改成 bind-mount），服务器上仍按旧版运行，
#   表现为「平台代码已升级、但挂载/环境没变」—— 最难定位的一类 bug。
#
#   这个脚本做三件事：
#     ① 把当前目录下的 docker-compose.yml 的 `${VAR:-default}` 提取出来，
#        在 .env 里缺啥补啥（compose 引用到的变量，后端进程也要能读到 .env）；
#     ② 强制重建 backend 容器（让新 mount / env 立刻生效）；
#     ③ 自检 /etc/ansible 是否真的变成 bind mount，避免「我以为升级了其实没变」。
#
# 用法：
#   cd /opt/ophub                          # 先 cd 到部署目录
#   bash /path/to/upgrade-compose.sh        # 然后跑脚本（脚本假设 cwd 是部署目录）
#
# ⚠️ 前置：deploy/linux/docker-compose.yml 已通过 scp / sftp / U 盘同步到
#   当前目录，覆盖了旧文件。
#
# ⚠️ 会做的事：
#   - 覆盖前备份旧 docker-compose.yml 为 .bak-<时间戳>
#   - 往 .env 补缺失的键（不影响已有键）
#   - 强制重建 backend 容器
#
# ⚠️ 不会做的事：
#   - 不动数据库、不动业务数据卷
#   - 不删旧的 docker volume（由调用方后续手动 `docker volume rm`）

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'; C_RESET='\033[0m'
info() { printf "${C_INFO}[upgrade]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit 1 }

[ -f ./.env ] || die "当前目录没有 .env（请 cd 到部署目录如 /opt/ophub 再跑本脚本）"
[ -f ./docker-compose.yml ] || die "当前目录没有 docker-compose.yml"

# ---------- 1. 备份现有 compose ----------
TS="$(date +%Y%m%d-%H%M%S)"
BAK="./docker-compose.yml.bak-$TS"
cp -p ./docker-compose.yml "$BAK"
ok "已备份旧 compose：$BAK"

# ---------- 2. 把 compose 引用的所有 ${VAR:-default} 提取出来，缺啥补啥 ----------
# 镜像地址相关的 4 个变量在镜像升级流程里维护，不在这里补
skip_vars="POSTGRES_IMAGE REDIS_IMAGE BACKEND_IMAGE FRONTEND_IMAGE"

needed_vars="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*(:-[^}]*)?\}' ./docker-compose.yml \
  | sed -E 's/^\$\{([A-Z_][A-Z0-9_]*).*/\1/' \
  | sort -u)"

added=0
for v in $needed_vars; do
  if echo " $skip_vars " | grep -q " $v "; then continue; fi
  if grep -qE "^${v}=" ./.env; then continue; fi
  echo "${v}=" >> ./.env
  warn ".env 缺失 ${v}=，已补空行（compose 会走内置兜底；如需显式覆盖请编辑）"
  added=$((added+1))
done
[ $added -eq 0 ] && ok ".env 已含 compose 引用到的所有变量"

# ---------- 3. 强制重建 backend ----------
info "重建 backend 容器（让新 compose 的 mount 与 env 立刻生效）…"
docker compose up -d --force-recreate --no-build backend

# ---------- 4. 自检 /etc/ansible 是否真变 bind mount ----------
echo
info "自检：当前 backend 容器的 /etc/ansible 挂载"
MOUNT_INFO="$(docker inspect ophub-backend --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}' 2>/dev/null | grep -i ansible || true)"
if echo "$MOUNT_INFO" | grep -q '^bind'; then
  ok "✓ bind mount 已生效：$MOUNT_INFO"
elif echo "$MOUNT_INFO" | grep -q '^volume'; then
  die "✗ 仍是命名卷挂载：$MOUNT_INFO —— compose 没读到新的 docker-compose.yml（确认文件已覆盖）"
else
  warn "没看到 /etc/ansible 挂载，请手工检查：docker inspect ophub-backend | grep -A 5 -i ansible"
fi

echo
info "下一步（验证平台「本机 Ansible 管理」页面能列出分组后再清理旧卷）："
echo "    docker volume rm ophub_ansible-data"