#!/usr/bin/env bash
# import-on-linux.sh —— 在目标 Linux 服务器上执行：拉镜像 + 起库 + 还原数据 + 全量启动
#
# 前提（见 迁移步骤.md 第 2 步）：
#   1) docker 与 docker compose v2 已装好
#   2) /etc/docker/daemon.json 已配 insecure-registries 并重启 docker
#   3) 已 docker login harbor.internal.example
#   4) 本脚本与 docker-compose.yml、.env 在同一目录，数据包在 ./migrate/
#
# 用法：
#   bash import-on-linux.sh                 # 数据包默认取 ./migrate
#   bash import-on-linux.sh /opt/migrate    # 指定数据包目录

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PKG="${1:-$PWD/migrate}"

C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'; C_RESET='\033[0m'
info() { printf "${C_INFO}[import]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit 1; }

envval() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r' || true; }

# ---------- 0. 前置检查 ----------
command -v docker >/dev/null 2>&1 || die "没装 docker"
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; warn "用的是 compose v1；本 compose 有顶层 name:，v1 会忽略它，项目名将取目录名"
else die "没装 docker compose（v2 插件或 v1 均可）"; fi

[ -f docker-compose.yml ] || die "当前目录没有 docker-compose.yml"
[ -f .env ]              || die "当前目录没有 .env（从 .env.example 复制并填好）"
[ -f "$PKG/ophub.dump" ] || die "数据包里没有 ophub.dump（目录：$PKG）"

DB_USER="$(envval DB_USER)"; DB_USER="${DB_USER:-ophub}"
DB_NAME="$(envval DB_NAME)"; DB_NAME="${DB_NAME:-ophub}"
PG_IMAGE="$(envval POSTGRES_IMAGE)"

# compose 项目名 -> 卷名前缀。目录改名会让卷名变，数据就「凭空消失」
PROJ="$(grep -m1 '^name:' docker-compose.yml | awk '{print $2}' | tr -d '\r' || true)"
PROJ="${PROJ:-ophub}"

# ---------- 密钥自检（最容易踩的坑，提前拦住）----------
KEY="$(envval PWD_ENC_KEY)"
SRCKEY="$(head -1 "$PKG/PWD_ENC_KEY.txt" 2>/dev/null | tr -d '\r\n' || true)"
if [ -z "$KEY" ] || [ "$KEY" = "请原样粘贴迁移包里PWD_ENC_KEY.txt的内容" ]; then
  die ".env 里的 PWD_ENC_KEY 还没填。必须填迁移包 PWD_ENC_KEY.txt 里的原值，
       否则库里所有 SSH/sudo 密码都解不开（表现为「密码错误」且不可恢复）。"
fi
if [ -n "$SRCKEY" ] && [ "$KEY" != "$SRCKEY" ]; then
  die ".env 的 PWD_ENC_KEY 与迁移包里的不一致！必须原样照搬：
       迁移包：${SRCKEY:0:6}…  当前 .env：${KEY:0:6}…"
fi
ok "PWD_ENC_KEY 与迁移包一致"

echo
info "项目名：$PROJ    数据包：$PKG"
echo

# ---------- 1. 拉镜像 ----------
info "1/6 从 Harbor 拉镜像 …"
$DC pull
ok "镜像就绪"

# ---------- 2. 只起数据库与缓存 ----------
# 关键顺序：必须在 backend 起来之前把数据灌进去。
# backend 启动会跑 AutoMigrate 并可能 seed 初始数据，先起它再灌库会撞车。
info "2/6 先只启动 postgres / redis …"
$DC up -d postgres redis

info "等待 postgres 健康 …"
for i in $(seq 1 60); do
  st="$(docker inspect -f '{{.State.Health.Status}}' ophub-postgres 2>/dev/null || echo '')"
  [ "$st" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' ophub-postgres 2>/dev/null)" = "healthy" ] \
  || die "postgres 60 秒内没健康起来，看日志：docker logs ophub-postgres"
ok "postgres 已就绪"

# ---------- 3. 还原数据库 ----------
info "3/6 还原数据库 $DB_NAME …"
docker cp "$PKG/ophub.dump" ophub-postgres:/tmp/ophub.dump
# --clean --if-exists：全新库上安全；万一有残留表也能覆盖
# --no-owner --no-privileges：避免源库 role 在目标库不存在而报错
docker exec ophub-postgres pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --clean --if-exists --no-owner --no-privileges /tmp/ophub.dump \
  || warn "pg_restore 有非零返回（常见是「对象已存在」类提示），继续，稍后按清单核对行数"
docker exec ophub-postgres rm -f /tmp/ophub.dump

TBL="$(docker exec ophub-postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")"
ASSET="$(docker exec ophub-postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc "select count(*) from assets" 2>/dev/null || echo 'n/a')"
USERC="$(docker exec ophub-postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc "select count(*) from users" 2>/dev/null || echo 'n/a')"
ok "还原完成：表 $TBL 张 / 资产 $ASSET 条 / 用户 $USERC 条"
echo "     ↑ 与迁移前核对：本地是 25 张表 / 16 条资产 / 2 个用户"

# ---------- 4. 还原三个持久卷 ----------
# 用 postgres 镜像当临时搬运容器：内网拉不到 alpine，但 postgres 一定已经拉下来了
info "4/6 还原持久卷（backend-data / backend-uploads / ansible-data）…"
for v in backend-data backend-uploads ansible-data; do
  if [ -f "$PKG/$v.tgz" ]; then
    docker run --rm -v "${PROJ}_$v:/dst" -v "$PKG:/src:ro" "$PG_IMAGE" \
      sh -c "cd /dst && tar xzf /src/$v.tgz" || warn "卷 $v 还原有告警，继续"
    ok "$v 已还原"
  else
    warn "数据包里没有 $v.tgz，跳过（新环境会用空卷）"
  fi
done

# ---------- 5. 启动全部服务 ----------
info "5/6 启动 backend / frontend …"
$DC up -d
ok "全部容器已启动"

# ---------- 6. 等待并给出验收清单 ----------
info "6/6 等待前端可用 …"
WEB_PORT="$(envval WEB_PORT)"; WEB_PORT="${WEB_PORT:-10001}"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:$WEB_PORT/" 2>/dev/null; then break; fi
  sleep 2
done

echo
echo "  ── 容器状态 ────────────────────────────────"
docker ps --format '    {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'ophub-|^(ophub-postgres|ophub-backend)' || docker ps | head -10
echo "  ────────────────────────────────────────────"
echo
echo "  ── 验收清单 ────────────────────────────────"
echo "    1) 浏览器打开 http://<服务器IP>:$WEB_PORT  用 admin/admin123 登录"
echo "    2) 资产列表应有 $ASSET 条"
echo "    3) 用户管理应有 $USERC 个"
echo "    4) 挑一台有 SSH 凭据的资产 -> Ansible 远程 -> 测试连接，必须返回 PING-OK"
echo "       （这一步同时证明：数据全 + PWD_ENC_KEY 对 + 到目标机网络通）"
echo "    5) 看后端日志：docker logs -f ophub-backend"
echo "  ────────────────────────────────────────────"
echo
