#!/usr/bin/env bash
# harbor_update.sh —— 内网侧「强制更新到 latest 标签」
#
# 流程（5 步）：
#   [1] docker pull backend/frontend :latest     （拉一次确保能拉到）
#   [2] docker compose stop backend frontend     （停容器）
#   [3] docker rmi :latest                       （删本地旧 latest，强制下一步拉远端最新）
#   [4] docker pull backend/frontend :latest     （再拉一次确认拉的是最新）
#   [5] docker compose up -d --no-build          （用新镜像重启）
#   [+] 健康检查: 前端 HTTP 200 / 后端 HTTP 200
#
# 用法:
#   bash scripts/harbor_update.sh                # 跑完整 5 步
#   bash scripts/harbor_update.sh --no-health    # 跳过健康检查
#   bash scripts/harbor_update.sh --prune        # 更新后清理悬空镜像
#
# 前提: 服务器要先 docker login harbor.internal.example (admin / <HARBOR_PASSWORD>)
#       否则 [1] 会报 "unauthorized",脚本直接失败退出
#
# 退出码: 0 成功; 1 配置/参数错误; 2 拉镜像失败; 3 健康检查失败

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../docker-compose.yml" ]; then
  DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  DEPLOY_DIR="$SCRIPT_DIR"
fi
cd "$DEPLOY_DIR"

C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
info() { printf "${C_INFO}[update]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

# ---------- 参数 ----------
DO_HEALTH=1; DO_PRUNE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-health) DO_HEALTH=0; shift ;;
    --prune)     DO_PRUNE=1; shift ;;
    -h|--help)   sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "未知参数: $1 (-h 看用法)" ;;
  esac
done

# ---------- 基础检查 ----------
[ -f .env ] || die "在 $DEPLOY_DIR 下找不到 .env"
[ -f docker-compose.yml ] || die "在 $DEPLOY_DIR 下找不到 docker-compose.yml"
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"

# 从 .env 读 registry / repo,但强制用 :latest
get_env() { sed -n "s/^$1=//p" .env | head -1 | tr -d '\r'; }
CUR_BACKEND="$(get_env BACKEND_IMAGE)"
CUR_FRONTEND="$(get_env FRONTEND_IMAGE)"
[ -n "$CUR_BACKEND" ] || die ".env 里没有 BACKEND_IMAGE"
[ -n "$CUR_FRONTEND" ] || die ".env 里没有 FRONTEND_IMAGE"

REG_BE="${CUR_BACKEND%:*}"   # 去掉 :tag
REG_FE="${CUR_FRONTEND%:*}"
TARGET_BE="${REG_BE}:latest"
TARGET_FE="${REG_FE}:latest"
REGISTRY="${REG_BE%%/*}"    # harbor.internal.example

info "目标镜像(强制 latest):"
info "  backend  : $TARGET_BE"
info "  frontend : $TARGET_FE"

# ---------- [1] 第一次 pull(摸底) ----------
info "[1/5] docker pull(第一次,摸底)"
docker pull "$TARGET_BE" || die "第一次 pull backend 失败(确认已 docker login $REGISTRY)" 1
docker pull "$TARGET_FE" || die "第一次 pull frontend 失败(确认已 docker login $REGISTRY)" 1

# ---------- [2] 停容器 ----------
info "[2/5] docker compose stop backend frontend"
docker compose stop backend frontend

# ---------- [3] 删本地 :latest(强制下一步拉远端最新) ----------
info "[3/5] docker rmi :latest(本地缓存清理)"
# rmi 可能因为容器依赖 / 多 tag 共享 layer 失败,警告而非 fatal
if docker rmi "$TARGET_BE" 2>/dev/null; then
  ok "  已删除 $TARGET_BE"
else
  warn "  删除 $TARGET_BE 失败(可能容器还在用 / 多 tag 共享),继续"
fi
if docker rmi "$TARGET_FE" 2>/dev/null; then
  ok "  已删除 $TARGET_FE"
else
  warn "  删除 $TARGET_FE 失败(可能容器还在用 / 多 tag 共享),继续"
fi

# ---------- [4] 再 pull(确认拉最新) ----------
info "[4/5] docker pull(第二次,确认拉最新)"
docker pull "$TARGET_BE" || die "第二次 pull backend 失败" 1
docker pull "$TARGET_FE" || die "第二次 pull frontend 失败" 1

# ---------- [5] 起容器 ----------
info "[5/5] docker compose up -d --no-build"
docker compose up -d --no-build backend frontend

# ---------- 健康检查 ----------
if [ "$DO_HEALTH" -eq 1 ]; then
  info "健康检查..."
  # 读 .env 里的端口
  WEB_PORT="$(get_env WEB_PORT)"
  : "${WEB_PORT:=10001}"
  BACKEND_PORT="$(get_env BACKEND_PORT)"
  : "${BACKEND_PORT:=10002}"
  # 前端
  HTTP_FE="$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "http://localhost:${WEB_PORT}/" || echo 000)"
  if [ "$HTTP_FE" = "200" ]; then
    ok "  前端 ${WEB_PORT}: HTTP 200"
  else
    warn "  前端 ${WEB_PORT}: HTTP ${HTTP_FE}(若已知无 / 路径返回 404/308 可加 --no-health)"
  fi
  # 后端
  HTTP_BE="$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "http://localhost:${BACKEND_PORT}/api/health" || echo 000)"
  if [ "$HTTP_BE" = "200" ]; then
    ok "  后端 ${BACKEND_PORT}: HTTP 200"
  else
    warn "  后端 ${BACKEND_PORT}: HTTP ${HTTP_BE}(若 /api/health 路径不存在可加 --no-health)"
  fi
fi

# ---------- 可选 prune ----------
if [ "$DO_PRUNE" -eq 1 ]; then
  info "清理悬空镜像..."
  docker image prune -f >/dev/null 2>&1 || warn "  prune 部分失败,忽略"
fi

ok "完成,backend=latest / frontend=latest 已生效"