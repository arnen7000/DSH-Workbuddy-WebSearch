# contrib/ — 上架与外部协作材料

这个目录放**给外部仓库用的提交物**，不属于插件运行时（`package.json` 的 `files`
不含它，因此不会进 npm 包）。

| 文件 | 用途 |
|---|---|
| [`awesome-dsh-plugin-entry.yml`](./awesome-dsh-plugin-entry.yml) | 上架条目本体（放进上游 `data/plugins/` 的那份内容） |
| [`submit-market.sh`](./submit-market.sh) | **一键提交上架 PR**（在临时目录里加条目、推到你的 fork、打印开 PR 链接） |
| [`market-pr.md`](./market-pr.md) | **提 PR 时直接复制粘贴**的标题与描述，含提交前自查清单 |
| [`publish.sh`](./publish.sh) | 一键推送 + 打 tag + 建 Release（Release 才触发 npm 发布） |

> 两个脚本都支持 `--dry-run`，建议先跑它看一眼会做什么：
> `bash contrib/publish.sh --dry-run`、`bash contrib/submit-market.sh --dry-run`。

### 两个脚本的代理行为

脚本**自动探测**代理，不写死端口：

| 环境变量 | 行为 |
|---|---|
| 未设（默认） | 探 `127.0.0.1:7890` / `7891`，**通才用**，不通就直连 |
| `DSH_GIT_PROXY=http://…` | 强制走指定代理 |
| `DSH_GIT_PROXY=`（空串） | 强制直连 |

> 为什么不做成写死：本机曾出现「代理关掉后脚本仍去连 127.0.0.1:7890」，
> 而报错却说「多半是缺凭据」—— 把网络问题误诊成权限问题，用户会白折腾 PAT。
> 现在推送失败按**三类分开报**（连不上 / 认证失败 / 其他），各给各的修法。
>
> 只作用于本次 git 调用，**不写入你的 git config**。

## `awesome-dsh-plugin-entry.yml` —— DSH 插件市场上架条目

**用途**：让本插件出现在 **DSH 插件市场**（`dshmarket`）里，用户就能在界面上
一键安装 / 升级 / 卸载，不必记命令行。

**市场列表从哪来**：市场本身不维护插件目录，它每次打开都实时拉取精选列表
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
生成的 `plugins.json`。所以「上架」= 往**那个仓库**加一条目。

### 怎么提交（整个流程就是一个文件 + 一个 PR）

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`。
2. 新建文件，路径**必须**是（文件名 = `slugFor(url)`，大小写敏感）：

   ```
   data/plugins/arnen7000__DSH-Workbuddy-WebSearch.yml
   ```

3. 内容 = 本目录 `awesome-dsh-plugin-entry.yml` 去掉注释后的部分
   （即 `url` / `name` / `category` / `description` 四个键）。
4. 提 PR。CI 依次检查：每个 PR ≤ 3 条 → 从你的 `package.json` 读 `dsh.bundle`
   → 仓库创建满 1 天 → awesome-lint 与站点构建。
5. 维护者读一遍仓库、核对描述与代码是否相符，然后合并。站点与市场自动重建，
   **通常一天内生效**。

> 不要改 `README.md` / `README.zh.md` —— 它们是**生成物**。
> 也不要手写 `npm` / `version` / `stars` / `downloads` / `install` / `added` /
> `capabilities` 这些键：**全部由 CI 生成，手写会被判为非法字段而失败**。
> 合法字段只有 5 个：`url`、`name`、`category`、`description`、`tarball`。

### 本仓库的条目为什么能过

| 门槛 | 本仓库情况 |
|---|---|
| `dsh.bundle` manifest | ✅ `{"bundle":{"patch":"./cordis.patch.yml"}}`（**最常见的拒收原因**，只声明 `dsh.client` 会失败） |
| 仓库创建满 1 天 | ✅ 本仓库早已超过（无提交数门槛） |
| 开源 + 许可证 | ✅ MIT |
| 已发布到 npm | ✅ 且 `repository` 指回本仓库，因此 `npm` / `version` / 下载量**自动关联** |
| 非纯聚合包 | ✅ 自带真实行为（注册搜索 provider），不是只有依赖清单 |
| 分类 | `browser`（浏览器与网页）—— 同类「搜索 provider」插件绝大多数也在这一类 |
| 星标门槛 | 无（星标与下载量只用于展示） |

**已用上游仓库的真实校验器验证**：把条目放进 `data/plugins/` 后跑
`readEntries` + `validateEntries`，全库 4490 条 **problems = 0**。

### 描述怎么写才不会被退回

维护者会**读代码核对描述里的每一条声明**，所以描述只写可验证的事实，
不加数字、不加最高级、不用营销词。当前描述的四条声明都能在源码里对上：

| 声明 | 代码依据 |
|---|---|
| 是内置 `web_search` 的搜索 provider | `ctx.web.registerSearchProvider(...)`（`lib/index.js`） |
| 复用桌面端登录态 | `lib/credentials.mjs` 读桌面端 auth 文件 |
| 无需 API Key | 只读 WorkBuddy 登录态，不读任何 `*_API_KEY` |
| 返回带引用来源的综述 | `callAgenticSearch()` 解析 SSE 的 `synthesis` 并抽取 `sources` |

### `capabilities` 与红线（不是我们填的）

市场会用第三方静态扫描器 `dsh-trust-check` 扫 npm 包，自动生成
`capabilities` 与 `capabilityRedLines`，**提交者不填**。本插件扫描结果为
`["shell","fs-read","network","env"]`、**`redLines: []`** ——
没有红线，市场不会拦或告警。其中 `shell` 来自解密时启动 WorkBuddy 自带
Electron 取密钥这一必要动作。

**2026-10 复验**（`dsh-trust-check@0.1.13`，扫 0.3.4 代码）：

```
1 plugin(s) · 0 red · 0 accepted · 1 review · 0 expected · 0 clear
dsh-workbuddy-websearch 0.3.4 — review
  No hard red lines; if capabilities match why you installed it, mark as expected in Settings.
  capabilities: shell, fs-read, network (outbound), env
  destinations (literal): https-host: copilot.tencent.com / https-host: www.workbuddy.ai
```

> ⚠️ **别被 JSON 里的 `band` 吓到。** 用 `--dir` 扫**本地目录**时，扫描器会因
> 「install spec is not pinned」再扣 10 分，`band` 变成 `red`（score 48）。
> 那是**调用方式的产物**，不是插件的属性 —— 市场扫的是已发布的 npm 包，
> 用 `--spec npm:dsh-workbuddy-websearch@<版本>` 复现即为 `yellow`（58 分）。
> 更关键的是扫描器自己的文档写明：**判定看 `redLines` 而不是 score**
> （`README.en.md`：*"The verdict follows `redLines`, not the score"*），
> 而我们的 `redLines` 为空，CLI 判词是 `0 red … review`。
>
> 上架前想自己复验：
>
> ```bash
> npx dsh-trust-check --dir . --spec npm:dsh-workbuddy-websearch@0.3.4
> ```
