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

# 代理：**自动探测**，不写死。
#
# 写死端口会在两种常见情形下帮倒忙，而且报错会指向错误的方向：
#   - 代理没开（或换了端口）→ git 连 127.0.0.1:7890 立即失败，
#     但脚本会把它误判成「缺凭据」，于是用户去折腾 PAT，白费功夫；
#   - 网络本来就能直连 → 白白多绕一跳。
#
# 规则：DSH_GIT_PROXY 显式指定则用它（也接受空串表示强制直连）；
# 否则探测默认端口，**通才用**，不通就直连。
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
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$(dirname "$0")/.."
ROOT="$PWD"

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
VERSION="$("$NODE" -p "require('${ROOT}/package.json').version")"
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
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

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
  local out="$1"
  echo "✗ 推送预演失败。" >&2
  if printf '%s' "$out" | grep -qiE "could not resolve host|failed to connect|connection (refused|timed out)|operation timed out|network is unreachable"; then
    echo "  原因：**连不上 GitHub**（不是凭据问题）。" >&2
    echo "  - 当前代理设置：${PROXY:-（直连）}" >&2
    echo "  - 可显式指定代理：DSH_GIT_PROXY=http://127.0.0.1:7890 bash $0" >&2
    echo "  - 或强制直连：  DSH_GIT_PROXY= bash $0" >&2
  elif printf '%s' "$out" | grep -qiE "could not read username|authentication failed|permission denied|403"; then
    echo "  原因：**缺推送凭据**。两种补救方式：" >&2
    echo "    a) 用 PAT：git remote set-url origin https://<用户名>:<PAT>@github.com/arnen7000/DSH-Workbuddy-WebSearch.git" >&2
    echo "    b) 改 SSH：git remote set-url origin git@github.com:arnen7000/DSH-Workbuddy-WebSearch.git" >&2
  else
    echo "  原因：见上方 git 输出。" >&2
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 将执行：git push origin ${PUSH_REF}"
  push_out="$("${GIT[@]}" push --dry-run origin "$PUSH_REF" 2>&1)" || {
    printf '%s\n' "$push_out" >&2
    diagnose_push_failure "$push_out"
    exit 1
  }
  printf '%s\n' "$push_out"
  echo "[dry-run] 将执行：git tag $TAG && git push origin $TAG"
  exit 0
fi

echo "== 推送分支（目标：${DEFAULT_BRANCH}）=="
push_out="$("${GIT[@]}" push origin "$PUSH_REF" 2>&1)" || {
  printf '%s\n' "$push_out" >&2
  diagnose_push_failure "$push_out"
  exit 1
}
printf '%s\n' "$push_out"

# 5) 打 tag 并推送。tag 与 package.json 版本必须一致（CI 也卡这条）。
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "标签 $TAG 已存在，跳过创建"
else
  git tag -a "$TAG" -m "Release $TAG"
  echo "已创建标签 $TAG"
fi

echo "== 推送标签 =="
"${GIT[@]}" push origin "$TAG"

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
