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

PROXY="${DSH_GIT_PROXY:-http://127.0.0.1:7890}"
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
GIT=(git -c "http.proxy=${PROXY}" -c "https.proxy=${PROXY}")

# 4) 推送分支。
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 将执行：git push origin HEAD"
  "${GIT[@]}" push --dry-run origin HEAD || {
    echo "✗ 推送预演失败：多半是缺凭据。两种补救方式：" >&2
    echo "    a) 用 PAT：git remote set-url origin https://<用户名>:<PAT>@github.com/arnen7000/DSH-Workbuddy-WebSearch.git" >&2
    echo "    b) 改 SSH：git remote set-url origin git@github.com:arnen7000/DSH-Workbuddy-WebSearch.git" >&2
    exit 1
  }
  echo "[dry-run] 将执行：git tag $TAG && git push origin $TAG"
  exit 0
fi

echo "== 推送分支 =="
"${GIT[@]}" push origin HEAD

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
