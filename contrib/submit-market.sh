#!/usr/bin/env bash
#
# 一键提交插件市场上架 PR（往 awesome-dsh-plugin 加一个条目文件）。
#
# 用法：
#   bash contrib/submit-market.sh --dry-run   # 只在本地准备，**不联网、不推送**
#   bash contrib/submit-market.sh             # 准备并推送分支，然后打印开 PR 的链接
#
# 前提：本机对 GitHub 有写权限（PAT 或 SSH），且已把 awesome-dsh-plugin
# fork 到自己账号下（脚本会提示 fork 链接）。
#
# 为什么不自动 fork：fork 是账号级写操作，用 API 自动做需要额外权限；
# 让你点一下更稳妥，脚本会检测 fork 是否存在并给出准确链接。
set -euo pipefail

# 共用工具：代理探测 / 超时包装 / 失败归因。理由与踩过的坑都写在 contrib/lib.sh。
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# 代理自动探测，与 publish.sh 同一套规则（写死端口会在代理关闭时误报成
# 「缺权限」，把用户引去折腾凭据）。DSH_GIT_PROXY 显式指定则用它，空串=强制直连。
PROXY="$(resolve_proxy)"
UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRY_SRC="${SELF_DIR}/awesome-dsh-plugin-entry.yml"
TARGET_PATH="data/plugins/arnen7000__DSH-Workbuddy-WebSearch.yml"
BRANCH="add-dsh-workbuddy-websearch"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# 从本仓库的 remote 推断 fork 的 owner（默认分支的 origin）。
# ⚠️ 读不到必须**带话退出**：`set -o pipefail` + `set -e` 之下，没有 origin 时这条管道
#    会返回非零，裸写就是「一声不响地中止」（零输出），用户根本不知道缺的是什么。
cd "${SELF_DIR}/.."
OWNER="$(git remote get-url origin 2>/dev/null | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#' || true)"
if [ -z "$OWNER" ]; then
  echo "✗ 读不出本仓库的 origin remote（无法推断你的 GitHub 账号）。" >&2
  echo "  请先设置：git remote add origin https://github.com/<你的账号>/<仓库>.git" >&2
  exit 1
fi
FORK="${OWNER}/${UPSTREAM##*/}"

echo "上游：    ${UPSTREAM}"
echo "你的 fork：${FORK}"
echo "分支：    ${BRANCH}"
echo "条目：    ${TARGET_PATH}"
echo "代理：    ${PROXY}"
echo

[ -f "$ENTRY_SRC" ] || { echo "✗ 找不到 $ENTRY_SRC" >&2; exit 1; }

# ── 本地准备：过滤出条目正文 ──
#
# ⚠️ 这一步**必须早于任何网络操作**。早先的写法是「先 clone，再往克隆出来的目录里
#    写文件」，于是 `--dry-run` 也要联网 —— 与「只在本地准备」的说明自相矛盾，
#    而且 clone 一旦挂起，dry-run 就永远不返回。
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adp-submit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "${WORK}/entry/$(dirname "$TARGET_PATH")"
# 只取条目正文，丢掉给提交者看的注释头（上游只认 5 个键，注释会被当成未知字段）。
grep -v '^#' "$ENTRY_SRC" | grep -v '^$' > "${WORK}/entry/${TARGET_PATH}"
echo "== 条目内容（已过滤注释头）=="
cat "${WORK}/entry/${TARGET_PATH}"
echo "=============================="

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 本地准备完成：**未联网、未推送**。"
  echo "[dry-run] 正式运行时会执行："
  echo "[dry-run]   1) git clone --depth 1 https://github.com/${FORK}.git <临时目录>"
  echo "[dry-run]   2) 写入 ${TARGET_PATH}"
  echo "[dry-run]   3) git commit && git push origin ${BRANCH}"
  echo "[dry-run] 然后到下面这个地址开 PR："
  echo "[dry-run]   https://github.com/${UPSTREAM}/compare/main...${OWNER}:${UPSTREAM##*/}:${BRANCH}?expand=1"
  exit 0
fi

# 代理只作用于本次 git 调用，不落盘到 git config。PROXY 为空 = 直连。
if [ -n "$PROXY" ]; then
  GIT=(git -c "http.proxy=${PROXY}" -c "https.proxy=${PROXY}")
else
  GIT=(git)
fi

# 网络失败归因：把「连不上」与「没 fork / 没权限」分开报 —— 两者的补救方式完全不同。
diagnose_fetch_failure() {
  local out="$1" status="${2:-}"
  if is_timeout_status "$status"; then
    # 超时被杀时输出是**空的**，只按文本归因会落到「未知原因」，等于没说。
    echo "✗ 拉取/推送 ${FORK} 超时（$(git_timeout_secs)s 内无任何响应）。这基本只意味着**连不上 GitHub**。" >&2
    echo "  - 当前代理设置：${PROXY:-（直连）}" >&2
    echo "  - 可显式指定代理：DSH_GIT_PROXY=http://127.0.0.1:7890 bash $0" >&2
    echo "  - 或强制直连：  DSH_GIT_PROXY= bash $0" >&2
    echo "  - 调整等待上限：DSH_GIT_TIMEOUT=300 bash $0" >&2
  elif is_network_failure "$out"; then
    echo "✗ 拉取/推送 ${FORK} 失败：**连不上 GitHub**（不是 fork 或权限问题）。" >&2
    echo "  - 当前代理设置：${PROXY:-（直连）}" >&2
    echo "  - 可显式指定代理：DSH_GIT_PROXY=http://127.0.0.1:7890 bash $0" >&2
    echo "  - 或强制直连：  DSH_GIT_PROXY= bash $0" >&2
  elif is_auth_failure "$out"; then
    echo "✗ 拉取/推送 ${FORK} 失败：**无权限或仓库不存在**。" >&2
    echo "  若还没 fork，请先打开：https://github.com/${UPSTREAM}/fork" >&2
    echo "  或确认本机有 GitHub 写权限（PAT / SSH）。" >&2
  else
    echo "✗ 拉取/推送 ${FORK} 失败（原因见上方 git 输出）。" >&2
    echo "  若还没 fork，请先打开：https://github.com/${UPSTREAM}/fork" >&2
  fi
}

echo "== 拉取你的 fork =="
# ⚠️ 两道保险，缺一不可：
#   - `2>&1` 捕获 stderr：早先写成 `2>/dev/null`，失败原因（网络/权限）全被吞掉，
#     用户只看到一句「克隆失败」，而这句话把网络问题指向了「你没 fork」；
#   - 套超时：GitHub 直连不通时 `git clone` 会**永久挂起**，脚本不返回、也不报错，
#     只能靠人肉 Ctrl-C（超时秒数可用 DSH_GIT_TIMEOUT 调整）。
clone_status=0
clone_out="$(run_with_timeout "$(git_timeout_secs)" "${GIT[@]}" clone --depth 1 "https://github.com/${FORK}.git" "$WORK/repo" 2>&1)" || clone_status=$?
if [ "$clone_status" != "0" ]; then
  printf '%s\n' "$clone_out" >&2
  diagnose_fetch_failure "$clone_out" "$clone_status"
  exit 1
fi
cd "$WORK/repo"

echo "== 加条目 =="
mkdir -p "$(dirname "$TARGET_PATH")"
cp "${WORK}/entry/${TARGET_PATH}" "$TARGET_PATH"
echo "--- 写入内容 ---"
cat "$TARGET_PATH"
echo "----------------"

git checkout -q -b "$BRANCH"
git add "$TARGET_PATH"
git -c user.name="$OWNER" -c user.email="${OWNER}@users.noreply.github.com" \
  commit -q -m "Add dsh-workbuddy-websearch: web_search provider backed by the WorkBuddy desktop sign-in"

echo "== 推送分支到你的 fork =="
push_status=0
push_out="$(run_with_timeout "$(git_timeout_secs)" "${GIT[@]}" push origin "$BRANCH" 2>&1)" || push_status=$?
if [ "$push_status" != "0" ]; then
  printf '%s\n' "$push_out" >&2
  diagnose_fetch_failure "$push_out" "$push_status"
  exit 1
fi
printf '%s\n' "$push_out"

echo
echo "✓ 分支已推送。现在开 PR（只改这一个文件）："
echo "    https://github.com/${UPSTREAM}/compare/main...${OWNER}:${UPSTREAM##*/}:${BRANCH}?expand=1"
echo
echo "PR 标题与描述直接复制 contrib/market-pr.md 里的内容。"
