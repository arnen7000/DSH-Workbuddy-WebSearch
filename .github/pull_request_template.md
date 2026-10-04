# PR 模板

## 这个 PR 做了什么

<!-- 一句话说明。若是修 bug，请写清"修前是什么现象、修后是什么现象"。 -->

## 关联 Issue

<!-- 例如 Closes #12。修 bug 的 PR 请务必关联，便于追溯。 -->

## 改动类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 文档
- [ ] 测试体系 / CI
- [ ] 重构（无行为变化）
- [ ] 其他：

## 检查清单（务必逐条确认）

- [ ] **我先加了会在旧代码上 FAIL 的 check**（复现问题），再改代码
      —— 正常路径放 `tools/regression.mjs`，异常路径放 `tools/scenarios.mjs`
- [ ] `node tools/regression.mjs "<已安装插件目录>"` 全绿（T1–T10）
- [ ] `node tools/scenarios.mjs "<插件目录>"` 全绿（S1–S9）
- [ ] 未把 `accessToken` 写进日志/错误信息/快照（红线，`S2.2` 会拦）
- [ ] 未新增 `registerFetchProvider`（红线，`S7.2` 会拦）
- [ ] `cordis.patch.yml` 仍复述 `fetchProvider: http`（红线，`S7.3` 会拦）
- [ ] 改了对外行为 → 已同步 `README.md` / `COMPATIBILITY.md`
- [ ] 改了测试体系 → 已同步 `TESTING.md`
- [ ] 已 bump `package.json` 的 `version`，并在 `versionNote` 写了变更摘要

## 验证方式

<!-- 你实际怎么验证的？贴命令与关键输出（记得脱敏）。 -->

```bash
node tools/regression.mjs "<已安装插件目录>"
node tools/scenarios.mjs  "<插件目录>"
```

## 风险 / 兼容性影响

<!-- 是否影响某些 dsh 版本？是否需要用户重装？是否需要 bump 版本号？ -->
