# 贡献指南（Contributing）

感谢愿意帮忙。本插件体量不大，但有一套已经成型的**测试体系**，照着走就能又快又稳地改对。

## 最短上手路径

1. 读 **[README.md](./README.md)** — 搞清插件做什么、边界在哪（尤其"只管搜索、不管抓取"）。
2. 读 **[TESTING.md](./TESTING.md)** — **这是最重要的一份**。它给出场景地图与两层测试套件，
   改代码前先看它，能避免"重新推演要测什么"。
3. 读 **[DEVELOPING.md](./DEVELOPING.md)** — 本机联调环境（junction 挂载、`--dump-config` 核验）。
4. 想动某个具体行为前，看 **[COMPATIBILITY.md](./COMPATIBILITY.md)** — 里面记着各 dsh 版本的实测差异与踩过的坑。

## 开发流程（务必遵循）

```bash
# 1. 先跑一遍现有测试，确认基线是绿的
node tools/regression.mjs "<已安装插件目录>"   # T1–T11 正常路径 + 契约
node tools/scenarios.mjs  "<插件目录>"          # S1–S9 异常路径 + 接管范围 + 体系自检

# 2. 改代码前：先加一条会在旧代码上 FAIL 的 check（复现问题）
#    —— 正常路径放 regression.mjs，异常路径放 scenarios.mjs

# 3. 改代码，只改到新 check 转绿

# 4. 再跑全套，确认"新 check 绿、老 check 全绿"（没顺手改坏别的）
```

> **原则：场景先行，用例落地。** 任何新场景，如果不能写成一条 `check(...)`，就说明它还是"感觉"，不是"测试"。

## 提交规范

- 一个 PR 只做一件事。**修 bug 的 PR 请附上复现步骤**，最好带一条新增的 check。
- 提交信息用祈使句，说明"做了什么"与"为什么"，例如：
  `fix: 空查询不再误发云端（S1.2）`。
- **必须**保证两层套件全绿；CI 会在 push/PR 上自动跑。
- 改了对外行为 → 同步更新 `README.md` / `COMPATIBILITY.md`；改了测试体系 → 同步 `TESTING.md`。
- 改了行为就要 **bump `package.json` 的 `version`** 并在 `versionNote` 里写一行变更摘要。

## 不能碰的红线

- **不要**把 `accessToken` 写进日志、错误信息或测试快照（`S2.2` 会拦）。
- **不要**给本插件增加 `registerFetchProvider`（`S7.2` 会拦）——它只接管搜索。
- **不要**移除 `cordis.patch.yml` 里复述的 `fetchProvider: http`（`S7.3` 会拦）——
  dsh 的 patch 是整行替换而非合并，删了会静默丢字段。
- **不要**为"看起来更符合规范"而给 `@deepseek-ai/dsh*` 加 `peerDependencies`——
  官方兼容性校验只认该命名空间，不声明才是永不被拒装的最稳选择（详见 `NORM-COMPLIANCE.md`）。

## 报告 Bug / 提需求

请用仓库的 **Issue 模板**（Bug 报告 / 功能请求），模板会把必要信息（dsh 版本、平台、
是否已登录、错误码）一次问全，省去来回。

**安全问题请勿走公开 Issue**，见 **[SECURITY.md](./SECURITY.md)**。

## 行为准则

参与本项目即表示你同意遵守 **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)**。
