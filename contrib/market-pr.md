# 提交 DSH 插件市场（awesome-dsh-plugin）用的 PR 材料

这个文件是**给你提 PR 时直接复制粘贴用**的，不是运行时资产（`contrib/` 不进 npm 包）。

---

## 一、要新增的文件

在 fork 出来的 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库里，新建**一个**文件：

```
data/plugins/arnen7000__DSH-Workbuddy-WebSearch.yml
```

内容就是 `contrib/awesome-dsh-plugin-entry.yml` 去掉注释头之后的四行：

```yaml
url: https://github.com/arnen7000/DSH-Workbuddy-WebSearch
name: arnen7000/DSH-Workbuddy-WebSearch
category: tools
description:
  en: Makes the WorkBuddy desktop app's web search the dsh web_search provider, reusing the app's existing sign-in with no extra configuration.
  zh: 把 WorkBuddy 桌面 App 的网络搜索作为 dsh 的 web_search 提供方，复用 App 已有的登录状态，无需额外配置。
```

> 文件名必须与 `slugFor(url)` 完全一致（大小写敏感）。
> 只允许 5 个键：`url` / `name` / `category` / `description` / `tarball`。
> **不要**手写 `npm` / `version` / `stars` / `downloads` / `install` / `added` / `capabilities`
> —— 全部由 CI 生成，手写会被判非法字段。

---

## 二、PR 标题

```
Add dsh-workbuddy-websearch: web_search provider backed by the WorkBuddy desktop sign-in
```

> 标题是**唯一保持单语英文**的字段：GitHub 的 PR 列表列会截断，双语标题反而更难扫读。
> 除此之外，PR 描述、PR/issue 评论一律中英对照（英文在前、中文紧随）。

## 三、PR 描述（直接复制）

> 中英对照：维护者以英文阅读为主，所以英文在前、中文紧随其后。仓库本身也是双语
> （条目 `description` 就有 `en` / `zh` 两个键），因此中文出现在 PR 描述里不违和。

```markdown
## What this plugin does / 这个插件做什么

`dsh-workbuddy-websearch` registers a `web_search` provider (`workbuddy-agentic`) that
routes the built-in `web_search` tool to the WorkBuddy desktop app's cloud agentic
search, reusing the app's existing sign-in. No API key is required, and results come
back as a summary with cited sources.

`dsh-workbuddy-websearch` 以 id `workbuddy-agentic` 注册一个 `web_search` provider，
把内置的 `web_search` 工具接到 WorkBuddy 桌面 App 的云端 agentic 检索上，复用 App
已有的登录态。无需 API Key，返回带引用来源的综述文本。

- Repo / 仓库: https://github.com/arnen7000/DSH-Workbuddy-WebSearch
- npm: https://www.npmjs.com/package/dsh-workbuddy-websearch
- License / 许可证: MIT

## What the code does / 代码具体做了什么

- Registers the provider under the id `workbuddy-agentic`; `searchProvider` is pinned,
  so the choice does not depend on registration order.
  以 id `workbuddy-agentic` 注册 provider；`searchProvider` 是钉住的，与注册顺序无关。
- Read-only on the desktop app's credential files; token refresh stays in memory and is
  never written back. The domestic and international editions are never mixed, and the
  newer `$wbEncrypted` credential format is decrypted.
  对桌面 App 的凭据文件只读；token 刷新只发生在内存里，从不回写。国内版 / 国际版不混用；
  能解开较新的 `$wbEncrypted` 加密凭据。
- Returns a summary plus a de-duplicated source list; every failure carries a
  classifiable code (`WB_SEARCH_BAD_REQUEST` / `TRANSPORT_ERROR` / `UPSTREAM_ERROR` /
  `SESSION_DEAD` / `CREDENTIAL_MISSING` / `CREDENTIAL_MALFORMED` /
  `CREDENTIAL_UNSUPPORTED_FORMAT` / `EMPTY_RESULT` / `WEB_ABORTED`).
  返回综述 + 去重后的来源列表；所有失败都带可分类的错误码（见上），宿主可据此处理。
- Takes over `web_search` only — `web_fetch` is left to the built-in `web-fetch-http`
  (the bundle patch restates `fetchProvider: http`).
  只接管 `web_search`；`web_fetch` 仍走内置（bundle patch 里重申 `fetchProvider: http`）。
- Test suite in the repo: 183 contract + 68 scenario/edge-case + 40 metadata checks, all
  green. Every new guard is verified by mutation testing, so it cannot be vacuously true.
  仓库自带测试：183 条契约 + 68 条场景/异常 + 40 条元信息检查，全绿；每条新护栏都做过
  变异测试，确保不是恒真。

## Checklist / 自查清单

- [x] `dsh.bundle` is declared in `package.json`
      (`{"bundle":{"patch":"./cordis.patch.yml"}}`) / 已声明 `dsh.bundle`
- [x] The repo is older than 1 day / 仓库已超过 1 天
- [x] Published on npm, and the package's `repository` field points back at this repo
      (so `npm` / version / downloads link automatically)
      / 已发布到 npm，且 `repository` 指回本仓库（`npm` / 版本 / 下载量自动关联）
- [x] Ships real behaviour (registers a search provider), not just a dependency list
      / 有真实行为（注册 search provider），不是纯依赖清单
- [x] Only adds my own entry — no other files touched / 只新增自己这一条，未改动其他文件
- [x] One entry in this PR / 本 PR 只加 1 条

## Notes / 补充说明

- Category `tools` — upstream `CAT_IDS` accepts both `tools` and `browser`; `tools` was
  chosen because the plugin's entire job is backing one built-in tool (`web_search`),
  and it is one of the most widely used categories in the catalog.
  分类选了 `tools`：上游 `CAT_IDS` 里 `tools` 与 `browser` 都合法；选 `tools` 是因为本插件的
  全部工作就是支撑一个内置工具（`web_search`），且它是目录里最常用的分类之一。
- The plugin only takes over `web_search`; `web_fetch` is left to the built-in
  `web-fetch-http` (the bundle patch restates `fetchProvider: http`).
  本插件只接管 `web_search`，抓取仍走内置。
- It reads the WorkBuddy desktop app's local credential file read-only; token refresh
  happens in memory only and is never written back to disk.
  对桌面 App 的本地凭据文件只读；token 刷新只在内存中，绝不回写磁盘。
```

---

## 四、提交前请自行确认（我没法替你验的）

1. **仓库已推送** —— CI 会去 `raw.githubusercontent.com` 读你**默认分支**上的
   `package.json`。如果 0.3.4 还没推上去，读到的是 0.3.3，同样含 `dsh.bundle`，能过。
2. **仓库仍公开可访问**（CI 要读它）。
3. **只改这一个文件** —— 不要顺手格式化邻居条目，CI 会列出被改动的既有条目。
4. **一个 PR 最多 3 条** —— 我们只加 1 条。

## 五、合并之后

- 站点与市场会自动重建，**通常一天内**在市场里能搜到。
- 届时用户即可在市场里一键安装/升级/卸载；市场安装会把目标固定到注册表最新版，
  因此不会踩 pnpm 11 的 24 小时冷静期（命令行安装才会，见 README「快速开始」）。
