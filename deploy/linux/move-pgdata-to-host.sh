#!/usr/bin/env bash
# move-pgdata-to-host.sh —— 把 ophub_pgdata 卷里的 PG 数据搬到主机目录
# /data/your-project/ophub/data/postgresql，让数据「看得见摸得着」。
#
# 适用场景：
#   你已经按 迁移步骤.md 成功把平台部署起来，16 资产 / 25 表都在 ophub_pgdata
#   卷里跑了。现在要把这卷卷里挑出来放到主机固定路径，方便备份 / 迁移 / 看。
#
# ⚠️ 不能直接改 compose 把 pgdata 卷换成主机目录 —— 那样 PG 会初始化空库覆盖
#   老数据。必须先把这卷内容搬到目标主机目录再切换。
#
# 用法（在 /opt/ophub 里跑）：
#   bash deploy/linux/move-pgdata-to-host.sh                       # 默认主机目录
#   bash deploy/linux/move-pgdata-to-host.sh /custom/path/pgdata   # 指定目录
#
# 退出码：0 成功；1 参数/环境错误；2 备份失败；3 搬运失败；4 compose 改失败；
#        5 启动失败

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TARGET="${1:-/data/your-project/ophub/data/postgresql}"

C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'; C_RESET='\033[0m'
info() { printf "${C_INFO}[pgmove]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

# ---------- 0. 前置 ----------
command -v docker >/dev/null 2>&1 || die "没装 docker"
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif docker-compose version >/dev/null 2>&1; then DC="docker-compose"
else die "没装 docker compose"; fi

[ -f docker-compose.yml ] || die "当前目录没有 docker-compose.yml（请 cd 到 /opt/ophub 再跑）"

# compose 项目名 -> 卷名前缀。**项目名一变卷名变、数据就丢**
PROJ="$(grep -m1 '^name:' docker-compose.yml | awk '{print $2}' | tr -d '\r' || true)"
PROJ="${PROJ:-ophub}"
VOL="${PROJ}_pgdata"

[ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJ}-postgres" 2>/dev/null || echo none)" = "healthy" ] \
  || die "postgres 容器不在 healthy 状态，先按 迁移步骤.md 起起来再来"

info "目标主机目录：$TARGET"
info "源 docker 卷：$VOL"
echo

# ---------- 1. 备份 compose + 备份卷 ----------
TS="$(date +%Y%m%d-%H%M%S)"
BAK_DIR="${HOME}/ophub-pgmove-bak-${TS}"
mkdir -p "$BAK_DIR"
info "1/6 备份 compose + 当前 docker 卷 → $BAK_DIR"
cp docker-compose.yml "$BAK_DIR/docker-compose.yml.bak"

# 用 postgres 镜像（Harbor 上一定已拉下来）做临时搬运容器，把卷内容 tar 到主机目录
# 同时把备份 tar 也打到主机上，省一份跨文件系统风险
docker run --rm -v "${VOL}:/src:ro" -v "$BAK_DIR:/bak" \
  "$(grep -m1 '^POSTGRES_IMAGE=' .env | cut -d= -f2- | tr -d '\r')" \
  sh -c "cd /src && tar czf /bak/${VOL}-${TS}.tgz ." \
  || die "备份当前卷失败" 2

# 验证备份 tar 里有 PG 关键目录
docker run --rm -v "$BAK_DIR:/bak:ro" alpine:3.19 \
  sh -c "tar tzf /bak/${VOL}-${TS}.tgz 2>/dev/null | head -5" 2>/dev/null | grep -q "base/" \
  || warn "备份 tar 里没看到 base/，请人工确认（alpine 镜像可能没拉到；不影响备份本身）"

ok "已备份 compose 与当前卷（${VOL}-${TS}.tgz，体积 $(du -h "$BAK_DIR/${VOL}-${TS}.tgz" | cut -f1)）"

# ---------- 2. 停 backend/frontend（保留 postgres） ----------
info "2/6 停 backend / frontend（postgres 保持 running，避免中途断连接）"
$DC stop backend frontend 2>/dev/null || true
ok "已停"

# ---------- 3. 停 postgres ----------
info "3/6 停 postgres（让卷完全不被读写，保证搬运一致性）"
$DC stop postgres
ok "已停"

# ---------- 4. 搬运卷内容到主机目录 ----------
info "4/6 搬运 $VOL → $TARGET"
mkdir -p "$TARGET"
# 目标目录已有内容的话警告（一般应为空）
if [ "$(ls -A "$TARGET" 2>/dev/null | wc -l)" -gt 0 ]; then
  warn "目标目录不是空的（$(ls -A "$TARGET" | wc -l) 个条目）—— 搬运会被 tar 解压覆盖"
  printf '输入 yes 继续：'; read -r yn
  [ "$yn" = "yes" ] || die "用户取消"
fi
# 用 postgres 镜像解 tar（同镜像工具，保证版本一致）
docker run --rm -v "${VOL}:/src:ro" -v "$TARGET:/dst" \
  "$(grep -m1 '^POSTGRES_IMAGE=' .env | cut -d= -f2- | tr -d '\r')" \
  sh -c "cd /src && tar cf - . | (cd /dst && tar xf -)" \
  || die "搬运失败" 3
ok "已搬到主机目录"

# 文件属主必须是 postgres 用户（uid=999）才能起 PG；否则会 permission denied 启动不了
info "修正文件属主为 uid=999（postgres 容器用户）"
chown -R 999:999 "$TARGET" 2>/dev/null || {
  warn "chown 999:999 失败（可能主机没 uid=999），改用 chmod 777 兜底（不安全但能起来）"
  chmod -R 777 "$TARGET" || die "修正权限失败"
}
ok "权限修正完成"

# ---------- 5. 改 compose：pgdata 卷 → bind mount ----------
info "5/6 改 docker-compose.yml：pgdata 卷 → 主机目录挂载"
# 备份当前 compose 的版本号
if ! grep -q "${TARGET}:/var/lib/postgresql/data" docker-compose.yml; then
  # 写法匹配 v1.7.8 compose 里 pgdata 这一行
  sed -i.bak "s|^\(\s*\)-\s*pgdata:/var/lib/postgresql/data|\1- ${TARGET}:/var/lib/postgresql/data|" docker-compose.yml \
    || die "改 compose 失败（请手动把 pgdata 改成 ${TARGET}:/var/lib/postgresql/data）" 4
  ok "compose 已改（备份见 docker-compose.yml.bak）"
else
  warn "compose 里已经是 ${TARGET} 挂载，跳过 sed"
fi

# ---------- 6. 起全部容器 + 验收 ----------
info "6/6 docker compose up -d（让 postgres 重新挂载新主机目录）"
$DC up -d

info "等待 postgres healthy …"
for i in $(seq 1 60); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "${PROJ}-postgres" 2>/dev/null || echo '')"
  [ "$st" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJ}-postgres" 2>/dev/null)" = "healthy" ] \
  || die "postgres 60 秒内没起来 —— 看 docker logs ${PROJ}-postgres；如报 permission denied，"\
"        说明主机目录权限没配对，参考 迁移步骤.md「常见问题」" 5

TBL="$(docker exec "${PROJ}-postgres" psql -U ophub -d ophub -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")"
ASSET="$(docker exec "${PROJ}-postgres" psql -U ophub -d ophub -tAc "select count(*) from assets")"
USERC="$(docker exec "${PROJ}-postgres" psql -U ophub -d ophub -tAc "select count(*) from users")"

echo
ok "全部完成！"
echo "  ├─ 表数   : $TBL  (预期 25)"
echo "  ├─ 资产   : $ASSET  (预期 16)"
echo "  ├─ 用户   : $USERC  (预期 2)"
echo "  └─ 数据落 : $TARGET"
echo
echo "  旧卷    : $VOL  （**保留几天确认无误再删**："
echo "                docker volume rm $VOL）"
echo "  备份    : $BAK_DIR"
echo
echo "  ⚠️  如果上面数字对不上，立刻停服回滚："
echo "        sed -i.bak 's|^.*${TARGET}:/var/lib/postgresql/data|      - pgdata:/var/lib/postgresql/data|' docker-compose.yml"
echo "        $DC up -d"
echo