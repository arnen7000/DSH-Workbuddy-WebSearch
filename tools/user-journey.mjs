// 用户典型场景（user journey）验证 —— 走宿主同款入口，不测内部函数。
//
// 与 tools/regression.mjs 的区别：那份测「契约与边界」，这份按**用户实际使用顺序**
// 走一遍：装好 → 首次搜索 → 各种输入 → 上游异常 → 中断 → 并发 → 连续使用。
// 上游全部打桩，不需要真实凭据、不产生任何计费。
//
// 用法：
//   node tools/user-journey.mjs [插件目录]
// 不带参数时用仓库自身的 lib/（开发态）；也可以指向已安装的插件目录。
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.argv[2] ?? join(here, ".."));
const ENTRY = pathToFileURL(join(REPO, "lib", "index.js")).href;

let pass = 0;
const fails = [];
const check = (id, ok, desc, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${id}  ${desc}`);
  } else {
    fails.push(id);
    console.log(`  FAIL  ${id}  ${desc}${detail ? `  → ${detail}` : ""}`);
  }
};

// ---------- 夹具：一个「已登录」的凭据文件 ----------
const work = mkdtempSync(join(tmpdir(), "wb-journey-"));
const authOk = join(work, "auth-cn.json");
writeFileSync(
  authOk,
  JSON.stringify({ accessToken: "tok-fixture-123", refreshToken: "rt-fixture", expiresAt: 4102444800 }),
);
const authEmpty = join(work, "auth-empty.json");
writeFileSync(authEmpty, JSON.stringify({ accessToken: "", refreshToken: "" }));

function setEnv({ auth = authOk, region = "cn" } = {}) {
  process.env.WORKBUDDY_SEARCH_REGION = region;
  process.env.WORKBUDDY_AUTH_FILE = auth;
  process.env.WORKBUDDY_AI_AUTH_FILE = auth;
  // 指向不存在的 Electron：让「加密凭据」路径必然走不通，避免读到真机状态
  process.env.WORKBUDDY_ELECTRON_BIN = join(work, "no-such-electron.exe");
  process.env.WORKBUDDY_AI_ELECTRON_BIN = join(work, "no-such-electron.exe");
  process.env.WORKBUDDY_SEARCH_ENDPOINT = "https://fixture.invalid";
}

/** 每次调用都拿到一个全新的模块实例（模块级缓存不复用）。 */
let importSeq = 0;
async function loadPlugin() {
  importSeq += 1;
  return import(`${ENTRY}?journey=${importSeq}`);
}

// ---------- 打桩 fetch ----------
let fetchCalls = 0;
let handler = null;
function sseStream(content) {
  const frame = `event: done\ndata: ${JSON.stringify({ synthesis: { content } })}\n\n`;
  const bytes = new TextEncoder().encode(frame);
  let sent = false;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: async () => {},
      }),
    },
    text: async () => frame,
  };
}
function plainResponse(status, statusText, body) {
  return { ok: false, status, statusText, body: null, text: async () => body };
}
globalThis.fetch = async (url, init) => {
  fetchCalls += 1;
  return handler(url, init);
};

const SUMMARY = (tag) =>
  `这是 ${tag} 的综述正文。要点一 [1](https://example.com/${tag}/a) ，要点二 [2](https://example.org/${tag}/b) ，` +
  `另见裸链 https://example.net/${tag}/c 。<selected-refs>{"id":1,"url":"https://should-be-stripped.example"}</selected-refs>`;

/** 每次拿一个全新模块实例 + 全新 provider（避免上一场景的凭据缓存干扰）。 */
async function makeProvider() {
  const mod = await loadPlugin();
  const registered = [];
  const ctx = { config: {}, root: work, web: { registerSearchProvider: (p) => registered.push(p) } };
  await mod.apply(ctx);
  return { mod, provider: registered[0] };
}

const isRefreshCall = (url) => String(url).includes("/v2/plugin/auth/token/refresh");
function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    body: null,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

// ---------- 场景 ----------
console.log("\n【A】安装后能否被宿主加载");
{
  setEnv();
  const mod = await loadPlugin();
  const registered = [];
  const ctx = {
    config: {},
    root: work,
    web: { registerSearchProvider: (p) => registered.push(p) },
  };
  let applyError = null;
  try {
    await mod.apply(ctx);
  } catch (error) {
    applyError = error;
  }
  check("U1", applyError === null, "apply() 不抛错", applyError && String(applyError));
  check("U2", registered.length === 1, "向 ctx.web 注册且只注册 1 个 provider", `实际 ${registered.length}`);
  const provider = registered[0];
  check("U3", provider?.id === "workbuddy-agentic", "provider id 稳定（用户配置依赖它）", provider?.id);
  check("U4", typeof provider?.search === "function", "provider 暴露 search()");
  let avail;
  let availThrew = false;
  try {
    avail = provider.available();
  } catch {
    availThrew = true;
  }
  check("U5", !availThrew && typeof avail === "boolean", "available() 返回布尔且不抛", String(avail));

  console.log("\n【B】用户第一次搜索（最常见的路径）");
  handler = async () => sseStream(SUMMARY("first"));
  fetchCalls = 0;
  let result;
  let searchError = null;
  try {
    result = await provider.search({ query: "deepseek harness 是什么" }, undefined);
  } catch (error) {
    searchError = error;
  }
  check("U6", searchError === null, "普通查询成功返回", searchError && `${searchError.code} ${searchError.message}`);
  check("U7", typeof result?.content === "string" && result.content.includes("first"), "返回综述正文");
  check("U8", Array.isArray(result?.sources) && result.sources.length >= 3, "提取到 ≥3 条来源", `实际 ${result?.sources?.length}`);
  check(
    "U9",
    (result?.sources ?? []).every((s) => /^https?:\/\//.test(s.url)),
    "每条来源都是可打开的 http(s) 链接",
  );
  check(
    "U10",
    !(result?.content ?? "").includes("should-be-stripped"),
    "正文里不残留 <selected-refs> 内部数据",
  );
  check("U11", result?.truncated === false, "来源未被截断时 truncated=false", String(result?.truncated));
  check(
    "U12",
    (result?.sources ?? []).some((s) => s.title !== undefined),
    "markdown 链接带出了标题",
  );

  console.log("\n【C】用户输入不合法（不该白花一次检索）");
  for (const [id, q, desc] of [
    ["U13", "", "空查询"],
    ["U14", "   \n\t ", "纯空白查询"],
  ]) {
    fetchCalls = 0;
    let err = null;
    try {
      await provider.search({ query: q }, undefined);
    } catch (error) {
      err = error;
    }
    check(id, err !== null && typeof err.code === "string", `${desc}被拒且带 code`, err ? String(err.code) : "未抛错");
    check(`${id}b`, fetchCalls === 0, `${desc}不发起网络请求（不浪费计费）`, `fetch 被调用 ${fetchCalls} 次`);
  }

  console.log("\n【D】上游出问题（用户看到什么）");
  const upstream = [
    ["U15", () => plainResponse(500, "Internal Server Error", "boom"), "WB_SEARCH_UPSTREAM_ERROR", "上游 500"],
    ["U17", () => sseStream(""), "WB_SEARCH_EMPTY_RESULT", "流里没有综述内容"],
  ];
  for (const [id, make, expected, desc] of upstream) {
    handler = async () => make();
    let err = null;
    try {
      await provider.search({ query: "上游异常" }, undefined);
    } catch (error) {
      err = error;
    }
    check(id, err?.code === expected, `${desc} → ${expected}`, err ? String(err.code) : "未抛错");
    check(`${id}b`, !(err instanceof TypeError), `${desc} 不会逃逸成原生 TypeError`);
  }

  console.log("\n【D2】登录态过期（最常见的真实故障：自动续期 vs 需要重登）");
  {
    // ① 续期成功 → 重试一次 → 用户无感
    {
      setEnv();
      const { provider: p } = await makeProvider();
      let searchHits = 0;
      handler = async (url) => {
        if (isRefreshCall(url)) {
          return jsonResponse(200, { code: 0, data: { accessToken: "tok-renewed", refreshToken: "rt2", expiresAt: 4102444800 } });
        }
        searchHits += 1;
        if (searchHits === 1) return plainResponse(401, "Unauthorized", "Offline user session not found");
        return sseStream(SUMMARY("renewed"));
      };
      let out = null;
      let err = null;
      try {
        out = await p.search({ query: "续期后重试" }, undefined);
      } catch (error) {
        err = error;
      }
      check("U16a", err === null && out?.content?.includes("renewed"), "401 → 自动续期 → 重试成功（用户无感）", err ? String(err.code) : "未重试");
      check("U16a2", searchHits === 2, "确实重试了一次（不是直接失败）", `search 被调用 ${searchHits} 次`);
    }
    // ② 续期被拒 → 明确要求重新登录
    {
      setEnv();
      const { provider: p } = await makeProvider();
      handler = async (url) => {
        if (isRefreshCall(url)) return jsonResponse(401, { code: 401, msg: "invalid refresh token" });
        return plainResponse(401, "Unauthorized", "Offline user session not found");
      };
      let err = null;
      try {
        await p.search({ query: "续期也失败" }, undefined);
      } catch (error) {
        err = error;
      }
      check("U16b", err?.code === "WB_SEARCH_SESSION_DEAD", "续期也被拒 → SESSION_DEAD（提示重登）", String(err?.code));
      check("U16b2", /sign in|登录/i.test(String(err?.message)), "错误信息提示用户去重新登录", String(err?.message).slice(0, 60));
    }
    // ③ 续期返回非 JSON → 不崩，给可分类错误
    {
      setEnv();
      const { provider: p } = await makeProvider();
      handler = async (url) => {
        if (isRefreshCall(url)) return plainResponse(200, "OK", "<html>gateway</html>");
        return plainResponse(401, "Unauthorized", "Offline user session not found");
      };
      let err = null;
      try {
        await p.search({ query: "续期返回垃圾" }, undefined);
      } catch (error) {
        err = error;
      }
      check("U16c", err?.code === "WB_SEARCH_REFRESH_FAILED", "续期返回非 JSON → REFRESH_FAILED（不崩）", String(err?.code));
      check("U16c2", !(err instanceof TypeError), "且不是原生 TypeError");
    }
  }

  console.log("\n【E】上游协议违约（不该被误报成「没结果」）");
  {
    const frame = `event: done\ndata: ${JSON.stringify({ synthesis: { content: { bad: true } } })}\n\n`;
    handler = async () => {
      const bytes = new TextEncoder().encode(frame);
      let sent = false;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: {
          getReader: () => ({
            read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
            cancel: async () => {},
          }),
        },
        text: async () => frame,
      };
    };
    let err = null;
    try {
      await provider.search({ query: "协议违约" }, undefined);
    } catch (error) {
      err = error;
    }
    check("U18", err?.code === "WB_SEARCH_UPSTREAM_ERROR", "content 不是字符串 → 上游协议错误", String(err?.code));
    check("U19", !(err instanceof TypeError), "且不是原生 TypeError（宿主能按 code 分类）");
  }

  console.log("\n【F】用户中断（点停止）");
  {
    fetchCalls = 0;
    const controller = new AbortController();
    controller.abort();
    let err = null;
    try {
      await provider.search({ query: "会被中断" }, controller.signal);
    } catch (error) {
      err = error;
    }
    check("U20", err?.code === "WEB_ABORTED", "已中止的 signal → WEB_ABORTED", String(err?.code));
    check("U21", fetchCalls === 0, "且不发请求（中止语义在入口就生效）", `fetch ${fetchCalls} 次`);
  }

  console.log("\n【G】并发与连续使用（多轮对话的常态）");
  {
    handler = async (url, init) => {
      const body = JSON.parse(init.body);
      await new Promise((r) => setTimeout(r, 10));
      return sseStream(SUMMARY(body.query));
    };
    const queries = ["甲", "乙", "丙"];
    const results = await Promise.all(queries.map((q) => provider.search({ query: q }, undefined)));
    check(
      "U22",
      results.every((r, i) => r.content.includes(queries[i])),
      "3 路并发各自拿到自己的结果（无串流）",
      results.map((r) => r.content.slice(0, 6)).join(" | "),
    );
    const again = await provider.search({ query: "第二轮" }, undefined);
    check("U23", again.content.includes("第二轮"), "同一会话连续搜索正常（无状态污染）");
  }

  console.log("\n【H】极端输入（不该卡死宿主）");
  {
    handler = async () => sseStream(`正文${"<selected-refs>".repeat(100000)}尾巴`);
    const t0 = Date.now();
    let err = null;
    let out;
    try {
      out = await provider.search({ query: "10 万个未闭合标签" }, undefined);
    } catch (error) {
      err = error;
    }
    const ms = Date.now() - t0;
    check("U24", err === null || typeof err.code === "string", "极端输入不抛原生异常", err && String(err.code));
    check("U25", ms < 2000, "10 万个未闭合标签在 2 秒内完成（线性实现）", `${ms}ms`);
    check("U26", err !== null || out.content.length < 200, "内部标记未堆积进正文", String(out?.content?.length));
  }

  console.log("\n【I】来源上限（用户请求更多也不该爆）");
  {
    const many = Array.from({ length: 40 }, (_, i) => `[${i}](https://many.example/${i})`).join(" ");
    handler = async () => sseStream(`很多来源 ${many}`);
    const out = await provider.search({ query: "很多来源" }, undefined);
    check("U27", out.sources.length <= 20, "来源数不超过上限 20", `实际 ${out.sources.length}`);
    check("U28", out.truncated === true, "被上限截断时 truncated=true（前端提示依赖它）", String(out.truncated));
  }
}

console.log("\n【J】用户没登录 WorkBuddy");
{
  setEnv({ auth: authEmpty });
  const { mod, provider } = await makeProvider();
  const I = mod.__internals;
  const variant = I.variantByRegion("cn");

  // ⚠️ 已知限制（指南 §10.3 的实证）：注入 env **屏蔽不掉**真实 homedir()/LOCALAPPDATA。
  // 本机已登录 WorkBuddy，所以「空 token 夹具」会回落到真实凭据 → 无法通过公开入口
  // 模拟「未登录」。这里改用代码里预留的注入口子 candidates 直接验凭据层。
  //
  // 两种「没登录」形态都要验：
  //   a) 候选列表为空        —— 平台不支持 / 全部探测失败
  //   b) 候选路径都不存在    —— 最常见的真实情况（用户没装桌面端 / 没登录过）
  const probe = async (candidates) => {
    try {
      return { value: await I.resolveCredentialForVariant({ variant, candidates }) };
    } catch (error) {
      return { threw: true, value: error };
    }
  };
  const a = await probe([]);
  const b = await probe([join(tmpdir(), "no-such-auth-" + Date.now() + ".json")]);
  check("U29", a.threw !== true && a.value === undefined, "候选为空时安全返回 undefined（不抛）", a.threw ? "抛错" : String(a.value));
  check(
    "U29a",
    b.threw !== true && b.value === undefined,
    "候选路径都不存在（没装桌面端/没登录过）时安全返回 undefined（不抛）",
    b.threw ? "抛错" : String(b.value),
  );

  const realPaths = I.credentialPathsForVariant(variant) ?? [];
  check(
    "U29b",
    realPaths.length > 0,
    "记录事实：本机存在真实凭据路径 → 该场景必须用注入口子，不能用 env 隔离",
    `候选 ${realPaths.length} 条`,
  );

  let err = null;
  try {
    await provider.search({ query: "没登录" }, undefined);
  } catch (error) {
    err = error;
  }
  check("U30", err === null || !String(err.message).includes("tok-fixture"), "错误信息不泄露凭据内容");
  check(
    "U31",
    err === null || /WORKBUDDY|登录|region|凭据/.test(String(err.message)),
    "错误信息里有可操作的指引（不是只说「不可用」）",
    err ? String(err.message).slice(0, 80) : "（本机有真实凭据，search 走通，此断言不适用）",
  );
}

console.log(`\n${"=".repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fails.length}${fails.length ? `   → ${fails.join(", ")}` : ""}`);
process.exit(fails.length === 0 ? 0 : 1);
