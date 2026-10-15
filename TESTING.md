# TESTING.md — 测试体系与发布回环

> 目的：第一版发布到 GitHub 之后，用户报 bug 或提新需求时，**不必重新推演「要测什么」**。
> 本文把「用户场景 → 测试套件 → 具体用例」固化下来，改完代码照着跑一遍即可，全程可复用、可自动化。

---

## 0. 一句话总览

```
用户场景（场景地图）
      │  每条场景必须能落到一条可执行的 check 上
      ▼
三层套件：
  tools/regression.mjs         ← 正常路径（happy path）+ 契约，需「已安装的实体目录」
  tools/scenarios.mjs          ← 异常路径（用户真实会撞的坑）+ 接管范围 + 体系自检，全部离线可验
  tools/check-github-meta.mjs  ← 仓库门面（社区档案 / 模板格式 / 工作流加固），仓库根即可跑
      │
      ▼
CI（.github/workflows/ci.yml）在每次 push / PR 上自动跑三层套件
      │
      ▼
每次发版：走「发布回环」（第 4 节），把新增场景先写成 check，再改代码
```

**核心原则：场景先行，用例落地。** 任何一条新场景，如果不能写成一条 `check(...)`，就说明它还是「感觉」，不是「测试」。

---

## 1. 场景地图（五阶段）

插件的生命周期拆成五段，每段对应一组用户真实会遇到的情况。**新增 bug / 新需求时，先判断它落在哪一段**，再决定往哪个套件加 check。

| # | 阶段 | 用户真实场景 | 主要落在 |
|---|---|---|---|
| 1 | **安装** | 装不上 / 装了不生效 / 版本不兼容 / 升级后回退 | 手工核对清单（§3）+ CI 的 pack 检查 |
| 2 | **凭据** | 没登录 / 登录了但文件读不到 / 两版（国内、国际）搞混 / 加密凭据 | T3、T9、S4、S5 |
| 3 | **运行** | 正常搜索、区域切换、超长 query、并发、引用来源 | T5、T6、S6、T7 |
| 4 | **异常** | 空 query、断网、500、401、流中断、坏 JSON、用户中止 | **S1、S2、S3、S6** |
| 5 | **跨环境** | Windows / macOS、CPU 架构、有/无 connect | T9、T10、T11、S5 |
| 6 | **发布**（维护者，非终端用户） | 发布脚本在本机跑不起来 / 上架脚本挂死 / 失败原因指向错误的方向 | S10 |

**第 4 段（异常）是历史上最大的盲区**：`regression.mjs` 只覆盖正常路径，用户报的 bug 却几乎全在异常路径上。`scenarios.mjs` 就是为此而建。

**第 6 段是第二个盲区**：`contrib/` 下的发布/上架脚本长期没有任何自动化测试，结果两个脚本在本机**一个一步都跑不动、一个永久挂死**。S10 用真实的 bash / git 把它们的行为钉住（需要失败时就把代理指向必然不通的端口），全程离线。

---

## 2. 三层套件的分工

### 2.1 `tools/regression.mjs` — 正常路径 + 契约（T1–T14；源态 / 安装态均 183 项）

被测对象：**已安装的插件实体目录**（`link:` junction 或 `.tgz` 解包后的目录均算）。
无凭据时会自动把 T3/T5 降级为 `WARN`，因此 CI 上恒可跑。

| 组 | 覆盖 | 关键契约 |
|---|---|---|
| T1 | 模块契约 | 导出集合、`name`、`inject` 含 `web`、`PROVIDER_ID` |
| T2 | patch 与版本策略契约 | 挂载行 id/name、`searchProvider`、**复述 `fetchProvider: http`**、**`dsh.compatibility` 为宽松下界且未声明 DSH peer（T2.7–T2.10）** |
| T3 | 凭据解析 | connect 桥、双 variant store 枚举 |
| T4 | 区域切换 | config 优先于 env，`china`→`cn` 归一化 |
| T5 | 真实搜索 | 仅在有凭据时跑；sources 非空、综述非空、`<selected-refs>` 已清。**降级判据**：错误为 `electron-binary-unavailable`（本机装在自选路径/未装桌面端）→ `WARN` 跳过；`decryption-failed` 等真实缺陷 → `FAIL` |
| T6 | 纯函数 | `extractSources` / `cleanSynthesis` / `parseWorkBuddyAuth` / `regionOf` / `chatBase`；`cleanSynthesis` 必须是**全函数**（T6.11：非字符串输入返回空串，不得抛原生 TypeError） |
| T7 | 错误路径 | 空 query 报错码、`available()` 返回布尔、abort 码 |
| T8 | 边界 | 重复导入、`__internals` 齐全、候选路径含国际版 |
| T9 | 零依赖自足 | 三个自带模块可独立加载、只依赖 `node:` 与相对路径、AES 往返；**key helper 的绑定契约（T9.15/T9.16 源码断言：必须是 `_linkedBinding("electron_browser_workbuddy_storage").loggerGet()`）**、真实载荷形状兼容（T9.17/T9.18）、**provider id 冲突的可操作报错（T9.19/T9.20/T9.21：带冲突 id + 给出排查步骤 + 不点名任何具体插件）** |
| T10 | 平台覆盖 | win32/darwin 候选路径、cpu 约束、**Windows 安装根有界扫描（T10.13–T10.23）**、真实二进制探测（T10.24，仅 win32）、**卸载注册表发现（T10.25–T10.32：`DisplayIcon` 三形态、只取三个值名、单候选命中、多候选报歧义、布局校验拦截、产品形状互不匹配、按进程只查一轮、env 优先于注册表）**、**macOS Spotlight 发现（T10.33–T10.48：`mdfind`/`plutil` 绝对路径调用、bundle id 身份校验、缺 `Contents/MacOS/Electron` 与不可执行均被拒、多候选报歧义、索引重复行与软链接去重、两版 bundle id 互不匹配、非法入参不抛、查询只跑一轮、查询失败不缓存、env 优先于 Spotlight、`macosDiscovery:false` 跳过、win32 不触碰该链、静态接线断言）** |
| T11 | 区域绑定 | 凭据形态识别（absent/plain/encrypted）、`auto` 选定规则、显式指定的强约束、**绑定粘性**、跨版凭据拒绝（`WB_SEARCH_CREDENTIAL_REGION_MISMATCH`）、`available()` 只看绑定那一版，以及「不跨版回落」的源码级断言 |
| T12 | 来源提取的中英文边界 | **汉字/假名/谚文作为裸链定界符（T12.1–T12.3）**、markdown 链接保留非 ASCII 路径与 IDN/IPv6（T12.4/T12.4d）、**成对括号保留（T12.4e：`.../Foo_(bar)` 不被截断）、括号配对判断（T12.4f）、括号包裹的裸链不被丢弃（T12.4g）**、**刻意取舍的护栏（T12.4b/T12.4c：裸链中文路径截短、裸链 IDN/IPv6 取不到 —— 钉住它们，防止有人「顺手修好」而把中文吞并引回来）**、反引号与 markdown 强调记号剥离（T12.5/T12.6）、英文 URL 含 query/fragment 不回归（T12.7/T12.8）、**`capped` 语义与边界（T12.9–T12.11、T12.13、T12.14：25 条→capped、恰好 20 条→不误报、markdown 占满时裸链被丢弃必须上报、markdown 优先不被挤掉）**、`truncated` 不硬编码的源码断言（T12.12）、**病态输入的线性复杂度（T12.15：6 万个未闭合 `[` 必须远低于 1s，防标题正则退化成 O(n²)）与上界不误伤真实链接（T12.16）** |
| T13 | 未知加密算法版本与凭据形态 | **`suite=1` 仍走正常解密（T13.1）**、`suite=2` 仍被识别为凭据文档而非「没凭据」（T13.2/T13.3）、畸形信封与「算法太新」分开报（T13.4）、错误码为 `WB_SEARCH_CREDENTIAL_UNSUPPORTED_FORMAT` 且文案明确否认「未登录」（T13.5–T13.7）、明文凭据不受影响（T13.8）、**混合形态：明文 `accessToken` + 未知格式 `refreshToken` 仍返回可用 token（T13.9）、明文 + **合法但解不开**的 suite-1 信封同样返回可用 token（T13.11，判据是「最终 accessToken 是否为空」而非「有没有解不开的东西」）、两个 token 都是未知信封时如实报格式不支持（T13.10）、损坏信封报 `WB_SEARCH_CREDENTIAL_MALFORMED` 且文案指向「重新登录」而非「升级插件」（T13.12/T13.13）** |
| T14 | 综述清理的复杂度与 `apply` 的错误码契约 | **`cleanSynthesis` 在未闭合 `<selected-refs>` 上必须是线性的（T14.1/T14.2：10 万个未闭合标签远低于 1.5s，且耗时随输入近似线性 —— 旧实现是 O(n²)，实测 88 秒并同步卡死宿主）**、清理边界九种形态（T14.3：成对/孤立/带属性/跨行/大小写混写都要清掉，普通文本含尖括号不得误伤）、真实综述正文逐字保留（T14.4）、**重复注册 provider 时翻译后的错误必须保留 `code` 与原始 `cause`、且带可操作排查步骤（T14.5/T14.6）** |

> **为什么 T9.15/T9.16 是源码断言而不是行为测试**：key helper 是**另一个进程**里跑的私有绑定调用，
> 本进程无法用自造密钥验证它。在真实 5.6.2 设备上实测发现，helper 曾把绑定名写成
> `workbuddyStorage`、并用 `process.binding` 而非 `process._linkedBinding` —— 结果恒报
> `No such module`，被静默降级成「解密失败」，**国际版加密凭据永远解不开**。
> 而 T9.5 的加解密往返用的是自造密钥，**完全测不出**这个问题。
> 教训：凡涉及外部进程 / 私有绑定的调用，必须有源码级契约断言或真机实测。

### 2.2 `tools/scenarios.mjs` — 异常路径 + 接管范围 + connect 降级 + 体系自检 + 维护者脚本（S1–S10，68 项）

被测对象：**插件目录**（源码态即可，因为全部离线）。**不需要凭据、不需要网络**，靠构造输入和打桩 `fetch` 实现。

| 组 | 覆盖 | 代表性 check |
|---|---|---|
| S1 | 空 / 空白 / 提前 abort | S1.2 纯空白查询**不得误发云端计费**；S1.3 abort 已触发则短路不发请求 |
| S2 | 网络 / 500 / 401 / 无 body | S2.2 错误信息**不得泄漏 accessToken**；S2.4 401 → `SESSION_DEAD`（可续期，不能当普通失败） |
| S3 | 流畸形 / 空流 | S3.1 无 done 帧 → `EMPTY_RESULT`（不静默返回空）；S3.2 done 帧坏 JSON → 降级为空结果而非崩溃；**S3.5 SSE 换行形态兼容（LF / CRLF / CR-only / 混合 / `data:` 后无空格 / 多行 data 拼接）；S3.6 `data` 拆在两个 chunk 仍拼回整帧；S3.7 非字符串 `synthesis.content`（数字/对象/数组/布尔）必须归因成 `UPSTREAM_ERROR` 而**不得漏出原生 TypeError**；S3.8 content 缺失/`null` 是合法空帧，仍走 `EMPTY_RESULT`（不得误报成协议违约）** |
| S4 | 凭据垃圾输入 | S4.1 六种垃圾输入均返回安全值；**S4.1b/S4.1c/S4.1d 未知加密算法版本的三条边界（仍算有凭据、明文 token 不被整体拒绝、两个都是未知信封时如实报 unsupported-suite）**；S4.4 无凭据时 `available()` 返回 `false` 而非抛 |
| S5 | 平台路径分层 + 跨平台模拟 | S5.1 env 覆盖排在 `credentialPaths()` 首位；S5.2 `desktopAuthFiles()` **刻意不含** env 覆盖 |
| S6 | 并发 / 10 万字符 / abort | S6.1 五路并发不串流；S6.3 abort 须在 1500ms 内返回 |
| S7 | **接管范围** | S7.2 源码中**不存在** `registerFetchProvider`（只管搜索）；S7.3 patch 里复述了 `fetchProvider: http` |
| S8 | **体系自检** | S8.1/S8.3 两份文档必须存在；S8.2 TESTING.md 必须同时引用 regression 与 scenarios 两个套件；S8.4 CI 必须已接线 |
| S9 | **装了 connect 但 connect 坏了** | S9.1/S9.3 connect 返回过期/空 token 时**不得采信**（否则会拿死 token 去搜索并报 401，且不回落到自带路径）；S9.4/S9.5 connect 抛错或包 import 失败时静默降级；S9.6/S9.7 `forceRefresh` 必须走自带路径的显式 refresh，不复用 connect 的旧 token |
| S10 | **维护者脚本**（发布 / 上架） | S10.1/S10.2/S10.3 `resolve_root` 的输出必须能被 node 的 `require` 解析，且不得是 MSYS 形态（`publish.sh` 的第一步就在这里崩过：Git Bash 的 `/d/...` 路径 node 认不出）；S10.4 端口探测**不得依赖 `nc`**（把 `nc` 覆盖成必定失败，仍要探到真实监听的端口）；S10.5 `CONNECT tunnel failed, response 502` 必须归类为「连不上」且不误判成缺凭据；S10.6 `submit-market.sh --dry-run` 必须**离线**完成（代理指向死端口仍返回 0）；S10.7 clone 失败时非零退出 + **回显 git 原始 stderr** + 归因为「连不上 GitHub」而不是「你没 fork」；S10.8 防回退（两个脚本都必须 source `contrib/lib.sh`，不得再回到裸 `ROOT="$PWD"`）；**S10.9/S10.10 git 静默挂起被超时杀掉（输出为空）时必须单独归因成「超时/连不上」，不得落到「见上方 git 输出」这个空兜底** |

> **S9 守的是「connect 只是可选增强」这句承诺的另一半。**
> 文档一直说「装了 connect 更好、不装也能用」，但「装了」和「装了且好用」是两回事：
> 一个坏掉的 connect 完全可能拖累功能。S9 在临时目录里伪造 connect 包（通过 `DSH_HOME` 让插件找到它）
> 来钉住这条边界，全程离线。
>
> ⚠️ **两个写这类测试时必须知道的坑**（都是实际踩到的）：
> 1. **每个子用例必须用独立的 `DSH_HOME`**。connect 模块按「解析出的绝对路径」被 ESM 缓存，
>    而插件里那句 `import("dsh-workbuddy-connect")` 不带查询串——复用同一个 `DSH_HOME`
>    会让后面几个用例拿到**第一个**假包（缓存命中），于是「通过」得毫无意义。
> 2. **回归测试必须用变异测试证明它有效**：把生产代码改回修复前的写法，看新用例是否变红。
>    上面第 1 条就是这样发现的——未加隔离前，S9.3/S9.5 在变异体上依然「通过」。
>    （顺便也确认了 S9.4/S9.5 属于「本来就对」的守护用例，而非回归用例，这点如实标注。）

> **S10 守的是「发布链本身」。** 其余各组都在测插件运行时，只有 S10 测**维护者手上的脚本**——
> 而这两个脚本恰好是唯一长期没有测试的一段，于是同时踩了两个相反的坑：一个在本机
> **一步都跑不动**（`ROOT="$PWD"` 的 MSYS 路径交给 node 的 `require()`），一个**永久挂死**
> （代理探测依赖 `nc`，而 Git Bash 自带的 PortableGit 没有 `nc` → 静默判定「没有代理」→
> 直连 GitHub；同时 clone 的 stderr 被 `2>/dev/null` 吞掉，连原因都看不到）。
>
> ⚠️ **这组用例刻意不写「断言源码文本」，而是断言行为**：全部用真实的 `bash` / `git` / `node`，
> 需要失败时就把 `DSH_GIT_PROXY` 指向一个必然不通的端口（`127.0.0.1:1`）——
> 于是既不依赖网络、也不需要任何桩，且「脚本真的尝试联网了没有」是可断言的：
> 代理不通时 `--dry-run` 仍返回 0，就证明它确实没联网。
> 唯一的例外是 S10.7，它是有意保留的文本断言，用来防止有人把 `resolve_root` 再改回 `$PWD`
> （行为断言只能证明「现在的实现是对的」，防不住回退）。
>
> 两个脚本共用的逻辑（根路径解析、代理探测、超时包装、失败归因）已抽到 `contrib/lib.sh`——
> **抽出来的唯一理由是让它可被测试**：留在脚本里就只能靠「跑一遍发布」来验。
>
> ⚠️ **S10 依赖「能起子进程」**。本机（Windows + 安全中心「命令安全」黑名单）出现过
> `spawnSync bash` 整批返回 `EBUSY` 的情形（`reg.exe` 被拦时连 `bash` 都起不来）。
> 这既不是通过也不是失败，因此套件启动时先探测一次：**探不通就把 S10 里需要执行 bash 的
> 用例全部标 SKIP**（单独计数、不算 FAIL 也不算 PASS，并说明这是环境限制），CI（Linux）上
> 照常真实执行。S10.8 是纯文本断言，不受影响。

> **S7 是本插件最容易被误解、也最容易在重构中被改坏的地方**：一旦有人「顺手」把抓取也接管了，S7.2/S7.3 会立刻红。
>
> **S8 保护的是「体系化」这件事本身**：如果哪天有人删了 `TESTING.md`、或把套件从 CI 里摘掉，S8 会立刻红——防止「又回到每次重新推演」的状态。

### 2.3 `tools/check-github-meta.mjs` — GitHub 元数据自检（G1–G9，40 项）

被测对象：**仓库根目录**。这一层不测插件运行时，而是测**仓库在 GitHub 上的"门面"是否齐备且格式合法**——
缺文件只会掉勾，但 **Issue 表单格式错会让 GitHub 整份拒收**，所以要钉住。

| 组 | 覆盖 | 判据 |
|---|---|---|
| G1 | 社区健康文件 5 份 | `README` / `LICENSE` / `SECURITY` / `CONTRIBUTING` / `CODE_OF_CONDUCT` |
| G2 | 模板文件 | PR 模板 + Bug/功能请求两份 Issue 模板 |
| G3 | Issue Forms 结构合法 | 必须有 `name`/`description`/`body`，且每个 body 项含 `type` |
| G4 | Dependabot 配置合法 | `version: 2` + `updates` + `package-ecosystem`/`directory`/`schedule`；且只盯 `github-actions` |
| G5 | CI 加固与接线 | 顶层 `permissions` 最小权限；已接线各套件与文档检查；**发布工作流的可信发布（OIDC）契约**：`id-token: write`、由 Release 触发、指向官方 registry、不得注入长期 token、长期 token 闸门须放过 `actions/setup-node` 的占位值、显式确认 OIDC 通道可用、发布前接线三套检查 |
| G6 | 占位符提示 | `<your-gh-user>` / `OWNER/REPO` / TODO 邮箱 —— **只 WARN，不阻断** |
| G7 | **发布面精简** | `CREDITS.md` 保持简短（≤6000 bytes）；`.local/` 被 gitignore（本地长文不进仓库） |
| G8 | **本机信息零泄露** | 遍历仓库所有文本文件，禁止出现本机路径 / 用户名 / 本机目录名（见下） |
| G9 | **时间信息分级** | 只留"基本时间信息"：日级 ISO 日期仅白名单允许，其余一律 FAIL（见下） |

> 设计成 **WARN 不阻断** 是刻意的：仓库还没建时占位符必然存在，不该因此让 CI 变红。

> ⚠️ **断言工作流文件时必须先剥掉整行注释。** 本仓库的 YAML 注释里会写
> `id-token: write`、`registry.npmjs.org` 这类字面量（解释「为什么必须这样写」），
> 直接对原文做正则会命中注释 → 检查变成恒真。这条是**变异测试抓出来的**：
> 删掉真正的 `id-token: write` 后 G5.6 仍报 PASS。现在 G5.6–G5.12 一律先在
> 去注释后的代码上断言，并用 `.local/mutate-publish.py`（G5.6–G5.10）与
> `.local/mutate-publish2.py`（G5.11–G5.12）验证过 7 条都对破坏敏感。

> ⚠️ **G5.11 是被一次真实事故逼出来的。** 「确认未注入长期 token」这道闸门最初写成
> 「`NODE_AUTH_TOKEN` 非空即失败」，但 `actions/setup-node` 只要给了 `registry-url`，
> 就会主动把该变量设成占位值 `XXXXX-XXXXX-XXXXX-XXXXX`（它自己的注释是
> *"Set the token to a dummy value to avoid errors"*，为的是让缺 token 的 `npm install` 不报错）。
> 于是**每次发布都在这一步误报失败**。教训：断言「环境里没有某凭据」时，
> 必须先弄清 CI 自己会不会塞无害的占位值。
>
> **G5.12** 是同一段里顺带加的：`id-token: write` 若失效，`npm publish` 只会报难懂的
> `ENEEDAUTH`；先在闸门里检查 `ACTIONS_ID_TOKEN_REQUEST_URL` 是否存在，把故障点前移。

**G8 是本仓库的硬红线**——本项目对外发布，任何文件都不允许出现机器相关信息：

| 子项 | 拦截内容 |
|---|---|
| G8.1 | Windows 用户目录绝对路径（`…\Users\<用户名>`） |
| G8.2 | 本机 dsh 版本目录命名（本机给 dsh 各副本起的版本目录名） |
| G8.3 | 本机环境目录名（本机副本的短标签，形如 `dshV` + 数字） |
| G8.4 | 本机工作区目录名 |
| G8.5 | 本机用户名（只允许 `arnen7000` 与 `arnen@126.com` 这两种已公开形式） |
| G8.6 | 任何盘符绝对路径（应改用 `<占位符>` 或 `%变量%`） |

扫描范围：仓库内全部文本文件，**跳过** `.git/`、`node_modules/`、`.local/`（本机信息唯一允许存放处）
与 `dist/` 等构建产物。`tools/check-github-meta.mjs` 自身因以正则字面量描述这些模式而自排除。

> 确属合成数据（例如测试夹具里的假路径）的行，可加 `g8-ignore: <理由>` 显式豁免，
> 豁免点在代码里可见、可评审——不要为了过检查而放宽整条规则。

**G9 时间信息分级**——对外仓库只留"基本时间信息"，不留开发/测试过程的日期：

| 级别 | 处置 |
|---|---|
| 文档版本头（`更新：2026-10`） | ✅ 保留，粒度到**月** |
| 客观事实日期（产品上线、端点取证） | ✅ 保留到日，但**必须**在白名单里登记理由 |
| 开发/测试日志日期（"某天在全新环境上踩到"） | ❌ FAIL，只留结论 |

| 子项 | 判据 |
|---|---|
| G9.1 | 日级 ISO 日期（`20xx-xx-xx`）只允许出现在 `ALLOWED_DATES` 白名单里 |
| G9.2 | 白名单里的日期必须仍被引用（防止白名单悄悄失效、长期无人维护） |

> 确属必要的事实日期，可在该行加 `g9-allow: <理由>` 豁免；但优先考虑把理由写进白名单，
> 这样全仓库共用一条、可集中评审。

**运行方式**

```bash
# 源码态（开发时）——套件接受插件目录，不要求已安装
node tools/scenarios.mjs   "<本插件目录>"
node tools/check-github-meta.mjs "<本插件目录>"

# 实体安装态（发布前，最接近用户现场）
node tools/regression.mjs  "<DSH_HOME>/profiles/web/node_modules/dsh-workbuddy-websearch"
node tools/scenarios.mjs   "<DSH_HOME>/profiles/web/node_modules/dsh-workbuddy-websearch"
```

退出码约定：**只有 `FAIL` 才非零退出**；`WARN`（多为无凭据环境下的跳过）不影响退出码，所以 CI 恒通过、本地无网也不误报。

---

## 3. 安装阶段的「手工核对清单」（无法自动化的少数几项）

安装阶段依赖真实 dsh 运行时，CI 跑不动，只能本地核对。**踩过的坑如下，逐条确认：**

| 检查项 | 命令 / 判据 | 历史事故 |
|---|---|---|
| **必须设 `DSH_HOME`** | `echo $DSH_HOME` 应为**你要操作的那一份 dsh** 的数据目录 | 曾因未设 `DSH_HOME`，误改了默认数据目录 `~/.dsh` 下的 profile |
| 插件行已挂载 | `dsh --profile web --dump-config \| grep web-workbuddy-websearch` | — |
| provider 已生效 | 同命令确认 `searchProvider: workbuddy-agentic` **且** `fetchProvider: http` | grep 上下文不足（`-A3`）曾导致误判「字段被丢」 |
| link 形态是否自动套 patch | `--dump-config` 看 `searchProvider` 是否仍是 `deepseek-official` | **0.1.5-rc.2 对 `link:` 形态不自动套 bundle patch**，需在 profile 的 `cordis.patch.yml` 里兜底 |
| 同版本号重装不生效 | 改版本号或清 `node_modules/.pnpm` 缓存 | pnpm 见版本未变会跳过（"Lockfile is up to date"） |
| 残留写锁 | 报 `atomic-write: timed out waiting for the writer lock` → 删 `package.json.lock` | 0.1.7-rc.1 曾遇 |

> 排查口诀：**「dump-config 一跑，配置行里没有 `workbuddy-agentic`，就一定是 patch 层没套上，与插件代码无关。」**

---

## 4. 发布回环（bug / 新需求进来时照此走）

用户报 bug 或提新需求时，**永远走同一条流水线**，不重新推演：

```
① 归类      ── 这条反馈属于场景地图(§1)的哪一段？
② 落用例    ── 先写一条会在旧代码上 FAIL 的 check，放进对应套件
               （正常路径→regression，异常路径→scenarios，维护者脚本→scenarios 的 S10）
③ 跑全套    ── node tools/regression.mjs ... && node tools/scenarios.mjs ...
               确认「新 check 红、老 check 全绿」（证明你复现了，且没顺手改坏别的）
④ 改代码    ── 只改到新 check 转绿
⑤ 再跑全套  ── 全绿
⑥ 文档同步  ── 错误码/新场景写进 COMPATIBILITY.md 的异常路径表(§9)与该场景专节
⑦ 版本 + 打包 ── package.json 版本号 + versionNote（repository/homepage/bugs 必须与仓库名一致），
               npm pack → dist/*.tgz
⑧ 发布      ── 建 tag（v<版本>）+ GitHub Release → `publish.yml` 自动经 OIDC 发布到 npm
               并在发布前重跑三套检查；tag 与 package.json 版本不一致会被工作流拒绝
⑨ CI 兜底   ── push / PR 自动跑，任何人改坏都会红
```

**这样做的收益**：第 ② 步写下的 check 会永久留在仓库里。下一次有人碰同一块代码，CI 立刻提醒——**不需要任何人再回忆「以前踩过这个坑」**。

---

## 5. 覆盖矩阵（新增测试时对照，避免重复劳动）

| 用户场景 | 正常路径 | 异常路径 | 自动化程度 |
|---|---|---|---|
| 装上即用、正常搜到结果 | T5 | — | 需凭据，本地 |
| 没登录就搜 | — | S4.4 + COMPATIBILITY §10 | ✅ 离线 |
| 空 / 空白 query | T7.1 | S1.1 / S1.2 | ✅ 离线 |
| 断网 / 上游 5xx | — | S2.1 / S2.3 | ✅ 离线（打桩） |
| 登录态过期（401） | — | S2.4 | ✅ 离线 |
| 流中断 / 坏 JSON | — | S3.1 / S3.2 | ✅ 离线 |
| 用户中途取消 | T7.3 | S1.3 / S6.3 | ✅ 离线 |
| 国内版 ↔ 国际版 | T3/T4/T6.8 | S5.3 | 部分需凭据 |
| 只搜不抓（接管范围） | — | S7.2 / S7.3 | ✅ 离线 |
| Windows / macOS 路径 | T10 | S5.3 / S5.5 | ✅ 离线（模拟） |
| **macOS 定位链**（Spotlight 工具缺失/抛错 / 平台隔离） | T10.33–T10.48 | S5.8 / S5.9 | ✅ 离线（合成夹具 + 注入执行器） |
| 无 connect 也能跑 | T9 | — | ✅ 离线 |
| **connect 装了但坏了**（返回死 token / 抛错 / 包坏） | — | S9.1–S9.7 | ✅ 离线（伪造 connect 包） |
| 超长 query / 并发 | T8.3 | S6.1 / S6.2 | ✅ 离线 |
| **综述清理的性能**（未闭合内部标记） | T14.1 / T14.2 | — | ✅ 离线 |
| **上游给了非字符串 `synthesis.content`** | — | S3.7 / S3.8 | ✅ 离线（打桩） |
| **provider id 被别的插件占用** | T14.5 / T14.6 | — | ✅ 离线 |
| **维护者脚本**（发布 / 上架在本机跑得动） | — | S10.1–S10.10 | ✅ 离线（真实 bash/git + 死代理 + 黑洞代理） |
| **测什么永远不丢**（体系自检） | — | S8.1–S8.4 | ✅ 离线 |
| **版本策略**（不锁上限、声明已验证版本） | T2.7–T2.10 | — | ✅ 离线 |
| **仓库门面**（社区档案/模板格式） | — | G1.1–G6.2 | ✅ 离线 |
| **发布面精简**（长文不外发） | — | G7.1–G7.3 | ✅ 离线 |

---

## 6. CI 现状

`.github/workflows/ci.yml`（push / PR / 手动触发，顶层 `permissions: contents: read`）：

1. `package.json` 基本校验；
2. `cordis.patch.yml` 存在且被 `dsh.bundle.patch` 引用；
3. `node --check lib/index.js`（ESM 语法）；
4. 入口 import 冒烟（`apply` / `name` / `inject`）；
5. **`tools/regression.mjs`**（回归套件）；
6. **`tools/scenarios.mjs`**（异常路径 / 接管范围 / 体系自检套件）；
7. 文档存在性检查（`TESTING.md` / `NORM-COMPLIANCE.md` 必须随版本走）；
8. **`tools/check-github-meta.mjs`**（社区档案 / 模板 / 工作流加固）；
9. `npm pack --dry-run`。

**后续可选增强**（尚未落地）：把 `--dump-config` 的检查做成一个 nightly job，用 `dsh` 快照镜像跑，从而把「安装阶段」也纳入自动化。目前该阶段仍是本地手工清单（§3）。

### 6.1 `publish.yml` — 发布工作流（可信发布 / OIDC）

`.github/workflows/publish.yml`（**Release 发布时**触发，也可手动触发；顶层 `permissions: contents: read` + `id-token: write`）：

1. **版本一致性闸门** —— Release tag（去掉 `v`）必须等于 `package.json` 的 `version`，否则直接拒绝发布。防的是「tag 写 0.4.0、实际发出去 0.3.9」这类不可逆错误；
2. **发布前跑三套检查** —— `regression.mjs` / `scenarios.mjs` / `check-github-meta.mjs`，任一失败即不发布；
3. **确认未注入长期 token 且 OIDC 通道可用** —— 断言 `NODE_AUTH_TOKEN` / `NPM_TOKEN` 都不是真实凭据（**但放过 `actions/setup-node` 自动写入的占位值 `XXXXX-XXXXX-XXXXX-XXXXX`**，见 §2.3 的说明），并确认 `ACTIONS_ID_TOKEN_REQUEST_URL` 存在，把 `id-token: write` 失效的故障点从 `npm publish` 的 `ENEEDAUTH` 前移到这一步；
4. `npm publish` —— 经 OIDC 换取短时发布令牌，自动生成 provenance 签名。

> **不需要任何 GitHub Secret。** 这是刻意的：长期 token 会过期、会泄露、需要轮换，而 OIDC 每次由 GitHub 现签。
> 代价是必须在 npmjs.com 的包设置里把本仓库登记为 Trusted Publisher（见 `GITHUB-SETUP.md`），且
> **`package.json` 的 `repository.url` 必须与仓库地址完全一致**——这是官方文档的硬要求，写错只会在发布时才报错。

> 上述 4 条契约都由 G5.6–G5.12 钉住，并由 `.local/mutate-publish.py`（G5.6–G5.10）与
> `.local/mutate-publish2.py`（G5.11–G5.12）验证过对破坏敏感。

平台定位那两组（Windows 注册表发现、macOS Spotlight 发现）同样做过变异测试：
`.local/mutate-macos.py` 注入 4 个「写错」的版本（去掉 bundle id 身份校验 / 去掉多命中报歧义 /
把查询失败也缓存 / darwin 平台守卫失效），断言 T10.35·T10.40 / T10.38 / T10.44 / T10.47
**确实变红**——即这几条护栏不是恒真。该脚本用 **Python 而非 Node** 起子进程：
本机环境下 Node 的 `spawnSync` 被拦（EBUSY），拿不到子进程输出。

**v0.3.5 新增的护栏**（T6.11、T14.1–T14.6、S3.7、S3.8、S10.1–S10.10）由 `.local/mutate-v035.mjs`
验证：注入 13 个「把修复回退」的变异体（`cleanSynthesis` 退回惰性正则 / 去掉全函数保护 /
`?? ""` 回归 / 翻译错误时丢掉 `code` / `resolve_root` 回到 `$PWD` / `port_open` 只靠 `nc` /
归因正则漏掉 `CONNECT tunnel failed` / `--dry-run` 不再提前返回 / 吞掉 clone 的 stderr /
`submit-market.sh` 不再 source `lib.sh` / 两个脚本各自去掉「超时」归因分支 /
`DEFAULT_BRANCH` 去掉 `|| true`），断言对应 check **确实变红**，并在结束时校验所有文件已逐字节还原。
（本机 Node 的 `spawnSync` 已恢复可用，故这次用 Node 写。）

> ⚠️ **这轮变异测试立刻抓出一条假护栏。** S10.1 最初写成「在当前目录下跑 `resolve_root`，
> 看输出能不能被 node 的 `require` 解析」—— 而 node 的 `spawnSync` 传 `cwd` 给 bash 时，
> bash 里的 `$PWD` 拿到的已经是 Windows 形态（`<盘符>:/...`），**真实 MSYS 形态只在 Git Bash
> 交互/脚本环境里出现**。于是把 `resolve_root` 改回 `$PWD` 后这条用例依然全绿。
> 现在改为「打桩 `cygpath` + 直接注入 MSYS 形态的 `$PWD`」，断言输出不得是 MSYS 形态 ——
> 跨平台可复现，且不绑定实现（换成 `sed` 之类的转换手段同样通过）。
> 教训：**「在测试环境里跑一遍」不等于「复现了用户现场」**；环境差异（这里是 shell 传给
> 子进程的 `$PWD` 形态）会让复现条件悄悄失效，而只有变异测试能把它照出来。

> ⚠️ **S10.9 又顺手抓出一个「静默中止」。** 为了让这条用例不依赖本仓库的工作区状态
> （`publish.sh` 有「工作区必须干净」的闸门），它在一个**临时副本**里跑脚本。副本是用
> `git init` 现造的，因此没有 `refs/remotes/origin/HEAD` —— 于是 `publish.sh` 里那句
> `DEFAULT_BRANCH="$(git symbolic-ref … | sed …)"` 在 `set -o pipefail` + `set -e` 之下
> 返回非零，**整个脚本一声不响地中止**（退出码 1、零输出）。这正是该脚本声称要避免的
> 「静默失败」，已改为 `|| true` + 回落 `main`。同类写法（读版本号、读 `origin` 推断
> 账号）也一并改成「带话退出」。
> 教训：**`set -e` + `$(管道)` 是静默中止的高发地** —— 只要管道里任何一环可能失败，
> 就必须显式处理，否则用户只看到退出码。

---

## 7. 相关文档

- `COMPATIBILITY.md` — 逐版本兼容性矩阵、异常路径实测表、两大高危用户场景。
- `NORM-COMPLIANCE.md` — 与 dsh 官方规范的符合性审计（源码级证据）。
- `GITHUB-SETUP.md` — GitHub 侧要求对照、社区档案清单、仓库设置清单。
- 本文 `TESTING.md` — 测试体系与发布回环。
