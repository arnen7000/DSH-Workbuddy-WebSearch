# NORM-COMPLIANCE.md — 与 dsh 官方规范的符合性审计

> 问题：**我们的插件开发是否满足 dsh 官方的一些规范和建议？**
>
> 结论（先说结果）：**运行时完全符合，当前就能正常工作；有 3 处「与官方惯例不一致」的地方，但都不是 bug，是「打包态 / 市场生态」才需要的锦上添花。** 下面每条都有源码级证据。

审计基准：三个真实 dsh 运行时（同一台机器上的隔离安装，编号见 COMPATIBILITY.md）
- **dsh 0.1.5-rc.2**（环境 A）
- **dsh 0.2.0-rc.2**（环境 B）
- **dsh 0.1.7-rc.1**（环境 C）

关键实现都读过原文，不是推测。

---

## 1. 官方 bundle 清单「标准形状」

从官方三个 bundle（`dsh-base`、`dsh-headless`、`dsh-web-app`）提取出的统一形状：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`@deepseek-ai/dsh-base` 实测原文（0.1.5-rc.2）：

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./src/*": "./src/*",
  "./package.json": "./package.json"
},
"files": ["lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
"peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" }
```

**第三方插件的实际惯例**（我们 profile 里真实装着的）：

| 插件 | `exports["."]` | 导出 `./cordis.patch.yml` | `dsh.bundle.patch` | 声明 DSH peer |
|---|---|---|---|---|
| `dsh-cost-meter` 1.8.6 | 对象形式 | ❌ 无 | ✅ | ✅（+ `dsh.compatibility`） |
| `dshmarket` 1.44.0 | `main` 形式 | ❌ 无 | ✅ | ✅ |
| `dsh-workbuddy-connect` 0.5.4 | **对象形式** | ✅ **有** | ✅ | ❌ |
| `dsh-better-sidebar` 0.19.1 | 对象形式 | ❌ 无 | ✅ | ✅ |
| **本插件** 0.2.2 | 字符串形式 | ❌ 无 | ✅ | ❌（只有 connect） |

> 注意：**官方惯例本身就是分裂的**——`./cordis.patch.yml` 在官方 bundle 里全都有，在第三方里多数没有。所以它属于「建议」，不属于「规范」。

---

## 2. 逐条判定：Must-fix / Nice-to-align / 无需改

### 2.1 `dsh.bundle.patch` 指对了 —— ✅ 符合

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`loadProfileDirectory()`（`dsh-app-boot/lib/index.js:850-866`）的读取方式是：

```js
const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
if (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
const patchPath = join(packageDir, declared);   // ← 直接字符串拼接，不走 exports!
```

**它把 `declared` 直接 `join` 到 `packageDir`，完全不查 `exports`。**
→ 所以 `exports["./cordis.patch.yml"]` 缺失 **不影响加载**。

**实测确认插件已生效**（环境 A，0.1.5-rc.2）：

```
$ node bin.js --profile web --dump-config | grep -A14 "id: web"
339: # == @deepseek-ai/dsh-base, patched by dsh-workbuddy-websearch
340: - id: web
343:     searchProvider: workbuddy-agentic     ← 本插件已接管
344:     fetchProvider: http                   ← 复述成功，字段未被吞
...
563: # == dsh-workbuddy-websearch
564: - id: web-workbuddy-websearch
565:   name: dsh-workbuddy-websearch           ← 插件行已挂载
```

### 2.2 `exports["./cordis.patch.yml"]` 缺失 —— 🟡 Nice-to-align（**仅打包态需要**）

全仓搜索 `exports` 的唯一消费者是 `packageProxySource()`（`dsh-app-boot/lib/index.js:510`）。它的调用点只有一处：

```js
return {
  entries: !isPackagedExecutable() ? [...links].map(... => ({ kind: "symlink", ... }))
    : [...links].flatMap(([packageName, packageDir]) => {
        const source = packageProxySource(packageName, packageDir);   // :617 唯一调用点
        ...
      })
};
```

而 `isPackagedExecutable()` 的定义是：

```js
function isPackagedExecutable() { return process.pkg !== void 0; }
```

**`process.pkg` 只在 dsh 被打成单文件可执行程序（pkg 打包）时才存在。**
普通 `node bin.js ...` 启动时 `isPackagedExecutable()` 为 `false`，走 `symlink` 分支，`packageProxySource` **根本不会被调用**。

→ 结论：**在我们现在的运行方式（node 直启）下，这个 `exports` 字段永远读不到。** 只有将来把插件装进 pkg 打包版 dsh 时，它才可能影响子路径导入。
→ 而且注意：`packageProxySource` 的 subpath 收集逻辑里，`"."` 是唯一**必须**的键；`./package.json` 被显式排除：

```js
Object.keys(declared).filter((key) => key === "." || key.startsWith("./") && !key.includes("*") && !key.endsWith("/") && key !== "./package.json")
```

本插件已经导出了 `"."`，所以即使走代理分支也能解析。

### 2.3 `exports["."]` 是字符串而非对象 —— 🟡 Nice-to-align（无害）

```js
const candidates = resolve$1({ name: packageName, exports: declared }, subpath);
```

`resolve.exports` 库对 `"." : "./lib/index.js"`（字符串）和 `"." : {default: "./lib/index.js"}`（对象）**都支持**。对象形式的意义是能挂 `types` 条件——我们不用 TS，所以字符串形式功能等价。

### 2.4 未声明 DSH `peerDependencies` —— ✅ 实际是最安全的选择

这一条最容易搞反，必须看清官方判定逻辑。`evaluatePluginCompatibility()`（`dsh-app-boot/lib/index.js:286-313`）核心循环：

```js
for (const [name, range] of Object.entries(dependencies)) {
  if (typeof range !== "string") throw new Error(...);
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;   // ★ 关键
  ...
  if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
}
if (Object.keys(peers).length === 0) return void 0;   // ← 没有 DSH peer = 直接放行
```

**`evaluatePluginCompatibility` 只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 命名空间下的 peer。**
我们的 `peerDependencies` 只有 `dsh-workbuddy-connect`（**不在该命名空间**）→ 循环里被 `continue` 跳过 → 返回 `undefined` → **永远不会触发 `incompatible-version`**。

官方 docstring 也印证这个意图：

> Check every **@deepseek-ai/dsh or @deepseek-ai/dsh-\*** peer against the runtime.

→ 判定：**不加 DSH peer = 零误判风险 = 最稳。** 加了反而可能因为 dsh 版本 range 写太窄而**主动引入**被拒装的风险。**建议：保持现状，有意不声明。**

（顺带纠正此前一条不准确的说法：`dsh plugin` 子命令本身**不做**任何兼容检查——它只是 pnpm 的 thin forwarder（`dsh/lib/plugin-*.js`）。真正的检查在 `dsh-plugin-manager`（0.2.0-rc.2 / 0.1.7-rc.1 有，**0.1.5-rc.2 没有**），且用的是同一份 `dsh-app-boot` 里的函数。）

### 2.5 `dsh.compatibility` —— ✅ **已采用**（作为"已验证版本"的声明载体）

`dsh-cost-meter` 用的形状：

```json
"dsh": { "compatibility": { "dsh": ">=0.1.0-rc.5", "dshReleases": { "0.1.5-alpha.1": "compatible", ... } } }
```

**关键事实：`evaluatePluginCompatibility` 完全不读 `dsh.compatibility`**——它只看 `peerDependencies`。
全仓检索确认（dsh 0.2.0-rc.2 与 0.1.7-rc.1）：

```bash
$ grep -rn "dsh?.compatibility\|dsh\.compatibility" --include=*.js node_modules/@deepseek-ai/
（无输出 → 没有任何代码读取该字段）
$ grep -rn "dshReleases" --include=*.js node_modules/@deepseek-ai/
（无输出 → 同上）
```

**这正是我们需要的性质**：它能**声明**"验证过哪些版本"，却**不会强制**任何东西。
于是本项目采用它作为版本声明的载体：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "compatibility": {
    "dsh": ">=0.1.5-rc.2",
    "dshReleases": { "0.1.5-rc.2": "compatible", "0.1.6-alpha.2": "unknown", "0.1.7-rc.1": "compatible", "0.2.0-rc.2": "compatible" }
  }
}
```

- `dsh: ">=0.1.5-rc.2"` 是**宽松下界**——它表达"我们验证的起点"，而**不是**安装门槛；
- `0.1.6-alpha.2` 标 `unknown`（接缝核对过，但未端到端），**如实标注**，不冒充已验证；
- **更新版本（含未来 1.x / 2.x）照样安装**——因为该字段不参与校验。

**实测证据**（调用官方真实函数评估我们的 manifest）：

| dsh 版本 | 我们的 manifest | 若改声明 `@deepseek-ai/dsh: ">=0.1.5-rc.2 <0.2.0"` |
|---|---|---|
| 0.1.0 | ✅ 放行 | ✅ 放行 |
| 0.1.5-rc.2 | ✅ 放行 | ✅ 放行 |
| 0.1.6-alpha.2 | ✅ 放行 | ✅ 放行 |
| 0.1.7-rc.1 | ✅ 放行 | ✅ 放行 |
| 0.2.0-rc.2 | ✅ 放行 | ✅ 放行 |
| 1.0.0 | ✅ **放行** | ❌ **被拒装** |
| 2.5.1 | ✅ **放行** | ❌ **被拒装** |

→ **这就是"不锁上限"的实现方式**：用非强制的 `dsh.compatibility` 声明，
而**不**用会强制的 `peerDependencies`。

> 豁免机制（profile 的 `compatibility.json` / `allow-version --accept-risk`）是给
> "明知不兼容仍要装"的用户用的。我们**根本不触发**不兼容，故用不上。

---

## 3. 审计结论表

| # | 项 | 官方/生态情况 | 我们的现状 | 判定 |
|---|---|---|---|---|
| 1 | `dsh.bundle.patch` 指向 patch | 全部都有 | ✅ `./cordis.patch.yml` | **必须**，已满足 |
| 2 | 导出 `"."` 入口 | 全部都有 | ✅ | **必须**，已满足 |
| 3 | 导出 `./package.json` | 官方全有 | ✅ | 建议，已满足 |
| 4 | `exports["."]` 对象形式 | 官方+多数三方用对象 | 字符串形式 | 🟡 无害（`resolve.exports` 两者都认；无 TS 时等价） |
| 5 | 导出 `./cordis.patch.yml` | 官方全有，三方**多数没有** | 未导出 | 🟡 仅 **pkg 打包态**可能相关；node 直启**读不到** |
| 6 | 声明 `@deepseek-ai/dsh*` peer | 官方全有；三方约半数有 | 未声明 DSH peer | ✅ **有意为之**：官方只校验 `@deepseek-ai/dsh*`，不声明=永不误拒 |
| 7 | `dsh.compatibility` | 少数插件有 | ✅ **已采用** | ✅ 作为"已验证版本"声明；非强制字段，不拦任何版本（§2.5） |
| 8 | `type: module` / 纯 ESM | 官方全有 | ✅ | 已满足 |
| 9 | `engines.node` | 普遍声明 | ✅ `>=20` | 已满足 |
| 10 | 无 `dependencies`（零依赖） | 官方 bundle 重依赖；三方插件可有 | ✅ **零 `dependencies`** | ✅ 优于惯例（更易装、更抗环境漂移） |
| 11 | `files` 白名单 | 普遍有 | ✅ | 已满足 |

---

## 4. 建议动作

### 建议现在做（低风险、纯对齐）
在 `package.json` 的 `exports` 里补一行、并把 `"."` 改对象形式——**为将来可能的 pkg 打包态与市场生态对齐**，但要注意这需要 **bump 版本号**：

```json
"exports": {
  ".": { "default": "./lib/index.js" },
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json",
  "./platform": "./lib/platform.mjs",
  "./credentials": "./lib/credentials.mjs",
  "./decrypt": "./lib/decrypt.mjs"
}
```

> ⚠️ 这是**纯增量、无行为改变**的改动（`resolve.exports` 两种形式等价；`loadProfileDirectory` 不读 `exports`）。唯一代价是版本号要动，用户需重装。

### 明确不建议做
- ❌ **不要**为了"符合规范"去加 `@deepseek-ai/dsh` 的 `peerDependencies`。官方只校验该命名空间，不声明才不会因为 range 写窄而被拒装；声明了反而**主动引入风险**（见 §2.5 实测对照表）。
- ❌ **不要**把 `dsh.compatibility` 的 `dsh` 写成有上界的区间（如 `>=0.1.5 <0.2.0`）。它本身不强制，但写成上界会误导读者以为"超版不能用"，与本项目"允许更新版本安装"的策略相悖。

### 已做（v0.2.3）
- ✅ `dsh.compatibility` 声明已验证版本（宽松下界 + `dshReleases` 清单），作为版本策略的载体。

### 可选（上架市场时再做）
- 补 `dshhub` 元数据（`displayName` / `summary` / `categories` / `capabilities`），参考 `dsh-cost-meter`。

---

## 5. 一句话回答用户的问题

> **满足。** 我们走的是 dsh 官方 bundle 的核心契约（`dsh.bundle.patch` + ESM 入口 + `./package.json` 导出），并且经 `--dump-config` 三版本实测**已正常生效**。
> 有 3 处与官方惯例不完全一致（`exports` 对象形式、导出 `./cordis.patch.yml`、未声明 DSH peer），其中：
> - 前两处只在 **pkg 打包态**才可能被读取（普通 node 启动读不到），属于可对齐的"锦上添花"；
> - 第三处**不声明才是更安全的选择**——因为官方兼容性校验只认 `@deepseek-ai/dsh*` 命名空间，我们不声明即永不被误拒。
>
> 版本策略上，我们**用非强制的 `dsh.compatibility` 声明"验证过哪些版本"，而不用会强制的 `peerDependencies` 锁版本**——
> 于是更新版本（含未来 1.x / 2.x）照样能装，同时又如实告知了验证边界。
>
> 所以：**不是"不合规"，是"官方惯例本身有分歧，而我们选的正是运行时最稳的那一支"。**
