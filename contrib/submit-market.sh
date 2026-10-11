#!/usr/bin/env bash
#
# 一键提交插件市场上架 PR（往 awesome-dsh-plugin 加一个条目文件）。
#
# 用法：
#   bash contrib/submit-market.sh --dry-run   # 只在本地准备，不推送
#   bash contrib/submit-market.sh             # 准备并推送分支，然后打印开 PR 的链接
#
# 前提：本机对 GitHub 有写权限（PAT 或 SSH），且已把 awesome-dsh-plugin
# fork 到自己账号下（脚本会提示 fork 链接）。
#
# 为什么不自动 fork：fork 是账号级写操作，用 API 自动做需要额外权限；
# 让你点一下更稳妥，脚本会检测 fork 是否存在并给出准确链接。
set -euo pipefail

# 代理自动探测，与 publish.sh 同一套规则（写死端口会在代理关闭时误报成
# 「缺权限」，把用户引去折腾凭据）。DSH_GIT_PROXY 显式指定则用它，空串=强制直连。
PROXY="${DSH_GIT_PROXY-}"
if [ -z "${DSH_GIT_PROXY+x}" ]; then
  for candidate in http://127.0.0.1:7890 http://127.0.0.1:7891; do
    host_port="${candidate#http://}"
    if command -v nc >/dev/null 2>&1 && nc -z -G 1 "${host_port%%:*}" "${host_port##*:}" 2>/dev/null; then
      PROXY="$candidate"
      break
    fi
  done
fi
UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
ENTRY_SRC="$(cd "$(dirname "$0")" && pwd)/awesome-dsh-plugin-entry.yml"
TARGET_PATH="data/plugins/arnen7000__DSH-Workbuddy-WebSearch.yml"
BRANCH="add-dsh-workbuddy-websearch"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# 从本仓库的 remote 推断 fork 的 owner（默认分支的 origin）。
cd "$(dirname "$0")/.."
OWNER="$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#')"
FORK="${OWNER}/${UPSTREAM##*/}"

echo "上游：    ${UPSTREAM}"
echo "你的 fork：${FORK}"
echo "分支：    ${BRANCH}"
echo "条目：    ${TARGET_PATH}"
echo "代理：    ${PROXY}"
echo

[ -f "$ENTRY_SRC" ] || { echo "✗ 找不到 $ENTRY_SRC" >&2; exit 1; }

# 用临时目录做这次提交，不污染本仓库。
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adp-submit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
if [ -n "$PROXY" ]; then
  GIT=(git -c "http.proxy=${PROXY}" -c "https.proxy=${PROXY}")
else
  GIT=(git)
fi

echo "== 拉取你的 fork =="
if ! "${GIT[@]}" clone --depth 1 "https://github.com/${FORK}.git" "$WORK/repo" 2>/dev/null; then
  echo "✗ 克隆 ${FORK} 失败。若还没 fork，请先打开：" >&2
  echo "    https://github.com/${UPSTREAM}/fork" >&2
  echo "  或确认本机有 GitHub 写权限（PAT / SSH）。" >&2
  exit 1
fi
cd "$WORK/repo"

echo "== 加条目 =="
mkdir -p "$(dirname "$TARGET_PATH")"
# 只取条目正文，丢掉给提交者看的注释头（上游只认 5 个键，注释会被当成未知字段）。
grep -v '^#' "$ENTRY_SRC" | grep -v '^$' > "$TARGET_PATH"
echo "--- 写入内容 ---"
cat "$TARGET_PATH"
echo "----------------"

git checkout -q -b "$BRANCH"
git add "$TARGET_PATH"

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 已在 $WORK/repo 准备好提交，未推送。"
  echo "[dry-run] 将执行：git commit && git push origin $BRANCH"
  exit 0
fi

git -c user.name="$OWNER" -c user.email="${OWNER}@users.noreply.github.com" \
  commit -q -m "Add dsh-workbuddy-websearch: web_search provider backed by the WorkBuddy desktop sign-in"

echo "== 推送分支到你的 fork =="
"${GIT[@]}" push origin "$BRANCH"

echo
echo "✓ 分支已推送。现在开 PR（只改这一个文件）："
echo "    https://github.com/${UPSTREAM}/compare/main...${OWNER}:${UPSTREAM##*/}:${BRANCH}?expand=1"
echo
echo "PR 标题与描述直接复制 contrib/market-pr.md 里的内容。"
