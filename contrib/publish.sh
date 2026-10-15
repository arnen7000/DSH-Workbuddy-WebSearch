#!/usr/bin/env bash
#
# 一键推送 + 打 tag + 建 Release（Release 才会触发 CI 发布到 npm）。
#
# 用法：
#   bash contrib/publish.sh              # 推 main + 打 vX.Y.Z tag + 建 Release
#   bash contrib/publish.sh --dry-run    # 只看会做什么，不改动远端
#
# ⚠️ 为什么最后一步是「建 Release」而不是「推 tag」：
#   .github/workflows/publish.yml 的触发条件是 release: types: [published]
#   （外加 workflow_dispatch），**没有** push/tags 触发 —— 只推 tag 不会发布。
#
# 为什么需要它：本机 git 不走系统代理，而 GitHub 直连不通。
# 脚本自动为本次命令注入代理（不写入全局配置，不改你的 git config）。
#
# 前置：仓库需有推送权限的凭据（HTTPS + PAT，或改用 SSH remote）。
# 凭据缺失时脚本会明确报错并给出两种补救方式，而不是静默失败。
set -euo pipefail

# 共用工具：仓库根路径解析 / 代理探测 / 超时包装 / 失败归因。理由与踩过的坑都写在
# contrib/lib.sh 里（这段逻辑原先在两个脚本里各抄一份，且没法被测试）。
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# 代理：DSH_GIT_PROXY 显式指定则用它（**空串表示强制直连**）；否则探测默认端口，
# 通才用，不通就直连。不写死端口 —— 写死会在代理关闭时误报成「缺凭据」。
PROXY="$(resolve_proxy)"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$(dirname "$0")/.."
# ⚠️ 不要直接用 $PWD：Git Bash / MSYS 下它是 /d/... 形式，交给 node 的 require()
# 会 MODULE_NOT_FOUND，把「读版本号」这一步崩掉。resolve_root 会做平台转换。
ROOT="$(resolve_root)"

# 解析 node：优先 PATH，其次 DSH 自带的运行时（桌面版 dsh 不一定把 node 放进 PATH）。
NODE="${DSH_NODE:-}"
if [ -z "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  else
    for c in \
      "${DSH_HOME:-$HOME/.dsh}"/dsh-runtimes/*/dependencies/node/bin/node \
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
    do
      [ -x "$c" ] && NODE="$c" && break
    done
  fi
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "✗ 找不到 node。请设 DSH_NODE=<node 绝对路径> 后重试。" >&2
  exit 1
fi

# 版本号取自 package.json —— 唯一真源，避免 tag 与包版本不一致。
# ⚠️ 读失败必须**带话退出**：在 `set -e` 下裸写会让脚本一声不响地中止（退出码非零、
#    零输出），而「静默失败」正是本脚本声称要避免的事。
VERSION="$("$NODE" -p "require('${ROOT}/package.json').version" 2>/dev/null)" || {
  echo "✗ 读不出 ${ROOT}/package.json 的 version。请确认仓库根路径正确，或设 DSH_NODE=<node 绝对路径>。" >&2
  exit 1
}
if [ -z "$VERSION" ]; then
  echo "✗ ${ROOT}/package.json 的 version 为空。" >&2
  exit 1
fi
TAG="v${VERSION}"

# 注意：变量一律写 ${VAR}。中文全角括号是多字节，bash 会把它当成变量名的一部分，
# 于是 "${VERSION}（" 会被解析成未定义变量 VERSION（ 并在 set -u 下报错。
echo "仓库：  ${ROOT}"
echo "node：  ${NODE}"
echo "版本：  ${VERSION}（来自 package.json）"
echo "标签：  ${TAG}"
echo "代理：  ${PROXY}"
echo

# 1) 工作区必须干净 —— 避免把未提交的改动漏在发布之外。
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区有未提交改动，请先提交：" >&2
  git status --short >&2
  exit 1
fi

# 2) 发布前跑三套检查（与 CI 同款），全绿才继续。
echo "== 跑发布前检查 =="
"$NODE" tools/regression.mjs "$ROOT"         >/dev/null
"$NODE" tools/scenarios.mjs  "$ROOT"         >/dev/null
"$NODE" tools/check-github-meta.mjs "$ROOT"  >/dev/null
echo "✓ regression / scenarios / check-github-meta 全通过"
echo

# 3) 代理只作用于本次 git 调用，不落盘到 git config。
#    PROXY 为空 = 直连（不带 -c 参数，避免把空代理传给 git）。
if [ -n "$PROXY" ]; then
  GIT=(git -c "http.proxy=${PROXY}" -c "https.proxy=${PROXY}")
else
  GIT=(git)
fi

# ⚠️ 必须推到**默认分支**，而不是当前 HEAD。
#
# 两处都依赖默认分支：
#   - 市场 CI 从 raw.githubusercontent.com/<默认分支>/package.json 读 dsh.bundle；
#   - npm 的 provenance 记录的是 tag 指向的提交。
# 若在 feature 分支上跑本脚本而推 HEAD，远端默认分支仍停在旧版本，
# 用户与市场看到的都是旧版 —— 而本地却以为已经发布。
#
# 默认分支名优先取远端 HEAD 指向（origin/HEAD），回落到 main。
#
# ⚠️ `|| true` 不能省：`set -o pipefail` + `set -e` 之下，`git symbolic-ref` 找不到
#    `refs/remotes/origin/HEAD`（例如远端是手工 add 的、或克隆时没建这个符号引用）会
#    返回非零，于是**整个赋值失败、脚本一声不响地中止** —— 用户只看到退出码 1 和
#    零输出，完全不知道发生了什么。回落 main 才是符合注释本意的行为。
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -z "$CURRENT_BRANCH" ]; then
  echo "✗ 取不到当前分支名（这看起来不像一个 git 仓库）。" >&2
  exit 1
fi

if [ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]; then
  # 只有能快进时才允许直接推默认分支，避免把分叉历史强推上去。
  if git merge-base --is-ancestor "origin/${DEFAULT_BRANCH}" HEAD; then
    PUSH_REF="HEAD:${DEFAULT_BRANCH}"
    echo "当前在 ${CURRENT_BRANCH} 分支；将快进推送到 ${DEFAULT_BRANCH}（可快进，安全）"
  else
    echo "✗ 当前分支 ${CURRENT_BRANCH} 与 origin/${DEFAULT_BRANCH} 已分叉，不能直接推送。" >&2
    echo "  请先合并/变基到 ${DEFAULT_BRANCH}，或手工处理。" >&2
    exit 1
  fi
else
  PUSH_REF="HEAD"
  echo "当前在默认分支 ${DEFAULT_BRANCH}"
fi
echo

# 4) 推送。
#
# 失败原因分三类，报错必须分开 —— 把它们混成一句「缺凭据」会让用户白折腾：
#   - 连不上（网络/代理）→ 该去查网络，不是去配 PAT；
#   - 认证失败 → 才是凭据问题；
#   - 其他（如非快进）→ 原样回显 git 的话。
diagnose_push_failure() {
  local out="$1" status="${2:-}"
  echo "✗ git push 失败。" >&2
  if is_timeout_status "$status"; then
    # ⚠️ 这一支不能少：GitHub 连不上时 git 会静默等待、连一行输出都没有，
    #    被 `timeout` 杀掉后输出是**空的** —— 若只按输出文本归因，会落到
    #    「见上方 git 输出」，而上方一片空白，等于什么都没说。
    echo "  原因：**超时**（$(git_timeout_secs)s 内无任何响应）。这基本只意味着**连不上 GitHub**，不是凭据问题。" >&2
    echo "  - 当前代理设置：${PROXY:-（直连）}" >&2
    echo "  - 可显式指定代理：DSH_GIT_PROXY=http://127.0.0.1:7890 bash $0" >&2
    echo "  - 或强制直连：  DSH_GIT_PROXY= bash $0" >&2
    echo "  - 调整等待上限：DSH_GIT_TIMEOUT=300 bash $0" >&2
  elif is_network_failure "$out"; then
    echo "  原因：**连不上 GitHub**（不是凭据问题）。" >&2
    echo "  - 当前代理设置：${PROXY:-（直连）}" >&2
    echo "  - 可显式指定代理：DSH_GIT_PROXY=http://127.0.0.1:7890 bash $0" >&2
    echo "  - 或强制直连：  DSH_GIT_PROXY= bash $0" >&2
  elif is_auth_failure "$out"; then
    echo "  原因：**缺推送凭据**。两种补救方式：" >&2
    echo "    a) 用 PAT：git remote set-url origin https://<用户名>:<PAT>@github.com/arnen7000/DSH-Workbuddy-WebSearch.git" >&2
    echo "    b) 改 SSH：git remote set-url origin git@github.com:arnen7000/DSH-Workbuddy-WebSearch.git" >&2
  else
    echo "  原因：见上方 git 输出。" >&2
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 将执行：git push origin ${PUSH_REF}"
  # ⚠️ 套超时：GitHub 不通时 `git push` 会**永久挂起**（既不出错也不返回、也无输出），
  #    在 CI 或非交互环境里就是静默卡死。超时秒数可用 DSH_GIT_TIMEOUT 调整。
  push_status=0
  push_out="$(run_with_timeout "$(git_timeout_secs)" "${GIT[@]}" push --dry-run origin "$PUSH_REF" 2>&1)" || push_status=$?
  if [ "$push_status" != "0" ]; then
    printf '%s\n' "$push_out" >&2
    diagnose_push_failure "$push_out" "$push_status"
    exit 1
  fi
  printf '%s\n' "$push_out"
  echo "[dry-run] 将执行：git tag $TAG && git push origin $TAG"
  exit 0
fi

echo "== 推送分支（目标：${DEFAULT_BRANCH}）=="
push_status=0
push_out="$(run_with_timeout "$(git_timeout_secs)" "${GIT[@]}" push origin "$PUSH_REF" 2>&1)" || push_status=$?
if [ "$push_status" != "0" ]; then
  printf '%s\n' "$push_out" >&2
  diagnose_push_failure "$push_out" "$push_status"
  exit 1
fi
printf '%s\n' "$push_out"

# 5) 打 tag 并推送。tag 与 package.json 版本必须一致（CI 也卡这条）。
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "标签 $TAG 已存在，跳过创建"
else
  git tag -a "$TAG" -m "Release $TAG"
  echo "已创建标签 $TAG"
fi

echo "== 推送标签 =="
tag_status=0
run_with_timeout "$(git_timeout_secs)" "${GIT[@]}" push origin "$TAG" || tag_status=$?
if [ "$tag_status" != "0" ]; then
  echo "✗ 推送标签 $TAG 失败（分支已推送成功，可单独重试这一步）。" >&2
  diagnose_push_failure "" "$tag_status"
  exit 1
fi

# ⚠️ 关键：**推 tag 本身不会触发发布**。
# .github/workflows/publish.yml 的触发条件是 `release: types: [published]`
# 与 `workflow_dispatch`，**没有** push/tags 触发。所以必须再去 GitHub
# 把这个 tag 发布成 Release，CI 才会跑起来。
#
# 若装了 gh CLI 且有权限，下面这段会自动建 Release；否则打印手工步骤。
echo
if command -v gh >/dev/null 2>&1; then
  echo "== 用 gh 创建 Release（这一步才真正触发发布）=="
  if gh release create "$TAG" --title "$TAG" --notes "见 package.json 的 versionNote 与 CHANGELOG 章节。"; then
    echo "✓ Release 已创建，publish 工作流应已开始运行"
  else
    echo "⚠ gh release create 失败，请到网页端手工创建 Release" >&2
  fi
else
  echo "⚠ 未检测到 gh CLI —— 还需要一步手工操作才能发布："
  echo "    打开 https://github.com/arnen7000/DSH-Workbuddy-WebSearch/releases/new?tag=${TAG}"
  echo "    选择 tag ${TAG}，标题填 ${TAG}，点 Publish release"
  echo "  （publish.yml 只监听 release published，推 tag 不会触发它）"
fi

echo
echo "✓ 推送完成。接下来："
echo "  1. 确认 Release 已发布（上一步）—— 否则 CI 不会跑"
echo "  2. 到 Actions 看 publish 工作流是否成功（OIDC 可信发布）"
echo "  3. npm 上确认：https://www.npmjs.com/package/dsh-workbuddy-websearch"
