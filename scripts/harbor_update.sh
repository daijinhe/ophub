#!/usr/bin/env bash
# harbor_update.sh —— 内网侧：从 Harbor 拉取新镜像并重启服务
#
# 用途：本地 build 并 push 到 Harbor 之后，内网靠这条命令生效；
#       配 cron 即为「内网自动拉取新镜像启动」。
#
# 用法：
#   bash scripts/harbor_update.sh                # 按 .env 里的 tag 拉取；镜像有变化才重建
#   bash scripts/harbor_update.sh --tag v1.7.6   # 切到指定版本
#   bash scripts/harbor_update.sh --latest       # 切到 latest（跟随最近一次推送）
#   bash scripts/harbor_update.sh --rollback     # 回退到上一次成功部署的版本
#   bash scripts/harbor_update.sh --check        # 只显示当前状态，不做任何改动
#   bash scripts/harbor_update.sh --no-health    # 跳过健康检查
#   bash scripts/harbor_update.sh --prune        # 更新后清理悬空镜像
#
# cron（每 10 分钟检查，有更新才重建）：
#   */10 * * * * cd /opt/ophub && bash scripts/harbor_update.sh >> /var/log/ophub-update.log 2>&1
#
# 退出码：0 成功或无需更新；1 参数/配置错误；2 拉取失败；4 健康检查失败

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

[ -f .env ] || die "在 $DEPLOY_DIR 下找不到 .env"
[ -f docker-compose.yml ] || die "在 $DEPLOY_DIR 下找不到 docker-compose.yml"
command -v docker >/dev/null 2>&1 || die "未找到 docker"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose（需要 v2）"

get_env() { sed -n "s/^$1=//p" .env | head -1 | tr -d '\r'; }
set_env() {
  local k="$1" v="$2" tmp=".env.tmp.$$"
  if grep -q "^$k=" .env; then sed "s|^$k=.*|$k=$v|" .env > "$tmp"; else cp .env "$tmp"; printf '\n%s=%s\n' "$k" "$v" >> "$tmp"; fi
  mv "$tmp" .env
}

HIST=".deploy_history"
# 前端容器名从 compose 取（不能硬编码 ophub-frontend：container_name 改过就探错对象）。
# 只在没有 curl、退回 wget 兜底时用到。
FE_C="$(sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' docker-compose.yml \
  | tr -d '\r' | grep -i front | head -1 || true)"
: "${FE_C:=ophub-frontend}"
CUR_BACKEND="$(get_env BACKEND_IMAGE)"
CUR_FRONTEND="$(get_env FRONTEND_IMAGE)"
CUR_TAG="${CUR_BACKEND##*:}"

show_state() {
  echo "  部署目录 : $DEPLOY_DIR"
  echo "  当前版本 : ${CUR_TAG:-<未设置>}"
  echo "  后端镜像 : ${CUR_BACKEND:-<未设置>}"
  echo "  前端镜像 : ${CUR_FRONTEND:-<未设置>}"
  echo "  运行容器 :"
  docker compose ps --format '    {{.Name}}  {{.Status}}  {{.Image}}' 2>/dev/null || true
  if [ -f "$HIST" ]; then
    echo "  最近部署 :"
    tail -5 "$HIST" | sed 's/^/    /'
  fi
}

# ---------- 参数 ----------
NEW_TAG=""; DO_ROLLBACK=0; CHECK_ONLY=0; DO_HEALTH=1; DO_PRUNE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)       NEW_TAG="${2:-}"; [ -n "$NEW_TAG" ] || die "--tag 需要一个版本号"; shift 2 ;;
    --latest)    NEW_TAG="latest"; shift ;;
    --rollback)  DO_ROLLBACK=1; shift ;;
    --check)     CHECK_ONLY=1; shift ;;
    --no-health) DO_HEALTH=0; shift ;;
    --prune)     DO_PRUNE=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "未知参数：$1（-h 看用法）" ;;
  esac
done

if [ "$CHECK_ONLY" -eq 1 ]; then
  show_state
  exit 0
fi

# 离线镜像模式（.env 里没有 Harbor 地址）不该走这条路径
if [ -z "$CUR_BACKEND" ]; then
  warn "BACKEND_IMAGE 未在 .env 中设置 —— 这是「离线镜像」模式，不涉及 Harbor 拉取。"
  warn "若要从 Harbor 更新，请先按 docs/内网迁移指南.md 把 4 个镜像变量指向 Harbor。"
  exit 0
fi

# ---------- 回退 ----------
if [ "$DO_ROLLBACK" -eq 1 ]; then
  [ -f "$HIST" ] || die "没有部署历史（$HIST），无法回退"
  LAST="$(tail -1 "$HIST")"
  PREV="$(printf '%s' "$LAST" | awk -F'|' '{print $2}')"
  [ -n "$PREV" ] || die "无法从历史记录解析出上一个版本：$LAST"
  info "回退：$CUR_TAG → $PREV"
  nextTag="$PREV"
else
  nextTag="$NEW_TAG"
fi

# 记录本次变更前的版本（用于写部署历史 & 回退）
ORIG_TAG="$CUR_TAG"

# ---------- 切 tag ----------
if [ -n "$nextTag" ] && [ "$nextTag" != "$CUR_TAG" ]; then
  oldTag="$CUR_TAG"
  for v in BACKEND_IMAGE FRONTEND_IMAGE; do
    cur="$(get_env "$v")"
    [ -n "$cur" ] || continue
    set_env "$v" "${cur%:*}:$nextTag"
  done
  info ".env 已切换：$oldTag → $nextTag"
  CUR_TAG="$nextTag"
  CUR_BACKEND="$(get_env BACKEND_IMAGE)"
  CUR_FRONTEND="$(get_env FRONTEND_IMAGE)"
fi

# ---------- 拉取 ----------
IMG_ID_OF() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || echo none; }
BEFORE_BE="$(IMG_ID_OF "$CUR_BACKEND")"
BEFORE_FE="$(IMG_ID_OF "$CUR_FRONTEND")"

info "拉取镜像（当前 tag：$CUR_TAG）…"
PULL_LOG="$(mktemp)"
if ! docker compose pull backend frontend 2>&1 | tee "$PULL_LOG"; then
  if grep -qi 'server gave HTTP response to HTTPS client\|insecure' "$PULL_LOG"; then
    echo
    warn "HTTP 仓库未授权。请在内网机执行后重试："
    echo "    echo '{\"insecure-registries\":[\"$(get_env BACKEND_IMAGE | cut -d/ -f1)\"]}' | sudo tee /etc/docker/daemon.json"
    echo "    sudo systemctl restart docker"
  fi
  rm -f "$PULL_LOG"
  die "镜像拉取失败" 2
fi
rm -f "$PULL_LOG"

AFTER_BE="$(IMG_ID_OF "$CUR_BACKEND")"
AFTER_FE="$(IMG_ID_OF "$CUR_FRONTEND")"

if [ "$BEFORE_BE" = "$AFTER_BE" ] && [ "$BEFORE_FE" = "$AFTER_FE" ]; then
  ok "已是最新（后端/前端镜像均无变化），无需重建"
  exit 0
fi

[ "$BEFORE_BE" != "$AFTER_BE" ] && info "后端镜像已更新：${BEFORE_BE:0:19} → ${AFTER_BE:0:19}"
[ "$BEFORE_FE" != "$AFTER_FE" ] && info "前端镜像已更新：${BEFORE_FE:0:19} → ${AFTER_FE:0:19}"

# ---------- 重建 ----------
info "重建 backend / frontend …"
docker compose up -d --no-build backend frontend

# ---------- 健康检查 ----------
if [ "$DO_HEALTH" -eq 1 ]; then
  WEB_PORT="$(get_env WEB_PORT)"; : "${WEB_PORT:=8088}"
  info "健康检查 …"
  http_code() {
    local c
    # Git Bash 下 curl 成功也可能返回非 0 退出码；`|| echo 000` 会拼成 200000
    c="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null || true)"
    printf '%s' "${c:-000}"
  }
  if ! command -v curl >/dev/null 2>&1; then
    http_code() { docker exec "$FE_C" wget -q -S -O /dev/null "$1" 2>&1 | sed -n 's/.*HTTP\/[0-9.]* \([0-9]\{3\}\).*/\1/p' | head -1 || echo 000; }
  fi

  FE="000"; BE="000"
  for i in $(seq 1 30); do
    FE="$(http_code "http://127.0.0.1:$WEB_PORT/")"
    [ "$FE" = "200" ] && break
    sleep 2
  done
  for i in $(seq 1 15); do
    BE="$(http_code "http://127.0.0.1:$WEB_PORT/api/auth/me")"
    [ "$BE" != "000" ] && [ "$BE" != "502" ] && break
    sleep 2
  done

  if [ "$FE" = "200" ] && [ "$BE" != "000" ] && [ "$BE" != "502" ]; then
    ok "更新成功：前端 $FE / 后端 $BE"
  else
    warn "健康检查未通过（前端 $FE / 后端 $BE）"
    echo "    查看日志： docker compose logs --tail 80 backend"
    echo "    回退版本： bash scripts/harbor_update.sh --rollback"
    printf '%s|%s|%s|FAILED\n' "$(date -Iseconds 2>/dev/null || date)" "$ORIG_TAG" "$CUR_TAG" >> "$HIST" 2>/dev/null || true
    exit 4
  fi
fi

# ---------- 记录 ----------
printf '%s|%s|%s\n' "$(date -Iseconds 2>/dev/null || date)" "$ORIG_TAG" "$CUR_TAG" >> "$HIST"

if [ "$DO_PRUNE" -eq 1 ]; then
  info "清理悬空镜像 …"
  docker image prune -f
fi

ok "完成，当前版本：$CUR_TAG"
