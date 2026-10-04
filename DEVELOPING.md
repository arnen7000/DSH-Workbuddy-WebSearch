# 本地开发环境（联调）

本仓库是 `dsh-workbuddy-websearch` 的**源码开发树**。联调方式是把源码目录以
**junction**（Windows）或**符号链接**（macOS）挂进 dsh 的 profile：改 `lib/index.js`
无需重装，重启 dsh 即生效。

> 下文命令里的 `<dsh 安装根>`、`<DSH_HOME>`、`<本源码目录>` 都是占位符，请换成你
> 自己的实际路径。文档里刻意不出现任何具体机器路径。

## 关键路径

| 用途 | 路径 |
|---|---|
| 本源码（git 仓库） | `<本源码目录>` |
| dsh 安装目录 | `<dsh 安装根>` |
| dsh 自带 node | `<dsh 安装根>\node\node.exe` |
| dsh CLI 入口 | `<dsh 安装根>\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| dsh 数据根（DSH_HOME） | `<dsh 安装根>\.dsh-home`（**建议隔离**，不要用全局默认） |
| profile 目录 | `<DSH_HOME>\profiles\web` |
| **联调点** | `<profile>\node_modules\dsh-workbuddy-websearch` → 本源码目录 |
| 国际版 App | `<WorkBuddy AI 安装目录>\WorkBuddyAI.exe` |
| 国内版 App | `<WorkBuddy 安装目录>\WorkBuddy.exe` |

> WorkBuddy 桌面端只发布 Windows 与 macOS 版。Windows 上装在**你选定的盘符**下的
> `Programs\WorkBuddyAI\` 与 `Programs\WorkBuddy\`；macOS 上是
> `/Applications/WorkBuddy AI.app` 与 `/Applications/WorkBuddy.app`。
> 插件会自动探测这些位置；探测不到时用 `aiElectronBin` / `cnElectronBin` 显式指定。

## 联调机制：junction / symlink

profile 的 `node_modules\dsh-workbuddy-websearch` 是指向本源码目录的链接，profile 的
`package.json`：

```json
"dependencies": { "dsh-workbuddy-websearch": "link:<本源码目录>" },
"dsh": { "profile": { "bundles": [ ..., "dsh-workbuddy-websearch", ... ] } }
```

profile 的 `cordis.patch.yml` 里以插件 **id**（不是包名）固化凭据参数：

```yaml
- id: web-workbuddy-websearch      # loader 里的真实 id，写错会 "entry not found"
  name: "dsh-workbuddy-websearch"
  config:
    region: global                 # global=国际版 · cn=国内版
    aiElectronBin: "<WorkBuddy AI 安装目录>\\WorkBuddyAI.exe"
    cnElectronBin: "<WorkBuddy 安装目录>\\WorkBuddy.exe"
```

> config 优先级高于环境变量，因此不依赖会被 DSH 管理器重新生成的启动脚本。

## 日常命令

```bash
# 启动 dsh（或用你的启动脚本）
"<dsh 安装根>/dsh.bat"

# 核验插件是否被正确加载（应看到 workbuddy-agentic / web-workbuddy-websearch）
DSH_HOME="<DSH_HOME>" \
  "<dsh 安装根>/node/node.exe" \
  "<dsh 安装根>/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile web --dump-config | grep -iE "workbuddy-websearch|searchProvider"
```

端到端自检（凭据解析 + 真实搜索，命中云端 agentic_search）：

```bash
cd <profile>/node_modules/dsh-workbuddy-websearch/tools
DSH_HOME="<DSH_HOME>" \
WORKBUDDY_SEARCH_REGION=global \
WORKBUDDY_AI_ELECTRON_BIN="<WorkBuddy AI 安装目录>/WorkBuddyAI.exe" \
  node final-verify.mjs
```

成功样例输出：

```
preferredRegion = global
variant = workbuddy-ai | region = global | domain = www.workbuddy.ai
chatBase = https://www.workbuddy.ai
SEARCH OK | sources = 20 | contentLen = 39896
```

## 版本切换（国内 / 国际）

- 国际版：`cordis.patch.yml` 里 `region: global`（默认）。
- 国内版：改成 `region: cn`，或临时 `set WORKBUDDY_SEARCH_REGION=cn` 再启动。

## 依赖

- 运行时：`node >= 20`（dsh 自带 node 24）。
- 软依赖：`dsh-workbuddy-connect >= 0.5.4`（用于解密 5.6+ 加密凭据、双版本凭据解析、
  内存续期）。**未安装也能完整工作**——插件自带平台定位、解密与凭据读取，退回
  「明文只读」兜底路径（仅国内版旧格式）；装了则优先复用 connect 的实现。
- 宿主接缝：`@deepseek-ai/dsh-web` 的 `ctx.web.registerSearchProvider`。

## 发布到 GitHub

仓库地址：<https://github.com/arnen7000/dsh-workbuddy-websearch>

```bash
git push -u origin main
# （可选）发布 npm 包
npm publish
```

CI 会校验包元数据、ESM 语法/导入冒烟，并跑 `npm pack --dry-run`。

## 安装排障（在一个全新 dsh 环境上踩到的两个坑）

`dsh plugin --profile web add link:<本仓库>` 在全新环境里**可能装不上**。两个已知原因：

### 坑 1：pnpm 不落地 `link:` 依赖（环境问题）

实测 pnpm **12.4.1**：在**全新空目录**（无 `.npmrc`）执行 `pnpm install` 时，
包被解到 `node_modules/.pnpm/…`，但**顶层 `node_modules/<包名>` 不创建**，
且反复输出 "Already up to date"。于是 `dsh plugin add` 在 reconcile 阶段报
`cannot resolve profile bundle …`。

**判定**：

```bash
ls <profile>/node_modules/<包名>     # 不存在即为本问题
```

**绕过**（Windows，等价于 `link:` 语义）：

```powershell
New-Item -ItemType Junction `
  -Path   '<profile>\node_modules\dsh-workbuddy-websearch' `
  -Target '<本源码目录>'
```

### 坑 2：`dsh plugin add` 的"半状态"陷阱（dsh 0.2.0-rc.2）

若首次 `add` 时 pnpm **已把依赖写进 `package.json`**，但随后的 reconcile 失败，
profile 会停在"**有 dependency、但不在 `bundles` 里**"的半状态 → dsh **静默忽略**插件。
而且**重跑命令修不好**：`dsh-plugin-manager` 的 `reconcile()` 里有

```js
if (beforeDeps.has(name)) continue;   // 已存在的依赖直接跳过，永远补不进 bundles
```

**修复**：手动把包名加进 `<profile>/package.json` 的 `dsh.profile.bundles`：

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-workbuddy-websearch"]
```

### 装完必做的核验

```bash
DSH_HOME="<DSH_HOME>" node "<dsh 安装根>/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile web --dump-config | grep -E "web-workbuddy-websearch|searchProvider|fetchProvider"
```

期望看到：`searchProvider: workbuddy-agentic`、`fetchProvider: http`、插件行
`web-workbuddy-websearch`，且**无** `duplicate` / `entry not found` 告警。

> 注意：**0.2.0-rc.2 会自动套用 `link:` bundle 的 patch，无需手写兜底**；
> 只有 **0.1.5-rc.2** 需要在 profile `cordis.patch.yml` 里补 `- id: web` 覆盖。
> 装完若 `searchProvider` 仍是 `deepseek-official`，就是这条差异。

## 本地专属文件（不进 GitHub）

`.local/` 已被 `.gitignore` 忽略，用来放**只给自己看**的内容：

| 文件 | 说明 |
|---|---|
| `.local/CREDITS-full.md` | **完整版借鉴报告**（实现级对照：具体借鉴了哪段算法、我们改了什么）。对外发布的是精简版 `CREDITS.md`。 |
| `.local/DEVELOPING-local.md` | 本机路径速查表（安装根、DSH_HOME、App 位置等）。**这类机器相关信息一律不进仓库。** |
| `.local/run-verify.bat`、`.local/run-diag.bat` | 本机快捷启动脚本。 |

`tools/check-github-meta.mjs` 的 **G7** 组会钉住这件事：`CREDITS.md` 必须保持精简
（≤6000 bytes），且 `.local/` 必须仍被忽略。

## 版本策略（改版本相关代码前必读）

**本插件不锁版本上限**——dsh / WorkBuddy 出更新版本照样能装。实现方式：

- `package.json` 的 `dsh.compatibility` 只做**声明**（dsh 无任何代码读取它，不参与强制校验）；
- **刻意不声明** `@deepseek-ai/dsh*` 的 `peerDependencies` 区间——官方兼容性校验只认该命名空间，
  一旦声明且 range 写窄，**更新版本会被拒装**（实测：声明 `>=0.1.5-rc.2 <0.2.0` 会让 dsh `1.0.0` 被拒）。

`tools/regression.mjs` 的 **T2.7–T2.10** 是护栏：会把上界区间、caret 区间、任何 `@deepseek-ai/dsh*`
peer 声明全部拦下。**别绕过它。** 详见 [NORM-COMPLIANCE.md](./NORM-COMPLIANCE.md) §2.5 与 [README](./README.md) 的「版本策略」。
