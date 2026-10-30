#!/usr/bin/env bash
#
# publish.sh / submit-market.sh 共用的小工具。
#
# 为什么单独成文件：这两段逻辑（仓库根路径解析、本地代理探测）原先在两个脚本里
# 各抄了一份，且**都没法被测试** —— 于是「缺 nc 就静默不探测」这类缺陷可以一直
# 藏着。抽出来后由 `tools/check-github-meta.mjs` 的 G10 组直接 source 本文件做
# 行为断言（由 `tools/check-github-meta.mjs` 的 G10 组直接 source 本文件验证）。
#
# ⚠️ 本文件不得出现任何本机信息（用户目录 / 盘符 / 用户名 / 安装路径），
#    仓库有 G8 护栏扫描（8 项）。改动后请跑 check-github-meta.mjs。
#
# 用法（在脚本里）：
#   . "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# ───────────────────────── 仓库根路径 ─────────────────────────

# 打印仓库根目录，形式为 **node 与 git 都能识别**的路径。
#
# ⚠️ Git Bash / MSYS 下 `$PWD` 是 `/d/...`（MSYS 风格）形式，把它交给 node 的
#    `require()` 会直接 MODULE_NOT_FOUND —— 于是「读 package.json 版本号」这一步
#    就把整个发布脚本崩掉，连一行有效输出都没有。
#    `cygpath -m` 给出正斜杠的 Windows 路径（形如 `<盘符>:/...`），node 与 git 都认；
#    非 MSYS 平台没有 cygpath，直接用 `$PWD`。
resolve_root() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$PWD"
  else
    printf '%s' "$PWD"
  fi
}

# ───────────────────────── 本地代理探测 ─────────────────────────

# port_open <host> <port>：TCP 端口是否可连（可连返回 0）。
#
# ⚠️ **不依赖 nc**。原先的写法是 `command -v nc && nc -z ...`，在没装 nc 的机器上
#    （例如 Git Bash / MSYS 自带的 PortableGit 就没有）整段判断直接短路成「没有
#    代理」，于是脚本以为该直连，而 GitHub 直连又不通 —— 表现是**永久挂起**，
#    且脚本还宣称自己「不会静默失败」。现在优先用 bash 内建 /dev/tcp，不需要
#    任何外部程序；nc 只作为 /dev/tcp 不可用时的兜底。
port_open() {
  local host="$1" port="$2"
  # bash 内建 /dev/tcp：连不上（含被拒）返回非零。套一层 timeout，避免
  # 对「丢包而非拒绝」的端口无限等待；本机没有 timeout（macOS 默认）时退化为直连。
  if command -v timeout >/dev/null 2>&1; then
    timeout 1 bash -c "exec 3<>/dev/tcp/${host}/${port}" >/dev/null 2>&1 && return 0
  else
    (exec 3<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1 && return 0
  fi
  # 兜底：极少数 shell 未编译 /dev/tcp。
  if command -v nc >/dev/null 2>&1; then
    nc -z -G 1 "$host" "$port" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# 探测常见本地代理端口，**通才用**，都不通就打印空串（调用方据此走直连）。
#
# 写死端口会在两种常见情形下帮倒忙，且报错会指向错误方向：
#   - 代理没开（或换了端口）→ 直连代理端口立即失败，却容易被误判成「缺凭据」，
#     于是用户去折腾 PAT，白费功夫；
#   - 网络本来就能直连 → 白白多绕一跳。
detect_proxy() {
  local candidate host port
  for candidate in http://127.0.0.1:7890 http://127.0.0.1:7891 http://127.0.0.1:7897; do
    host="${candidate#http://}"
    host="${host%%:*}"
    port="${candidate##*:}"
    if port_open "$host" "$port"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  printf ''
  return 0
}

# 按「DSH_GIT_PROXY 显式指定优先，否则自动探测」的规则打印最终代理（空串=直连）。
#
# 判定「是否显式指定」必须用 `${DSH_GIT_PROXY+x}` 而不是 `-z` —— 空串是**合法的
# 显式取值**，表示「强制直连」，不能被当成未设置。
resolve_proxy() {
  if [ -n "${DSH_GIT_PROXY+x}" ]; then
    printf '%s' "${DSH_GIT_PROXY-}"
  else
    detect_proxy
  fi
}

# ───────────────────────── 超时包装 ─────────────────────────

# git 调用的超时秒数（默认 120s，可用 DSH_GIT_TIMEOUT 覆盖）。
#
# 为什么必须有：GitHub 连不上时 git 会**静默等待**，既不报错也不返回、连一行输出
# 都没有 —— 于是「等它自己失败」是等不到的，只能靠超时兜。而超时被杀掉时输出为空，
# 所以调用方**必须单独识别退出码 124**，否则归因会落到「见上方输出」而上方一片空白。
git_timeout_secs() {
  printf '%s' "${DSH_GIT_TIMEOUT:-120}"
}

# 退出码是否来自 `timeout` 超时（GNU coreutils 约定 124）。
is_timeout_status() {
  [ "${1:-}" = "124" ]
}

# run_with_timeout <秒> <命令...>：有 timeout 就用（GNU/Linux 与 Git Bash 自带），
# 没有（macOS 默认）就退化为直接执行 —— 至少不会因为缺一个命令就整体失败。
run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@"
  fi
}

# ───────────────────────── 推送/克隆失败归因 ─────────────────────────

# classify_net_failure <git 输出>：输出是否为「连不上」类失败（而非凭据问题）。
#
# 把「连不上」与「缺凭据」混成一句会让用户白折腾：连不上该去查网络/代理，
# 缺凭据才该去配 PAT。这里只做分类，措辞留给调用方。
#
# ⚠️ 必须覆盖 `CONNECT tunnel failed, response 502` —— 走 HTTP 代理访问 GitHub
#    被中间设备拦截时就报这一句，而它既不含 "failed to connect" 也不含
#    "could not resolve host"，早先的正则漏了它，于是落到「原因见上方输出」，
#    恰好丢掉了「该去查网络」这条唯一有用的指引。
is_network_failure() {
  printf '%s' "$1" | grep -qiE \
    "could not resolve host|failed to connect|connection (refused|timed out)|operation timed out|network is unreachable|connect tunnel failed|proxy connect aborted|response 5[0-9][0-9]"
}

# classify_auth_failure <git 输出>：输出是否为「缺凭据」类失败。
is_auth_failure() {
  printf '%s' "$1" | grep -qiE \
    "could not read username|authentication failed|permission denied|repository not found|403|401"
}
