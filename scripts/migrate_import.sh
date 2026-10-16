#!/usr/bin/env bash
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# migrate_import.sh —— 首次迁移·内网侧：把迁移包导入并启动平台
#
# 在解包后的目录里执行。脚本按顺序完成：
#   环境检查 → 生成 .env（镜像地址指向内网 Harbor）→ 拉镜像 → 起 PG/Redis
#   → 恢复数据 → 起 frontend/backend → 健康检查 → 逐表行数比对
#
# 用法：
#   bash scripts/migrate_import.sh                      # 全自动（Harbor 地址取自迁移包清单）
#   bash scripts/migrate_import.sh --harbor harbor.internal.example --project ophub
#   bash scripts/migrate_import.sh --load-images        # 改用包内 images/*.tar.gz（不依赖 Harbor）
#   bash scripts/migrate_import.sh --skip-db            # 不恢复数据（全新空库）
#   bash scripts/migrate_import.sh --force --yes        # 库已有数据时强制覆盖，不再交互
#
# 幂等性：重复执行安全；但恢复数据库会 DROP + 重建（覆盖现有数据），故库非空时会要求确认。
#
# 退出码：0 成功；1 参数/环境错误；2 镜像获取失败；3 数据库恢复失败；4 健康检查失败

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_ROOT"

C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
info() { printf "${C_INFO}[import]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

[ -f MANIFEST.txt ] || die "当前目录不是迁移包根（找不到 MANIFEST.txt）。请在解包后的目录里执行。"

# ---------- 参数 ----------
HARBOR_OPT=""; PROJECT_OPT=""; LOAD_IMAGES=0; WITH_DB=1; FORCE=0; ASSUME_YES=0; NO_PULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --harbor)      HARBOR_OPT="${2:-}";  [ -n "$HARBOR_OPT" ]  || die "--harbor 需要一个地址"; shift 2 ;;
    --project)     PROJECT_OPT="${2:-}"; [ -n "$PROJECT_OPT" ] || die "--project 需要一个名字"; shift 2 ;;
    --load-images) LOAD_IMAGES=1; shift ;;
    --skip-db)     WITH_DB=0; shift ;;
    --no-pull)     NO_PULL=1; shift ;;
    --force)       FORCE=1; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    -h|--help)     sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "未知参数：$1（-h 看用法）" ;;
  esac
done

# ---------- 读清单 ----------
mani() { sed -n "s/^$1=//p" MANIFEST.txt | head -1 | tr -d '\r'; }
VER="$(mani version)"; HAS_DB="$(mani has_db)"; HARBOR_REGISTRY="$(mani harbor_registry)"
HARBOR_PROJECT="$(mani harbor_project)"; DB_NAME="$(mani db_name)"; DB_USER="$(mani db_user)"
: "${HARBOR_PROJECT:=ophub}"; : "${DB_NAME:=ophub}"; : "${DB_USER:=ophub}"
[ -n "$HARBOR_OPT" ]    && HARBOR_REGISTRY="$HARBOR_OPT"
[ -n "$PROJECT_OPT" ]   && HARBOR_PROJECT="$PROJECT_OPT"
# 数据库容器名。默认与 docker-compose.yml 里的 container_name 一致；
# 可用 PG_CONTAINER 覆盖（同机多环境 / 测试时用）。
PG_C="${PG_CONTAINER:-ophub-postgres}"

echo "  迁移包版本 : $VER"
echo "  Harbor     : ${HARBOR_REGISTRY:-<未指定>} / 项目 ${HARBOR_PROJECT}"
echo "  数据库     : $DB_NAME（用户 $DB_USER）  $( [ "$HAS_DB" = "1" ] && echo '含数据' || echo '不含数据' )"
echo

# ---------- 1. 环境检查 ----------
command -v docker >/dev/null 2>&1 || die "未找到 docker"
docker info >/dev/null 2>&1 || die "docker 未运行（或当前用户无权限，试试 sudo 或加入 docker 组）"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose（需要 v2，插件形式）"
ok "docker 与 compose 就绪"

[ -f env/.env ] || die "找不到 env/.env（迁移包不完整）"
[ -f compose/docker-compose.yml ] || die "找不到 compose/docker-compose.yml（迁移包不完整）"

# ---------- 2. 生成 .env ----------
info "生成 .env …"
# 统一去掉 CRLF：.env 在 Windows 侧生成时可能带 \r，会让密码/密钥多出一个不可见字符
tr -d '\r' < env/.env > .env

set_env_var() {
  local k="$1" v="$2" tmp=".env.tmp.$$"
  if grep -q "^$k=" .env; then
    sed "s|^$k=.*|$k=$v|" .env > "$tmp"   # 用 | 分隔，避开地址里的 /
  else
    cp .env "$tmp"; printf '\n%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  mv "$tmp" .env
}

# 按镜像获取方式确定 .env 里的镜像地址（这是本地 → 内网的关键差异）
if [ "$LOAD_IMAGES" -eq 1 ]; then
  # 离线通道：镜像来自包内 tar，不联网。具体镜像名要等 load 完、解析出真实标签后
  # 再写回 .env —— tar 里的名字带的是「打包时的 Harbor 地址」，未必等于当前地址。
  NO_PULL=1
else
  [ -n "$HARBOR_REGISTRY" ] || die "迁移包里没有 Harbor 地址，请用 --harbor <地址:端口> 指定"
  set_env_var POSTGRES_IMAGE "$HARBOR_REGISTRY/$HARBOR_PROJECT/postgres:16"
  set_env_var REDIS_IMAGE    "$HARBOR_REGISTRY/$HARBOR_PROJECT/redis:7.4.10"
  set_env_var BACKEND_IMAGE  "$HARBOR_REGISTRY/$HARBOR_PROJECT/ophub-backend:$VER"
  set_env_var FRONTEND_IMAGE "$HARBOR_REGISTRY/$HARBOR_PROJECT/ophub-frontend:$VER"
fi

WEB_PORT="$(sed -n 's/^WEB_PORT=//p' .env | head -1 | tr -d '\r')"
: "${WEB_PORT:=10001}"
ok ".env 就绪（WEB_PORT=$WEB_PORT）"

cp -f compose/docker-compose.yml ./docker-compose.yml

# 前端容器名从 compose 里取，供「没有 curl 时」的兜底健康检查使用
# （不能硬编码 ophub-frontend：改过 container_name 的部署会探错对象）
FE_C="$(sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' docker-compose.yml \
  | tr -d '\r' | grep -i front | head -1 || true)"
: "${FE_C:=ophub-frontend}"

# ---------- 3. 获取镜像 ----------
if [ "$LOAD_IMAGES" -eq 1 ]; then
  [ -f images/ophub-images.tar.gz ] || die "包内没有 images/ophub-images.tar.gz" 2
  info "从包内加载镜像（约需 1-3 分钟）…"
  set +e
  LOAD_OUT="$(gunzip -c images/ophub-images.tar.gz | docker load 2>&1)"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || { printf '%s\n' "$LOAD_OUT" | tail -10 >&2; die "镜像加载失败" 2; }
  printf '%s\n' "$LOAD_OUT" | grep -i 'loaded image' | sed 's/^/    /' || true

  # 把 load 进来的真实镜像名写回 .env：离线包里的名字带的是「打包时的 Harbor 地址」，
  # 与当前内网 Harbor 未必相同；不写回的话 compose 会去找一个本地不存在的名字。
  # ⚠️ 脚本开了 set -o pipefail：管道里 grep 无匹配返回 1 → 函数返回 1 → 赋值失败 → set -e 直接退出。
  # 所以必须 || true，把「没找到」变成正常的空值返回（--with-base 未包含基础镜像时就会命中）。
  pick_img() { printf '%s\n' "$LOAD_OUT" | sed -n 's/^Loaded image: //p' | grep -E "$1" | head -1 || true; }
  IMG_BE="$(pick_img 'ophub-backend')"
  IMG_FE="$(pick_img 'ophub-frontend')"
  IMG_PG="$(pick_img '(^|/)postgres:')"
  IMG_RD="$(pick_img '(^|/)redis:')"
  [ -n "$IMG_BE" ] && set_env_var BACKEND_IMAGE  "$IMG_BE"
  [ -n "$IMG_FE" ] && set_env_var FRONTEND_IMAGE "$IMG_FE"
  [ -n "$IMG_PG" ] && set_env_var POSTGRES_IMAGE "$IMG_PG"
  [ -n "$IMG_RD" ] && set_env_var REDIS_IMAGE    "$IMG_RD"
  ok "镜像已加载"
else
  info "登录镜像仓库 $HARBOR_REGISTRY …"
  docker login "$HARBOR_REGISTRY" || die "docker login 失败" 2
  if [ "$NO_PULL" -eq 0 ]; then
    info "拉取镜像 …（首次约 1-2GB，视网络而定）"
    PULL_LOG="$(mktemp)"
    if ! docker compose pull 2>&1 | tee "$PULL_LOG"; then
      if grep -qi 'http: server gave HTTP response to HTTPS client\|insecure' "$PULL_LOG"; then
        echo
        warn "这是 HTTP 仓库未授权导致的。请在内网机上执行："
        echo "    echo '{\"insecure-registries\":[\"$HARBOR_REGISTRY\"]}' | sudo tee /etc/docker/daemon.json"
        echo "    sudo systemctl restart docker"
      fi
      rm -f "$PULL_LOG"
      die "镜像拉取失败" 2
    fi
    rm -f "$PULL_LOG"
  fi
  ok "镜像就绪"
fi

# ---------- 4. 起数据库 ----------
info "启动 PostgreSQL 与 Redis …"
docker compose up -d postgres redis >/dev/null
for i in $(seq 1 60); do
  if docker exec "$PG_C" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 60 ] && die "PostgreSQL 60s 内未就绪，检查：docker logs $PG_C"
  sleep 2
done
ok "PostgreSQL 就绪"

# ---------- 4.5 安全校验：确认要写入的是「本部署」的数据库 ----------
# 容器名是固定的。若同机上还跑着另一套平台（或本脚本被在错误目录执行），
# 恢复数据就会写进别人的库 —— 这是不可逆的覆盖操作，必须交叉校验。
DEPLOY_PROJ="$(sed -n 's/^name:[[:space:]]*//p' docker-compose.yml 2>/dev/null | head -1 | tr -d '\r')"
: "${DEPLOY_PROJ:=ophub}"
PG_PROJ="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PG_C" 2>/dev/null || true)"
if [ -n "$PG_PROJ" ] && [ "$PG_PROJ" != "$DEPLOY_PROJ" ]; then
  warn "目标数据库容器「$PG_C」属于 compose 项目「$PG_PROJ」，而当前部署项目是「$DEPLOY_PROJ」"
  warn "继续会把数据写进「$PG_PROJ」那一套环境，而不是当前目录这一套。"
  if [ "$ASSUME_YES" -eq 0 ]; then
    printf "  确认仍要写入 %s 吗？输入 yes 继续：" "$PG_PROJ"
    read -r a
    [ "$a" = "yes" ] || die "已取消（未做任何改动）"
  fi
fi

# ---------- 5. 恢复数据 ----------
if [ "$WITH_DB" -eq 1 ] && [ "$HAS_DB" = "1" ] && [ -f db/ophub.sql.gz ]; then
  EXIST_TABLES="$(docker exec "$PG_C" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '[:space:]' || true)"
  : "${EXIST_TABLES:=0}"

  if [ "$EXIST_TABLES" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
    warn "目标库已有 $EXIST_TABLES 张表，继续会 DROP 并重建，**现有数据将被覆盖**"
    if [ "$ASSUME_YES" -eq 0 ]; then
      printf "  确认覆盖请输入 yes："
      read -r ans
      [ "$ans" = "yes" ] || die "已取消（未做任何改动）"
    fi
  fi

  info "恢复数据 …"
  set +e
  gunzip -c db/ophub.sql.gz | docker exec -i "$PG_C" psql -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -q > /tmp/ophub_restore.log 2>&1
  rc=${PIPESTATUS[1]}
  set -e
  if [ "$rc" -ne 0 ]; then
    (grep -v -i 'notice' /tmp/ophub_restore.log || true) | tail -20 >&2
    die "数据库恢复失败（完整日志 /tmp/ophub_restore.log）" 3
  fi
  ok "数据恢复完成"

  if [ -f db/ROWCOUNTS.txt ]; then
    info "逐表比对行数 …"
    SNAP_SQL="$(docker exec "$PG_C" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
      "select string_agg(format('select %L as tbl, count(*)::text as cnt from %I', tablename, tablename), ' union all ' order by tablename) from pg_tables where schemaname='public';" || true)"
    docker exec "$PG_C" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F' ' -c "$SNAP_SQL" 2>/dev/null | tr -d '\r' | sed '/^$/d' > /tmp/ophub_after.txt || true
    tr -d '\r' < db/ROWCOUNTS.txt | sed '/^$/d' > /tmp/ophub_before.txt
    if diff -u /tmp/ophub_before.txt /tmp/ophub_after.txt > /tmp/ophub_rowdiff.txt 2>&1; then
      ok "全部 $(wc -l < /tmp/ophub_after.txt | tr -d ' ') 张表行数一致 ✓"
    else
      warn "以下表行数不一致（- 迁移前 / + 迁移后）："
      (grep -E '^[-+][^-+]' /tmp/ophub_rowdiff.txt || true) | sed 's/^/      /' | head -30
      warn "常见原因：导出与导入之间源库仍在写入。核对无误可忽略。"
    fi
  fi
else
  warn "按 --skip-db 或迁移包不含数据：跳过数据恢复（内网为全新空库）"
fi

# ---------- 6. 起全部服务 ----------
info "启动 frontend 与 backend …"
# --no-build：镜像必须来自 Harbor/本地，绝不在内网触发构建（内网拉不到 go/npm 源）
docker compose up -d --no-build

# ---------- 7. 健康检查 ----------
info "健康检查 …"
http_code() {
  local c
  # ⚠️ Git Bash 下 curl 即使正常拿到响应也可能返回非 0 退出码。
  #    写成 `curl ... || echo 000` 会把两个结果拼接起来（200 + 000 = 200000），
  #    所以这里只取 -w 写出的内容，为空才回落到 000。
  c="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null || true)"
  printf '%s' "${c:-000}"
}
if ! command -v curl >/dev/null 2>&1; then
  http_code() { docker exec "$FE_C" wget -q -S -O /dev/null "$1" 2>&1 | sed -n 's/.*HTTP\/[0-9.]* \([0-9]\{3\}\).*/\1/p' | head -1 || echo 000; }
fi

FE_CODE="000"
for i in $(seq 1 30); do
  FE_CODE="$(http_code "http://127.0.0.1:$WEB_PORT/")"
  [ "$FE_CODE" != "000" ] && break
  sleep 2
done
[ "$FE_CODE" = "200" ] || warn "前端返回 HTTP $FE_CODE（期望 200）"

BE_CODE="000"
for i in $(seq 1 30); do
  # 未登录访问受保护接口，401/403 都说明后端活着
  BE_CODE="$(http_code "http://127.0.0.1:$WEB_PORT/api/auth/me")"
  [ "$BE_CODE" != "000" ] && break
  sleep 2
done

echo
docker compose ps
echo
if [ "$FE_CODE" = "200" ] && [ "$BE_CODE" != "000" ] && [ "$BE_CODE" != "502" ]; then
  ok "平台已在内网跑起来"
else
  warn "健康检查未完全通过（前端 $FE_CODE / 后端 $BE_CODE）"
  echo "    排查：docker compose logs --tail 60 backend"
fi

echo
echo "  ─────────────────────────────────────────────────────"
echo "    访问地址 : http://<本机IP>:$WEB_PORT"
echo "    默认账号 : admin / admin123   ← **登录后立即改密**"
echo
echo "    建议把 .env 里 ENV=dev 改成 ENV=prod（生产环境会强制校验密钥强度）"
echo "    后续发版 : bash scripts/harbor_update.sh"
echo "  ─────────────────────────────────────────────────────"

[ "$FE_CODE" = "200" ] || exit 4
