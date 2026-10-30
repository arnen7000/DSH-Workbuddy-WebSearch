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
  - [快速开始](#快速开始)
  - [遇到问题](#遇到问题)
  - [依赖](#依赖)
  - [卸载](#卸载)
- [使用](#使用)
  - [CLI](#cli)
  - [配置](#配置)
- [适用范围](#适用范围)
  - [版本策略：声明下界，不设上限](#版本策略声明下界不设上限)
- [注意事项](#注意事项)
- [变更记录](#变更记录)
- [致谢](#致谢)
- [参与贡献](#参与贡献)
  - [维护者：改一处代码并发布（最短路径）](#维护者改一处代码并发布最短路径)
  - [维护者：插件市场上架材料](#维护者插件市场上架材料)
- [许可证](#许可证)

## 安全

- 本插件对 WorkBuddy 桌面端的凭据文件**只读**；token 续期只在内存中完成，**不回写磁盘**。
- 所有请求只发往 **WorkBuddy 官方网关**（国内 `https://copilot.tencent.com`、
  国际 `https://www.workbuddy.ai`），不经过任何第三方中转，也不会把你的凭据发往别处。
- 发现安全问题请**不要开公开 Issue**，按 [SECURITY.md](./SECURITY.md) 的渠道私下反馈。

## 安装

前置只有一条：**本机已安装并登录 WorkBuddy 桌面 App**（国内版 WorkBuddy 或国际版
WorkBuddy AI 任一）。

### 快速开始

**从 DSH 插件市场装（最省事）** —— 在 DSH 里打开**插件市场**，搜索
`workbuddy-websearch`，点安装即可。安装、升级、卸载都在界面里完成，
不用记命令、不用碰配置文件。

**从 npm 装（命令行）** —— 本插件已发布到 npm，不必 clone：

```bash
dsh plugin --profile web add dsh-workbuddy-websearch
```

> ⚠️ **请固定版本号，或直接用市场安装。**
> pnpm 11 起内置了 24 小时的「新版本冷静期」（`minimum-release-age`）：
> 刚发布不久的版本会被**静默降级**到上一个满 24 小时的版本，
> 而 `@latest` 标签也绕不过它。想要立刻用上最新版就显式指定：
>
> ```bash
> dsh plugin --profile web add dsh-workbuddy-websearch@0.3.7
> ```
>
> DSH 插件市场**自带**这个问题的处理（安装前先把目标固定到注册表的最新版），
> 所以走市场安装不会有这个困扰。

**从源码装** —— 想改代码、或想固定到某个提交时：

```bash
# <本插件目录>：你 clone 下来的仓库路径
dsh plugin --profile web add <本插件目录>
```

对**每一份** dsh 副本各执行一次，用你平时启动 dsh 的方式调用它的 CLI。
**重启 dsh 即生效** —— `web_search` 走 WorkBuddy 搜索，模型回答里会带来源链接。

核验（应看到 `searchProvider: workbuddy-agentic` 与 `id: web-workbuddy-websearch`）：

```bash
dsh --profile web --dump-config | grep -i "workbuddy-websearch\|searchProvider"
```

若 `dsh` 不在 `PATH` 上，直接用它的绝对入口调用，效果相同：

```bash
"<node>" "<dsh 安装根>/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add dsh-workbuddy-websearch
```

**升级**（`plugin` 子命令就是 dsh 官方的插件管理入口）：

```bash
dsh plugin --profile web add dsh-workbuddy-websearch@latest   # 升到最新版
dsh plugin --profile web add dsh-workbuddy-websearch@0.3.7    # 或固定到某一版
```

### 遇到问题

**`add` 报错、或核验不通过**时，先试一遍幂等修复脚本（可反复跑，不会重复安装）：

```bash
node tools/ensure-installed.mjs "<DSH_HOME>" web
```

最常见的两个原因：① pnpm 没把 `link:` 依赖真正落地到 `node_modules`；
② 上一次 `add` 中途失败留下「半状态」（`dependencies` 已写、`node_modules` 不完整），
此时先 `remove` 再 `add`。

> **`dsh-workbuddy-connect` 是可选增强，不是前置。** 装了会更稳（复用其久经验证的凭据 store），
> 不装也能完整工作。详见[适用范围](#适用范围)。

> 🔴 **同一个搜索 provider id 只能有一个插件注册。** 本插件注册 `workbuddy-agentic`；
> 若你还装着**注册了同一 id 的其他插件**（本插件的旧版本 / 前身版本、改过 id 的 fork 等），
> dsh 的 `ctx.web` 会按 id 去重 —— **同时装只会有一个生效**，另一个静默不激活
> （日志里只有一行 `1 entry did not activate`）。撞上这个坑时，插件会直接告诉你
> **怎么把占用者查出来、怎么卸**。

> ⚠️ **装之前先确认 dsh 用的是哪个数据目录。** dsh 未设 `DSH_HOME` 时会回落到默认
> 数据目录（`~/.dsh`）。若你平时是用某个包装脚本 / 固定数据目录启动 dsh 的，
> 请让安装时的 `DSH_HOME` 与它**保持一致**，否则插件会被装进另一个你并不会启动的环境。
> 用各发行版自带的 `dsh` / `dsh.bat` 启动可避免此问题。

### 依赖

| 依赖 | 要求 | 说明 |
|---|---|---|
| **Node** | `>= 20` | 实测 v22 / v24；真实下界是 `AbortSignal.any`（20.3+） |
| **WorkBuddy 桌面 App** | 已安装**并登录** | 国内版或国际版任一 |
| **Python** | **不需要** | 本插件不调用 Python（dsh 自带的 Python 是给它自己用的） |
| **git** | **运行时不依赖** | 只在 `npm install` 装 git 依赖、或 `git clone` 做开发时需要 |
| **原生构建工具链** | **不需要** | 零运行时依赖，没有需要编译的模块 |
| **其他 dsh 插件** | **不需要** | 零硬依赖，独立工作 |

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
> **模型配置与搜索插件是两件事，别混淆。**

### 配置

全部为环境变量，**都有默认值，不设也能用**：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_SEARCH_REGION` | `auto` | 用哪一版账号：`auto`（选实际可用的那一版）/ `global`（国际版 WorkBuddy AI）/ `cn`（国内版 WorkBuddy） |
| `WORKBUDDY_SEARCH_MODE` | `2` | 云端 search_mode（2 = PRO，桌面 App 同款） |
| `WORKBUDDY_SEARCH_MAX_CONTENT_CHARS` | `30000` | 综述回传上限字符，`0` = 不截断 |
| `WORKBUDDY_SEARCH_ENDPOINT` | 按区域自动 | 覆盖网关地址 |
| `WORKBUDDY_AUTH_FILE` | 自动探测 | 显式指定**国内版**凭据 JSON 路径 |
| `WORKBUDDY_AI_AUTH_FILE` | 自动探测 | 显式指定**国际版**凭据 JSON 路径 |
| `WORKBUDDY_ELECTRON_BIN` | 自动探测 | 国内版 App 的 Electron 二进制（解密 5.6+ 凭据用） |
| `WORKBUDDY_AI_ELECTRON_BIN` | 自动探测 | 国际版 App 的 Electron 二进制（**装在自选盘符/自定义路径时必填**） |

> **两版账号不会混用。** 国内版（WorkBuddy）与国际版（WorkBuddy AI）是两套账号、
> 两套积分。插件在首次用到时**绑定其中一版**，整个会话不再切换；被绑定的那一版
> 没登录就如实报错，**不会**悄悄改用另一版去扣费。
>
> `auto`（默认）选**实际可用的那一版**，只装了一版的人无需任何配置；两版都可用时
> 取国际版（保持 0.2.x 的额度归属），想固定用国内版就写 `region: cn`。

> **自动探测顺序**：① 上面的环境变量 → ② 平台默认布局
> （Windows 国内版 `%LOCALAPPDATA%\Programs\WorkBuddy\`；macOS `/Applications/*.app`）
> → ③ **macOS Spotlight 发现**（按 bundle id 反查 → `plutil` 校验 → 可执行性检查；
> 装在 `/Applications` 之外也能找到）
> → ④ Windows 常见安装根的**一层有界扫描**（`%LOCALAPPDATA%\Programs`、`%ProgramFiles%*` 下
> 目录名以 `WorkBuddy` 开头的；**不枚举盘符、不做全盘遍历**）
> → ⑤ **Windows 卸载注册表**（`Uninstall` 三处根；`DisplayName` 形状匹配后取
> `DisplayIcon` / `InstallLocation`，每个候选都要通过「exe 名相符 + 同级 `version` +
> `resources/app.asar`」三道布局校验；多于一个就报歧义，**绝不猜**）。
>
> ❗ 官方安装器允许把 App 装到**自选盘符或自定义目录**（macOS 上则是 `/Applications` 之外）。
> 第 ③ ⑤ 步分别覆盖了这两种情形；万一仍找不到，请用环境变量显式指定。
> 找不到时插件抛出的错误里已包含**可直接粘贴**的设置命令。

## 适用范围

| 项 | 要求 |
|---|---|
| **操作系统** | **Windows x64**（稳定）· **macOS**（🧪 实验性，未在真机验证） |
| **CPU** | x64 / arm64（**32 位 Windows 不支持**：WorkBuddy 桌面端无 32 位构建） |
| **dsh** | `>= 0.1.5-rc.2`（低于此版本**会被拒绝安装**，见下节） |
| **Node** | `>= 20`（实测 v22 / v24） |
| **WorkBuddy 桌面 App** | 已安装**并登录**（国内版 / 国际版任一） |
| **dsh profile** | **任意**：`web` / `headless` / `tui` / `desktop` 均可 |

不支持的平台：**32 位 Windows**、**Linux / WSL**、**鸿蒙**（WorkBuddy 鸿蒙版是手机 App，非桌面端）。

### 版本策略：声明下界，不设上限

dsh 从 **0.2.2** 起，安装器会读插件 `package.json` 里的 **`engines.dsh`**，不满足就**拒绝安装**
并直接给出补救命令。本插件据此声明下界：

```json
"engines": { "node": ">=20", "dsh": ">=0.1.5-rc.2" }
```

- **低于 `0.1.5-rc.2` 明确不支持。** 那时 `ctx.web.registerSearchProvider` 这个接缝还没有，
  装了也不会工作。与其让它静默不生效（用户只会看到「搜不出来」，却查不到原因），
  不如在安装那一刻就说清楚。
- **不设上限。** `>=` 没有上界，dsh 出 0.3 / 1.0 照样能装。
- **更老的 dsh 不执行这条闸门。** `engines.dsh` 是 0.2.2-alpha.2 才引入的：0.1.x / 0.2.0 / 0.2.1
  的安装器完全不读它，此时它只是一条声明。这不是缺陷 —— 那些版本本身也不需要被拦住
  （它们都能跑），只是「低于下界就装不上」这句保证，从 0.2.2 起才成立。
- **`dsh.compatibility` 只是给人看的。** dsh 从不读它 —— 兼容判定
  （`evaluatePluginCompatibility`）只认 `engines.dsh`，以及 `@deepseek-ai/dsh*` 的 peer 区间。
  本插件两者取同一个下界，并由 `S8.5` / `S8.6` 两条用例钉住，防止「文档说一套、执行另一套」。

| 组件 | 已验证 | 是否阻止安装 |
|---|---|---|
| **dsh** | 实机搜索通过：0.1.5-rc.2 / 0.1.7-rc.1 / 0.2.0-rc.2<br>接口核对通过：0.2.1-alpha.2 / 0.2.2-alpha.2 | ⚠️ **`< 0.1.5-rc.2` 拒绝安装**（自 0.2.2 的安装器起生效；更老的安装器不读该字段），其余一律放行 |
| **WorkBuddy 桌面端** | 国内版 + 国际版；明文与 `$wbEncrypted` 加密两种凭据格式均实测 | ❌ **不阻止** |
| **Node** | v22.22.2 / v24.21.0 | ❌ 不阻止（仅 `engines.node` 提示） |

> **为什么能放心不设上限**：本插件只依赖一个极窄的接缝（`ctx.web.registerSearchProvider`），
> 且**刻意不声明** `@deepseek-ai/dsh*` 的 `peerDependencies` 版本区间 —— 那会把 alpha 版
> 也挡在门外，反而制造「装不上」。
>
> **0.2.2 新增的 `ready?()` 为什么不实现**：宿主源码写的是「没有 `ready()` 就当作就绪」，
> 它是可选的、供需要按模型路由判断凭据的 provider 使用。本插件的凭据来自本机 WorkBuddy，
> 与模型路由无关，不实现即是正确语义。

**装了更新版本后搜索失效怎么办？** 按顺序排查：

1. `dsh --profile web --dump-config | grep -A6 "id: web"` —— 看 `searchProvider`
   还是不是 `workbuddy-agentic`（不是 → patch 层没套上）；
2. 看桌面端是否还登着（登出会导致 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，见[注意事项](#注意事项)）；
3. 若接缝变了，带着你的 dsh 版本号提 Issue，我们会补验证并更新上表。

**`dsh-workbuddy-connect` 是可选增强，不是前置**：装了它 → 复用其久经验证的凭据 store
（对罕见落盘形态与刷新时序兼容更完整）；**不装它 → 一切照常工作**，即便它加载失败或内部报错，
也会**静默降级**，不会让搜索失效。

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

- 📋 **失败态可自查**：`node tools/scenarios.mjs <插件目录>` 会离线验证 52 项异常路径
  （空查询、断网、401、流畸形、凭据损坏、并发、abort、接管范围、connect 装了但坏掉等）。

## 变更记录

只列对外可读的要点。**每个版本的完整说明见 [Releases](https://github.com/arnen7000/dsh-workbuddy-websearch/releases)**；
机器可读的全量摘要见 `package.json` 的 `versionNote`。

| 版本 | 要点 |
|---|---|
| **0.3.7** | 精简仓库与发布物：五份开发文档（测试体系、兼容性矩阵、规范审计、联调环境、上架流程）不再随仓库与 npm 包分发，README 里原先外链到它们的说明改为就地写清。安装方式、配置项、运行时行为全部不变 |
| **0.3.6** | 「最低 dsh 版本」从声明变成**真正会被执行**的闸门：补 `engines.dsh`，dsh 0.2.2 起据此拒装过低版本并给出补救命令。测试与发布闸门同步扩到五套件。**运行时逻辑一行未改** |
| **0.3.5** | 修六个缺陷：综述清理的二次复杂度（同步执行会卡死 dsh 主进程）、上游非字符串响应的错误码归类，另四个在维护脚本里 |
| **0.3.4** | 修四个影响真实使用的缺陷：中文正文被吞进 URL、URL 收尾漏剥反引号、`truncated` 恒为 false、未知加密算法被误报成「未登录」 |
| **0.3.3** | macOS 补 **Spotlight 发现链**，装在 `/Applications` 之外也能找到；**Windows 行为不变** |
| **0.3.2** | 新增市场详情页截图。**运行时行为与 0.3.1 相同** |
| **0.3.1** | 发布改走 **npm 可信发布（OIDC）**，不再依赖长期 token，发布物带 provenance 签名；修正仓库地址大小写。**运行时行为与 0.3.0 相同** |
| **0.3.0** | **区域绑定**：`region` 默认 `auto`，首次用到时绑定一版、整会话不切换，取消跨版静默回落；新增 **Windows 卸载注册表发现**，覆盖「两版装在同一目录」「装在自选盘符」 |
| **0.2.6** | 文档按读者分层：安装拆成「快速开始」与「遇到问题」；新增本变更记录 |
| **0.2.5** | 冲突提示改为通用表述（不点名具体插件）；安装文档去本机化；修正测试降级判据 |
| **0.2.4** | 修三个真实缺陷：5.6+ 加密凭据解不开、Windows 缺 Electron 自动发现、connect 可能复用过期凭据 |
| **0.2.3** | 版本策略改为「允许更新版本安装，只声明已验证到哪」；精简 CREDITS |
| **0.2.2** | 新增异常路径测试套件；修两个健壮性缺陷；补「只管搜索、不管抓取」等用户场景说明 |
| **0.2.1** | 转为**零硬依赖**：自带平台定位与凭据解密，不装 `dsh-workbuddy-connect` 也能完整工作；扩展到 macOS（实验性） |
| **0.2.0** | 委托 connect 的凭据 store；支持国际版与加密凭据 |
| **0.1.0** | 首版 |

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

### 维护者：改一处代码并发布（最短路径）

```bash
# 1) 改代码（lib/ 下三个模块：index=搜索流程、credentials=凭据、platform=平台定位）
#    纯 ESM、无构建步骤，改完直接生效。

# 2) 跑全套检查 —— 必须全绿才能发
node tools/regression.mjs "$PWD"        # 契约、凭据、区域、平台、提取边界
node tools/scenarios.mjs  "$PWD"        # 异常路径（断网/401/abort/凭据损坏/换行形态…）
node tools/user-journey.mjs "$PWD"      # 用户旅程（走宿主同款入口）
node tools/check-links.mjs "$PWD"       # 文档链接 / 锚点 / 交叉引用 / README 目录
node tools/check-github-meta.mjs "$PWD" # 仓库元信息与「不夹带本机信息」红线
# 任一非零退出即不许发版；各套件自己会打印项数与失败明细

# 3) 改版本号（package.json 的 version 与 versionNote）
#    versionNote 是给人和给机器看的一句话全量说明，请一并更新。

# 4) 提交并推到**默认分支**（main）
git commit -am "fix: ..." && git push origin HEAD:main

# 5) 打 tag 并**发布成 Release** —— 这一步才触发发布
git tag -a v<新版本号> -m "Release v<新版本号>" && git push origin v<新版本号>
#    然后 GitHub 上 Releases → Draft a new release → 选该 tag → Publish release
```

> ⚠️ **必须推到默认分支（main），不能只推 feature 分支。** 市场 CI 是从
> `raw.githubusercontent.com/<默认分支>/package.json` 读 `dsh.bundle` 的 ——
> 默认分支没更新，市场和用户看到的就还是旧版。
>
> ⚠️ **推 tag 不会触发发布。** `.github/workflows/publish.yml` 的触发条件是
> `release: types: [published]`（外加手动 `workflow_dispatch`），**没有** `push: tags`。
> 必须把 tag 发布成 **Release**，CI 才会跑。
>
> 本机可直接用 `bash contrib/publish.sh` 走完 4–5 步：它会自动注入代理、
> 跑完全套检查、**把当前分支快进推送到默认分支**（分叉则明确报错，绝不强推）、
> 校验 tag 与 `package.json` 版本一致，并在装了 `gh` 时自动创建 Release。
> 建议先 `bash contrib/publish.sh --dry-run` 看一眼会做什么。

**为什么发布这么省事**：`.github/workflows/publish.yml` 用 **npm 可信发布（OIDC）**，
不需要任何长期 npm token；工作流里还有一道**版本一致性闸门**，tag 与 `package.json`
不一致会直接拒绝发布，避免「tag 写 0.4.0、实际发出去 0.3.9」这种不可逆错误。
每次发布都会在 npm 上留下 SLSA provenance 签名（来源仓库 = 本仓库、
来源工作流 = `.github/workflows/publish.yml`、触发 = 对应的 `refs/tags/v*`）。

**用户怎么升级**：市场里点「升级」，或 `dsh plugin --profile web add dsh-workbuddy-websearch@<新版本号>`
（见[快速开始](#快速开始)里关于 pnpm 24 小时冷静期的说明）。

**想加一条回归用例**：在 `tools/regression.mjs` 里找 `T13`/`T14` 段照抄格式即可
（`check("T14.1", 条件, "说明")`；异常路径则加到 `tools/scenarios.mjs`）。
**顺手做一次变异测试** —— 把修复点改回旧行为，确认新用例真的会失败；
否则那条用例只是恒真的装饰。

### 维护者：插件市场上架材料

上架到 DSH 插件市场的提交物在 **[contrib/](./contrib/README.md)** —— 一个 YAML 条目
加一个 PR 即可；流程、门槛与「描述怎么写过审」都写在那个 README 里。
（`contrib/` 不进 npm 包，只用于对外提交。）

## 许可证

[MIT](./LICENSE) © 2026 XingLang & WorkBuddy (小研)
