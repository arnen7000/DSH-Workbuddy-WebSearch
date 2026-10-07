# 安全政策（Security Policy）

本插件会**读取 WorkBuddy 桌面端的登录凭据**（`accessToken`）用于调用云端搜索服务。
因此我们特别重视凭据安全，也请你按下面的方式报告问题。

## 支持范围

| 版本 | 是否维护 |
|---|---|
| 最新 minor（当前 `0.2.x`） | ✅ 接受报告并修复 |
| 更早版本 | ⚠️ 建议先升级；仅在其仍为最新 patch 时处理 |

## 报告漏洞

**请不要用公开 Issue 报告安全问题。**

请通过以下任一私密渠道联系维护者：

- **GitHub 私密漏洞报告**（推荐）：仓库页面 → **Security** 标签 → **Report a vulnerability**
  （若该入口未开放，请用下一条）
- **邮箱**：`arnen@126.com`

请在报告中尽量包含：

- 受影响版本（`package.json` 的 `version`）
- 复现步骤（越具体越好）
- 影响范围（能否读到他人凭据？能否外发 token？能否越权调用？）
- 如有可能，附上最小复现脚本

我们会在 **7 天内**确认收到，并在修复发布后于 `CHANGELOG`/Release 说明中致谢（除非你要求匿名）。

## 设计上已经做到的防护（便于你判断"这算不算漏洞"）

- **只读凭据**：本插件**从不写入**凭据文件；token 续期只发生在内存里。
- **不外发凭据**：`accessToken` 只发往 WorkBuddy 官方网关（国内 `copilot.tencent.com` /
  国际 `www.workbuddy.ai`），不经过任何第三方。
- **不记录凭据**：错误信息与日志**不含** token（测试套件 `S2.2` 专门断言这一点，
  防止将来有人重构时把 token 带进报错文本）。
- **零第三方依赖**：无 `dependencies`，不存在供应链传递风险。

## 已知的、不算漏洞的行为

- **未登录时 `web_search` 会整体报错**（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`），
  且**不会**静默回退到其他搜索后端。这是 dsh 的 provider 选择语义决定的，属于预期行为，
  不是降级失败。详见 `README.md` 的「注意事项」。
- 本插件**不接管 `web_fetch`**（抓取仍走 dsh 内置直连 HTTP），因此抓取行为与本插件无关。

## 凭据泄露了怎么办

1. 在 WorkBuddy 桌面端**退出登录**（使 token 失效），必要时重新登录；
2. 若你怀疑是本插件的缺陷导致，请按上文私密渠道报告，并**先不要**粘贴真实 token。

---

参考：GitHub 官方安全政策指南
<https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/add-security-policy>
