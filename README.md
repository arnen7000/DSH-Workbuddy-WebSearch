# dsh-workbuddy-websearch

把 **WorkBuddy 桌面 App 的网络搜索服务**接入 **DeepSeek Harness (dsh)**：装上后，
dsh 内置的 `web_search` 工具会通过 WorkBuddy 的登录态（积分套餐）调用云端
agentic 搜索，返回带引用来源的综述文本。

- **零硬依赖**：不装任何其他 dsh 插件也能完整工作；桌面端登录态、5.6+ 加密凭据解密均自带。
- 复用 WorkBuddy 桌面端登录态，**零配置**、不需要任何 API Key。
- 对凭据文件**只读**（token 续期只在内存里做），与其他插件零冲突。
- 纯 ESM 实现，无构建步骤，无第三方依赖。

## WHY：工作原理（一图流）

```
dsh 会话                     本插件                       WorkBuddy 云端
   │                           │                              │
   │  模型调 web_search        │                              │
   │  {queries:[...]}  ──────▶ │                              │
   │                           │  读凭据(只读)：              │
   │                           │  .workbuddy-auth.json /      │
   │                           │  桌面端 workbuddy-desktop.info│
   │                           │  (过期→内存refresh，不写盘)  │
   │                           │                              │
   │                           │  POST /agenttool/v1/         │
   │                           │  agentic_search              │
   │                           │  {query,search_mode:2,       │
   │                           │   stream:true,biz_via}       │
   │                           │  Authorization: Bearer token │────▶ 远程agent
   │                           │  ◀── SSE: tool_call/result   │      多步检索
   │                           │  ◀── SSE: done(synthesis)    │
   │                           │                              │
   │  {content: 综述,          │  提取markdown链接→sources    │
   │   sources:[{url,title}]}◀─│  清理<selected-refs>         │
   │  经 ctx.web 接缝回给模型   │                              │
```

**端点取证**（2026-09-24，WorkBuddy 桌面 App `app.asar` 内
`builtin-tools/tools/agentic-search-tool.ts` 反编译确认 + 实测 200 OK）：

- `POST {网关}/agenttool/v1/agentic_search`，网关国内 `https://copilot.tencent.com`、
  国际 `https://www.workbuddy.ai`（按凭据 `domain` 字段自动分流）；
- 请求体 `{query, search_mode: 2, stream: true, biz_via}`，
  `biz_via = enterpriseId ? "internal" : "public"`；
- 响应为 SSE：`done` 事件的 `synthesis.content` 即带引用的综述。

**接缝取证**：dsh 的搜索能力走 `ctx.web`（`@deepseek-ai/dsh-web`），
`registerSearchProvider(provider)`；三个版本（0.1.5-rc.2 / 0.1.6-alpha.2 /
0.1.7-rc.1）该接缝完全一致。本插件的 `cordis.patch.yml` 做两件事：

1. 挂载插件行 `web-workbuddy-websearch`；
2. 把 `web` 行的 `searchProvider` 从 `deepseek-official` 改为 `workbuddy-agentic`
   （dsh 的 provider 选择是"配置了 id 就认死"，不覆盖则 web_search 永远先撞
   DeepSeek 的 API Key 校验）。

### ⚠️ 接管范围：只管**搜索**，不管**抓取**

这是最容易误解的一点，请务必看清：

| 工具 | 谁提供 | 是否用 WorkBuddy 登录态 |
|---|---|---|
| `web_search`（联网搜索） | **本插件** | ✅ 是（你的 WorkBuddy 账号） |
| `web_fetch`（抓取指定 URL） | dsh 内置 `web-fetch-http` | ❌ 否（直连目标站点） |

也就是说，装了本插件后：

- **搜索**会走 WorkBuddy 云端 agentic 检索，返回带引用的综述，**不需要** DeepSeek API Key；
- **抓取**仍是 dsh 原生的直连 HTTP 行为，**与本插件无关**，想换后端请另行配置
  `fetchProvider`。

本插件的 `cordis.patch.yml` 之所以**显式复述** `fetchProvider: http`，是因为 dsh 的
patch 语义是「按 id **整行替换** config」而非合并——不写这一行，`web` 行原有的
`fetchProvider` 会被静默抹掉。实测三版本（0.1.5-rc.2 / 0.1.7-rc.1 / 0.2.0-rc.2）
的最终配置均完整保留 `fetchProvider: http`。

## HOW：安装

前置：**已安装并登录 WorkBuddy 桌面 App**（国内版或国际版任一）。这就够了——
本插件**零硬依赖**，不需要其他 dsh 插件，也不需要 API Key。

> `dsh-workbuddy-connect` 是**可选增强**：装了会更稳（复用其凭据 store，对罕见
> 落盘形态与刷新时序兼容更好），不装也能完整工作。详见「适用范围」一节。

> 🔴 **装之前先卸掉 `dsh-workbuddy-searchserver`（如果你有）**：那是本插件的**前身插件**，
> 两者注册的是同一个 provider id `workbuddy-agentic`，而 dsh 的 `ctx.web` 按 id 去重
> ——**同时装只会有一个生效**，另一个直接不激活（`1 entry did not activate`）。
> 卸法见 [COMPATIBILITY.md](./COMPATIBILITY.md) §7.1；从 v0.2.4 起，撞上这个坑时插件会
> 直接告诉你该卸谁、怎么卸。

> ⚠️ **务必先设 `DSH_HOME`**：dsh 在未设该变量时会回落到默认目录 `~/.dsh`，
> 你可能会把插件装进一个根本没用过的环境（本仓库作者实测踩过这个坑）。
> 用各版本自带的 `dsh.bat` / `dsh-cli.bat` 可避免此问题（它们已内置 `DSH_HOME`）。

> **已知的 pnpm 坑（实测）**：`plugin add <本地目录>` 在部分环境下会把
> `node_modules/dsh-workbuddy-websearch` 留成**空目录**（而非 junction），
> 且首次 add 可能不登记 `bundles`。所以 add 之后若 `--dump-config` 核验不通过，
> 跑一遍第 3 步的助手脚本即可（幂等，可重复执行）。
>
> 另一个坑：**版本号未变时重装不会刷新**。pnpm 会判定
> "Lockfile is up to date" 并跳过，改过的代码不会被覆盖。迭代时**必须 bump
> version**，或先 `remove` 再 `add`。

对**每一份** dsh 副本执行（cmd/PowerShell；务必设 `DSH_HOME` 隔离数据根）：

```bat
:: 0. 先按你的实际安装位置设好这几个变量（把 <...> 换成你的真实路径）
set "DSH_ROOT=<dsh 安装根>"                   :: dsh 的安装目录
set "DSH_HOME=%DSH_ROOT%\.dsh-home"          :: dsh 的数据根，务必隔离
set "DSH_NODE=%DSH_ROOT%\node\node.exe"      :: dsh 自带的 node
set "PLUGIN=<本插件目录>"                     :: 你 clone 下来的仓库路径

:: 1. 安装（写依赖）
"%DSH_NODE%" "%DSH_ROOT%\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add "%PLUGIN%"

:: 2. 核验（应看到 searchProvider: workbuddy-agentic 与 id: web-workbuddy-websearch）
"%DSH_NODE%" "%DSH_ROOT%\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config | findstr /I "workbuddy-websearch searchProvider"

:: 3. 若第 2 步核验不通过 → 跑安装助手修复链接与 bundles 登记
"%DSH_NODE%" "%PLUGIN%\tools\ensure-installed.mjs" "%DSH_HOME%" web
```

> 📌 **第 3 步仅适用于「从源码 / git 安装」**：安装助手随仓库分发，**不进 npm 包**
> （npm 包只含 `lib/` 与文档）。所以上面 `%PLUGIN%` 必须是**你 clone 下来的仓库路径**，
> 不能是 npm 解出的包目录。
>
> 如果你是从 npm 装的、又撞上了 pnpm 不落地 `link:` 的坑，有两个选择：
> ① 按上面同样方式 clone 一份源码，用它的 `tools/ensure-installed.mjs` 修（脚本只操作
> profile，与插件来源无关，照样管用）；② 直接手建 junction / 补 `bundles`（见
> [DEVELOPING.md](./DEVELOPING.md) 的「安装排障」）。

重启 dsh 后，`web_search` 工具即走 WorkBuddy 搜索（模型回答里会带来源链接）。

> **开发态 vs 发布态（进阶）**：把依赖写成 `link:<源码目录>` 即「开发态」——
> 改源码立即生效，无需重装；写成 `file:<某.tgz>` 即「发布态」——安装的是快照，
> 改源码需重装。做开发联调用前者，模拟用户安装用后者。

## HOW：卸载

```bat
set "DSH_ROOT=<dsh 安装根>"
set "DSH_HOME=%DSH_ROOT%\.dsh-home"
set "DSH_NODE=%DSH_ROOT%\node\node.exe"
"%DSH_NODE%" "%DSH_ROOT%\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web remove dsh-workbuddy-websearch
```

`remove` 会同时移除 dependencies 与 bundles 登记；bundle patch 随包消失，
`web` 行自动回到 dsh-base 默认（`searchProvider: deepseek-official`），无需手动改配置。
若 remove 后 `node_modules` 里仍残留 `dsh-workbuddy-websearch` 空目录，手动删掉即可。

## 适用范围（前置条件）

| 项 | 要求 |
|---|---|
| **操作系统** | **Windows x64**（稳定）· **macOS**（🧪 实验性，未在真机验证） |
| **CPU** | x64 / arm64（**32 位 Windows 不支持**：WorkBuddy 桌面端无 32 位构建） |
| **dsh** | `>= 0.1.5-rc.2`（实测 0.1.5-rc.2 / 0.1.7-rc.1 / 0.2.0-rc.2 全通过） |
| **Node** | `>= 20`（实测 v22 / v24；真实下界是 `AbortSignal.any`，20.3+） |
| **Python** | **不需要**——本插件不调用 Python（dsh 自带的 Python 是给它自己用的） |
| **git** | **运行时不依赖**——只在 `npm install` 装 git 依赖、或 `git clone` 做开发时才需要 |
| **原生构建工具链** | **不需要**——零运行时依赖，没有需要编译的模块 |
| **WorkBuddy 桌面 App** | 已安装**并登录**（国内版 WorkBuddy 或国际版 WorkBuddy AI 任一） |
| **dsh profile** | **任意**：`web`（桌面/浏览器 UI）、`headless`（CLI 一次性任务）、`tui`（终端 UI）均可 |
| **其他 dsh 插件** | **无需**。本插件零硬依赖，独立工作 |

不支持的平台：**32 位 Windows**、**Linux / WSL**、**鸿蒙**（WorkBuddy 鸿蒙版是手机 App，非桌面端）。

> 依赖环境的**实测范围**与逐项依据（含"为什么 Node 下界是 20.3 而不是 20"）见
> [COMPATIBILITY.md](./COMPATIBILITY.md) §5「依赖环境（Node / Python / git / 原生模块）」。

> 💡 **CLI 用法**：`dsh headless "帮我搜一下最近的 XX 进展"` 也可以正常工作。
> 注意 `headless` profile 默认模型走 `deepseek-official`（需 API Key）；
> 想复用 WorkBuddy 登录态，需在该 profile 的 `cordis.patch.yml` 把
> `agent-default-model` 的 `provider` 改为 `workbuddy`（详见 [COMPATIBILITY.md](./COMPATIBILITY.md) §7）。
> **模型配置与搜索插件是两件事**，别混淆。

### 版本策略：**允许更新版本安装**，只声明"已验证到哪"

本插件**不锁版本上限**——dsh 或 WorkBuddy 出了更新版本，**照样能装、能用**。
我们只在文档里说清楚"验证过哪些版本"，把判断权留给你。

| 组件 | 已验证（端到端跑通真实搜索） | 未验证但预期可用 | 是否阻止安装 |
|---|---|---|---|
| **dsh** | **0.1.5-rc.2**、**0.1.7-rc.1**、**0.2.0-rc.2** | 0.1.6-alpha.2（接缝已核对，未端到端）；> 0.2.0-rc.2（接缝稳定，预期兼容） | ❌ **不阻止**（含未来的 1.x / 2.x） |
| **WorkBuddy 桌面端** | 国内版 + 国际版，两条凭据路径均实测：**明文格式**与 **`$wbEncrypted` 加密格式**（加密格式已在实机 **5.6.2** 上端到端解出真实 token） | 更新版本（凭据格式若变，见下方排查） | ❌ **不阻止** |
| **Node** | v22.22.2 / v24.21.0 | `>= 20` 任意版本 | ❌ 不阻止（仅 `engines` 提示） |

**为什么能做到"不锁上限"**：本插件只依赖一个极窄的接缝
（`ctx.web.registerSearchProvider`），且在 0.1.5-rc.2 / 0.1.7-rc.1 / 0.2.0-rc.2
三个版本里该接缝结构完全一致。因此我们**刻意不声明** `@deepseek-ai/dsh*` 的
`peerDependencies` 版本区间——那会主动引入"被拒装"的风险（详见 [NORM-COMPLIANCE.md](./NORM-COMPLIANCE.md)）。

`package.json` 里用 `dsh.compatibility` 记录已验证清单（**纯声明，不参与强制校验**）：

```json
"dsh": {
  "compatibility": {
    "dsh": ">=0.1.5-rc.2",
    "dshReleases": { "0.1.5-rc.2": "compatible", "0.1.7-rc.1": "compatible", "0.2.0-rc.2": "compatible" }
  }
}
```

> **装了更新版本后搜索失效怎么办？** 按顺序排查：
> ① `dsh --profile web --dump-config | grep -A6 "id: web"` 看 `searchProvider` 还是不是
> `workbuddy-agentic`（不是 → patch 层没套上）；
> ② 看桌面端是否还登着（登出会导致 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，见「已知边界」）；
> ③ 若接缝变了，带着你的 dsh 版本号提 Issue，我们会补验证并更新上表。

### `dsh-workbuddy-connect` 是可选增强，不是前置

装了它 → 复用其久经验证的凭据 store（对罕见落盘形态与刷新时序兼容更完整）。
**不装它 → 一切照常工作**：本插件自带平台定位、5.6+ 加密凭据解密、双版本读取。
即便它加载失败或内部报错，也会**静默降级**，不会让搜索失效。

详细兼容矩阵、实测依据与边界清单见 **[COMPATIBILITY.md](./COMPATIBILITY.md)**。

## 开发与测试（贡献者 / 反馈处理）

| 文档 | 用途 |
|---|---|
| **[TESTING.md](./TESTING.md)** | 测试体系与发布回环：场景地图五阶段、三层套件（T1–T10 / S1–S9 / G1–G9）、发布八步流程、覆盖矩阵。**改代码前先读它。** |
| **[NORM-COMPLIANCE.md](./NORM-COMPLIANCE.md)** | 与 dsh 官方规范的符合性审计（源码级证据），以及「哪些要改、哪些故意不改」。 |
| **[GITHUB-SETUP.md](./GITHUB-SETUP.md)** | GitHub 侧要求对照：社区档案清单、工作流安全加固、仓库网页端设置清单。 |

三层套件均可离线运行：

```bash
node tools/regression.mjs "<已安装插件目录>"      # 正常路径 + 契约（T1–T10）
node tools/scenarios.mjs  "<插件目录>"             # 异常路径 + 接管范围 + 体系自检（S1–S9）
node tools/check-github-meta.mjs "<仓库根>"        # GitHub 门面 + 本机信息零泄露 + 时间分级（G1–G9）
```

> ⚠️ 卸载提醒：若你在 profile 的 `cordis.patch.yml` 里写过 `- id: web-workbuddy-websearch`
> 传 config，卸载后需**手动删掉**该行，否则 dsh 启动会报 `entry not found`（仅告警）。

## 配置（可选，全部环境变量，均有默认值）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_SEARCH_REGION` | `global` | 期望账号区域：`global`（国际版）/ `cn`（国内版） |
| `WORKBUDDY_SEARCH_MODE` | `2` | 云端 search_mode（2=PRO，桌面 App 同款） |
| `WORKBUDDY_SEARCH_MAX_CONTENT_CHARS` | `30000` | 综述回传上限字符，`0`=不截断 |
| `WORKBUDDY_SEARCH_ENDPOINT` | 按区域自动 | 覆盖网关地址 |
| `WORKBUDDY_AUTH_FILE` | 自动探测 | 显式指定**国内版**凭据 JSON 路径 |
| `WORKBUDDY_AI_AUTH_FILE` | 自动探测 | 显式指定**国际版**凭据 JSON 路径 |
| `WORKBUDDY_ELECTRON_BIN` | 自动探测 | 国内版 App 的 Electron 二进制（解密 5.6+ 凭据用） |
| `WORKBUDDY_AI_ELECTRON_BIN` | 自动探测 | 国际版 App 的 Electron 二进制（**装在自选盘符/自定义路径时必填**） |

> **自动探测顺序**：① 上面的环境变量 → ② 平台默认布局
> （Windows 国内版 `%LOCALAPPDATA%\Programs\WorkBuddy\`；macOS `/Applications/*.app`）
> → ③ Windows 常见安装根的**一层有界扫描**（`%LOCALAPPDATA%\Programs`、`%ProgramFiles%*`
> 下目录名以 `WorkBuddy` 开头的；**不枚举盘符、不做全盘遍历**）。
>
> ❗ 官方安装器允许把 App 装到**自选盘符或自定义目录**，这种情况**不会被自动发现**，
> 请用环境变量显式指定。找不到时插件抛出的错误里已包含**可直接粘贴**的设置命令。
> 详见 [COMPATIBILITY.md](./COMPATIBILITY.md) §4.1。

## 已知边界（诚实清单）

- ⚠️ **未登录时 `web_search` 会整体报错，不降级**。本插件把 `searchProvider` 写死为
  `workbuddy-agentic`，而 dsh 的 provider 选择是「配置了就认死」：一旦 WorkBuddy
  桌面端登出（或 token 过期且 refresh 失败），`web_search` 会抛出
  `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，**不会**悄悄退回 DeepSeek 搜索。
  **排查口诀：报这个 code → 先看桌面端还登着吗。**（详见 COMPATIBILITY §10）
- ⚠️ **只管搜索，不管抓取**。`web_search` 走 WorkBuddy；`web_fetch` 仍是 dsh 原生
  直连 HTTP，与本插件无关。（详见上文「接管范围」）
- 一次查询 = 云端一次多步 agentic 检索，实测 10~60 秒；dsh 的 `web_search`
  允许模型一次发 1-4 个查询并发跑，开销较大属服务特性，不是 bug。
  **中途 abort 有效**：实测 100ms 内即中止，不会白付一次完整检索费用。
- 综述里的引用是搜索服务自己选的来源；`snippet` 不提供（云端不下发原文摘录）。
- 凭据过期且 refresh 也失效时，需回 WorkBuddy 桌面 App 重新登录。
- ❗ **桌面端装在自选盘符/自定义路径时需手动指定二进制**：官方安装器允许改安装目录，
  这种情况插件**不猜、不枚举盘符**。若桌面端 ≥ 5.6 且凭据已加密，需设
  `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN`。
  未设时插件会**回落到另一版的明文凭据**（若存在）而不是整体失败——
  可用 `getLastCredentialSource()` 或日志确认当前实际用的是哪一版。
  （为什么不用注册表自动找？见 [COMPATIBILITY.md](./COMPATIBILITY.md) §4.1。）
- provider id `workbuddy-agentic` 注册后，若你同时配好 DeepSeek API Key 并想
  用回官方搜索：把 `web` 行 `searchProvider` 改回 `deepseek-official` 即可
  （profile 的 `cordis.patch.yml` 里加一行覆盖，或卸载本插件）。
- 📋 **失败态可自查**：`node tools/scenarios.mjs <插件目录>` 会离线验证 40 项
  异常路径（空查询、断网、401、流畸形、凭据损坏、并发、abort、接管范围、**connect 装了但坏掉**等）。

## 致谢与借鉴声明

本插件站在他人成果之上，**尤其感谢 [dsh-workbuddy-connect](https://github.com/) 的作者
Corrine Hu**——WorkBuddy 5.6+ 的 `$wbEncrypted` 凭据解密算法、平台路径规则、
Electron 二进制定位策略，都源自该项目的逆向与验证工作（MIT 许可）。

我们把这部分能力重写为零依赖的自带模块，并**在代码注释中逐处标注来源**。
完整的借鉴清单、来源项目、许可证与我们各自的贡献边界，见 **[CREDITS.md](./CREDITS.md)**。

> 若你是被借鉴项目的作者，认为标注不足或使用方式不当，请提 Issue——我们会补正或重写。
