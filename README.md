# dsh-workbuddy-websearch

将 WorkBuddy 桌面 App 的网络搜索接入 DeepSeek Harness 的 web_search 工具（零配置、零硬依赖）

装上本插件后，dsh 内置的 `web_search` 会改用你 **WorkBuddy 账号的登录态**（积分套餐）调用云端
agentic 检索，返回**带引用来源的综述文本**。不需要任何 API Key，也不用改 dsh 的模型配置。

- **零配置** —— 复用 WorkBuddy 桌面端登录态，不填任何 Key、不改账号设置。
- **零硬依赖** —— 不装其他 dsh 插件也能完整工作；平台定位、5.6+ 加密凭据解密、
  国内版/国际版双版本读取均自带。
- **对凭据文件只读** —— token 续期只在内存中完成，不回写磁盘，与其他插件零冲突。
- **纯 ESM，无构建步骤，无第三方依赖** —— clone 下来即可用。
- **不锁版本上限** —— dsh 与 WorkBuddy 出了更新版本照样能装，只声明「已验证到哪」。

## 目录

- [安全](#安全)
- [安装](#安装)
  - [依赖](#依赖)
  - [卸载](#卸载)
- [使用](#使用)
  - [CLI](#cli)
  - [配置](#配置)
- [适用范围](#适用范围)
  - [版本策略：允许更新版本安装，只声明「已验证到哪」](#版本策略允许更新版本安装只声明已验证到哪)
- [注意事项](#注意事项)
- [致谢](#致谢)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 安全

- 本插件对 WorkBuddy 桌面端的凭据文件**只读**；token 续期只在内存中完成，**不回写磁盘**。
- 所有请求只发往 **WorkBuddy 官方网关**（国内 `https://copilot.tencent.com`、
  国际 `https://www.workbuddy.ai`），不经过任何第三方中转，也不会把你的凭据发往别处。
- 发现安全问题请**不要开公开 Issue**，按 [SECURITY.md](./SECURITY.md) 的渠道私下反馈。

## 安装

前置只有一条：**本机已安装并登录 WorkBuddy 桌面 App**（国内版 WorkBuddy 或国际版
WorkBuddy AI 任一）。

> **`dsh-workbuddy-connect` 是可选增强，不是前置。** 装了会更稳（复用其久经验证的凭据 store），
> 不装也能完整工作。详见[适用范围](#适用范围)。

> 🔴 **同一个搜索 provider id 只能有一个插件注册。** 本插件注册 `workbuddy-agentic`；
> 若你还装着**注册了同一 id 的其他插件**（本插件的旧版本 / 前身版本、改过 id 的 fork 等），
> dsh 的 `ctx.web` 会按 id 去重 —— **同时装只会有一个生效**，另一个静默不激活
> （日志里只有一行 `1 entry did not activate`）。撞上这个坑时，插件会直接告诉你
> **怎么把占用者查出来、怎么卸**。
> 详见 [COMPATIBILITY.md](./COMPATIBILITY.md) §7.1。

> ⚠️ **装之前先确认 dsh 用的是哪个数据目录。** dsh 未设 `DSH_HOME` 时会回落到默认
> 数据目录（`~/.dsh`）。若你平时是用某个包装脚本 / 固定数据目录启动 dsh 的，
> 请让安装时的 `DSH_HOME` 与它**保持一致**，否则插件会被装进另一个你并不会启动的环境。
> 用各发行版自带的 `dsh` / `dsh.bat` 启动可避免此问题。

对**每一份** dsh 副本执行一次，用你平时启动 dsh 的方式调用它的 CLI：

```bash
# <本插件目录>：你 clone 下来的仓库路径，或 npm 包名
dsh plugin --profile web add <本插件目录>
```

若 `dsh` 不在 `PATH` 上，直接用它的绝对入口调用，效果相同：

```bash
"<node>" "<dsh 安装根>/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add "<本插件目录>"
```

核验（应看到 `searchProvider: workbuddy-agentic` 与 `id: web-workbuddy-websearch`）：

```bash
dsh --profile web --dump-config | grep -i "workbuddy-websearch\|searchProvider"
```

若核验不通过 → 跑安装助手修复链接与 `bundles` 登记：

```bash
node "<本插件目录>/tools/ensure-installed.mjs" "<你的 DSH_HOME>" web
```

> 📌 **上面「安装助手」那一步仅适用于「从源码 / git 安装」**：安装助手随仓库分发，
> **不进 npm 包**，所以 `<本插件目录>` 必须是你 clone 下来的仓库路径，不能是 npm 解出的包目录。
> 若你是从 npm 装的又撞上了链接不落地的坑，可以按上面方式 clone 一份源码，
> 用它的 `tools/ensure-installed.mjs` 修（脚本只操作 profile，与插件来源无关，照样管用）。

> **两个已知的 pnpm 坑**：
> ① `plugin add <本地目录>` 在部分环境下会把 `node_modules/dsh-workbuddy-websearch`
> 留成**空目录**（而非 junction），且首次 add 可能不登记 `bundles`；
> ② **版本号未变时重装不会刷新** —— pnpm 判定 "Lockfile is up to date" 直接跳过，
> 改过的代码不会被覆盖。迭代时**必须 bump version**，或先 `remove` 再 `add`。

重启 dsh 后，`web_search` 即走 WorkBuddy 搜索（模型回答里会带来源链接）。

> **开发态 vs 发布态**：依赖写成 `link:<源码目录>` 即「开发态」（改源码立即生效，无需重装）；
> 写成 `file:<某.tgz>` 即「发布态」（装的是快照，改源码需重装）。联调用前者，模拟用户安装用后者。

### 依赖

| 依赖 | 要求 | 说明 |
|---|---|---|
| **Node** | `>= 20` | 实测 v22 / v24；真实下界是 `AbortSignal.any`（20.3+） |
| **WorkBuddy 桌面 App** | 已安装**并登录** | 国内版或国际版任一 |
| **Python** | **不需要** | 本插件不调用 Python（dsh 自带的 Python 是给它自己用的） |
| **git** | **运行时不依赖** | 只在 `npm install` 装 git 依赖、或 `git clone` 做开发时需要 |
| **原生构建工具链** | **不需要** | 零运行时依赖，没有需要编译的模块 |
| **其他 dsh 插件** | **不需要** | 零硬依赖，独立工作 |

> 逐项实测依据见 [COMPATIBILITY.md](./COMPATIBILITY.md) §5。

### 卸载

```bash
dsh plugin --profile web remove dsh-workbuddy-websearch
```

`remove` 会同时移除 dependencies 与 bundles 登记；bundle patch 随包消失，`web` 行自动回到
dsh-base 默认（`searchProvider: deepseek-official`），无需手动改配置。
若 remove 后 `node_modules` 里仍残留空目录，手动删掉即可。

> ⚠️ 若你曾在 profile 的 `cordis.patch.yml` 里写过 `- id: web-workbuddy-websearch` 传 config，
> 卸载后需**手动删掉**该行，否则 dsh 启动会报 `entry not found`（仅告警）。

## 使用

安装并重启 dsh 后**无需任何额外操作** —— 模型调用 `web_search` 时自动走 WorkBuddy：

```
你：帮我搜一下最近的 XX 进展
  └─ 模型内部调用 web_search
       └─ WorkBuddy 云端多步 agentic 检索
            └─ 返回带引用来源的综述文本
```

### CLI

`headless` profile 同样可用：

```bash
dsh headless "帮我搜一下最近的 XX 进展"
```

> 注意 `headless` profile 的**默认模型**走 `deepseek-official`（需 DeepSeek API Key）；
> 想让它也复用 WorkBuddy 登录态，需在该 profile 的 `cordis.patch.yml` 里把
> `agent-default-model` 的 `provider` 改为 `workbuddy`。
> 详见 [COMPATIBILITY.md](./COMPATIBILITY.md) §7。**模型配置与搜索插件是两件事，别混淆。**

### 配置

全部为环境变量，**都有默认值，不设也能用**：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_SEARCH_REGION` | `global` | 期望账号区域：`global`（国际版）/ `cn`（国内版） |
| `WORKBUDDY_SEARCH_MODE` | `2` | 云端 search_mode（2 = PRO，桌面 App 同款） |
| `WORKBUDDY_SEARCH_MAX_CONTENT_CHARS` | `30000` | 综述回传上限字符，`0` = 不截断 |
| `WORKBUDDY_SEARCH_ENDPOINT` | 按区域自动 | 覆盖网关地址 |
| `WORKBUDDY_AUTH_FILE` | 自动探测 | 显式指定**国内版**凭据 JSON 路径 |
| `WORKBUDDY_AI_AUTH_FILE` | 自动探测 | 显式指定**国际版**凭据 JSON 路径 |
| `WORKBUDDY_ELECTRON_BIN` | 自动探测 | 国内版 App 的 Electron 二进制（解密 5.6+ 凭据用） |
| `WORKBUDDY_AI_ELECTRON_BIN` | 自动探测 | 国际版 App 的 Electron 二进制（**装在自选盘符/自定义路径时必填**） |

> **自动探测顺序**：① 上面的环境变量 → ② 平台默认布局
> （Windows 国内版 `%LOCALAPPDATA%\Programs\WorkBuddy\`；macOS `/Applications/*.app`）
> → ③ Windows 常见安装根的**一层有界扫描**（`%LOCALAPPDATA%\Programs`、`%ProgramFiles%*` 下
> 目录名以 `WorkBuddy` 开头的；**不枚举盘符、不做全盘遍历**）。
>
> ❗ 官方安装器允许把 App 装到**自选盘符或自定义目录**，这种情况**不会被自动发现**，
> 请用环境变量显式指定。找不到时插件抛出的错误里已包含**可直接粘贴**的设置命令。
> 详见 [COMPATIBILITY.md](./COMPATIBILITY.md) §4.1。

## 适用范围

| 项 | 要求 |
|---|---|
| **操作系统** | **Windows x64**（稳定）· **macOS**（🧪 实验性，未在真机验证） |
| **CPU** | x64 / arm64（**32 位 Windows 不支持**：WorkBuddy 桌面端无 32 位构建） |
| **dsh** | `>= 0.1.5-rc.2`（实测 0.1.5-rc.2 / 0.1.7-rc.1 / 0.2.0-rc.2 全通过） |
| **Node** | `>= 20`（实测 v22 / v24） |
| **WorkBuddy 桌面 App** | 已安装**并登录**（国内版 / 国际版任一） |
| **dsh profile** | **任意**：`web` / `headless` / `tui` / `desktop` 均可 |

不支持的平台：**32 位 Windows**、**Linux / WSL**、**鸿蒙**（WorkBuddy 鸿蒙版是手机 App，非桌面端）。

### 版本策略：允许更新版本安装，只声明「已验证到哪」

本插件**不锁版本上限** —— dsh 或 WorkBuddy 出了更新版本，**照样能装、能用**。
我们只在文档里说清楚「验证过哪些版本」，把判断权留给你。

| 组件 | 已验证 | 是否阻止安装 |
|---|---|---|
| **dsh** | 0.1.5-rc.2 / 0.1.7-rc.1 / 0.2.0-rc.2 | ❌ **不阻止**（含未来的 1.x / 2.x） |
| **WorkBuddy 桌面端** | 国内版 + 国际版；明文与 `$wbEncrypted` 加密两种凭据格式均实测 | ❌ **不阻止** |
| **Node** | v22.22.2 / v24.21.0 | ❌ 不阻止（仅 `engines` 提示） |

> 之所以能做到「不锁上限」，是因为本插件只依赖一个极窄的接缝
> （`ctx.web.registerSearchProvider`），且**刻意不声明** `@deepseek-ai/dsh*` 的
> `peerDependencies` 版本区间 —— 那会主动引入「被拒装」的风险。
> 实现细节与护栏见 [DEVELOPING.md](./DEVELOPING.md) 的「版本策略」与
> [NORM-COMPLIANCE.md](./NORM-COMPLIANCE.md) §2.5。

**装了更新版本后搜索失效怎么办？** 按顺序排查：

1. `dsh --profile web --dump-config | grep -A6 "id: web"` —— 看 `searchProvider`
   还是不是 `workbuddy-agentic`（不是 → patch 层没套上）；
2. 看桌面端是否还登着（登出会导致 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，见[注意事项](#注意事项)）；
3. 若接缝变了，带着你的 dsh 版本号提 Issue，我们会补验证并更新上表。

**`dsh-workbuddy-connect` 是可选增强，不是前置**：装了它 → 复用其久经验证的凭据 store
（对罕见落盘形态与刷新时序兼容更完整）；**不装它 → 一切照常工作**，即便它加载失败或内部报错，
也会**静默降级**，不会让搜索失效。

完整兼容矩阵、实测依据与边界清单见 **[COMPATIBILITY.md](./COMPATIBILITY.md)**。

## 注意事项

- ⚠️ **只管搜索，不管抓取。** 这是最容易误解的一点：

  | 工具 | 谁提供 | 是否用 WorkBuddy 登录态 |
  |---|---|---|
  | `web_search`（联网搜索） | **本插件** | ✅ 是（你的 WorkBuddy 账号） |
  | `web_fetch`（抓取指定 URL） | dsh 内置 `web-fetch-http` | ❌ 否（直连目标站点） |

  想换抓取后端请另行配置 `fetchProvider`，**与本插件无关**。

- ⚠️ **未登录时 `web_search` 会整体报错，不降级。** 本插件把 `searchProvider` 写死为
  `workbuddy-agentic`，而 dsh 的 provider 选择是「配置了就认死」：一旦桌面端登出
  （或 token 过期且 refresh 失败），会抛出 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，
  **不会**悄悄退回 DeepSeek 搜索。
  **排查口诀：报这个 code → 先看桌面端还登着吗。**

- ⚠️ **桌面端装在自选盘符 / 自定义路径时需手动指定二进制。** 插件**不猜、不枚举盘符**，
  需设 `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN`。未设时会**回落到另一版的
  明文凭据**（若存在）而不是整体失败。

- 一次查询 = 云端一次多步 agentic 检索，实测 10~60 秒；dsh 的 `web_search` 允许模型一次发
  1-4 个查询并发跑，开销较大属服务特性，不是 bug。**中途 abort 有效**（实测 100ms 内即中止）。

- 综述里的引用由搜索服务自行选取；不提供 `snippet`（云端不下发原文摘录）。

- 凭据过期且 refresh 也失效时，需回 WorkBuddy 桌面 App 重新登录。

- 想用回 dsh 官方搜索：把 `web` 行 `searchProvider` 改回 `deepseek-official`，或直接卸载本插件。

- 📋 **失败态可自查**：`node tools/scenarios.mjs <插件目录>` 会离线验证 40 项异常路径
  （空查询、断网、401、流畸形、凭据损坏、并发、abort、接管范围、connect 装了但坏掉等）。

## 致谢

本插件站在他人成果之上，**尤其感谢 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
的作者 Corrine Hu** —— WorkBuddy 5.6+ 的 `$wbEncrypted` 凭据解密算法、平台路径规则、
Electron 二进制定位策略，都源自该项目的逆向与验证工作（MIT 许可）。

我们把这部分能力重写为零依赖的自带模块，并**在代码注释中逐处标注来源**。
完整的借鉴清单、来源项目、许可证与各自的贡献边界，见 **[CREDITS.md](./CREDITS.md)**。

> 若你是被借鉴项目的作者，认为标注不足或使用方式不当，请提 Issue —— 我们会补正或重写。

## 参与贡献

欢迎提 Issue 与 PR。三条最短规则：

- **报告 Bug / 提需求**：请用仓库的 **Issue 模板**（Bug 报告 / 功能请求），
  模板会把必要信息（dsh 版本、平台、是否已登录、错误码）一次问全，省去来回。
- **安全问题请勿走公开 Issue**，见 [SECURITY.md](./SECURITY.md)。
- **参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。**

完整的贡献流程、提交规范与不能碰的红线，见 **[CONTRIBUTING.md](./CONTRIBUTING.md)**。
动手改代码前，建议按这个顺序读文档：

| 文档 | 用途 |
|---|---|
| **[TESTING.md](./TESTING.md)** | 测试体系与发布回环：场景地图、三层套件（T1–T10 / S1–S9 / G1–G9）、发布流程。**改代码前先读它。** |
| **[DEVELOPING.md](./DEVELOPING.md)** | 本地联调环境（junction 挂载、`--dump-config` 核验）、实现要点与安装排障。 |
| **[COMPATIBILITY.md](./COMPATIBILITY.md)** | 兼容矩阵与逐条实测依据。 |
| **[NORM-COMPLIANCE.md](./NORM-COMPLIANCE.md)** | 与 dsh 官方规范的符合性审计（源码级证据），以及「哪些要改、哪些故意不改」。 |
| **[GITHUB-SETUP.md](./GITHUB-SETUP.md)** | GitHub 侧要求对照：社区档案清单、工作流安全加固、仓库网页端设置清单。 |

## 许可证

[MIT](./LICENSE) © 2026 XingLang & WorkBuddy (小研)
