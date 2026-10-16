#!/usr/bin/env bash
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# update_latest.sh —— 内网侧「一键更新到最新版」
#
# 干什么：自动查 Harbor 上 ophub-backend / ophub-frontend **共有的最新正式版本**
#         （形如 vX.Y.Z，忽略 latest 等非正式标签）→ 改 .env → 拉镜像 → 重建 → 健康检查。
#         已经是最新版就什么都不做（退出码 0），可以放心挂在 cron 上反复跑。
#
# 用法：
#   bash scripts/update_latest.sh                # 探测最新版并更新（已是最新则跳过）
#   bash scripts/update_latest.sh --check        # 只对比：当前版本 / 最新版本 / 是否需要更新
#   bash scripts/update_latest.sh --dry-run      # 只打印将要执行的命令，不真的更新
#   bash scripts/update_latest.sh --no-health    # 跳过健康检查（传给 harbor_update.sh）
#   bash scripts/update_latest.sh --prune        # 更新后清理悬空镜像（传给 harbor_update.sh）
#   bash scripts/update_latest.sh --tag v1.7.9   # 不探测，直接更新到指定版本（等价 harbor_update.sh --tag）
#   bash scripts/update_latest.sh --rollback     # 回退到上一次成功部署的版本
#
# 凭据（查 Harbor 的 tag 列表需要登录态，按此顺序取）：
#   1) 环境变量 HARBOR_USER / HARBOR_PASSWORD（或部署目录下 .env.harbor）
#   2) ~/.docker/config.json 里该 registry 的 auth（docker login 后自动就有）
#   3) docker credential helper（credsStore / credHelpers）
#   4) 匿名访问（Harbor 项目设为公开时可用）
#   都拿不到时会明确报错退出，不会偷偷用旧版本顶上。
#
# cron（每 10 分钟跑一次，有新版才动）：
#   */10 * * * * cd /opt/ophub && bash scripts/update_latest.sh --prune >> /var/log/ophub-update.log 2>&1
# 注意：cron 的 PATH 很干净，建议写成
#   */10 * * * * cd /opt/ophub && PATH=/usr/local/bin:/usr/bin:/bin bash scripts/update_latest.sh >> /var/log/ophub-update.log 2>&1
#
# 退出码：0 成功或无需更新；1 参数/配置错误；2 探测最新版本失败；3 前端或后端缺该版本镜像

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../docker-compose.yml" ]; then
  DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  DEPLOY_DIR="$SCRIPT_DIR"
fi
cd "$DEPLOY_DIR"

C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
info() { printf "${C_INFO}[latest]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

[ -f .env ] || die "在 $DEPLOY_DIR 下找不到 .env"
[ -f docker-compose.yml ] || die "在 $DEPLOY_DIR 下找不到 docker-compose.yml"
command -v docker >/dev/null 2>&1 || die "未找到 docker"

get_env() { sed -n "s/^$1=//p" .env | head -1 | tr -d '\r'; }

# ---------- 参数 ----------
WANT_TAG=""; CHECK_ONLY=0; DRY_RUN=0; DO_ROLLBACK=0
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)        WANT_TAG="${2:-}"; [ -n "$WANT_TAG" ] || die "--tag 需要一个版本号"; shift 2 ;;
    --check)      CHECK_ONLY=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --rollback)   DO_ROLLBACK=1; PASS_ARGS+=("$1"); shift ;;
    --no-health|--prune) PASS_ARGS+=("$1"); shift ;;
    -h|--help)    sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "未知参数：$1（-h 看用法）" ;;
  esac
done

# 回退不需要探测最新版本，直接转交
if [ "$DO_ROLLBACK" -eq 1 ]; then
  exec bash "$SCRIPT_DIR/harbor_update.sh" "${PASS_ARGS[@]}"
fi

CUR_BACKEND="$(get_env BACKEND_IMAGE)"
CUR_FRONTEND="$(get_env FRONTEND_IMAGE)"
[ -n "$CUR_BACKEND" ] || die ".env 里没有 BACKEND_IMAGE（离线镜像模式不适用本脚本）"
CUR_TAG="${CUR_BACKEND##*:}"

# repo 全名 = 去掉 tag 与 registry 后的部分（如 your-project/ophub-backend）
REGISTRY="$(printf '%s' "$CUR_BACKEND" | cut -d/ -f1)"
REPO_BE="$(printf '%s' "${CUR_BACKEND%:*}" | cut -d/ -f2-)"
REPO_FE="$(printf '%s' "${CUR_FRONTEND%:*}" | cut -d/ -f2-)"
[ -n "$REPO_BE" ] || die "无法从 BACKEND_IMAGE 解析出仓库名：$CUR_BACKEND"
[ -n "$REPO_FE" ] || REPO_FE="$(printf '%s' "$REPO_BE" | sed 's/-backend$/-frontend/')"

info "部署目录 : $DEPLOY_DIR"
info "镜像仓库 : $REGISTRY"
info "当前版本 : ${CUR_TAG:-<未设置>}"

# ---------- 凭据 ----------
CRED=""
if [ -n "${HARBOR_USER:-}" ] && [ -n "${HARBOR_PASSWORD:-}" ]; then
  CRED="$HARBOR_USER:$HARBOR_PASSWORD"
  info "凭据来源 : 环境变量 HARBOR_USER/HARBOR_PASSWORD"
elif [ -f .env.harbor ]; then
  HU="$(sed -n 's/^HARBOR_USER=//p' .env.harbor | head -1 | tr -d '\r')"
  HP="$(sed -n 's/^HARBOR_PASSWORD=//p' .env.harbor | head -1 | tr -d '\r')"
  if [ -n "$HU" ] && [ -n "$HP" ]; then
    CRED="$HU:$HP"
    info "凭据来源 : .env.harbor"
  fi
fi
if [ -z "$CRED" ]; then
  for CFG in "$HOME/.docker/config.json" /root/.docker/config.json; do
    [ -f "$CFG" ] || continue
    # 只取该 registry 的 auth 字段（base64 的 user:pass）
    A="$(sed -n "s/.*\"$REGISTRY\"[[:space:]]*:[[:space:]]*{[^}]*\"auth\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CFG" | head -1)"
    if [ -n "$A" ]; then
      CRED="$(printf '%s' "$A" | base64 -d 2>/dev/null || true)"
      [ -n "$CRED" ] && info "凭据来源 : $CFG（docker login 缓存）" && break
    fi
  done
fi
if [ -z "$CRED" ]; then
  # credential helper：printf registry | docker-credential-<helper> get
  HELPER="$(sed -n 's/.*"credsStore"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME/.docker/config.json" 2>/dev/null | head -1)"
  [ -z "$HELPER" ] && HELPER="$(sed -n "s/.*\"$REGISTRY\"[[:space:]]*:[[:space:]]*{[^}]*\"credHelper\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$HOME/.docker/config.json" 2>/dev/null | head -1)"
  if [ -n "$HELPER" ] && command -v "docker-credential-$HELPER" >/dev/null 2>&1; then
    CRED="$(printf '%s' "$REGISTRY" | "docker-credential-$HELPER" get 2>/dev/null \
      | sed -n 's/.*"Username":"\([^"]*\)".*"Secret":"\([^"]*\)".*/\1:\2/p' | head -1)"
    [ -n "$CRED" ] && info "凭据来源 : docker-credential-$HELPER"
  fi
fi
[ -z "$CRED" ] && warn "未取到 Harbor 凭据，将尝试匿名访问（Harbor 项目公开时才可用）"

# ---------- HTTP(S) 探测 ----------
# 内网 Harbor 多为 HTTP（insecure-registries），先试 https 再退 http
SCHEME="${HARBOR_SCHEME:-}"
probe_base() {
  local base="$1" out
  out="$(curl -s -m 6 ${CRED:+-u "$CRED"} "$base/v2/" 2>/dev/null || true)"
  # 空响应 = 连不上（内网 Harbor 多为 HTTP，https 会直接失败）；带 errors = 未授权
  [ -n "$out" ] || return 1
  case "$out" in
    *'"errors"'*) return 1 ;;
    *) return 0 ;;
  esac
}
if [ -z "$SCHEME" ]; then
  if probe_base "https://$REGISTRY"; then SCHEME="https"; else SCHEME="http"; fi
fi
BASE="$SCHEME://$REGISTRY"
info "访问协议 : $SCHEME"

# ---------- 取某个仓库的版本标签 ----------
list_versions() {
  local repo="$1" body
  body="$(curl -s -m 10 ${CRED:+-u "$CRED"} "$BASE/v2/$repo/tags/list?n=1000" 2>/dev/null || true)"
  [ -n "$body" ] || return 1
  case "$body" in
    *'"errors"'*) return 1 ;;
  esac
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r '.tags[]? // empty'
  else
    printf '%s' "$body" \
      | sed -e 's/.*"tags"[[:space:]]*:[[:space:]]*\[//' -e 's/\].*//' \
      | tr ',' '\n' \
      | sed -n 's/^[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p'
  fi | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true
}

# ---------- 确定目标版本 ----------
if [ -n "$WANT_TAG" ]; then
  TARGET="$WANT_TAG"
  info "指定版本 : $TARGET（跳过探测）"
else
  TAGS_BE="$(list_versions "$REPO_BE" || true)"
  [ -n "$TAGS_BE" ] || die "拿不到 $REPO_BE 的版本列表（凭据不对 / 网络不通 / 仓库名不对）。
    排查：curl -s -u <user>:<pass> $BASE/v2/$REPO_BE/tags/list
    手工更新：bash scripts/harbor_update.sh --tag vX.Y.Z" 2

  LATEST_BE="$(printf '%s\n' "$TAGS_BE" | sort -V | tail -1)"
  [ -n "$LATEST_BE" ] || die "仓库里没有形如 vX.Y.Z 的正式版本标签" 2

  # 后端与前端必须都有这个版本，否则可能出现「后端新 + 前端旧」的错配
  TAGS_FE="$(list_versions "$REPO_FE" || true)"
  if [ -z "$TAGS_FE" ]; then
    warn "拿不到 $REPO_FE 的标签列表，跳过前端校验（建议检查仓库名）"
    TARGET="$LATEST_BE"
  else
    TARGET=""
    # 从最新版往下找第一个前后端都有的版本（防止某次只推成功了一半）
    while read -r t; do
      [ -n "$t" ] || continue
      if printf '%s\n' "$TAGS_FE" | grep -qx "$t"; then TARGET="$t"; break; fi
    done <<< "$(printf '%s\n' "$TAGS_BE" | sort -Vr)"
    if [ -z "$TARGET" ]; then
      die "后端与前端没有共同的正式版本（后端最新 $LATEST_BE）。请确认 Harbor 上前端镜像是否推送成功。" 3
    fi
    [ "$TARGET" != "$LATEST_BE" ] && warn "后端最新是 $LATEST_BE，但前端还没有这个版本 → 本次更新到双方都有的 $TARGET"
  fi
  info "最新版本 : $TARGET（Harbor 上共有）"
fi

# ---------- 比较 ----------
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  if [ "$TARGET" = "$CUR_TAG" ]; then
    ok "已是最新版本 $CUR_TAG，无需更新"
  else
    echo "  需要更新：$CUR_TAG → $TARGET"
    echo "  执行：bash scripts/update_latest.sh"
  fi
  exit 0
fi

if [ "$TARGET" = "$CUR_TAG" ]; then
  ok "已是最新版本 $CUR_TAG，无需更新"
  exit 0
fi

CMD="bash scripts/harbor_update.sh --tag $TARGET${PASS_ARGS:+ ${PASS_ARGS[*]}}"
if [ "$DRY_RUN" -eq 1 ]; then
  info "dry-run，将执行：$CMD"
  exit 0
fi

info "更新：$CUR_TAG → $TARGET"
# shellcheck disable=SC2086
exec bash "$SCRIPT_DIR/harbor_update.sh" --tag "$TARGET" ${PASS_ARGS:+"${PASS_ARGS[@]}"}
