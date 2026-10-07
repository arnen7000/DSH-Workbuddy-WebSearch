# GITHUB-SETUP.md — GitHub 侧要求对照与仓库设置清单

> 问题：**GitHub 网站是否还有其他要求，是否需要满足？**
>
> 结论（先说结果）：**GitHub 几乎没有"硬性要求"**——它的社区档案清单（Community Standards）
> 全部是**推荐**项，缺了只会"掉勾"，不会拦你推送或使用。真正需要注意的只有两类：
> ① **网页端设置**（仓库描述、Topics、Releases）——不在文件里，必须手动做；
> ② **工作流安全加固**——官方以"best practice"表述，但仓库/组织管理员**可以**把它变成强制策略。
>
> 推荐项已全部补齐，并用 CI 钉住（见 §4）。

---

## 1. 社区档案清单（Insights → Community Standards）

GitHub 官方清单共 8 项，**全部为 recommended，无强制**：

| # | 项目 | 载体 | 我们 | 说明 |
|---|---|---|---|---|
| 1 | **Description**（仓库描述） | 网页端设置 | ⬜ **待做** | 不在文件里，创建仓库时填 |
| 2 | **README** | `README.md` | ✅ 有 | 必需心智，GitHub 首页展示；结构遵循 Standard Readme，见本文 §9 |
| 3 | **Code of conduct** | `CODE_OF_CONDUCT.md` | ✅ **新增** | Contributor Covenant v2.1 |
| 4 | **Contributing** | `CONTRIBUTING.md` | ✅ **新增** | 指向 TESTING.md，闭合"怎么改" |
| 5 | **License** | `LICENSE` | ✅ 有 | MIT |
| 6 | **Security policy** | `SECURITY.md` | ✅ **新增** | 本插件碰凭据，**强烈建议有** |
| 7 | **Issue templates** | `.github/ISSUE_TEMPLATE/*` | ✅ **新增** | Bug 报告 + 功能请求（Issue Forms） |
| 8 | **Pull request template** | `.github/pull_request_template.md` | ✅ **新增** | 内含红线检查清单 |

> **官方规则**：Issue 模板必须在 `.github/ISSUE_TEMPLATE/` 下，且
> `.md` 版需含 `name:` + `about:`，`.yml`（Issue Forms）版需含 `name:` + `description:`，
> 才会显示绿勾。我们用的是 **Issue Forms（.yml）**，已按此格式写并加了 CI 校验。

**文件可放的位置**（GitHub 都认）：仓库根、`.github/`、`docs/`。
我们选择：`SECURITY/CONTRIBUTING/CODE_OF_CONDUCT` 放**根目录**（更显眼），
模板类放 **`.github/`**（GitHub 惯例位置）。

---

## 2. 真正"硬"的东西（会拦你 / 会被策略强制）

| 项 | 强制程度 | 我们 |
|---|---|---|
| 仓库名、可见性、License 选择 | 创建时必填 | ✅ 已有 MIT |
| **Action 固定到完整 commit SHA** | ⚠️ 仓库/组织管理员**可启用强制策略**；未启用时是强建议 | 🟡 目前用 `@v4` 标签（见 §5 权衡） |
| Issue 模板格式合法 | 格式错 → **整份表单被拒收**（不是"掉勾"） | ✅ 已加 CI 校验 |
| `dependabot.yml` 结构合法 | 格式错 → Dependabot 静默不工作 | ✅ 已加 CI 校验 |

**结论：唯一可能被"强制"的是 Action SHA 固定**，而它取决于你的仓库设置，不是 GitHub 对所有人的要求。

---

## 3. 工作流安全加固（官方表述为 best practice）

来源：GitHub Docs《Security hardening for GitHub Actions》。已落实：

| 建议 | 我们 | 落点 |
|---|---|---|
| `GITHUB_TOKEN` 默认**只读**，按 job 提权 | ✅ | `ci.yml` 顶层 `permissions: contents: read` |
| 限制 token 权限范围（最小权限） | ✅ | 同上；本工作流只需读 |
| 用 Dependabot 保持 action 最新 | ✅ | 新增 `.github/dependabot.yml`（只盯 `github-actions`） |
| 用 `CODEOWNERS` 监控 `.github/workflows` 变更 | ⬜ 未做 | 单人项目价值有限，可选 |
| 避免 `pull_request_target` | ✅ | 我们未使用 |
| 不在工作流里明文放敏感信息 | ✅ | 本工作流**完全不需要任何 secret** |

> 本仓库刻意**零运行时依赖**（`package.json` 无 `dependencies`），
> 所以供应链面只有 GitHub Actions 这一处 —— Dependabot 也只盯它，不制造噪声。

---

## 4. 新增/改动清单

**新增文件（GitHub 侧，不进 npm 包）**

```
SECURITY.md                                  # 凭据相关漏洞的私密报告渠道
CONTRIBUTING.md                              # 贡献流程，指向 TESTING.md
CODE_OF_CONDUCT.md                           # Contributor Covenant v2.1
.github/pull_request_template.md             # PR 清单（含 3 条红线）
.github/ISSUE_TEMPLATE/bug_report.yml        # Bug 报告表单（11 项，含错误码/版本/平台）
.github/ISSUE_TEMPLATE/feature_request.yml   # 功能请求表单（6 项，含"不接管抓取"提示）
.github/ISSUE_TEMPLATE/config.yml            # 关闭空白 Issue，引导先读文档
.github/dependabot.yml                       # 只盯 GitHub Actions
tools/check-github-meta.mjs                  # GitHub 元数据自检（G1–G9，33 项）
```

**改动文件**

- `.github/workflows/ci.yml`：新增顶层 `permissions: contents: read`；新增
  `GitHub metadata self-check` 步骤（调用上面的脚本）。

**对用户的影响：无。** 以上全部是 GitHub 侧元数据，`npm pack` 结果仍为 **12 个文件**，
**不需要 bump 版本号，也不需要用户重装**。

---

## 5. 已知的权衡与未做项

### 5.1 Action 用 `@v4` 标签 vs 固定 SHA

- **官方立场**：固定到完整 commit SHA 是"唯一把 action 当作不可变发布版本的方式"。
- **另一面**：Dependabot **不会**为固定到 SHA 的 action 创建漏洞告警（官方文档明确说明）。
- **我们的选择**：保留 `@v4` / `@v4` 语义化标签 + Dependabot 月度更新。
  理由：本项目仅用 GitHub 官方 action（`actions/checkout`、`actions/setup-node`），
  风险面小；用标签可让 Dependabot 正常告警。**若将来引入第三方 action，建议改为固定 SHA。**

### 5.2 未做的项

- **CODEOWNERS**：单人维护，价值有限。若日后有人协作，建议加一行
  `/github/workflows/ @<owner>` 以监控工作流改动。
- **CHANGELOG.md**：不在 GitHub 社区档案清单内。本项目的变更摘要已由
  `package.json` 的 `versionNote`（机器可读）与 `COMPATIBILITY.md`（人读）承担，
  再加一份会造成"三处维护"。**故有意不加。**
- **FUNDING.yml / GitHub Sponsors**：与项目定位无关，跳过。

### 5.3 发布面精简：长文不外发

对外仓库（以及 npm 包）**保持简短**，长篇的"内部分析"留在本地：

| 文件 | 对外（GitHub / npm） | 本地 |
|---|---|---|
| 借鉴报告 | `CREDITS.md` —— **精简版**（约 2.7 KB），只保留 MIT 归属义务所需信息与主要来源表 | `.local/CREDITS-full.md` —— **完整版**（约 8.5 KB），含实现级对照（具体借鉴了哪段算法、我们改了什么）。`.local/` 已被 `.gitignore` 忽略 |
| 实现级对照 | 分散在**源码注释**里，就地标注来源 | 同左（完整叙述在 `.local/`） |

> 由 `tools/check-github-meta.mjs` 的 **G7** 组钉住：`CREDITS.md` ≤ 6000 bytes，
> 且 `.local/` 必须仍被忽略。
>
> ⚠️ 注意：完整版**曾存在于 git 历史**里（提交 `20598fb`）。由于仓库对外发布，
> 已在推送前做了一次历史重写，把各提交里的 `CREDITS.md` 统一替换为精简版——
> 因此 **GitHub 上任何位置（含 `git log -p`）都只有精简版**。完整版仅存于本地
> `.local/CREDITS-full.md`。重写前的全量备份见仓库外的 `*.bundle`。

---

## 6. 仓库创建时在网页上要做的事（文件覆盖不到）

创建 GitHub 仓库后，逐条设置：

1. **Repository name**：`dsh-workbuddy-websearch`
2. **Description**（对应清单第 1 项）：**必须与 `package.json` 的 `description`、README 简介
   三处同文**（见 §9 硬约束 1），当前为
   `将 WorkBuddy 桌面 App 的网络搜索接入 DeepSeek Harness 的 web_search 工具（零配置、零硬依赖）`
3. **Topics**（提升可发现性）：`dsh` `deepseek-harness` `deepseek` `workbuddy` `web-search` `plugin`
4. **LICENSE**：仓库已含 `LICENSE`（MIT），GitHub 会自动识别
5. **Releases**：打完 tag 后建 Release（把 `package.json` 的 `versionNote` 摘要贴进去）
6. **Security → Report a vulnerability**：建议开启私密漏洞报告入口（`SECURITY.md` 里引用了它）
7. **Community Standards**：设置完上面几项后，去 Insights → Community Standards 复核是否全绿

---

## 7. 一键自检

新增的 `tools/check-github-meta.mjs` 把上述可自动化的部分都钉住了：

```bash
node tools/check-github-meta.mjs "$PWD"
```

| 组 | 覆盖 |
|---|---|
| G1 | 社区健康文件 5 份是否齐备 |
| G2 | PR 模板与两份 Issue 模板是否存在 |
| G3 | Issue Forms 结构是否合法（`name`/`description`/`body`+`type`） |
| G4 | Dependabot 结构合法，且只盯 `github-actions` |
| G5 | CI 最小权限 + 关键步骤接线（含本脚本自身） |
| G6 | 占位符提示（`<your-gh-user>` / `OWNER/REPO` / TODO 邮箱）——**只 WARN 不阻断** |
| G7 | 发布面精简（`CREDITS.md` ≤ 6000 bytes、`.local/` 必须被忽略、完整版留在本地） |
| G8 | **本机信息零泄露**——遍历全部文本文件，禁止本机路径 / 用户名 / 本机目录名 / 本机专属的 dsh 数据目录命名 / 本机专属包名（违规即 FAIL） |
| G9 | **时间信息分级**——日级 ISO 日期仅白名单允许，只留"基本时间信息"（违规即 FAIL） |

当前：**33 PASS / 0 FAIL / 0 WARN**。

---

## 8. 落地状态

已完成：

| 事项 | 结果 |
|---|---|
| 替换仓库 URL 占位符 | ✅ `package.json`（3 处）、`DEVELOPING.md`（2 处）、`.github/ISSUE_TEMPLATE/config.yml`（3 条 contact_links）、`bug_report.yml`（1 条链接）→ 全部指向 `github.com/arnen7000/dsh-workbuddy-websearch` |
| 填写联系邮箱 | ✅ `SECURITY.md` + `CODE_OF_CONDUCT.md` → `arnen@126.com` |
| **清除本机信息** | ✅ 见下 |
| 自检 | ✅ `node tools/check-github-meta.mjs "$PWD"` → 33 PASS / 0 FAIL / 0 WARN |
| 推送 | ⏳ 见下（远端仓库已改名为全小写 `dsh-workbuddy-websearch`） |

### 8.1 本机信息清理明细

本仓库**对外发布**，因此任何文件都不允许出现机器相关信息。清理内容：

| 类别 | 处理 |
|---|---|
| 本机快捷脚本 | `tools/run-diag.bat`、`tools/run-verify.bat` 硬编码了本机绝对路径，且前者调用的 `diag.mjs` **根本不在仓库里**（对别人是坏文件）→ 移入 `.local/`，从仓库移除 |
| 文档里的本机路径 | `README.md` / `TESTING.md` / `DEVELOPING.md` / `COMPATIBILITY.md` 里的用户目录与盘符绝对路径全部改为 `<占位符>` 或 `%变量%` |
| 源码注释 | `ensure-installed.mjs` / `regression.mjs` / `scenarios.mjs` / `final-verify.mjs` 的用法示例同样通用化 |
| 本机目录名 | 46 处本机环境目录名 → 匿名「环境 A/B/C/D」（表格里已有 dsh 版本列，不丢信息） |
| 规则固化 | 新增 **G8** 组，把「不得泄露本机信息」变成会 FAIL 的自动检查；CI 每次都会跑 |
| 本机速查表 | 你自己的路径表存到 `.local/DEVELOPING-local.md`（已被 gitignore） |

> 确属合成数据的行（如测试夹具里的假路径）用 `g8-ignore: <理由>` 显式豁免，
> 豁免点留在代码里可见、可评审。

> ⚠️ **G8 只扫工作区，不扫 git 历史。** 历史同样对外可见（`git log -p` 就能看到），
> 而它不经过任何自动检查——发布前请自己确认一次：
>
> ```bash
> # ① 提交信息
> git log --all --format="%s%n%b" | grep -nE "<本机信息模式>"
> # ② 每个历史版本的文件内容
> git rev-list --all | while read c; do
>   git grep -lE "<本机信息模式>" "$c" -- . ':!tools/check-github-meta.mjs'
> done
> ```
>
> （`<本机信息模式>` 即 G8.1–G8.6 那几条正则，见 `tools/check-github-meta.mjs`——
> 本文不复制字面量，否则文档自己就会违规。）
>
> **本仓库的做法**：发布前把 `main` 压成**单个干净的初始提交**（`--orphan` + 当前树 +
> 干净 commit message），旧历史只留在**本地备份分支**里。
> 因为发布前仓库从未被推送过，这样能一次性清掉历史里的机器信息与开发日期，
> 又不影响任何已有克隆。
>
> 🔴 **只能推 `main`**：`git push --all` / `--mirror` 会把带机器信息的备份分支一起推上去。

### 8.2 时间信息清理明细（时间信息分级）

对外文档只保留**基本时间信息**，不保留**开发/测试过程的日期**。分级如下：

| 级别 | 例子 | 处置 |
|---|---|---|
| **保留**·文档版本头 | `更新：2026-10` | 每个面向用户的文档顶部一行「版本 + 更新**年月**」，粒度到**月** |
| **保留**·客观事实日期 | 鸿蒙版随 iOS/Android 上线（`2026-07-18`）、端点取证（`2026-09-24`） | 属**产品或技术事实**，与开发环境无关，保留到日 |
| **移除**·开发/测试日志日期 | 「某天在一个全新环境上踩到」、「某天在真实设备上实测发现」、附录标题里的日期 | 删掉日期，**只留结论**；顺序由版本号体现 |
| **移除**·会话指代 | 「本次新增」「当时规模」「我们今天…」 | 改为中性措辞（「新增」「该版本规模」「当前」） |

理由：日级日期会暴露开发节奏与测试时点，对读者无价值；而版本号 + 年月已足够表达"这份文档有多新"。
规则固化：新增 **G9** 组（见 §7），日级 ISO 日期只允许出现在显式白名单里，其余一律 FAIL。

> 注：Git 提交历史（`git log`）里的时间戳是版本控制系统的固有属性，不属于本项清理范围。

仍需在**网页端**手工完成（文件覆盖不到）：Description、Topics、开启私密漏洞报告、Releases、Community Standards 复核 —— 见第 6 节。

---

## 9. README 结构规范（Standard Readme）

对外 README 遵循 **[Standard Readme](https://github.com/RichardLitt/standard-readme)** 规范
（社区事实标准，带配套 linter）。**章节必须按下列顺序出现**，可选节可省略：

| 顺序 | 章节 | 状态 | 本项目对应 |
|---|---|---|---|
| 1 | Title | 必需 | `# dsh-workbuddy-websearch` |
| 2 | Banner / Badges | 可选 | 未使用（见下「刻意未做的事」） |
| 3 | Short Description | 必需 | 标题下一行，**< 120 字符**，无标题、独占一行 |
| 4 | Long Description | 可选 | 无标题，紧接简介之后 |
| 5 | Table of Contents | 必需（不足 100 行可省） | `## 目录` |
| 6 | Security | 可选 | `## 安全` |
| 7 | Background | 可选 | 未使用 |
| 8 | Install | 必需 | `## 安装`（子节：`依赖` / `卸载`） |
| 9 | Usage | 必需 | `## 使用`（子节：`CLI` / `配置`） |
| 10 | Extra Sections | 可选 | `## 适用范围`、`## 注意事项` |
| 11 | API | 可选 | 未使用（无对外 API） |
| 12 | Maintainers | 可选 | 未使用 |
| 13 | Thanks | 可选 | `## 致谢` |
| 14 | Contributing | 必需 | `## 参与贡献` |
| 15 | License | 必需，**必须排在最后** | `## 许可证` |

**三条硬约束**

1. **简介必须与 `package.json` 的 `description` 一致**，并与 GitHub 仓库网页端的
   Description **三处同文**。当前统一为：
   > 将 WorkBuddy 桌面 App 的网络搜索接入 DeepSeek Harness 的 web_search 工具（零配置、零硬依赖）
2. **不得有失效链接**。所有 `./xxx.md` 必须真实存在，外部链接必须可达。
3. **README 只面向使用者**。实现细节、协议取证、内部权衡一律不进 README，分别归入
   `DEVELOPING.md`（实现要点与取证）、`COMPATIBILITY.md`（实测依据）、
   `NORM-COMPLIANCE.md`（规范审计）。

**刻意未做的事**

- **不加 badges**。规范里 badges 是可选项；而 shields.io 在国内网络下常不可达，会渲染成坏图。
  本项目坚持「零外部资源」，故不加。
- **不新增 `ARCHITECTURE.md`**。实现说明并入 `DEVELOPING.md`，避免再多一份需要同步的文档
  （与 §5.2「有意不加 CHANGELOG」同一条理由）。

**改动 README 后的必做动作**

```bash
node tools/check-github-meta.mjs "$PWD"   # G1–G9，33 项
node tools/regression.mjs "$PWD"          # T1–T10
node tools/scenarios.mjs "$PWD"           # S1–S9
```

再同步 GitHub 网页端的 **Description**（与硬约束 1 同文）与 **Topics**（见第 6 节）。
