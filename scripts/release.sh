#!/usr/bin/env bash
# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# release.sh —— 云枢 OpsHub发版一条龙（落实项目「版本铁律」）
#
# 项目约定：每完成一项开发任务，必须
#   ① 递增 VERSION（语义化 vX.Y.Z）② commit ③ 打 tag ④ push（含 tag）
# 本脚本把四步合成一条命令，避免漏打 tag / 漏推 tag（漏推 tag 会让远端失去回滚能力）。
#
# 用法：
#   bash scripts/release.sh "fix(ws): 修复 xxx"                # 补丁号 +1 并推送
#   bash scripts/release.sh "feat: xxx" --minor                # 次版本 +1
#   bash scripts/release.sh "feat: xxx" -v v1.8.0              # 指定版本号
#   bash scripts/release.sh "chore: xxx" --no-push             # 只提交+打 tag，不推
#   bash scripts/release.sh --status                           # 只看同步状态，不做改动
#
# 退出码：0 成功；1 参数/环境错误；2 git 操作失败

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
info() { printf "${C_INFO}[release]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}[fail]${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

# ---------- 状态查看（--status）----------
show_status() {
  local ver br remote merge upstream_ref remote_tags
  ver="$(tr -d '[:space:]' < VERSION 2>/dev/null || echo '?')"
  br="$(git rev-parse --abbrev-ref HEAD)"
  echo "  当前版本 : $ver    HEAD: $(git rev-parse --short HEAD)   分支: $br"

  # 上游以 config 的 branch.<name>.remote / .merge 为准（这才是 push/pull 真正读的），
  # 不要用 @{u}：它依赖 refs/remotes/* 存在，而该引用缺失时 @{u} 会直接报错，
  # 让人误以为「没配上游」。两者是两个独立的东西。
  remote="$(git config --get "branch.$br.remote" || echo origin)"
  merge="$(git config --get "branch.$br.merge" || true)"
  if [ -z "$merge" ]; then
    warn "当前分支没有设置上游（upstream），push 需要显式指定远端"
  else
    upstream_ref="refs/remotes/$remote/${merge#refs/heads/}"
    echo "  上游分支 : $remote/${merge#refs/heads/}"
    if git rev-parse -q --verify "$upstream_ref" >/dev/null 2>&1; then
      local counts
      counts="$(git rev-list --left-right --count "$remote/${merge#refs/heads/}...HEAD")"
      echo "  与远端   : 落后 ${counts%%$'\t'*} 个 / 领先 ${counts##*$'\t'} 个提交"
    else
      warn "本地缺少远端跟踪引用 $upstream_ref（受管沙箱会拦截 refs/remotes/ 写入）"
      echo "        补上：git fetch $remote     —— 不影响 push/pull，只是 ahead/behind 显示不出来"
    fi
  fi

  # 未推送的本地 tag —— 这正是「远端回滚不了」的根因，必须显式暴露
  remote_tags="$(git ls-remote --tags origin 2>/dev/null | sed 's#.*refs/tags/##; s/\^{}//' | sort -u || true)"
  local unpushed=()
  while read -r t; do
    [ -z "$t" ] && continue
    grep -qx "$t" <<<"$remote_tags" || unpushed+=("$t")
  done < <(git tag | sort -V)

  if [ "${#unpushed[@]}" -gt 0 ]; then
    warn "以下 tag 只在本地、远端没有：${unpushed[*]}"
    echo "        补推：git push origin ${unpushed[*]}"
  else
    ok "本地 tag 与远端一致"
  fi

  if [ -n "$(git status --porcelain)" ]; then
    warn "有未提交改动："
    git status --short | sed 's/^/        /'
  else
    ok "工作区干净"
  fi
}

# ---------- 参数解析 ----------
MSG=""; BUMP="patch"; NEWVER=""; DO_PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --status)  show_status; exit 0 ;;
    --minor)   BUMP="minor"; shift ;;
    --major)   BUMP="major"; shift ;;
    --no-push) DO_PUSH=0; shift ;;
    -v|--version) NEWVER="${2:-}"; [ -n "$NEWVER" ] || die "-v 需要一个版本号，如 -v v1.8.0"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "未知参数：$1（-h 看用法）" ;;
    *)         [ -z "$MSG" ] && MSG="$1" || die "只接受一个提交信息参数"; shift ;;
  esac
done

[ -n "$MSG" ] || die "缺少提交信息。用法：bash scripts/release.sh \"<提交信息>\""

# ---------- 前置检查 ----------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "当前目录不是 git 仓库"
[ -f VERSION ] || die "找不到 VERSION 文件（应在仓库根）"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "HEAD" ] && die "处于 detached HEAD 状态，先切回分支再发版"

# 有未提交改动才能发版（否则 tag 会打在空提交上，没有意义）
if [ -z "$(git status --porcelain)" ]; then
  die "工作区没有改动，无需发版（如果只是要补推 tag：git push origin --tags）"
fi

# ---------- 计算新版本号 ----------
CUR="$(tr -d '[:space:]' < VERSION)"
if [ -n "$NEWVER" ]; then
  NEW="${NEWVER#v}"; NEW="v$NEW"
else
  [[ "$CUR" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "VERSION 格式不是 vX.Y.Z：$CUR"
  MAJ="${BASH_REMATCH[1]}"; MIN="${BASH_REMATCH[2]}"; PAT="${BASH_REMATCH[3]}"
  case "$BUMP" in
    major) MAJ=$((MAJ+1)); MIN=0; PAT=0 ;;
    minor) MIN=$((MIN+1)); PAT=0 ;;
    patch) PAT=$((PAT+1)) ;;
  esac
  NEW="v$MAJ.$MIN.$PAT"
fi

git rev-parse -q --verify "refs/tags/$NEW" >/dev/null && die "tag $NEW 已存在，换个版本号（当前 $CUR）"

info "版本：$CUR → $NEW     提交信息：$MSG"

# ---------- 执行四步 ----------
printf '%s\n' "$NEW" > VERSION
git add -A
git commit -q -F - <<EOF
$MSG

版本：$CUR → $NEW
EOF
ok "已提交 $(git rev-parse --short HEAD)"

git tag "$NEW"
ok "已打 tag $NEW"

if [ "$DO_PUSH" -eq 1 ]; then
  REMOTE="$(git config --get branch."$BRANCH".remote || echo origin)"
  info "推送到 $REMOTE（$BRANCH + tag）"
  # --atomic：分支与 tag 要么都成功要么都不动，避免「代码上去了 tag 没上去」
  if git push --atomic "$REMOTE" "$BRANCH" "$NEW"; then
    ok "已推送 $BRANCH 与 tag $NEW"
  else
    rc=$?
    warn "推送失败（rc=$rc）。本地提交与 tag 都已生成，可稍后手动补推："
    echo "        git push $REMOTE $BRANCH && git push $REMOTE $NEW"
    exit 2
  fi
else
  warn "已按 --no-push 跳过推送。记得补：git push origin $BRANCH && git push origin $NEW"
fi

ok "发版完成：$NEW"
