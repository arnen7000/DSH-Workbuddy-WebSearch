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
category: browser
description:
  en: 'Web search provider for the built-in web_search tool that reuses the WorkBuddy desktop app sign-in, so searches run on the WorkBuddy account without an API key and come back as cited summaries.'
  zh: '把 WorkBuddy 桌面 App 的网络搜索接入内置 web_search 工具的搜索 provider：复用桌面端登录态，无需 API Key，返回带引用来源的综述文本。'
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

## 三、PR 描述（直接复制）

```markdown
## What this plugin does

`dsh-workbuddy-websearch` registers a `web_search` provider (`workbuddy-agentic`) that
routes the built-in `web_search` tool to the WorkBuddy desktop app's cloud agentic
search, reusing the app's existing sign-in. No API key is required, and results come
back as a summary with cited sources.

- Repo: https://github.com/arnen7000/DSH-Workbuddy-WebSearch
- npm: https://www.npmjs.com/package/dsh-workbuddy-websearch
- License: MIT

## Checklist

- [x] `dsh.bundle` is declared in `package.json`
      (`{"bundle":{"patch":"./cordis.patch.yml"}}`)
- [x] The repo is older than 1 day
- [x] Published on npm, and the package's `repository` field points back at this repo
      (so `npm` / version / downloads link automatically)
- [x] Ships real behaviour (registers a search provider), not just a dependency list
- [x] Only adds my own entry — no other files touched
- [x] One entry in this PR

## Notes

- Category `browser` follows the other web-search-provider plugins already listed
  (e.g. `dsh-plugin-tavily`, `dsh-web-search-firecrawl`).
- The plugin only takes over `web_search`; `web_fetch` is left to the built-in
  `web-fetch-http` (the bundle patch restates `fetchProvider: http`).
- It reads the WorkBuddy desktop app's local credential file read-only; token refresh
  happens in memory only and is never written back to disk.
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
