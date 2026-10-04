# 致谢与借鉴声明（Credits & Attribution）

本插件以 **MIT** 发布，构建在他人的成果之上。此处如实列出主要来源与许可。
**逐处的实现级对照说明（含具体借鉴了哪段算法、我们改了什么）保留在源码注释中**——
每一处对齐都在对应代码里就地标注了来源。

> 原则：**能引用就引用，不能引用就重写，重写必标注来源。**

## 主要来源

| 项目 | 作者 | 许可证 | 与本插件的关系 |
|---|---|---|---|
| **`dsh-workbuddy-connect`** | **Corrine Hu**（npm `corrinehu`） | **MIT, Copyright (c) 2026 Corrine Hu** | **最重要的借鉴来源**。桌面端凭据读取路径、`$wbEncrypted` 信封解密（密钥派生 / AAD 构造 / 载荷校验）、平台候选路径与 Electron 定位策略、环境变量命名约定，均以其实现为参考并对齐。在本插件中作为**可选增强**（非前置）。 |
| **`@deepseek-ai/dsh-web`** | DeepSeek | MIT | **契约级依赖**。通过其 `ctx.web.registerSearchProvider()` 接缝注册搜索能力。非源码借鉴。 |
| **`@deepseek-ai/dsh-home-paths`** | DeepSeek | MIT | 解析 `DSH_HOME`；不可用时回退环境变量与默认值。 |
| **`dsh-better-sidebar`** | `omdsh-dev` | MIT | **仅工程方法**：`package.json` 平台约束写法、兼容矩阵的组织方式。**未复制任何代码。** |

## 端点与协议取证

搜索端点与请求形状取自 **WorkBuddy 官方桌面 App** 的 `app.asar`（本插件**不打包、不修改**该 App 的任何代码）。
相关权利归 **腾讯 / WorkBuddy** 所有；本插件只是使用其登录态与公开接口，不声称对任何端点或协议拥有权利。

## 本项目的原创部分

WorkBuddy agentic 搜索接入 dsh `web_search` 接缝的 provider 实现、SSE 帧解析与综述来源提取、
`<selected-refs>` 清理、token 内存续期与「会话已死 → 续期重试」流程、abort 语义处理、
零依赖自足架构（`platform.mjs` / `decrypt.mjs` / `credentials.mjs` 三模块拆分）、区域切换与配置优先级设计。

## 如果我们是错的

若你是上述项目的作者，认为某处标注不足、使用方式不当，或不希望被以这种方式参考，
请提 Issue 或直接联系。我们会**在下一次发布中补正标注**，或**按你的要求移除/重写相应实现**。

**尊重原创不是一句口号——是可以被指出、并且必须被改正的具体行为。**

---

本插件以 **MIT License** 发布，`Copyright (c) 2026 XingLang & WorkBuddy (小研)`。
MIT 与上述所有来源的许可证（均为 MIT）兼容；按 MIT 要求，我们保留了来源与版权声明。
