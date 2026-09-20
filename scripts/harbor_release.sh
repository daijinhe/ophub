#!/usr/bin/env bash
# harbor_release.sh —— 本地构建镜像 → 推送到内网 Harbor（构建/发布分离的「构建侧」）
#
# 为什么要分离：平台要跑在与互联网隔离的内网，内网既拉不到
# swr.cn-north-4.myhuaweicloud.com 的基础镜像，也访问不了 goproxy.cn /
# registry.npmmirror.com，因此**不在内网构建**。
# 约定：镜像一律在本地（有网）构建好 → push 到内网 Harbor → 内网 pull 后重启容器。
#
# 配套：
#   首次迁移 → scripts/migrate_export.sh（本地导出数据）+ migrate_import.sh（内网导入）
#   日常发版 → 本脚本构建并推 Harbor，内网侧 scripts/harbor_update.sh 拉取生效
#
# 用法：
#   bash scripts/harbor_release.sh                     # 按当前 VERSION 构建并推送
#   bash scripts/harbor_release.sh --with-base         # 额外推 postgres/redis 基础镜像（首次必做）
#   bash scripts/harbor_release.sh --tag v1.7.5        # 指定镜像 tag（默认取 VERSION）
#   bash scripts/harbor_release.sh --git "fix: xxx"    # 先走 release.sh（升版本+提交+打tag+推git）再构建推送
#   bash scripts/harbor_release.sh --no-build          # 跳过构建，直接 retag + push 本地已有镜像
#   bash scripts/harbor_release.sh --save-only         # 不推 Harbor，导出镜像 tar 到 dist/（Harbor 不可用时兜底）
#   bash scripts/harbor_release.sh --login             # 只执行 docker login
#   bash scripts/harbor_release.sh --status            # 只读：检查 Harbor 连通性与本地镜像
#
# 配置：复制 .env.harbor.example 为 .env.harbor 填好地址。密码**不建议**写进文件——
#       留空则交互输入，docker 会安全缓存到系统凭据管理器。
#
# 退出码：0 成功；1 参数/配置错误；2 构建失败；3 推送失败

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
info() { printf "${C_INFO}[harbor]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

# ---------- 读取 .env.harbor ----------
if [ -f .env.harbor ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.harbor
  set +a
  info "已读取 .env.harbor"
else
  warn "未找到 .env.harbor（可从 .env.harbor.example 复制），将只使用环境变量里的值"
fi

HARBOR_REGISTRY="${HARBOR_REGISTRY:-}"
HARBOR_PROJECT="${HARBOR_PROJECT:-ophub}"
HARBOR_USER="${HARBOR_USER:-}"
HARBOR_PASSWORD="${HARBOR_PASSWORD:-}"
TARGET_PLATFORM="${TARGET_PLATFORM:-}"

# 基础镜像的「本地源」（有网侧）。注意不要读 .env 里的 POSTGRES_IMAGE ——
# 那是给内网 compose 用的、指向 Harbor 的值，会形成自引用。
SWR_SRC="swr.cn-north-4.myhuaweicloud.com/pixiu-public/your-project"
BASE_POSTGRES_SRC="${BASE_POSTGRES_SRC:-$SWR_SRC/postgres:16}"
BASE_REDIS_SRC="${BASE_REDIS_SRC:-$SWR_SRC/redis:7.4.10}"

http_code() {
  local c
  # ⚠️ Git Bash 下 curl 即使正常拿到响应也可能返回非 0 退出码（CURLE_WRITE_ERROR）。
  #    写成 `curl ... || echo 000` 会把两部分拼起来（200 + 000 = 200000），
  #    check_registry 的 case 匹配不到 200/401/403，就会把可达的 Harbor 误判成不可达。
  c="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true)"
  printf '%s' "${c:-000}"
}

# Harbor / Gitea registry 都遵循 Docker Registry v2 协议：/v2/ 返回 401 即「服务在，需认证」
check_registry() {
  [ -n "$HARBOR_REGISTRY" ] || return 1
  local c
  c="$(http_code "http://$HARBOR_REGISTRY/v2/")"
  case "$c" in 200|401|403) return 0 ;; esac
  c="$(http_code "https://$HARBOR_REGISTRY/v2/")"
  case "$c" in 200|401|403) return 0 ;; esac
  return 1
}

# 检查 ~/.docker/config.json 是否已有该 registry 的凭据条目
# （明文 base64 / Windows 凭据管理器占位条目都是这种形式）。用 grep 即可，
# 避免 bash 嵌套 python 时的引号/变量展开坑。
has_auth() {
  local reg="$1" cfg="$HOME/.docker/config.json"
  [ -f "$cfg" ] || return 1
  grep -qF "\"$reg\"" "$cfg" 2>/dev/null
}

do_login() {
  [ -n "$HARBOR_REGISTRY" ] || die "未配置 HARBOR_REGISTRY（见 .env.harbor.example）"
  # 已缓存凭据（GCM / wincred / keychain 等）就跳过，避免非 TTY 下交互失败
  if has_auth "$HARBOR_REGISTRY"; then
    ok "已检测到 $HARBOR_REGISTRY 的 Docker 凭据缓存，跳过 login"
    return 0
  fi
  if [ -n "$HARBOR_USER" ] && [ -n "$HARBOR_PASSWORD" ]; then
    printf '%s' "$HARBOR_PASSWORD" | docker login "$HARBOR_REGISTRY" -u "$HARBOR_USER" --password-stdin
  elif [ -n "$HARBOR_USER" ]; then
    info "登录 $HARBOR_REGISTRY（账号 $HARBOR_USER，密码请交互输入；docker 会缓存到凭据管理器）"
    docker login "$HARBOR_REGISTRY" -u "$HARBOR_USER"
  else
    info "登录 $HARBOR_REGISTRY（请输入账号密码；docker 会缓存到凭据管理器，之后无需重复输入）"
    docker login "$HARBOR_REGISTRY"
  fi
}

# ---------- 只读状态 ----------
show_status() {
  echo "  仓库地址 : ${HARBOR_REGISTRY:-<未配置>}"
  echo "  项目名   : $HARBOR_PROJECT"
  echo "  当前版本 : $(tr -d '[:space:]' < VERSION 2>/dev/null || echo '?')"
  if [ -z "$HARBOR_REGISTRY" ]; then
    warn "未配置 HARBOR_REGISTRY，无法检查远端"
  elif check_registry; then
    ok "Harbor 可达（$HARBOR_REGISTRY）"
  else
    warn "Harbor 不可达（$HARBOR_REGISTRY）—— 检查网络/地址/端口，HTTP 仓库还需在 daemon.json 配 insecure-registries"
  fi
  echo "  本地镜像 :"
  docker images --format '    {{.Repository}}:{{.Tag}}  {{.Size}}' 2>/dev/null \
    | grep -E 'ophub-(backend|frontend)' || echo "    (无)"
  if [ -n "$TARGET_PLATFORM" ]; then
    echo "  目标平台 : $TARGET_PLATFORM"
  else
    echo "  目标平台 : 本机架构（如需交叉编译，设 TARGET_PLATFORM=linux/arm64）"
  fi
}

# ---------- 参数解析 ----------
WITH_BASE=0; NO_BUILD=0; SAVE_ONLY=0; LOGIN_ONLY=0; GIT_MSG=""; IMAGE_TAG_OPT=""
GIT_EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --status)    show_status; exit 0 ;;
    --login)     LOGIN_ONLY=1; shift ;;
    --with-base) WITH_BASE=1; shift ;;
    --no-build)  NO_BUILD=1; shift ;;
    --save-only) SAVE_ONLY=1; shift ;;
    --tag)       IMAGE_TAG_OPT="${2:-}"; [ -n "$IMAGE_TAG_OPT" ] || die "--tag 需要一个值"; shift 2 ;;
    --git)       GIT_MSG="${2:-}"; [ -n "$GIT_MSG" ] || die "--git 需要提交信息"; shift 2 ;;
    --minor|--major|--no-push) GIT_EXTRA+=("$1"); shift ;;
    -h|--help)   sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "未知参数：$1（-h 看用法）" ;;
  esac
done

if [ "$LOGIN_ONLY" -eq 1 ]; then
  do_login && ok "登录完成"
  exit 0
fi

# ---------- 可选的 git 发版 ----------
if [ -n "$GIT_MSG" ]; then
  info "先执行 release.sh 发版：$GIT_MSG"
  bash scripts/release.sh "$GIT_MSG" "${GIT_EXTRA[@]+"${GIT_EXTRA[@]}"}"
  ok "git 发版完成"
fi

VER="$(tr -d '[:space:]' < VERSION 2>/dev/null || echo '')"
[ -n "$VER" ] || die "读不到 VERSION 文件"
TAG="${IMAGE_TAG_OPT:-$VER}"

IMAGE_BACKEND_REPO="$HARBOR_REGISTRY/$HARBOR_PROJECT/ophub-backend"
IMAGE_FRONTEND_REPO="$HARBOR_REGISTRY/$HARBOR_PROJECT/ophub-frontend"
IMAGE_POSTGRES_REPO="$HARBOR_REGISTRY/$HARBOR_PROJECT/postgres"
IMAGE_REDIS_REPO="$HARBOR_REGISTRY/$HARBOR_PROJECT/redis"

BASE_POSTGRES_TAG="${BASE_POSTGRES_SRC##*:}"
BASE_REDIS_TAG="${BASE_REDIS_SRC##*:}"

echo
echo "  ── 本次构建 ──────────────────────────────────────────"
echo "    版本 / 镜像 tag : $TAG"
echo "    后端            : $IMAGE_BACKEND_REPO:$TAG"
echo "    前端            : $IMAGE_FRONTEND_REPO:$TAG"
[ "$WITH_BASE" -eq 1 ] && echo "    基础镜像        : $IMAGE_POSTGRES_REPO:$BASE_POSTGRES_TAG , $IMAGE_REDIS_REPO:$BASE_REDIS_TAG"
echo "  ─────────────────────────────────────────────────────"
echo

# ---------- 1. 构建 ----------
if [ "$NO_BUILD" -eq 0 ]; then
  info "构建后端镜像 …"
  PLATFORM_ARG=()
  [ -n "$TARGET_PLATFORM" ] && PLATFORM_ARG=(--platform "$TARGET_PLATFORM")
  DOCKER_BUILDKIT=0 docker build "${PLATFORM_ARG[@]+"${PLATFORM_ARG[@]}"}" -t ophub-backend:latest ./backend \
    || die "后端构建失败" 2
  ok "后端构建完成"

  info "构建前端镜像 …"
  DOCKER_BUILDKIT=0 docker build "${PLATFORM_ARG[@]+"${PLATFORM_ARG[@]}"}" -t ophub-frontend:latest ./frontend \
    || die "前端构建失败" 2
  ok "前端构建完成"
elif [ "$NO_BUILD" -eq 1 ]; then
  warn "按 --no-build 跳过构建，直接使用本地已有的 ophub-backend/frontend:latest"
fi

# ---------- 2. 打标 ----------
info "打标 …"
docker tag ophub-backend:latest  "$IMAGE_BACKEND_REPO:$TAG"
docker tag ophub-frontend:latest "$IMAGE_FRONTEND_REPO:$TAG"
docker tag ophub-backend:latest  "$IMAGE_BACKEND_REPO:latest"
docker tag ophub-frontend:latest "$IMAGE_FRONTEND_REPO:latest"

if [ "$WITH_BASE" -eq 1 ]; then
  info "准备基础镜像 …"
  docker image inspect "$BASE_POSTGRES_SRC" >/dev/null 2>&1 || docker pull "$BASE_POSTGRES_SRC"
  docker image inspect "$BASE_REDIS_SRC"    >/dev/null 2>&1 || docker pull "$BASE_REDIS_SRC"
  docker tag "$BASE_POSTGRES_SRC" "$IMAGE_POSTGRES_REPO:$BASE_POSTGRES_TAG"
  docker tag "$BASE_REDIS_SRC"    "$IMAGE_REDIS_REPO:$BASE_REDIS_TAG"
fi
ok "打标完成"

# ---------- 3a. 只导出 tar（离线兜底）----------
if [ "$SAVE_ONLY" -eq 1 ]; then
  mkdir -p dist
  OUT="dist/ophub-images-$TAG.tar.gz"
  IMGS=("$IMAGE_BACKEND_REPO:$TAG" "$IMAGE_FRONTEND_REPO:$TAG")
  [ "$WITH_BASE" -eq 1 ] && IMGS+=("$IMAGE_POSTGRES_REPO:$BASE_POSTGRES_TAG" "$IMAGE_REDIS_REPO:$BASE_REDIS_TAG")
  info "导出镜像到 $OUT …"
  docker save "${IMGS[@]}" | gzip -9 > "$OUT"
  ok "已导出：$OUT（$(du -h "$OUT" | cut -f1)）"
  echo
  echo "  内网侧导入： docker load -i <解压后的 tar>"
  exit 0
fi

# ---------- 3b. 推送 ----------
[ -n "$HARBOR_REGISTRY" ] || die "未配置 HARBOR_REGISTRY，无法推送。可先用 --save-only 导出 tar 走离线通道。"
check_registry || die "Harbor 不可达：$HARBOR_REGISTRY（检查地址/端口；HTTP 仓库需在 daemon.json 加 insecure-registries）"

do_login || die "docker login 失败" 3

PUSH_LIST=("$IMAGE_BACKEND_REPO:$TAG" "$IMAGE_FRONTEND_REPO:$TAG" "$IMAGE_BACKEND_REPO:latest" "$IMAGE_FRONTEND_REPO:latest")
if [ "$WITH_BASE" -eq 1 ]; then
  PUSH_LIST+=("$IMAGE_POSTGRES_REPO:$BASE_POSTGRES_TAG" "$IMAGE_REDIS_REPO:$BASE_REDIS_TAG")
fi

for img in "${PUSH_LIST[@]}"; do
  info "推送 $img …"
  docker push "$img" >/dev/null || die "推送失败：$img" 3
  ok "已推送 $img"
done

# ---------- 4. 输出内网侧需要设置的变量 ----------
echo
ok "全部推送完成"
echo
echo "  ── 内网 .env 里对应改成（当前版本 $TAG）────────────────"
cat <<EOF
POSTGRES_IMAGE=$IMAGE_POSTGRES_REPO:$BASE_POSTGRES_TAG
REDIS_IMAGE=$IMAGE_REDIS_REPO:$BASE_REDIS_TAG
BACKEND_IMAGE=$IMAGE_BACKEND_REPO:$TAG
FRONTEND_IMAGE=$IMAGE_FRONTEND_REPO:$TAG
EOF
echo "  ─────────────────────────────────────────────────────"
echo "  内网生效： cd <内网部署目录> && bash scripts/harbor_update.sh"
