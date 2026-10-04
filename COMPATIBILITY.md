# 适用范围（Compatibility Matrix）

> 版本：dsh-workbuddy-websearch **v0.2.4** · 更新：2026-10
> 本文件定义本插件**能装在哪、依赖什么、适配哪些版本**，以及每一条的**实测依据**。
> 发布前请对照本文确认声明与实测一致。

---

## 一句话结论

在 **Windows（稳定）** 或 **macOS（实验性）** 上，只要装了
**WorkBuddy 桌面 App（国内版或国际版，已登录）**，配合 **dsh ≥ 0.1.5-rc.2**，
本插件即可工作。**不依赖任何其他 dsh 插件、无原生模块、无 API Key、零配置。**

`dsh-workbuddy-connect` 是**可选增强**：装了更稳，不装也能完整工作。

### ⭐ 版本策略（重要）

**本插件不锁版本上限。** dsh 或 WorkBuddy 发布更新版本后，**照样可装可用**——
我们只声明"已验证到哪些版本"，把判断权留给用户。

- **已验证（端到端）**：dsh `0.1.5-rc.2` / `0.1.7-rc.1` / `0.2.0-rc.2`；
  WorkBuddy 桌面端国内版 + 国际版（明文与 `$wbEncrypted` 加密两条凭据路径，
  加密格式在实机 **5.6.2** 上端到端验证，见 附 D）。
- **未验证但预期可用**：dsh `0.1.6-alpha.2`（接缝已核对，未端到端）、
  dsh `> 0.2.0-rc.2`（接缝稳定）、WorkBuddy 桌面端更新版本。
- **实现方式**：`package.json` 的 `dsh.compatibility`（**纯声明**，dsh 无任何代码读取它，
  不参与强制校验）+ 本文档。**刻意不声明 `@deepseek-ai/dsh*` 的 `peerDependencies` 区间**——
  那会主动引入"被拒装"风险（官方兼容性校验只认该命名空间）。

> 实测证据（用官方 `evaluatePluginCompatibility` 跑我们的 manifest）：
> dsh `0.1.0` ~ `2.5.1` **全部放行**；若改声明 `>=0.1.5-rc.2 <0.2.0`，
> 则 dsh `1.0.0` 会被**拒装**。详见 [NORM-COMPLIANCE.md](./NORM-COMPLIANCE.md) §2.5。

---

## 0. 平台支持一览（先看这张表）

| 平台 / 架构 | 支持级别 | 依据 |
|---|---|---|
| **Windows x64** | ✅ **稳定支持** | 全部实测环境均为 Win11 x64 |
| **Windows ARM64** | ⚠️ 预期可用，未实测 | WorkBuddy 官方称「Windows x64 兼容 ARM64」；Node 有 win-arm64 版 |
| **Windows 32 位（ia32）** | ❌ **不支持** | 见 §1.1：WorkBuddy 桌面端**没有 32 位版本**，无凭据可读 |
| **macOS Apple Silicon（arm64）** | 🧪 **实验性** | WorkBuddy 官方提供 Mac ARM64 版；路径逻辑对齐 connect 已验证实现，**手头无 Mac 设备，未实测** |
| **macOS Intel（x64）** | 🧪 **实验性** | 同上（官方提供 Mac x64 版） |
| **Linux / WSL** | ❌ 不支持（保留代码路径） | WorkBuddy **无 Linux 桌面端**；仅在 WSL 中可读宿主机 Windows 凭据，未实测 |
| **鸿蒙 HarmonyOS** | ❌ 不支持 | WorkBuddy 鸿蒙版是**手机 App**（2026-07-18 随 iOS/Android 上线），非桌面端；且无 dsh 运行时 |

> 「实验性」= 代码路径完整、逻辑有依据，但**未在真实设备上端到端验证**。
> 遇到问题请带平台信息反馈。

---

## 1. 操作系统（OS）

### 1.1 为什么 32 位 Windows 不可用

关键不在 Node，而在**凭据来源**：

| 环节 | 32 位可用性 | 证据 |
|---|---|---|
| Node.js | ✅ 有 `win-x86` 官方包 | 实测 `node-v22.22.2-win-x86.zip` 返回 200，33MB |
| **WorkBuddy 桌面端** | ❌ **仅提供 x64** | 腾讯云官方文档：`Windows 10及以上，支持 Windows x64；ARM64 设备的支持情况以当前版本说明为准`；下载表仅有 `Windows x64 (兼容 ARM64)` |

本插件的凭据**只能**来自 WorkBuddy 桌面端登录态。桌面端没有 32 位构建
→ 32 位 Windows 上不存在凭据文件 → 插件无法工作。

因此 `package.json` 声明：
```json
"os":  ["win32", "darwin"],
"cpu": ["x64", "arm64"]
```
`cpu` 不含 `ia32`，是**有意为之**：在 32 位机器上安装时就给出明确错误，
而不是装完才发现读不到凭据。

### 1.2 平台路径（自带实现，`lib/platform.mjs`）

凭据落在 WorkBuddy 桌面 App 的共享 auth 目录（两版仅文件名不同）：

| 平台 | 目录 | 状态 |
|---|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`<br>`%APPDATA%\CodeBuddyExtension\Data\Public\auth\` | ✅ 已验证 |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/` | 🧪 实验性 |
| Linux | `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` 下的同名路径（WSL 额外探测宿主 `%LOCALAPPDATA%`） | 🧪 代码保留，不支持 |

文件名：
```
workbuddy-desktop.info      ← 国内版
workbuddy-desktop-ai.info   ← 国际版
```

> **Windows 探测两个根**：新版写 `Local`，旧版写 `Roaming`。只探一个会把
> 「已登录」误判为「未登录」（connect 侧的 issue #43 记录了同类问题）。
>
> **Electron 二进制定位**：国内版有已验证的 per-user 默认布局，国际版没有公认默认值；
> 两者都会再做一次**常见安装根的有界扫描**（详见 §4.1）。自选盘符/自定义路径
> 一律走环境变量 `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN` 显式指定。
> 宁可让用户填一行，也不猜错。

除凭据路径与 Electron 定位外，插件只用 Node 标准库
（`fs`/`os`/`path`/`url`/`crypto`/`child_process`）+ 内置 `fetch`，**无原生模块**。

---

## 2. dsh（DeepSeek Harness）宿主版本

依赖的唯一硬接缝：`ctx.web.registerSearchProvider(provider)`（`@deepseek-ai/dsh-web`）。

| dsh 版本 | 加载 | 真实搜索 | 实测环境 |
|---|---|---|---|
| **0.1.5-rc.2** | ✅ | ✅ 9 sources | 环境 A（connect 0.5.4，命中 cn） |
| **0.1.7-rc.1** | ✅ | ✅ 10 sources | 环境 C（connect 0.6.1，命中 cn） |
| **0.2.0-rc.2** | ✅ | ✅ 18~20 sources | 环境 B（connect 0.7.1，命中 global） |
| 更早（< 0.1.5） | ❓ 未验证 | — | — |
| 更高（> 0.2.0-rc.2） | ❓ 未验证 | — | 接缝稳定，预期兼容 |

> ✅ **以上全部允许安装**，包括"未验证"的更新版本——本插件不设版本上限（见开头「版本策略」）。
> 上表只说明"我们亲手验证到哪"，不代表"超过就不能装"。
>
> 「环境 A/B/C/D」是**匿名化的实测环境编号**（同一台机器上的多份隔离安装），
> 与 dsh 版本一一对应，详见 附 A 与 附 C。

**接缝稳定性证据**：三个版本的 `@deepseek-ai/dsh-web` 中，
`registerSearchProvider` 与 `WebError` 均存在且结构一致。
故对该接缝**向前兼容信心较高**，但未逐一验证。

> ⚠️ **重要提醒（卸载残留）**：若你按 README 在 profile 的 `cordis.patch.yml` 里
> 手动写了 `- id: web-workbuddy-websearch`（用来传 `region` / `*ElectronBin` 等 config），
> 那么**卸载插件后这条覆盖不会被自动清理**，dsh 启动会报
> `patch: entry "web-workbuddy-websearch" not found`（仅告警，不影响运行）。
> 卸载后请手动删掉这条。**不写 config 的场景无此问题**。

---

## 3. dsh-workbuddy-connect（**可选增强**，非前置）

| 维度 | 结论 |
|---|---|
| 声明 | `peerDependencies: { "dsh-workbuddy-connect": ">=0.5.4" }`，`peerDependenciesMeta.optional = true` |
| **是否必需** | ❌ **不必需**。缺失时本插件走自带路径，**功能完整** |
| 装了它 | ✅ 优先复用其 `WorkBuddyCredentialStore`（对罕见落盘形态与刷新时序兼容更完整） |
| 它抛错时 | ✅ **静默降级**到自带路径，不让搜索失效（T9.4） |
| **它返回坏凭据时** | ✅ **不采信**，继续走自带路径（v0.2.4 修，见下） |
| 实测版本 | 0.5.4 / 0.6.1 / 0.7.1 全通过 |

### 「可选增强」到底是什么意思

一句话：**connect 在不在、好不好，都不影响你能不能搜。** 拆成四条可验证的边界：

| # | 情形 | 行为 | 护栏 |
|---|---|---|---|
| 1 | **没装 connect** | 走自带路径，功能完整（不是降级） | T9.1–T9.14 |
| 2 | connect 包 import 就失败 / 没导出需要的类 | bridge 视为不可用，走自带路径 | T9.12、S9.5 |
| 3 | connect 的 `resolve()` 抛错 | 捕获并记录诊断，走自带路径 | S9.4 |
| 4 | **connect 返回的凭据不可用**（token 为空 / 已过期） | **不采信**，走自带路径 | S9.1–S9.3 |

> ⚠️ **第 4 条是 v0.2.4 补的，此前是个真实漏洞**。旧实现只要 connect 返回了「非 undefined」
> 就立刻采信——而 connect 内部续期失败时，完全可能返回一个**已过期**的凭据。
> 后果很隐蔽：插件会拿着死 token 去搜索、拿到 401，而且**不会**回落到自带路径，
> 于是「connect 坏了也不影响功能」这句承诺并不成立。
>
> 同时修掉一个相关漏洞：**`forceRefresh` 时不能再向 connect 要凭据**。
> 该参数的语义是「刚才那个 token 已经死了，换一个新的」，而 connect 的 `resolve()`
> **没有**「强制刷新」入参，只会把手上那个（正是死掉的那个）还回来，
> 于是 401 重试必然再失败一次。现在强制刷新**先走自带路径的显式 refresh**，
> 自带路径也拿不到时才回头找 connect。

**v0.2.1 的关键改进——零硬依赖**。插件自带三块能力，不再把核心功能外包：

| 自带模块 | 职责 |
|---|---|
| `lib/platform.mjs` | 平台候选路径（win32/darwin/linux）+ Electron 二进制定位 |
| `lib/decrypt.mjs` | 独立解开 `$wbEncrypted` 信封（AES-256-GCM + App 的 `WB-AAD` 构造） |
| `lib/credentials.mjs` | 统一「明文 / 加密」「国内版 / 国际版」的读取与解析 |

> **实测证据**：在**完全没有任何 connect** 的隔离目录中加载插件，
> 自带路径成功解析出真实凭据（`source = desktop`，token 长度 1323，domain `www.workbuddy.cn`）。
> 加密往返另由 T9.5 用真实 AES-256-GCM 验证通过。
> 坏 connect 的四种形态由 S9.1–S9.7 在临时目录里伪造 connect 包验证（已用变异测试确认护栏有效）。

**它还做什么**（装了就顺手复用）：token 临近过期自动 refresh；枚举两版账号的额外元数据。

---

## 4. WorkBuddy 桌面 App 版本

| 维度 | 结论 |
|---|---|
| **已验证版本** | 国内版 + 国际版均实测；凭据两条路径（**明文**与 **`$wbEncrypted` 加密**）均跑通。加密格式在实机 **5.6.2** 上端到端验证（真实凭据 → 解出 token） |
| 国内版 | ✅ 支持（`workbuddy-desktop.info`，网关 `copilot.tencent.com`） |
| 国际版 | ✅ 支持（`workbuddy-desktop-ai.info`，网关 `www.workbuddy.ai`） |
| 凭据格式（明文） | ✅ 支持（自有实现直接读取） |
| 凭据格式（**5.6+ 加密 `$wbEncrypted`**） | ✅ 支持（**自有解密实现**，不依赖 connect；实机 5.6.2 验证） |
| 未登录 | ❌ 不可用（`available()` = false，回退 dsh 默认搜索） |

> ⭐ **更新版本允许使用**：WorkBuddy 桌面端发布更新版本后**照样可装可用**。
> 若某次更新改动了凭据落盘格式或端点，表现为 `available()` 为 false 或搜索报错——
> 请带桌面端版本号提 Issue，我们会补验证并更新本表。

**加密凭据的工作方式**（`lib/decrypt.mjs`）：运行 App 自带的 Electron 二进制
（`ELECTRON_RUN_AS_NODE=1`），用其**链接绑定**
`process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`
取回 `atRestSecretKey` → `sha256` 得 AES-256-GCM 密钥 → 用 App 自身的
`buildAuthenticatedContextAad`（前缀 `WB-AAD\0`、帧类型 `WBEV1`、族 `sym-v1`）
解开字段。密钥与明文 token **只驻内存**，不写盘、不落日志。

> ⚠️ **易错点（已在实机踩过）**：绑定名是 `electron_browser_workbuddy_storage`，
> 且必须走 `process._linkedBinding`（链接绑定）。写成 `process.binding("workbuddyStorage")`
> 会恒报 `No such module` —— 因为 `process.binding` 查的是 Node 内置绑定表。
> 这种错误**不会被自造密钥的往返单测发现**，只会表现为「登录了却读不到」，
> 因此 `tools/regression.mjs` 用源码断言（T9.15/T9.16）把它钉住。

### 4.1 Electron 二进制的定位顺序

| 顺序 | 手段 | 覆盖情形 |
|---|---|---|
| 1 | 环境变量 `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN` | **任何**安装位置（最高优先级） |
| 2 | 平台默认布局 | Windows 国内版 `%LOCALAPPDATA%\Programs\WorkBuddy\`；macOS 两版 `/Applications/*.app` |
| 3 | Windows **常见安装根的有界扫描** | 系统级安装（`%ProgramFiles%`）、目录名带后缀（如 `WorkBuddy AI\`）——**国际版靠这一步才可能被自动发现** |
| — | 找不到 | 返回 `undefined`，并抛出**带可操作指引**的错误（含该设哪个变量、两条可粘贴命令） |

扫描的边界（刻意保守）：只扫 `%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramW6432%`、
`%ProgramFiles(x86)%` 这**固定几个根**下的**一层**子目录，且只认目录名以 `WorkBuddy` 开头的；
不做全盘遍历、不枚举盘符（枚举盘符可能卡在失联的网络驱动器上）。任何一步失败都静默跳过。

> ❗ **仍覆盖不到：用户把 App 装到自选盘符或自定义路径**（例如 `<安装盘>:\Programs\WorkBuddyAI\`）。
> 这是官方安装器**允许**的常见操作，也是实机最常见的布局。
> 本插件对这种情况**不做猜测**，请用上表第 1 行的环境变量显式指定——
> 错误信息里会给出可直接粘贴的命令。
>
> 为什么不用注册表（`App Paths` / `Uninstall`）发现？那是 Windows 的官方机制，但需要调用
> `reg.exe`：① 无法在本项目环境中实测验证；② `reg.exe` 常被安全软件/企业策略列入程序黑名单
> （本项目开发机上即被拦截），届时会静默失效。与其塞一条测不到、还可能被拦的路径，
> 不如把「找不到」做成明确的指引。

> 桌面端 **≥ 5.6**：凭据可能加密 → 需能定位 App 的 Electron 二进制（见上表）。
> 桌面端 **< 5.6**：凭据明文 → 直接读取，无需 Electron 二进制。
>
> 若两版凭据同时存在且国际版解不开，插件会**回落到国内版明文凭据**（`source=desktop`），
> 而不是整体失败——但此时用的是国内版账号与网关。

> ⚠️ **加密与否不能只看版本号**。加密由 App 的落盘策略决定，而实测表明**同一台机器上
> 两个产品可以不一样**：在桌面端 **5.6.2** 上，国际版凭据为加密（5 个 `$wbEncrypted` 字段），
> 而**国内版凭据仍是明文**（0 个）。因此本插件**按实际读到的内容判断**，不按版本号猜：
> 读到明文就直接用，读到信封才去找 Electron 二进制。两种格式都已实测。
>
> 另注：Electron 二进制**只在需要解密时才被调用**——若你用的是明文凭据（例如国内版），
> 定位不到二进制也不影响使用。

---

## 5. 依赖环境（Node / Python / git / 原生模块）

> 原则：**不承诺覆盖所有组合，但每一条声明都必须写清「已验证范围」**，
> 未验证的一律显式标注，不含糊其辞。

### 5.1 总表

| 依赖 | 本插件是否需要 | 说明 |
|---|---|---|
| **Node.js** | ✅ **必需** | 唯一硬依赖。`engines: { "node": ">=20" }` |
| **Python** | ❌ **不需要** | 零 Python 依赖，不调用 `python`/`python3` |
| **git** | ❌ **不需要**（运行时） | 运行时零 git 依赖；仅「从 git 源码安装」这一步用到 git |
| **原生模块 / 编译工具链** | ❌ **不需要** | 无 `.node` 依赖、无 `node-gyp`、无 postinstall 构建 |
| **系统包管理器** | ❌ **不需要** | 无 apt/brew/choco 等前置要求 |

### 5.2 Node.js

| 维度 | 结论 |
|---|---|
| 声明 | `engines: { "node": ">=20" }` |
| **已验证** | **v22.22.2**（开发实测）、**v24.21.0**（dsh 桌面版自带运行时） |
| 未验证但预期可用 | v20.x、v21.x、v23.x、v25+（接缝是稳定的标准 API） |
| 为什么下限是 20 | 用到 `fetch`（18+）、`AbortSignal.any`（**20.3+**，这是真正的下限）、`randomUUID`（14.17+）、`??=`（15+） |

> 注：若同时安装 `dsh-workbuddy-connect@0.7.x`，它要求 `^22.19.0 || >=24.0.0`。
> **本插件自身的下限仍是 20**，不因 connect 而抬高。

### 5.3 Python

**本插件完全不需要 Python。** 代码里没有任何 `python` / `python3` 调用，
`tools/` 下的脚本也全是 `.mjs`（Node 运行）。

> ℹ️ **但你可能在机器上看到 Python**：dsh **自身**会带一个 Python 运行时
> （实测 dsh 桌面版 0.2.0-rc.2 自带 **Python 3.12.14**，并预装 numpy / pandas /
> python-docx / python-pptx / openpyxl 等），那是 **dsh 的功能需要，与本插件无关**。
> 换句话说：**dsh 有没有 Python、Python 是几点几，都不影响本插件能否工作。**

### 5.4 git

**运行时不依赖 git。** 插件只做两件事：读本机凭据文件、调云端搜索接口，
都不涉及 git。`tools/` 下的测试脚本也不需要 git。

| 场景 | 是否用 git |
|---|---|
| `dsh plugin add dsh-workbuddy-websearch`（从 npm/registry） | ❌ 不需要 |
| `dsh plugin add link:<本地目录>` | ❌ 不需要 |
| **从 GitHub 源码安装**（`git clone` 后 `link:`） | ✅ 需要（但这是「怎么拿到源码」的问题，不是插件的要求） |

> 注：`dsh plugin add` 底层用 pnpm。若你给的依赖是 `git+https://…` 形式，
> 那一步会用到 git —— 属于 **pnpm/dsh 的行为**，与本插件无关。

### 5.5 OS / CPU

见 §0 平台支持一览。摘要：**Windows x64 稳定支持**；Windows ARM64 预期可用未实测；
macOS（arm64 / x64）**实验性**；Linux / WSL 不支持（WorkBuddy 无 Linux 桌面端）；
32 位 Windows 明确不支持（WorkBuddy 桌面端无 32 位构建）。

`package.json` 里用 `os` / `cpu` 字段把这条边界写死，避免在不支持的平台上被静默安装：

```json
"os": ["win32", "darwin"],
"cpu": ["x64", "arm64"]
```

---

## 6. 网络与端点

| 项 | 值 |
|---|---|
| 国内版网关 | `https://copilot.tencent.com` |
| 国际版网关 | `https://www.workbuddy.ai` |
| 搜索端点 | `POST {网关}/agenttool/v1/agentic_search`（SSE） |
| 刷新端点 | `POST {网关}/v2/plugin/auth/token/refresh` |
| 鉴权 | `Authorization: Bearer <桌面端登录 token>` |

需要能访问上述网关。国际版账号必须能连 `www.workbuddy.ai`。

---

## 7. 运行环境 / profile（含 CLI）

**dsh 没有独立的「CLI 版」**——它是一个可执行 + 多个 **profile**：
`dsh <profile> [args]`，每个 profile 是 `$DSH_HOME/profiles/<name>/` 下的 bundle 栈。
内置模板有 **web**（桌面/浏览器 UI）、**headless**（一次性任务 `dsh headless "任务"`）、
**tui**（终端 UI）三种。

本插件与 profile 无关，**任意 profile 均可用**：

| profile | 本插件 | 实测 |
|---|---|---|
| `web` | ✅ | 三版本实测，见附 A |
| `headless`（CLI 一次性任务） | ✅ | 环境 B 实测：`--dump-config` 显示 `searchProvider: workbuddy-agentic`；回归 64/64 PASS（**该版本**套件规模）；**端到端 `dsh headless "…"` 真实调用 `web_search` 成功（11 个来源）** |
| `tui`（终端 UI） | ✅ 预期可用 | 与 headless 同为 dsh-base 之上的 bundle，接缝相同（未逐一实测） |
| `desktop`（WorkBuddy 桌面 App 内置） | ✅ | 见 §7.1（App 自管 profile，实测走等价 profile） |
| 自定义 profile | ✅ 预期可用 | 只要是 `@deepseek-ai/dsh-base` 的 bundle 栈 |

**为什么与 profile 无关**：所有 profile 都以 `@deepseek-ai/dsh-base` 为基座，
而 dsh-base 已注册 `id: web`（`@deepseek-ai/dsh-web`）并挂载 `tool-web`
（`web_search` / `web_fetch`）。本插件的 `inject: ["web"]` 因此恒成立。

> ⚠️ **CLI 场景的模型前提（与插件无关）**：`headless` profile 默认模型路由是
> `provider: deepseek-official`，需要 `DEEPSEEK_API_KEY`。若想像 web profile 那样
> 复用 WorkBuddy 免费登录态，需在该 profile 的 `cordis.patch.yml` 里加：
> ```yaml
> - id: agent-default-model
>   config:
>     provider: workbuddy
>     model: glm-5.3-flash
> ```
> 并安装 `dsh-workbuddy-connect`（它提供模型）。否则会报
> `MISSING_CREDENTIAL: no API key for provider route "deepseek-official"`。
> **这不是本插件的问题**——本插件只负责 `web_search`，不负责模型。

| 项 | 结论 |
|---|---|
| dsh profile | 任意（`web` 实测；`headless` 实测；`tui` 预期） |
| 安装方式 | `dsh plugin --profile <p> add <插件目录或.tgz>` |
| 自动登记 | ✅ `bundles` 会自动加入 `dsh-workbuddy-websearch` |
| 依赖形态 | 目录安装（`link:`/junction）或 **npm pack 的 .tgz** 均可 |
| 端口/DSH_HOME | 无要求（插件遵循 `DSH_HOME`，默认 `~/.dsh`） |

### 7.1 dsh 桌面版（WorkBuddy 桌面 App 内置的 dsh）

WorkBuddy 桌面 App 自己跑一套 dsh，用的 profile 名就叫 **`desktop`**。
两点必须先说清楚：

**① `desktop` profile 不能由 CLI 驱动。** 它是 App 独占的：

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

所以对桌面版做验证，只能用**复刻桌面版 bundle 组合的等价 profile**（换个 profile 名），
或者由 App 自己加载。本插件的实测走的是前者。

**② 桌面版自带运行时**（`$DSH_HOME/dsh-runtimes/dsh-primary-runtime/runtime.json`）：

| 组件 | 版本 |
|---|---|
| Node | **24.21.0** |
| pnpm | 11.7.0 |
| Python | 3.12.14（给 dsh 自己用的，见 §5.3） |

**实测结果（等价 profile：复刻桌面版真实 bundle 组合 —— dsh-base + web-app + dshmarket +
connect + memory-evolve + better-sidebar + cost-meter + genui，把 searchserver 换成本插件）**：

| 验证项 | 结果 |
|---|---|
| `--dump-config` 组合 | ✅ `searchProvider: workbuddy-agentic` + `fetchProvider: http` + 插件行，无 duplicate |
| 真实启动（0.2.0-rc.2） | ✅ `registered "workbuddy-agentic" into ctx.web`，web 服务正常起在 3080，**无 `did not activate` 告警** |
| 真实搜索（**桌面版自带 Node 24.21.0**，cn） | ✅ `source=builtin`、`variant=workbuddy`、20 sources |
| 真实搜索（同上，global + 国际版二进制） | ✅ `variant=workbuddy-ai`、`source=desktop-encrypted`、20 sources |

> ⚠️ **与 `dsh-workbuddy-searchserver` 不能共存（桌面版最容易踩的一个坑）**
>
> 桌面版的真实 profile 里预装了 `dsh-workbuddy-searchserver`（本插件的前身插件）。
> 两者注册的是**同一个 provider id `workbuddy-agentic`**，而 `ctx.web` 按 id 去重
> （`@deepseek-ai/dsh-web` 的 `registerProvider` 会抛 `WEB_DUPLICATE_PROVIDER`）——
> 于是**后注册的那个直接不激活**。
>
> 实测复现（两个插件同装）：
> ```
> [dsh-workbuddy-searchserver] registered "workbuddy-agentic" into ctx.web
> dsh: warning: 1 entry did not activate
> web-workbuddy-websearch (dsh-workbuddy-websearch): ...
> ```
>
> **装本插件前必须先卸掉旧插件**，并确认 profile 的 `package.json` 里
> `dsh.profile.bundles` 已无 `dsh-workbuddy-searchserver`，然后重启 dsh。
> 从 v0.2.4 起，本插件会把这个裸错误翻译成**点名旧插件 + 给出卸载命令**的指引（回归护栏 T9.19）。


**环境变量 / config 速查**

| 名称 | 用途 | 默认 |
|---|---|---|
| `WORKBUDDY_SEARCH_REGION` | 期望账号区域（`cn` / `global`） | `global` |
| `WORKBUDDY_AUTH_FILE` | 国内版凭据文件绝对路径 | 自动探测 |
| `WORKBUDDY_AI_AUTH_FILE` | 国际版凭据文件绝对路径 | 自动探测 |
| `WORKBUDDY_ELECTRON_BIN` | 国内版 App 的 Electron 二进制 | 平台默认 |
| `WORKBUDDY_AI_ELECTRON_BIN` | 国际版 App 的 Electron 二进制 | 无（需显式指定） |
| `WORKBUDDY_SEARCH_MAX_CONTENT_CHARS` | 综述回传上限（0 = 不截断） | 30000 |
| `WORKBUDDY_SEARCH_MODE` | 云端 `search_mode` | 2（PRO） |
| `WORKBUDDY_SEARCH_ENDPOINT` | 覆盖搜索端点 | 按区域推导 |

以上均可在 profile 的 `cordis.patch.yml` 里以同名 config 键写死（`region` /
`cnElectronBin` / `aiElectronBin` / `endpoint`），优先级 config > env。

---

## 8. 未验证 / 已知边界（诚实清单）

- 🧪 **macOS**：代码路径完整、逻辑对齐 connect，但**未在真实 Mac 上端到端验证**。
- ❌ **Linux / WSL / 鸿蒙**：不支持（无对应桌面端；WSL 读宿主凭据的路径未实测）。
- ❌ **32 位 Windows**：不支持（WorkBuddy 桌面端无 32 位构建）。
- ❓ **dsh < 0.1.5-rc.2** 或 **> 0.2.0-rc.2**：未逐一验证（接缝稳定，预期可用）。
- ✅ **CLI / headless / tui profile**：**已验证可用**（见 §7；headless 已端到端跑通）。
- ⚠️ **卸载残留**：profile 手动写的插件 config 行不会被清理（见 §2）。
- ⚠️ **同版本号重新安装不会刷新**：`dsh plugin add` 在版本号未变时会复用 pnpm 缓存，
  不会覆盖已安装文件（实测：改了代码但版本号未变时，重装无效）。
  **发版/迭代时必须 bump version**，或先 `remove` 再 `add`。
- ⚠️ **`dsh plugin add` 的"半状态"陷阱（dsh 0.2.0-rc.2 实测）**：
  若首次 `add` 时 pnpm 成功写入了 `package.json` 的 `dependencies`，
  但随后的 reconcile 失败（例如依赖尚未落地），则 profile 会停在
  **"有 dependency、但不在 `bundles` 里"** 的半状态 —— 此时 dsh **静默忽略**该插件。
  更麻烦的是**重跑命令无法修复**：`dsh-plugin-manager` 的 `reconcile()` 里有
  `if (beforeDeps.has(name)) continue;`，已存在的依赖会被直接跳过，永远补不进 `bundles`。
  **修复**：手动把包名加进 profile `package.json` 的 `dsh.profile.bundles`，或先 `remove` 再 `add`。
  （在一个全新环境上真实踩到。）
- ⚠️ **pnpm 可能不落地 `link:` / `file:` 依赖（环境相关）**：
  实测 pnpm **12.4.1** 在全新空目录（无 `.npmrc`）中执行 `pnpm install` 时，
  会把包解到 `node_modules/.pnpm/...` 却**不创建顶层 `node_modules/<包名>`**，
  且反复报 "Already up to date"。这会让 `dsh plugin add` 在 reconcile 阶段失败。
  **判定**：`ls node_modules/<包名>` 是否存在。
  **绕过**：手动建链接（Windows 用目录 junction，等价于 `link:` 语义），再确认
  `dsh --profile web --dump-config` 里出现插件行。此为**环境问题，与本插件无关**。
- ℹ️ **重复 id 已被当前 dsh 容忍**：dsh 0.2.0-rc.2 **正常启动**；
  但早期 0.1.5-rc.2 曾因 duplicate loader entry id 卡死，故仍建议不要重复 insert。
- ⚠️ **搜索耗时**：一次查询 = 云端多步 agentic 检索，实测 **10~60 秒**；开销较大属服务特性。
- ⚠️ **引用来源**：由搜索服务自行选定，`snippet` 不下发。
- ⚠️ **凭据时效**：token 过期且 refresh 失败 → 需回桌面 App 重登。
- ⚠️ **解密依赖 App 二进制**：5.6+ 加密凭据需能定位 Electron 二进制；
  找不到时抛 `WB_SEARCH_CREDENTIAL_ENCRYPTED`，错误信息内含**可直接粘贴**的两条设置命令。
- ❗ **自选盘符/自定义安装路径不会被自动发现**：官方安装器允许改目录（实机常见）。
  插件只做「默认布局 + 常见根一层扫描」（§4.1），**不猜、不枚举盘符**。
  这类用户必须设 `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN`。
  未设且国际版凭据已加密时，会**静默回落到国内版明文凭据**——功能不中断，
  但用的是国内版账号与网关，这一点在日志与 `getLastCredentialSource()` 里可见。
- ℹ️ **不用注册表发现**：Windows 的 `App Paths` / `Uninstall` 虽是官方机制，但需调 `reg.exe`；
  该程序常被安全软件与企业策略列入黑名单（本项目开发机上即被拦截），届时静默失效。
  因此选择「明确的指引」而非「测不到、可能被拦的猜测」。详见 §4.1。
- ℹ️ **接管范围仅限搜索**：本插件只改 `web` 行的 `searchProvider`；
  `web_fetch`（抓取指定 URL）仍由 dsh 内置 `web-fetch-http` 提供，**不走 WorkBuddy 登录态**。
  patch 中显式复述 `fetchProvider: http` 是必须的（dsh 的 patch 是整行替换、非合并），
  三版本实测均未丢字段。

---

## 9. 异常路径实测（`tools/scenarios.mjs`）

「用户真实会撞上」的失败态，全部**离线可验证**（构造输入 / 打桩 fetch），共 40 项全通过。

| # | 场景 | 期望行为 | 实测 |
|---|---|---|---|
| S1 | 空查询 / 纯空白 | 拒收且带 code，**不误发云端计费** | ✅ `WB_SEARCH_BAD_REQUEST` |
| S1.3 | 调用前已 abort | 入口短路，**不发起任何请求** | ✅ `WEB_ABORTED` |
| S2.1 | 断网 / DNS 失败 | 可归因的传输错误 | ✅ `WB_SEARCH_TRANSPORT_ERROR` |
| S2.2 | 错误信息 | **不泄漏 accessToken** | ✅ 无 token/Bearer 字样 |
| S2.3 | 上游 500 | 归因为上游错误而非崩溃 | ✅ `WB_SEARCH_UPSTREAM_ERROR` |
| S2.4 | 401 / 会话失效 | 归为可续期错误（触发一次 refresh 重试） | ✅ `WB_SEARCH_SESSION_DEAD` |
| S2.5 | 200 但无响应体 | 明确报错，**不静默当成功** | ✅ `WB_SEARCH_UPSTREAM_ERROR` |
| S3.1 | 流无 done 帧 | 归为空结果，不静默成功 | ✅ `WB_SEARCH_EMPTY_RESULT` |
| S3.2 | done 帧 JSON 损坏 | 归为空结果，不崩溃 | ✅ `WB_SEARCH_EMPTY_RESULT` |
| S3.3–4 | 正常 done 帧 | 解析 content + sources 去重保序 | ✅ 对照组通过 |
| S4.1 | 凭据文件半损坏（6 种垃圾输入） | 不抛、**不造出假 token** | ✅ 全部安全 |
| S4.2–4 | 无凭据环境 | 探针/枚举/`available()` 均不抛 | ✅ |
| S5.1 | `WORKBUDDY_AUTH_FILE` 自定义路径 | 在 `credentialPaths()` 里**最高优先级生效** | ✅ |
| S5.2 | — | `desktopAuthFiles()` 只给平台默认路径（分层设计） | ✅ |
| S5.3 | 跨平台模拟（darwin） | 产出 macOS 路径 | ✅ |
| S5.4/5.6 | 传非法 variant（undefined/字符串） | 返回空/undefined，**不抛生僻异常** | ✅ |
| S6.1 | 5 路并发搜索 | 各自结果正确，**无串流** | ✅ |
| S6.2 | 10 万字符查询 | 不崩溃、原样传出 | ✅ |
| S6.3 | 中途 abort | **快速返回**（实测 <150ms），不等云端跑完 | ✅ |
| S7.1–3 | 接管范围 | 只注册 search，不注册 fetch；patch 保留 fetchProvider | ✅ |
| S9.1–9.7 | **connect 装了但坏了** | 返回死 token / 空 token 时**不采信**并回落自带路径；抛错或包坏时静默降级；`forceRefresh` 不复用 connect 的旧 token | ✅ |

> **S6.3 的意义**：abort 若无效，用户按了取消仍会付一次完整的云端检索费用。
> 实测入口短路 + 收流竞态兜底共同生效，是「省钱」的关键路径。

> **S5.6 的修复**：早期 `resolveElectronBinary("字符串")` 会抛
> `Cannot read properties of undefined (reading 'envVar')`；现已加守卫，
> 非对象输入返回 `undefined`。`desktopAuthFiles(undefined)` 同理返回 `[]`。

---

## 10. ⚠️ 最重要的用户场景：未登录时 web_search 会**整体不可用**

本插件的 patch **写死**了 `searchProvider: workbuddy-agentic`。据
`@deepseek-ai/dsh-web` 的 `resolveProvider`（源码 lib/index.js:119-132）：

```js
if (configuredId !== undefined) {
  const provider = providers.get(configuredId);
  if (!provider) throw new WebError(..., "WEB_PROVIDER_CONFIGURED_MISSING");
  if (!provider.available()) throw new WebError(..., "WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
  return provider;                       // ← 认死，不再尝试其他 provider
}
```

**「配置了就认死」**——因此三种结局（已用真实 resolveProvider 逻辑模拟验证）：

| 情况 | `available()` | dsh 行为 | 错误码 |
|---|---|---|---|
| WorkBuddy 桌面端**已登录** | `true` | ✅ 正常搜索 | — |
| **未登录** / token 失效且 refresh 失败 | `false` | ❌ **直接报错，不降级** | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 插件被移除但 profile 的 patch 行残留 | 未注册 | ❌ 报错 | `WEB_PROVIDER_CONFIGURED_MISSING` |

**这意味着**：

- 本插件的设计假设是「WorkBuddy 桌面端**始终登录**」——这正是它「零配置」的代价。
- 登出后 `web_search` **不会**悄悄退回 `deepseek-official`，而是整体失效。
- **排查口诀**：`web_search` 报 `CONFIGURED_UNAVAILABLE` → 先看桌面端还登着吗。

**想换回可降级行为**：把 profile 的 `cordis.patch.yml` 里 `web` 行的
`searchProvider` 改回 `deepseek-official`（但需 `DEEPSEEK_API_KEY`）。
两者只能取其一。

> **为什么 `available()` 用「文件存在 + 可解析」而非「token 未过期」**：
> 过期 token 仍可能通过内存 refresh 续期成功，故不能仅因过期就判定不可用。
> 该判断带 3 秒 TTL 缓存，避免每次 `web_search` 都同步读盘。

---

## 附 A：三版本实测记录

| 环境 | dsh | connect | 账号 | 加载 | 真实搜索 |
|---|---|---|---|---|---|
| 环境 A | 0.1.5-rc.2 | 0.5.4 | cn | ✅ | ✅ 9 sources |
| 环境 C | 0.1.7-rc.1 | 0.6.1 | cn | ✅ | ✅ 10 sources |
| 环境 B | 0.2.0-rc.2 | 0.7.1 | global | ✅ | ✅ 18~20 sources |

加载判定 = `dsh --profile web --dump-config` 显示 `searchProvider: workbuddy-agentic`
与插件行 `web-workbuddy-websearch`，且无 `duplicate` / `entry not found`。

## 附 B：v0.2.1 零依赖验证

| 验证项 | 方法 | 结果 |
|---|---|---|
| 无 connect 时加载 | 隔离目录（仅 `lib/` + `package.json`）import 入口 | ✅ 成功注册 `workbuddy-agentic` |
| 无 connect 时解析凭据 | `resolveCredentialIndependently()` | ✅ `source = desktop`，token 1323 字符 |
| 自带解密正确性 | 真实 AES-256-GCM + App AAD 往返 | ✅ 正确密钥解出、错误密钥认证失败 |
| 自带模块零外部依赖 | 静态扫描 import 说明符 | ✅ 仅 `node:` 与相对路径 |
| 回归套件 | `node tools/regression.mjs <dir>` | ✅ 64/64 PASS（T1–T10，**该版本**规模；套件随版本增长，最新见 附 C） |

## 附 C：全新环境实测

这是一份**全新未使用**的安装（`.dsh-home` 为空、无 profile、用 npm 扁平安装）。
在该环境上从零安装并测试，用于验证"**全新用户拿到插件能不能跑起来**"。

| 验证项 | 方法 | 结果 |
|---|---|---|
| profile 初始化 | `dsh --profile web --dump-config` 首次调用 | ✅ 自动生成 web profile（模板 = dsh-base + dsh-web-app） |
| 插件安装 | `dsh plugin --profile web add link:…` | ⚠️ pnpm 未落地顶层链接 → **手动 junction 绕过**（见 §8） |
| bundles 注册 | `dsh plugin add` 的 reconcile | ⚠️ 撞上"半状态"陷阱 → **手动补 `bundles`**（见 §8） |
| 加载 | `--dump-config` | ✅ `searchProvider: workbuddy-agentic` + `fetchProvider: http` + 插件行，**无任何告警** |
| **是否需手写 patch 兜底** | profile `cordis.patch.yml` 保持 `[]` | ✅ **零配置**——0.2.0-rc.2 自动套用 `link:` bundle 的 patch（对比：0.1.5-rc.2 需兜底，见 环境 A） |
| 凭据解析 | `resolveCredential()` | ✅ `source = builtin`（**未装 connect**）、cn 变体、token 1323 字符 |
| **真实搜索** | `tools/final-verify.mjs` | ✅ **20 sources / 39313 字符** |
| 回归套件 | `node tools/regression.mjs <dir>` | ✅ 69/69 PASS（T1–T10，含新增 T9.14；**该版本**规模，最新见 附 D） |
| 场景套件 | `node tools/scenarios.mjs <dir>` | ✅ 33/33 PASS（S1–S8） |

**关键结论**：在**完全全新、未装 connect、零配置**的环境里，插件开箱即用，
且真实搜索跑通 —— 这是"零硬依赖"承诺在真实新环境中的端到端验证。

**顺带修掉的自身缺陷**：`tools/final-verify.mjs` 原先直接调 `resolveViaConnect()`
（只走 connect 那一条腿），未装 connect 时会拿到 `undefined` 并崩在 `chatBase()`，
报出难懂的 `Cannot read properties of undefined`。已改为走**统一入口** `resolveCredential()`，
并新增回归护栏 **T9.14** 防止复发。

## 附 D：真实设备 5.6.2 加密凭据实测

在一台**真实使用中**的设备上做的一次深度验证。该机的布局恰好落在两个"易漏"点上：
桌面端 **5.6.2**；两版 App 都装在**自选盘符**（`<安装盘>:\Programs\`）下，而非默认的
`%LOCALAPPDATA%\Programs\`；且两版凭据同时存在、国际版为**加密**格式。

| 验证项 | 方法 | 结果 |
|---|---|---|
| 国内版凭据格式 | 结构化转储（不打印值） | ℹ️ **明文**（`$wbEncrypted` 字段数 = 0）→ 无需 Electron 二进制 |
| 国际版凭据格式 | 同上 | ℹ️ **加密**（`$wbEncrypted` 字段数 = 5）→ **必须** Electron 二进制 |
| 默认布局 + 常见根扫描 | `resolveElectronBinary()` | ❌ 未命中（装在自选盘符，符合设计预期，不猜） |
| 加密凭据 + 无二进制 | `readCredentialFile(ai)` | ✅ 按预期返回 `electron-binary-unavailable` |
| **加密凭据 + 显式二进制** | `readCredentialFile(ai)` | ✅ **解出 `accessToken` / `refreshToken`**（真实凭据） |
| 区域回落行为 | `resolveCredentialIndependently({region})` | ℹ️ 未给二进制时**回落到国内版明文凭据**（`variant=workbuddy`、`www.workbuddy.cn`），功能不中断 |
| 区域正确性 | 同上，给出二进制 | ✅ `variant=workbuddy-ai`、`source=desktop-encrypted`、`www.workbuddy.ai` |
| 注册表发现 | `reg.exe` | ⛔ 被安全策略列入程序黑名单，**无法实测**（故不实现，见 §4.1） |
| 回归套件 | `node tools/regression.mjs <dir>` | ✅ **84/84 PASS**（T1–T10，含新增 T9.15–T9.18、T10.13–T10.24；**该版本**规模） |

**修掉的两个真实缺陷**（都由上面的实测暴露，且都**不会**被自造密钥的单测发现）：

1. **key helper 绑定名与 API 双错** —— 原实现为
   `process.binding("workbuddyStorage").readSealedPayload()`，实机恒报
   `No such module: workbuddyStorage`。正确写法是
   `process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`
   （同步返回 JSON 字符串）。后果很隐蔽：helper 失败被静默降级成「解密失败」，
   于是**国际版加密凭据永远解不开**，只能悄悄回落到国内版凭据。
   已加回归护栏 **T9.15 / T9.16**（源码断言）。
2. **`windowsExeBasename` 是死字段 + 文档虚标** —— 该字段定义了却从未被读取；
   文档承诺的「Windows 注册表/目录发现」也从未实现，导致国际版在 Windows 上
   **完全没有**自动发现手段。已补上「常见安装根的有界扫描」（§4.1）并加护栏
   **T10.13–T10.23**（含"已接线"的静态断言，防止该字段再次沦为死字段）。

> 教训（已写入仓库测试体系）：**用自造密钥的加解密往返测试，证明不了外部 API 用对了**。
> 凡涉及外部进程 / 私有绑定的调用，必须有源码级契约断言或真机实测。
