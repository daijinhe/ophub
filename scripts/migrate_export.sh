#!/usr/bin/env bash
# migrate_export.sh —— 首次迁移·本地侧：把「数据 + 密钥配置 + 内网脚本」打成迁移包
#
# 产出一个自包含的 tar.gz，拷进内网后由包内 scripts/migrate_import.sh 一键导入。
#
# 用法：
#   bash scripts/migrate_export.sh                 # 导出数据 + 配置 + 脚本（推荐）
#   bash scripts/migrate_export.sh --with-images   # 额外把 4 个镜像打进包里（Harbor 不可用时兜底）
#   bash scripts/migrate_export.sh --no-db         # 只导配置与脚本（内网全新初始化、不搬数据）
#   bash scripts/migrate_export.sh -o /path/out.tar.gz
#
# ⚠️ 迁移包里的 env/.env 含 JWT_SECRET 与 PWD_ENC_KEY：
#    PWD_ENC_KEY 必须是「同一把」，否则库里 enc:v1: 加密的资产密码全部解不开。
#    包等同密钥文件，请通过安全通道传递（不要走邮件/群）。
#
# 退出码：0 成功；1 参数/环境错误；2 数据库导出失败

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
info() { printf "${C_INFO}[export]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

WITH_IMAGES=0; WITH_DB=1; OUT_OPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-images) WITH_IMAGES=1; shift ;;
    --no-db)       WITH_DB=0; shift ;;
    -o|--output)   OUT_OPT="${2:-}"; [ -n "$OUT_OPT" ] || die "-o 需要一个路径"; shift 2 ;;
    -h|--help)     sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "未知参数：$1（-h 看用法）" ;;
  esac
done

# ---------- 前置检查 ----------
[ -f VERSION ] || die "找不到 VERSION 文件（应在仓库根）"
[ -f .env ]    || die "找不到 .env —— 迁移包必须带上密钥，否则内网解不开加密凭据"
[ -f docker-compose.yml ] || die "找不到 docker-compose.yml"

VER="$(tr -d '[:space:]' < VERSION)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT_OPT:-dist/ophub-migrate-$VER-$TS.tar.gz}"
# 注意：这里不能用 mktemp -d —— 在 Git Bash 下它返回 Windows 风格路径（C:\...），
# 与 POSIX 路径拼接后会错乱；而且本机的删除 shim 会在 rm 时失败，配合 set -e 直接中断脚本。
# 统一放在项目 dist/ 下，路径完全可控。
mkdir -p dist
WORK="dist/.migrate-work"
rm -rf "$WORK" 2>/dev/null || true
mkdir -p "$WORK"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT

# 从 .env 读取库连接（compose 用的是这套）
env_get() { sed -n "s/^$1=//p" .env | head -1; }
DB_USER="$(env_get DB_USER)"; DB_NAME="$(env_get DB_NAME)"
: "${DB_USER:=ophub}"; : "${DB_NAME:=ophub}"
PG_C="${PG_CONTAINER:-ophub-postgres}"

info "版本 $VER，输出 $OUT"
mkdir -p "$WORK/db" "$WORK/env" "$WORK/compose" "$WORK/scripts"

# ---------- 1. 数据库导出 ----------
HAS_DB=0
if [ "$WITH_DB" -eq 1 ]; then
  docker inspect -f '{{.State.Running}}' "$PG_C" >/dev/null 2>&1 \
    || die "PostgreSQL 容器 $PG_C 不在运行，先 docker compose up -d postgres"
  info "导出数据库（$DB_NAME）…"
  # --clean --if-exists：内网可重复导入而不报「已存在」
  # --no-owner --no-privileges：避免内网角色名与本地不一致导致导入失败
  # 用 PIPESTATUS 取 docker 的退出码（管道里 $? 是 gzip 的）；不落临时错误文件，避免触发删除 shim
  set +e
  docker exec "$PG_C" pg_dump -U "$DB_USER" -d "$DB_NAME" \
      --no-owner --no-privileges --clean --if-exists | gzip -9 > "$WORK/db/ophub.sql.gz"
  rc=${PIPESTATUS[0]}
  set -e
  [ "$rc" -eq 0 ] || die "pg_dump 失败（退出码 $rc）" 2
  [ -s "$WORK/db/ophub.sql.gz" ] || die "导出的 SQL 是空的，检查 DB_NAME/DB_USER 是否正确" 2
  ok "数据库已导出（$(du -h "$WORK/db/ophub.sql.gz" | cut -f1)）"

  # 行数快照 —— 内网导入后据此逐表比对，这是「数据完整」的客观依据
  info "生成行数快照 …"
  SNAP_SQL="$(docker exec "$PG_C" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
    "select string_agg(format('select %L as tbl, count(*)::text as cnt from %I', tablename, tablename), ' union all ' order by tablename) from pg_tables where schemaname='public';" || true)"
  if [ -n "$SNAP_SQL" ]; then
    docker exec "$PG_C" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F' ' -c "$SNAP_SQL" \
      > "$WORK/db/ROWCOUNTS.txt" 2>/dev/null || warn "行数快照生成失败（不阻塞迁移）"
    [ -s "$WORK/db/ROWCOUNTS.txt" ] && ok "行数快照：$(wc -l < "$WORK/db/ROWCOUNTS.txt" | tr -d ' ') 张表"
  fi
  HAS_DB=1
else
  warn "按 --no-db 跳过数据库导出（内网将是全新空库）"
fi

# ---------- 2. 配置与文件 ----------
info "收集配置 …"
cp .env "$WORK/env/.env"
# 快照里去掉 Harbor 镜像变量，避免把「本地构建」的地址带进内网（导入脚本会按 HARBOR_* 重建）
grep -v -E '^(POSTGRES_IMAGE|REDIS_IMAGE|BACKEND_IMAGE|FRONTEND_IMAGE)=' "$WORK/env/.env" > "$WORK/env/.env.tmp" || true
mv "$WORK/env/.env.tmp" "$WORK/env/.env"

cp docker-compose.yml "$WORK/compose/"
[ -f .env.example ] && cp .env.example "$WORK/compose/"

for s in migrate_import.sh harbor_update.sh; do
  [ -f "scripts/$s" ] && cp "scripts/$s" "$WORK/scripts/"
done
[ -f scripts/migrate_export.sh ] && cp scripts/migrate_export.sh "$WORK/scripts/"  # 便于内网再导出

# ---------- 3. 镜像（可选）----------
# 先读 Harbor 配置：离线包要优先打包「Harbor 命名 + 版本号」的镜像，
# 这样内网 docker load 出来的名字就和 Harbor 通道下的完全一致，
# 两种通道的 .env / compose 不需要任何差异。
HARBOR_REGISTRY_V=""; HARBOR_PROJECT_V="ophub"
if [ -f .env.harbor ]; then
  HARBOR_REGISTRY_V="$(sed -n 's/^HARBOR_REGISTRY=//p' .env.harbor | head -1 | tr -d '\r')"
  HARBOR_PROJECT_V="$(sed -n 's/^HARBOR_PROJECT=//p' .env.harbor | head -1 | tr -d '\r')"
  : "${HARBOR_PROJECT_V:=ophub}"
fi

HAS_IMAGES=0
if [ "$WITH_IMAGES" -eq 1 ]; then
  info "导出镜像（体积较大，请耐心等待）…"
  SWR_SRC="swr.cn-north-4.myhuaweicloud.com/pixiu-public/your-project"
  IMGS=()
  # 优先用 Harbor 命名的版本 tag；没有（还没跑过 harbor_release.sh / 没配 .env.harbor）
  # 就退回本地 build 出来的 ophub-*:latest —— 两者层内容相同，只是名字不同。
  add_app_img() {  # $1=ophub-backend|ophub-frontend
    local cand="$HARBOR_REGISTRY_V/$HARBOR_PROJECT_V/$1:$VER"
    if [ -n "$HARBOR_REGISTRY_V" ] && docker image inspect "$cand" >/dev/null 2>&1; then
      IMGS+=("$cand")
    elif docker image inspect "$1:latest" >/dev/null 2>&1; then
      IMGS+=("$1:latest")
    else
      warn "缺少本地镜像 $1（先跑 scripts/harbor_release.sh）"
    fi
  }
  add_app_img ophub-backend
  add_app_img ophub-frontend
  for i in "$SWR_SRC/postgres:16" "$SWR_SRC/redis:7.4.10"; do
    docker image inspect "$i" >/dev/null 2>&1 && IMGS+=("$i") || warn "缺少基础镜像 $i"
  done
  if [ "${#IMGS[@]}" -gt 0 ]; then
    mkdir -p "$WORK/images"
    docker save "${IMGS[@]}" | gzip -9 > "$WORK/images/ophub-images.tar.gz"
    HAS_IMAGES=1
    ok "镜像已打包（$(du -h "$WORK/images/ophub-images.tar.gz" | cut -f1)）"
    for i in "${IMGS[@]}"; do echo "      $i"; done
  fi
fi

# ---------- 4. 清单 ----------

GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_TAG="$(git describe --tags --exact-match 2>/dev/null || echo '')"

cat > "$WORK/MANIFEST.txt" <<EOF
# 云枢 OpsHub迁移包清单（导入脚本会解析本文件，请勿改动键名）
platform=ophub
version=$VER
git_commit=$GIT_COMMIT
git_tag=$GIT_TAG
exported_at=$TS
db_name=$DB_NAME
db_user=$DB_USER
has_db=$HAS_DB
has_images=$HAS_IMAGES
harbor_registry=$HARBOR_REGISTRY_V
harbor_project=$HARBOR_PROJECT_V

# 文件校验和（sha256）
EOF

( cd "$WORK" && find . -type f ! -name MANIFEST.txt | sort | while read -r f; do
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f"; else shasum -a 256 "$f"; fi
  done ) >> "$WORK/MANIFEST.txt"

# ---------- 5. 内网操作说明 ----------
cat > "$WORK/README-内网部署.md" <<'EOF'
# 内网部署步骤（首次迁移）

前置：目标机已装 Docker + Docker Compose v2，且能访问内网 Harbor。

1) 解包
   mkdir -p /opt/ophub
   tar -xzf ophub-migrate-*.tar.gz -C /opt/ophub

2) 导入（会自动：登录 Harbor → 拉镜像 → 起 PG/Redis → 恢复数据 → 起前后端 → 自检）
   cd /opt/ophub
   bash scripts/migrate_import.sh

   若 Harbor 地址与导出时不同，可覆盖：
   bash scripts/migrate_import.sh --harbor harbor.internal.example --project ophub

3) 访问 http://<内网IP>:8088  默认账号 admin / admin123（**登录后立刻改密**）

⚠️ 包内 env/.env 含密钥，等同密码文件，用完请从内网删除或妥善保管。
⚠️ PWD_ENC_KEY 不能改：改了之后库里加密存储的资产密码会全部解不开。
EOF

# ---------- 6. 打包 ----------
mkdir -p "$(dirname "$OUT")"
# tar 用了 -C 切目录后，-f 的相对路径会相对**新目录**解析 → 必须先把输出转成绝对路径
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
info "打包 …"
tar -czf "$OUT_ABS" -C "$WORK" .
ok "迁移包已生成：$OUT（$(du -h "$OUT" | cut -f1)）"
echo
echo "  内含："
(tar -tzf "$OUT" | grep -v '/$' || true) | sed 's/^/    /' | head -20
echo "  下一步：把该文件拷到内网，解包后执行 scripts/migrate_import.sh"
