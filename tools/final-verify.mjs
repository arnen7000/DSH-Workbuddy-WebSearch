/**
 * 端到端自检（final-verify.mjs）
 * ---------------------------------------------------------------------------
 * 验证「凭据解析 → 真实调用云端 agentic 搜索」这条完整链路。
 *
 * ⚠️ 本插件是**零硬依赖**的：不装 dsh-workbuddy-connect 也必须能跑。
 * 因此这里必须走**统一入口** `resolveCredential()`（先试 connect，失败则回落自带实现），
 * **不能**直接调 `resolveViaConnect()`——那只走 connect 那一条腿，未装 connect 时会拿到
 * undefined 并让后续 chatBase() 崩掉（在一个全新未使用过的 dsh 环境上实测到的真实问题）。
 *
 * 用法：
 *   node final-verify.mjs
 * 可选环境变量：
 *   WORKBUDDY_SEARCH_REGION=global|cn
 *   WORKBUDDY_AI_ELECTRON_BIN / WORKBUDDY_ELECTRON_BIN
 *   WORKBUDDY_AUTH_FILE / WORKBUDDY_AI_AUTH_FILE
 */
import { __internals } from "../lib/index.js";

const say = (k, v) => console.log(`${k.padEnd(16)}=`, v);

say("AI_ELECTRON_BIN", process.env.WORKBUDDY_AI_ELECTRON_BIN ?? "(未设)");
say("SEARCH_REGION", process.env.WORKBUDDY_SEARCH_REGION ?? "(未设)");
say("preferredRegion", __internals.preferredRegion());

// 统一入口：connect 可用则复用，否则回落自带实现（零硬依赖的关键）。
const cred = await __internals.resolveCredential();

if (cred === undefined) {
  console.error("\n❌ 未解析到凭据。可能原因：WorkBuddy 桌面端未登录、凭据格式不认识，");
  console.error("   或加密凭据需要指定 Electron 二进制（WORKBUDDY_AI_ELECTRON_BIN）。");
  console.error("   排查：确认桌面端已登录；加密凭据（5.6+）需能定位 App 的 Electron。");
  process.exit(1);
}

say("source", __internals.getLastCredentialSource?.() ?? "(未知)");
say("variant", cred.variant?.id);
say("region", cred.variant?.region);
say("domain", cred.domain);
say("token 长度", (cred.accessToken ?? "").length);
say("chatBase", __internals.chatBase(cred));

console.log("\n发起真实搜索 …");
const r = await __internals.callAgenticSearch(cred, "DeepSeek Harness 是什么", undefined);
say("sources", r.sources.length);
say("contentLen", (r.content ?? "").length);
console.log("\n✅ SEARCH OK");
