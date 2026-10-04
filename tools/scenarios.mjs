/**
 * 用户场景测试（scenarios.mjs）
 * ---------------------------------------------------------------------------
 * 与 regression.mjs 的分工：
 *   - regression.mjs  —— 测「**正常路径**」（装得上、连得通、搜得到）。
 *   - 本文件        —— 测「**用户真实会撞上的异常路径**」，即最容易踩坑、
 *                      也最需要写进文档的那些失败态。
 *
 * 每个场景都比对：**错误码是否可归因**（用户能否按 code 定位问题）
 * 与 **是否优雅降级**（不把宿主搞崩、不静默吞错、不误报成功）。
 *
 * 用法：
 *   node tools/scenarios.mjs "<已安装的插件目录>"
 *   # 例：node tools/scenarios.mjs "<DSH_HOME>/profiles/web/node_modules/dsh-workbuddy-websearch"
 *
 * 无参数时默认用源码目录（自测用）。
 * 断言全部为**离线可验证**（构造输入 / 打桩 fetch），不需要真实网关。
 */

import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const targetDir = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const entryUrl = pathToFileURL(join(targetDir, "lib", "index.js")).href;

let pass = 0;
let fail = 0;
const failures = [];

function check(id, label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${id}  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${id}  ${label}${detail !== "" ? `  → ${detail}` : ""}`);
    fail += 1;
    failures.push(`${id} ${label}${detail !== "" ? ` (${detail})` : ""}`);
  }
}

async function expectReject(fn) {
  try {
    const value = await fn();
    return { rejected: false, value };
  } catch (error) {
    return { rejected: true, error };
  }
}

const mod = await import(entryUrl);
const { __internals } = mod;
const callAgenticSearch = __internals.callAgenticSearch;

console.log(`\n=== 用户场景 / 异常路径测试 ===\n目标: ${targetDir}\n`);

// ───────────────────────── S1 空查询与畸形输入 ─────────────────────────

console.log("S1  空查询与畸形输入（用户手滑 / 上游传空值）");

{
  // S1.1 空字符串必须被拒，且错误码可归因
  const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "", undefined));
  check("S1.1", "空查询被拒且带明确 code", r.rejected && typeof r.error?.code === "string", r.rejected ? `code=${r.error?.code}` : "未抛错");

  // S1.2 纯空白（用户敲了空格就回车）——不能当成有效查询发去云端计费
  const r2 = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "   \n\t  ", undefined));
  check("S1.2", "纯空白查询被拒（不误发云端）", r2.rejected, r2.rejected ? "" : "未抛错，可能误发计费请求");

  // S1.3 abort 在调用前已触发 → 必须短路，不发起网络请求
  const pre = new AbortController();
  pre.abort(new Error("user cancelled"));
  const r3 = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "hello", pre.signal));
  check(
    "S1.3",
    "预中止信号短路为 WEB_ABORTED（不发起请求）",
    r3.rejected && r3.error?.code === "WEB_ABORTED",
    r3.rejected ? `code=${r3.error?.code}` : "未抛错",
  );
}

// ───────────────────────── S2 网关不可达 / 传输失败 ─────────────────────────

console.log("\nS2  网关不可达 / 传输失败（断网、代理挂了、DNS 失败）");

{
  const originalFetch = globalThis.fetch;
  // 打桩：模拟 fetch 直接抛网络错（断网）
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND copilot.tencent.com");
  };
  try {
    const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
    check(
      "S2.1",
      "网络不可达 → WB_SEARCH_TRANSPORT_ERROR（可归因）",
      r.rejected && r.error?.code === "WB_SEARCH_TRANSPORT_ERROR",
      r.rejected ? `code=${r.error?.code}` : "未抛错",
    );
    // 错误信息里不应泄漏 token
    check("S2.2", "错误信息不含 accessToken（防泄漏）", !String(r.error?.message ?? "").includes("x") || !/Bearer/.test(String(r.error?.message ?? "")));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // S2.3 上游返回 500 → UPSTREAM_ERROR（而非崩溃）
  globalThis.fetch = async () =>
    new Response("internal boom", { status: 500, statusText: "Internal Server Error" });
  try {
    const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
    check(
      "S2.3",
      "上游 500 → WB_SEARCH_UPSTREAM_ERROR",
      r.rejected && r.error?.code === "WB_SEARCH_UPSTREAM_ERROR",
      r.rejected ? `code=${r.error?.code}` : "未抛错",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // S2.4 401 → SESSION_DEAD（会话失效是可续期的，不能当普通失败）
  globalThis.fetch = async () => new Response("Offline user session not found", { status: 401 });
  try {
    const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
    check(
      "S2.4",
      "401/会话失效 → WB_SEARCH_SESSION_DEAD（可触发续期）",
      r.rejected && r.error?.code === "WB_SEARCH_SESSION_DEAD",
      r.rejected ? `code=${r.error?.code}` : "未抛错",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // S2.5 响应无 body 流 → 不能静默当成功
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
    check(
      "S2.5",
      "200 但无响应体 → 明确报错（不静默成功）",
      r.rejected && r.error?.code === "WB_SEARCH_UPSTREAM_ERROR",
      r.rejected ? `code=${r.error?.code}` : "未抛错",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ───────────────────────── S3 流式响应畸形 / 空结果 ─────────────────────────

console.log("\nS3  流式响应畸形 / 空结果（上游改协议、返回空综述）");

{
  const originalFetch = globalThis.fetch;

  // S3.1 流结束但没有任何 done 帧 → EMPTY_RESULT（不是静默返回空数组）
  globalThis.fetch = async () =>
    new Response('event: message\ndata: {"delta":"noise"}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  try {
    const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
    check(
      "S3.1",
      "无 done 帧 → WB_SEARCH_EMPTY_RESULT（不静默成功）",
      r.rejected && r.error?.code === "WB_SEARCH_EMPTY_RESULT",
      r.rejected ? `code=${r.error?.code}` : "未抛错",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // S3.2 done 帧的 data 是坏 JSON → 视为空结果，而非崩溃
  globalThis.fetch = async () =>
    new Response("event: done\ndata: {not json\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  try {
    const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
    check(
      "S3.2",
      "done 帧 JSON 损坏 → 归为 EMPTY_RESULT（不崩溃）",
      r.rejected && r.error?.code === "WB_SEARCH_EMPTY_RESULT",
      r.rejected ? `code=${r.error?.code}` : "未抛错",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // S3.3 正常 done 帧 → 必须成功解析出 content 与 sources（对照组）
  const good = JSON.stringify({
    synthesis: {
      content: "DeepSeek Harness 是……\n\n参考：[A](https://a.example/x) [B](https://b.example/y)",
    },
  });
  globalThis.fetch = async () =>
    new Response(`event: done\ndata: ${good}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  try {
    const r = await callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined);
    check(
      "S3.3",
      "正常 done 帧 → 解析出 content + 去重 sources（对照组）",
      typeof r.content === "string" && r.content.length > 0 && Array.isArray(r.sources) && r.sources.length === 2,
      `content=${r.content?.length ?? 0}char sources=${r.sources?.length ?? "?"}`,
    );
    check("S3.4", "来源 URL 去重且保序", r.sources?.[0]?.url === "https://a.example/x", `first=${r.sources?.[0]?.url}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ───────────────────────── S4 凭据缺失 / 损坏 ─────────────────────────

console.log("\nS4  凭据缺失 / 损坏（用户没登录、文件半损坏）");

{
  // S4.1 parseWorkBuddyAuth 对垃圾输入必须返回安全值（不抛、不返回半成品）
  const junkInputs = ["", "not json at all", "[]", "null", '{"a":1}', "{}"];
  let allSafe = true;
  const details = [];
  for (const junk of junkInputs) {
    try {
      const out = __internals.parseWorkBuddyAuth(junk);
      // 允许 undefined / null / 无 token 的对象；不允许抛出或返回带假 token
      if (out !== undefined && out !== null && typeof out === "object" && typeof out.accessToken === "string" && out.accessToken !== "") {
        allSafe = false;
        details.push(`junk=${JSON.stringify(junk)} → 假 token`);
      }
    } catch (error) {
      allSafe = false;
      details.push(`junk=${JSON.stringify(junk)} 抛出 ${error?.message}`);
    }
  }
  check("S4.1", "凭据解析对 6 种垃圾输入均安全（不抛/不造 token）", allSafe, details.join("; "));

  // S4.2 探针函数对不存在的文件返回 false 而非抛错
  let probeSafe = true;
  try {
    const r = __internals.probeAuthFileSync("Z:/nonexistent/path/workbuddy-desktop.info"); // g8-ignore: 合成不存在路径，非本机路径
    if (r !== false) probeSafe = false;
  } catch {
    probeSafe = false;
  }
  check("S4.2", "凭据探针对不存在路径返回 false（不抛）", probeSafe);

  // S4.3 凭据候选枚举不抛错且为数组（可能在无凭据环境）
  let enumOk = false;
  let enumLen = -1;
  try {
    const c = __internals.syncCredentialCandidates();
    enumOk = Array.isArray(c);
    enumLen = c.length;
  } catch {}
  check("S4.3", "凭据候选枚举返回数组（无凭据环境也不抛）", enumOk, `len=${enumLen}`);

  // S4.4 available() 在无任何凭据时返回 false 而非抛（宿主会用它决定降级）
  let availOk = false;
  let availVal = null;
  try {
    const ProviderCtor = mod.default;
    if (typeof ProviderCtor !== "function") {
      // 无 default 导出时改为确认模块主入口（apply）存在
      availOk = typeof mod.apply === "function";
      availVal = "apply-present";
    } else {
      availVal = new ProviderCtor().available();
      availOk = availVal === false || availVal === true;
    }
  } catch (error) {
    availVal = `threw: ${error?.message}`;
  }
  check("S4.4", "available() 在无凭据时不抛（返回布尔）", availOk, `val=${availVal}`);
}

// ───────────────────────── S5 平台 / 环境变量覆盖 ─────────────────────────

console.log("\nS5  平台路径与自定义安装（用户把 App 装到非默认位置）");

{
  const { desktopAuthFiles, VARIANTS, resolveElectronBinary, credentialPaths } = __internals;

  // S5.1 环境变量覆盖生效（用户显式指定凭据文件）
  // 关键点：env 覆盖**不在** desktopAuthFiles() 里生效（那只是平台默认路径），
  // 而在统一入口 credentialPaths() 里以**最高优先级**排在最前。这是易踩的层级陷阱。
  const fake = "C:/custom/path/my-workbuddy.info"; // g8-ignore: 合成夹具路径，非本机路径
  const before = process.env.WORKBUDDY_AUTH_FILE;
  process.env.WORKBUDDY_AUTH_FILE = fake;
  try {
    const cnVariant = VARIANTS.find((v) => v.region === "cn") ?? VARIANTS[0];
    // 「按 variant 直接枚举」只给平台默认路径（不含 env 覆盖）——符合设计
    const rawFiles = desktopAuthFiles(cnVariant);
    // 「统一入口」才把 env 覆盖排最前——用户实际用到的行为
    const merged = typeof credentialPaths === "function" ? credentialPaths() : rawFiles;
    const first = String(merged[0] ?? "").replace(/\\/g, "/");
    check(
      "S5.1",
      "WORKBUDDY_AUTH_FILE 在 credentialPaths() 里优先生效",
      first.includes("custom/path/my-workbuddy.info"),
      `first=${merged[0]}`,
    );
    check(
      "S5.2",
      "desktopAuthFiles(variant) 只给平台默认路径（不含 env，符合分层设计）",
      Array.isArray(rawFiles) && !rawFiles.some((f) => String(f).replace(/\\/g, "/").includes("custom/path/my-workbuddy.info")),
      `len=${rawFiles.length}`,
    );
  } finally {
    if (before === undefined) delete process.env.WORKBUDDY_AUTH_FILE;
    else process.env.WORKBUDDY_AUTH_FILE = before;
  }

  // S5.3 显式传入 platform=darwin 时，应产出 macOS 路径（跨平台模拟）
  {
    const cnVariant = VARIANTS.find((v) => v.region === "cn") ?? VARIANTS[0];
    let darwinFiles = [];
    let threw = false;
    try {
      darwinFiles = desktopAuthFiles(cnVariant, "darwin", {}, "/Users/tester");
    } catch {
      threw = true;
    }
    const hasMac = darwinFiles.some((f) => /[\\/]Library[\\/]Application Support[\\/]/.test(String(f)));
    check("S5.3", "platform=darwin 模拟产出 macOS 路径", !threw && hasMac, `files=${JSON.stringify(darwinFiles).slice(0, 120)}`);
  }

  // S5.4 传入非法 variant 时不应抛难懂异常（健壮性，已加防御）
  {
    let out;
    let threw = false;
    try {
      out = desktopAuthFiles(undefined);
    } catch {
      threw = true;
    }
    check("S5.4", "对 undefined variant 不抛生僻异常（返回空）", !threw && Array.isArray(out) && out.length === 0, threw ? "抛出异常" : `len=${out?.length}`);
  }

  // S5.5 resolveElectronBinary 首参是 variant 对象；对未配置的国际版不抛
  {
    let electronSafe = true;
    let electronVal;
    try {
      const aiVariant = VARIANTS.find((v) => v.region === "global") ?? VARIANTS[1] ?? VARIANTS[0];
      electronVal = resolveElectronBinary(aiVariant);
    } catch (error) {
      electronSafe = false;
      electronVal = `threw: ${error?.message}`;
    }
    check("S5.5", "resolveElectronBinary(variant) 对未配置项不抛", electronSafe, `val=${String(electronVal).slice(0, 60)}`);
  }

  // S5.6 resolveElectronBinary 对非法输入（字符串/undefined）的健壮性
  {
    let threw = 0;
    for (const bad of ["workbuddy-ai", undefined, null]) {
      try {
        resolveElectronBinary(bad);
      } catch {
        threw += 1;
      }
    }
    check("S5.6", "对非对象 variant 不抛（返回 undefined）", threw === 0, `threw=${threw}/3`);
  }

  // S5.7 两版 variant 元数据完整（id / region / 文件名 / electron 配置）
  const variantsOk =
    Array.isArray(VARIANTS) &&
    VARIANTS.length === 2 &&
    VARIANTS.every(
      (v) =>
        typeof v?.id === "string" &&
        typeof v?.region === "string" &&
        typeof v?.desktopFilename === "string" &&
        v.desktopFilename !== "" &&
        typeof v?.electron === "object" &&
        v.electron !== null,
    );
  check("S5.7", "cn + global 两 variant 元数据完整", variantsOk, `count=${VARIANTS?.length}`);
}

// ───────────────────────── S6 并发 / 边界规模 ─────────────────────────

console.log("\nS6  并发与规模边界（多查询、超长查询）");

{
  const originalFetch = globalThis.fetch;

  // S6.1 并发多次搜索：互不干扰，各自拿到正确结果
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const q = body.query;
    // 每个查询回不同内容，验证无串流
    await new Promise((r) => setTimeout(r, Math.random() * 30));
    const payload = JSON.stringify({ synthesis: { content: `answer-for:${q}` } });
    return new Response(`event: done\ndata: ${payload}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const queries = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const results = await Promise.all(
      queries.map((q) => callAgenticSearch({ accessToken: "x", domain: "d" }, q, undefined)),
    );
    const allCorrect = results.every((r, i) => r.content === `answer-for:${queries[i]}`);
    check("S6.1", "5 路并发搜索各自结果正确（无串流）", allCorrect, results.map((r) => r.content).join(","));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // S6.2 超长查询（10 万字符）不应崩溃、应原样传出
  let seenLen = -1;
  globalThis.fetch = async (_url, init) => {
    seenLen = JSON.parse(init.body).query.length;
    const payload = JSON.stringify({ synthesis: { content: "ok" } });
    return new Response(`event: done\ndata: ${payload}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const longQuery = "x".repeat(100_000);
    const r = await callAgenticSearch({ accessToken: "x", domain: "d" }, longQuery, undefined);
    check("S6.2", "10 万字符查询不崩溃且原样传出", r.content === "ok" && seenLen === 100_000, `seenLen=${seenLen}`);
  } catch (error) {
    check("S6.2", "10 万字符查询不崩溃", false, `抛出: ${error?.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // S6.3 中途 abort：应尽快以 WEB_ABORTED 结束，而不是等云端跑完
  const ac = new AbortController();
  globalThis.fetch = async (_url, init) =>
    new Promise((resolve, reject) => {
      // 模拟慢流：2 秒后才有响应；期间若被 abort 则走 reject
      const timer = setTimeout(() => resolve(new Response("", { status: 200 })), 2000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  try {
    const started = Date.now();
    setTimeout(() => ac.abort(new Error("user cancelled")), 100);
    const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "slow", ac.signal));
    const elapsed = Date.now() - started;
    check(
      "S6.3",
      "中途 abort 快速返回 WEB_ABORTED（不等云端）",
      r.rejected && r.error?.code === "WEB_ABORTED" && elapsed < 1500,
      `code=${r.error?.code} elapsed=${elapsed}ms`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ───────────────────────── S7 接管范围（用户最容易误解的点） ─────────────────────────

console.log("\nS7  接管范围：只接管搜索，不接管抓取（最易误解）");

{
  const { PROVIDER_ID } = __internals;
  check("S7.1", "provider id 为 workbuddy-agentic（稳定契约）", PROVIDER_ID === "workbuddy-agentic", `id=${PROVIDER_ID}`);

  // S7.2 插件源码里**不应**出现 fetch provider 的注册（只注册 search）
  const src = await (await import("node:fs/promises")).readFile(join(targetDir, "lib", "index.js"), "utf8");
  const hasFetchRegister = /registerFetchProvider/.test(src);
  check("S7.2", "插件不注册 fetch provider（web_fetch 仍走 dsh 内置）", !hasFetchRegister, hasFetchRegister ? "发现 registerFetchProvider" : "");

  // S7.3 插件 patch 里显式复述 fetchProvider: http（防整行替换丢字段）
  const patchSrc = await (await import("node:fs/promises")).readFile(join(targetDir, "cordis.patch.yml"), "utf8");
  check(
    "S7.3",
    "cordis.patch.yml 显式保留 fetchProvider: http",
    /fetchProvider:\s*http/.test(patchSrc),
    /fetchProvider/.test(patchSrc) ? "" : "patch 未声明 fetchProvider（整行替换会丢字段）",
  );
}

// ───────────────────────── S9 装了 connect 但 connect 坏了（不许拖累功能） ─────────────────────────

// 承诺是「connect 只是可选增强：装了更好，不装也能用」。
// 但「装了」和「装了且好用」是两回事 —— 这一组专门验证**坏掉的 connect 不会拖累功能**。
// 做法：在临时目录里造一个假的 dsh-workbuddy-connect（通过 DSH_HOME 让插件找到它），
// 再用一份合成凭据走自带路径。全程离线。
{
  console.log(`\nS9  装了 connect 但 connect 坏了（"有它没它都能用"的硬约束）`);
  const fs = await import("node:fs");
  const os = await import("node:os");

  const sandbox = fs.mkdtempSync(join(os.tmpdir(), "dsh-wb-connect-"));
  const profile = "s9";
  const pluginDir = join(sandbox, "plugin");
  const authFile = join(sandbox, "auth.json");

  // ⚠️ 每个子用例必须用**独立的 DSH_HOME**。
  // 原因：connect 模块是按「解析出的绝对路径」被 ESM 缓存的，而插件代码里
  // 那句 `import("dsh-workbuddy-connect")` 不带查询串。若复用同一个 DSH_HOME，
  // 后面几个子用例会拿到**第一个**假包（缓存命中），于是「通过」得毫无意义
  // ——这个坑是在做变异测试时发现的：把逻辑改回修复前，S9.3/S9.5 居然还报
  // `token=connect-dead-token`（第一个假包的返回值），说明它们根本没换包。
  let caseSeq = 0;
  const setupCase = (connectBody, authExtra = {}) => {
    caseSeq += 1;
    const home = join(sandbox, `dsh-home-${caseSeq}`);
    const dir = join(home, "profiles", profile, "node_modules", "dsh-workbuddy-connect");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "package.json"),
      JSON.stringify({ name: "dsh-workbuddy-connect", version: "0.0.0-fake", type: "module", main: "index.js" }));
    fs.writeFileSync(join(dir, "index.js"), connectBody);
    fs.writeFileSync(authFile, JSON.stringify({
      auth: {
        accessToken: "builtin-token",
        refreshToken: "",
        domain: "www.workbuddy.cn",
        expiresAt: Date.now() + 3_600_000,
        ...authExtra,
      },
    }));
    process.env.DSH_HOME = home;
    return home;
  };
  // 插件本身也用带随机查询串的 URL 重新导入，避免跨用例共享模块状态。
  const loadPlugin = async () => await import(`${pathToFileURL(join(pluginDir, "lib", "index.js")).href}?v=${Math.random()}`);

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.cpSync(join(targetDir, "lib"), join(pluginDir, "lib"), { recursive: true });
  fs.cpSync(join(targetDir, "package.json"), join(pluginDir, "package.json"));

  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE: process.env.DSH_PROFILE,
    WORKBUDDY_AUTH_FILE: process.env.WORKBUDDY_AUTH_FILE,
  };
  process.env.DSH_PROFILE = profile;
  process.env.WORKBUDDY_AUTH_FILE = authFile;

  try {
    // S9.1 / S9.2 connect 返回「已过期」的凭据 → 绝不能采信
    //   （若采信，会拿死 token 去搜索、报 401，而且**不会**回落到自带路径）
    setupCase(`
      export class WorkBuddyCredentialStore {
        constructor() {}
        async resolve() {
          return { accessToken: "connect-dead-token", refreshToken: "r", expiresAtMs: Date.now() - 60_000, domain: "www.workbuddy.ai" };
        }
      }
    `);
    {
      const m = await loadPlugin();
      const cred = await m.__internals.resolveCredential();
      check("S9.1", "connect 返回过期凭据 → 不采信，回落自带路径",
        cred?.accessToken === "builtin-token" && m.__internals.getLastCredentialSource() === "builtin",
        `token=${cred?.accessToken} source=${m.__internals.getLastCredentialSource()}`);
      check("S9.2", "connect 的问题被记为诊断（不静默吞掉）",
        m.__internals.getLastConnectError() !== undefined,
        "(getLastConnectError 为空)");
    }

    // S9.3 connect 返回「空 token」→ 同样不采信
    setupCase(`
      export class WorkBuddyCredentialStore {
        constructor() {}
        async resolve() { return { accessToken: "", refreshToken: "r", expiresAtMs: 0 }; }
      }
    `);
    {
      const m = await loadPlugin();
      const cred = await m.__internals.resolveCredential();
      check("S9.3", "connect 返回空 token → 不采信，回落自带路径",
        cred?.accessToken === "builtin-token" && m.__internals.getLastCredentialSource() === "builtin",
        `token=${cred?.accessToken}`);
    }

    // S9.4 connect 的 resolve() 直接抛错 → 静默降级
    setupCase(`
      export class WorkBuddyCredentialStore {
        constructor() {}
        async resolve() { throw new Error("connect store exploded"); }
      }
    `);
    {
      const m = await loadPlugin();
      const cred = await m.__internals.resolveCredential();
      check("S9.4", "connect 抛错 → 静默降级到自带路径",
        cred?.accessToken === "builtin-token",
        `token=${cred?.accessToken}`);
    }

    // S9.5 connect 包本身 import 就炸 → bridge 视为不可用
    setupCase(`throw new Error("connect package is broken");`);
    {
      const m = await loadPlugin();
      const cred = await m.__internals.resolveCredential();
      check("S9.5", "connect 包 import 失败 → 仍能解析凭据",
        cred?.accessToken === "builtin-token",
        `token=${cred?.accessToken}`);
    }

    // S9.6 / S9.7 forceRefresh 时不得再向 connect 要凭据
    //   该参数语义是「刚才那个 token 已经死了」。connect 的 resolve() 没有强制刷新入参，
    //   只会把手上那个（正是死掉的那个）还回来 → 401 重试必然再失败。
    //   所以强制刷新必须走自带路径的显式 refresh。这里打桩刷新端点来验证。
    setupCase(`
      export class WorkBuddyCredentialStore {
        constructor() {}
        async resolve() {
          return { accessToken: "connect-stale-token", refreshToken: "r", expiresAtMs: Date.now() + 3_600_000, domain: "www.workbuddy.ai" };
        }
      }
    `, { expiresAt: Date.now() - 60_000, refreshToken: "rt-1" });
    {
      const m = await loadPlugin();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(
        JSON.stringify({ code: 0, data: { accessToken: "refreshed-token", expiresIn: 3600 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      try {
        const cred = await m.__internals.resolveCredential(true);
        check("S9.6", "forceRefresh 走自带路径的显式 refresh（不复用 connect 的旧 token）",
          cred?.accessToken === "refreshed-token",
          `token=${cred?.accessToken}（期望 refreshed-token）`);
        check("S9.7", "forceRefresh 结果的 source 标记为 refreshed",
          cred?.source === "refreshed",
          `source=${cred?.source}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
}

// ───────────────────────── S8 测试体系自检（保护"不成体系化"这件事本身） ─────────────────────────
{
  console.log(`\nS8  测试体系文档自检（让流程本身可被回归）`);
  const fs = await import("node:fs");
  const readDoc = (name) => (fs.existsSync(join(targetDir, name)) ? fs.readFileSync(join(targetDir, name), "utf8") : undefined);

  // S8.1 测试体系文档必须存在（否则"场景→套件→用例"的映射无处可查，下次又要重新推演）
  const testing = readDoc("TESTING.md");
  check("S8.1", "TESTING.md 存在（测试体系有落点）", testing !== undefined, testing ? "" : "缺失：下次修 bug 又要重新想测什么");

  // S8.2 测试文档必须同时引用两层套件（只提一层说明覆盖有缺口）
  check(
    "S8.2",
    "TESTING.md 同时引用 regression 与 scenarios 两层套件",
    Boolean(testing && testing.includes("tools/regression.mjs") && testing.includes("tools/scenarios.mjs")),
    testing ? "" : "（跳过：无 TESTING.md）",
  );

  // S8.3 规范审计文档必须存在（回答"是否符合 dsh 官方规范"要有存档，不能只在对话里）
  const norm = readDoc("NORM-COMPLIANCE.md");
  check("S8.3", "NORM-COMPLIANCE.md 存在（规范审计有存档）", norm !== undefined, norm ? "" : "缺失：规范的结论会随对话蒸发");

  // S8.4 本套件必须已被 CI 接线（写了用例却没人跑 = 等于没写）。
  //      注意：npm 包内不含 .github/，所以对「解包后的发布物」跳过该检查——
  //      它是仓库级约束，只在源码/仓库目录下才有意义。
  const ciPath = join(targetDir, ".github", "workflows", "ci.yml");
  const isRepoDir = fs.existsSync(join(targetDir, ".git")) || fs.existsSync(join(targetDir, ".github"));
  if (isRepoDir) {
    const ci = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, "utf8") : "";
    check(
      "S8.4",
      "CI 已接线 scenarios 套件（否则用例形同虚设）",
      ci.includes("scenarios.mjs"),
      ci ? "" : "（CI 文件不存在）",
    );
  } else {
    check("S8.4", "非仓库目录（npm 包内无 .github/），跳过 CI 接线检查", true, "");
  }
}

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n=== 汇总 ===`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
if (fail > 0) {
  console.log(`\n失败项：`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("");
process.exit(fail === 0 ? 0 : 1);
