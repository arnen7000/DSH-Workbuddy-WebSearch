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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const targetDir = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const entryUrl = pathToFileURL(join(targetDir, "lib", "index.js")).href;

let pass = 0;
let fail = 0;
const skipped = [];
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

/**
 * 明确跳过一条用例：**既不算 PASS 也不算 FAIL**，而是把理由打印出来并单独计数。
 *
 * 为什么需要它：本机（Windows + 安全中心策略）出现过 `spawnSync bash` 整批返回
 * `EBUSY` 的情况 —— 一旦某个程序进了「命令安全」黑名单，Node 起子进程就被统一拦掉。
 * 此时靠执行 bash 来验证的用例（S10 组）既无法失败也无法通过，把它算成 FAIL
 * 会误导「插件有缺陷」，算成 PASS 则是在掩护自己。所以如实标 SKIP。
 * CI（Linux）上 spawn 正常，这组用例照常 FAIL/PASS，不受影响。
 */
function skip(id, label, reason) {
  console.log(`  SKIP  ${id}  ${label}（${reason}）`);
  skipped.push(`${id} ${label}（${reason}）`);
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

// ───────────────────────── 环境能力探测（决定 S10 能否真跑） ─────────────────────────
//
// S10 组靠**真实执行 bash 脚本**来验证发布/上架工具的行为。但本机（Windows + 安全中心
// 「命令安全」策略）一旦把某个程序放进黑名单，Node 的 `spawnSync`/`execFileSync` 就会
// 整批返回 `EBUSY`（实测 `reg.exe` 被拦时，连 `spawnSync bash` 都拿不到子进程）。
// 这时硬跑只会得到 `status=null`、空输出 —— 既不是通过也不是失败，先把能力探出来。
const SPAWN_BLOCKED_REASON = "本机 Node 起子进程被安全策略拦成 EBUSY（进程黑名单所致），无法执行 bash";
const canSpawn = (() => {
  const probe = spawnSync("bash", ["-c", "true"], { encoding: "utf8", timeout: 20_000 });
  return probe.error === undefined && probe.status === 0;
})();
if (!canSpawn) {
  console.log(`\n⚠️ 子进程不可用：${SPAWN_BLOCKED_REASON}。`);
  console.log(`   → 依赖执行 bash 的用例（S10 组）将一律标 SKIP，不算 PASS 也不算 FAIL。`);
  console.log(`   → 这属于环境限制，不是插件缺陷；CI（Linux）上 spawn 正常，照常 FAIL/PASS。\n`);
}

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

  // ── S3.5 SSE 换行形态兼容 ──
  //
  // SSE 规范把换行定义为 LF / CR / CRLF 三者之一，Node 的 fetch 流并不保证
  // 帮你把 CRLF 归一成 LF。此前实现只在 "\n\n" 处切帧、且只在 "\n" 处切行，
  // 于是 CRLF 流的帧永远切不出来，最后报
  // 「stream ended without synthesis content」—— 把「服务器用了 CRLF」
  // 误报成「上游没给内容」。现在三种换行都要能解析。
  {
    const enc = new TextEncoder();
    const payload = JSON.stringify({ synthesis: { content: "ok" } });
    const forms = [
      ["LF", `event: done\ndata: ${payload}\n\n`, "ok"],
      ["CRLF", `event: done\r\ndata: ${payload}\r\n\r\n`, "ok"],
      ["CR-only", `event: done\rdata: ${payload}\r\r`, "ok"],
      ["混合换行", `event: done\r\ndata: ${payload}\n\n`, "ok"],
      ["data 冒号后无空格", `event: done\ndata:${payload}\n\n`, "ok"],
      ["多行 data 拼接", `event: done\ndata: {"synthesis":\ndata: {"content":"ml"}}\n\n`, "ml"],
    ];
    for (const [label, sse, expected] of forms) {
      globalThis.fetch = async () =>
        new Response(new ReadableStream({
          start(c) { c.enqueue(enc.encode(sse)); c.close(); },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      let ok = false;
      let detail = "";
      try {
        const r = await callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined);
        ok = r.content === expected;
        detail = `content=${JSON.stringify(r.content)}`;
      } catch (error) {
        detail = `抛 ${error?.code ?? String(error)}`;
      }
      check("S3.5", `SSE 换行形态兼容：${label}`, ok, detail);
      globalThis.fetch = originalFetch;
    }
  }

  // ── S3.6 跨 chunk 拆帧 ──
  // `data:` 被网络拆到两个 chunk 是常态：缓冲里那一帧还没收完就被切一刀。
  // 只有等**空行抵达**才算帧完整，所以拆在 data 中间必须能拼回。
  {
    const enc = new TextEncoder();
    const full = 'event: done\ndata: {"synthesis":{"content":"split-ok"}}\n\n';
    const mid = full.indexOf("split") + 3; // 切在 data 的 JSON 中间
    globalThis.fetch = async () =>
      new Response(new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(full.slice(0, mid)));
          c.enqueue(enc.encode(full.slice(mid)));
          c.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    let ok = false;
    let detail = "";
    try {
      const r = await callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined);
      ok = r.content === "split-ok";
      detail = `content=${JSON.stringify(r.content)}`;
    } catch (error) {
      detail = `抛 ${error?.code ?? String(error)}`;
    }
    check("S3.6", "data 被拆到两个 chunk 仍能拼回整帧", ok, detail);
    globalThis.fetch = originalFetch;
  }

  // ── S3.7 / S3.8 done 帧的 synthesis.content 不是字符串 ──
  //
  // 上游偶尔会给出非字符串的 content（数字/对象/数组/布尔）。旧实现直接把它交给
  // `cleanSynthesis`，于是抛出**原生 TypeError**（`content.replace is not a
  // function`）—— 宿主拿不到任何可分类的 code，违反 `webError` 兜底注释里明说的
  // 「必须保留 code」原则（重试/重登/中止等语义全靠 code 分流）。
  //
  // 归因要求：非字符串 → UPSTREAM_ERROR（上游协议违约，不是「查询无结果」）；
  //          缺失/null → 仍是 EMPTY_RESULT（合法空帧，不得误报成协议违约）。
  {
    const enc = new TextEncoder();
    const streamOf = (sse) => async () =>
      new Response(new ReadableStream({
        start(c) { c.enqueue(enc.encode(sse)); c.close(); },
      }), { status: 200 });

    for (const [label, literal] of [["数字", "123"], ["对象", '{"a":1}'], ["数组", "[1,2]"], ["布尔", "true"]]) {
      globalThis.fetch = streamOf(`event: done\ndata: {"synthesis":{"content":${literal}}}\n\n`);
      const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
      check(
        "S3.7",
        `非字符串 synthesis.content（${label}）→ 可归因 code（不得漏出原生 TypeError）`,
        r.rejected && r.error?.code === "WB_SEARCH_UPSTREAM_ERROR",
        r.rejected ? `code=${r.error?.code} 构造器=${r.error?.constructor?.name}` : "未抛错",
      );
      globalThis.fetch = originalFetch;
    }

    for (const [label, sse] of [
      ["缺失", 'event: done\ndata: {"synthesis":{}}\n\n'],
      ["null", 'event: done\ndata: {"synthesis":{"content":null}}\n\n'],
    ]) {
      globalThis.fetch = streamOf(sse);
      const r = await expectReject(() => callAgenticSearch({ accessToken: "x", domain: "d" }, "test", undefined));
      check(
        "S3.8",
        `content ${label} → WB_SEARCH_EMPTY_RESULT（合法空帧，不算协议违约）`,
        r.rejected && r.error?.code === "WB_SEARCH_EMPTY_RESULT",
        r.rejected ? `code=${r.error?.code}` : "未抛错",
      );
      globalThis.fetch = originalFetch;
    }
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

  // S4.1b 未知加密算法版本（suite 比插件新）必须报「格式不支持」，
  // 而不是退化成「没凭据」（那会让用户收到「请去桌面端登录」，
  // 而重登根本没用）。这里在异常路径层再钉一次，与 T13 互补。
  {
    const KID = "9127dea1b44020a7";
    const b64 = (n) => Buffer.alloc(n, 1).toString("base64");
    const envFor = (suite) => ({
      $wbEncrypted: 1,
      envelope: Buffer.from(JSON.stringify({
        suite, keyId: KID, nonce: b64(12), authTag: b64(16), ciphertext: b64(32),
      })).toString("base64"),
    });
    const futureDoc = JSON.stringify({
      auth: { accessToken: envFor(2), refreshToken: envFor(2), domain: "www.workbuddy.ai" },
      account: { uid: "u1" },
    });
    const parsed = __internals.parseWorkBuddyAuth(futureDoc);
    const recognized = parsed !== undefined && parsed?.envelopeIssue?.reason === "unsupported-suite";
    check(
      "S4.1b",
      "未知 suite 的凭据仍被识别并标为 unsupported-suite（不退化成「没凭据」）",
      recognized,
      `envelopeIssue=${JSON.stringify(parsed?.envelopeIssue)}`,
    );

    // 反向：明文 token 可用时不得因 refreshToken 格式新而整体拒绝。
    // ⚠️ 必须走 readCredentialFile（真正决定「采不采信」的那一层），
    // 只测 parseWorkBuddyAuth 抓不到这个缺陷 —— 拒绝逻辑在读取层。
    const s41Dir = mkdtempSync(join(tmpdir(), "dsh-wb-s41-"));
    try {
      const mixedDoc = JSON.stringify({
        auth: { accessToken: "USABLE-PLAIN", refreshToken: envFor(2), domain: "www.workbuddy.ai" },
        account: { uid: "u1" },
      });
      const mixedFile = join(s41Dir, "mixed-future.info");
      writeFileSync(mixedFile, mixedDoc);
      let mixedCred;
      try {
        mixedCred = await __internals.readCredentialFile(mixedFile, { variant: null });
      } catch { mixedCred = undefined; }
      check(
        "S4.1c",
        "明文 accessToken + 未知格式 refreshToken → 仍返回可用 token（不被整体拒绝）",
        mixedCred?.accessToken === "USABLE-PLAIN" && mixedCred?.undecryptable !== true,
        `undecryptable=${mixedCred?.undecryptable === true ? mixedCred.reason : "false"} token=${JSON.stringify(mixedCred?.accessToken)}`,
      );

      // 两个 token 都是未知信封时，必须如实报「格式不支持」而不是静默当没凭据。
      const bothFile = join(s41Dir, "both-future.info");
      writeFileSync(bothFile, futureDoc);
      let bothCred;
      try {
        bothCred = await __internals.readCredentialFile(bothFile, { variant: null });
      } catch { bothCred = undefined; }
      check(
        "S4.1d",
        "两个 token 都是未知信封 → undecryptable(unsupported-suite)，不静默当没凭据",
        bothCred?.undecryptable === true && bothCred?.reason === "unsupported-suite",
        `reason=${bothCred?.undecryptable === true ? bothCred.reason : JSON.stringify(bothCred)?.slice(0, 40)}`,
      );
    } finally {
      try { rmSync(s41Dir, { recursive: true, force: true }); } catch {}
    }
  }

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

  // S5.8 macOS Spotlight 工具真的不存在时（非 macOS 机器 / 工具被拦），
  //      定位必须安全失败：不抛错、返回 undefined，交给上层给环境变量指引。
  {
    const { resolveElectronFromMacosDiscovery, findElectronFromMacosBundles } = __internals;
    let safe = true;
    let value;
    try {
      const cnVariant = VARIANTS.find((v) => v.region === "cn") ?? VARIANTS[0];
      // 不注入执行器 → 真的去调 /usr/bin/mdfind（在非 macOS 上必然失败）
      value = resolveElectronFromMacosDiscovery(cnVariant, {});
      // 顺带：执行器自己抛错也不能穿透出来
      value = resolveElectronFromMacosDiscovery(cnVariant, {
        macosDiscovery: { findApps: () => { throw new Error("mdfind exploded"); } },
      }) ?? value;
      const bogus = findElectronFromMacosBundles(["not-a-real-bundle.app"], {
        bundleId: "com.tencent.workbuddy.mac",
        tools: { bundleIdentifier: () => { throw new Error("plutil exploded"); } },
      });
      safe = bogus?.found === false && bogus.rejected === 1;
    } catch (error) {
      safe = false;
      value = `threw: ${error?.message}`;
    }
    check(
      "S5.8",
      "mdfind/plutil 不可用或抛错 → 安全失败（不抛）",
      safe && value === undefined,
      `value=${String(value).slice(0, 60)}`,
    );
  }

  // S5.9 Windows 分支不得被 macOS 发现链污染（新代码对稳定路径必须零影响）
  {
    let touched = 0;
    let picked;
    let safe = true;
    try {
      const cnVariant = VARIANTS.find((v) => v.region === "cn") ?? VARIANTS[0];
      picked = resolveElectronBinary(cnVariant, {}, {
        platform: "win32",
        registry: false,
        macosDiscovery: { findApps: () => { touched += 1; return []; } },
      });
    } catch {
      safe = false;
    }
    check(
      "S5.9",
      "platform=win32 时不触碰 macOS 发现链",
      safe && picked === undefined && touched === 0,
      `touched=${touched} picked=${String(picked).slice(0, 40)}`,
    );
  }
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

  // S8.2 测试文档必须引用每一层套件（只提一层说明覆盖有缺口）
  const docSuites = ["tools/regression.mjs", "tools/scenarios.mjs", "tools/user-journey.mjs", "tools/check-links.mjs"];
  const docMissing = docSuites.filter((s) => !(testing && testing.includes(s)));
  check(
    "S8.2",
    "TESTING.md 引用了全部套件（regression / scenarios / user-journey / check-links）",
    docMissing.length === 0,
    testing ? (docMissing.length ? `缺少引用：${docMissing.join(", ")}` : "") : "（跳过：无 TESTING.md）",
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
    const ciSuites = ["scenarios.mjs", "user-journey.mjs", "check-links.mjs"];
    const ciMissing = ciSuites.filter((s) => !ci.includes(s));
    check(
      "S8.4",
      "CI 已接线 scenarios / user-journey / check-links 套件（否则用例形同虚设）",
      ciMissing.length === 0,
      ci ? (ciMissing.length ? `CI 未跑：${ciMissing.join(", ")}` : "") : "（CI 文件不存在）",
    );
  } else {
    check("S8.4", "非仓库目录（npm 包内无 .github/），跳过 CI 接线检查", true, "");
  }

  // S8.5 dsh 真正读的是 `engines.dsh`，不是 `dsh.compatibility`。
  //      实测（dsh 0.2.2-alpha.2 的 evaluatePluginCompatibility）：只写
  //      `dsh.compatibility.dsh` 时，任何版本都放行——包括 `ctx.web` 接缝尚不存在的
  //      0.1.4；写上 `engines.dsh` 才会真的拒绝并给出 `dsh plugin allow-version` 补救。
  //      所以两者必须同时存在且取同一个下界，否则「声明」与「执行」脱节。
  const pkgPath = join(targetDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    manifest = undefined;
  }
  const declaredFloor = manifest?.dsh?.compatibility?.dsh;
  const enforcedFloor = manifest?.engines?.dsh;
  check(
    "S8.5",
    "engines.dsh（dsh 实际执行的闸门）存在，且与 dsh.compatibility.dsh 同值",
    Boolean(enforcedFloor) && enforcedFloor === declaredFloor,
    manifest
      ? `engines.dsh=${JSON.stringify(enforcedFloor)} / dsh.compatibility.dsh=${JSON.stringify(declaredFloor)}`
      : "（package.json 不可读）",
  );

  // S8.6 闸门不得设上限：dsh 出新版本必须照样能装（只声明「已验证到哪」）。
  //      写成 `>=0.1.5-rc.2 <0.3.0` 之类会在升级后把用户挡在门外，且无法自救。
  const hasUpperBound = typeof enforcedFloor === "string" && /<[=]?/.test(enforcedFloor);
  check(
    "S8.6",
    "engines.dsh 不设版本上限（允许未来版本直接安装）",
    typeof enforcedFloor === "string" && enforcedFloor.startsWith(">=") && !hasUpperBound,
    JSON.stringify(enforcedFloor),
  );
}

// ───────────────────────── S10 维护者脚本（发布 / 上架） ─────────────────────────
//
// `contrib/` 下的两个脚本是发布链上**唯一没有自动化测试**的一段，而它们恰好在本机
// 完全跑不起来：publish.sh 第一步就崩（Git Bash 的 `/d/...` 路径交给 node 的
// `require()` → MODULE_NOT_FOUND），submit-market.sh 则永久挂起（探测依赖 `nc`，
// 而本机没有 nc → 静默判定「没有代理」→ 直连 GitHub → 卡死，且 clone 的 stderr
// 被 `2>/dev/null` 吞掉，连原因都看不到）。
//
// 这组用例把**行为**钉住，而不是把源码文本钉住：全部用真实的 bash / git / node，
// 需要失败时就把代理指向一个必然不通的端口，因此不依赖网络、也不依赖任何桩。
{
  console.log(`\nS10  维护者脚本（发布 / 上架）`);
  const fs = await import("node:fs");
  const contribDir = join(targetDir, "contrib");
  const isRepoDir = fs.existsSync(join(targetDir, ".git")) || fs.existsSync(join(targetDir, ".github"));
  const hasScripts = fs.existsSync(join(contribDir, "publish.sh")) && fs.existsSync(join(contribDir, "lib.sh"));

  if (!isRepoDir || !hasScripts) {
    check("S10.1", "非仓库目录（npm 包内无 contrib/），跳过维护者脚本检查", true, "");
  } else {
    const runBash = (cwd, code, extraEnv = {}) =>
      spawnSync("bash", ["-c", code], {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ...extraEnv },
      });
    const out = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

    // 子进程被安全策略拦成 EBUSY 时，**凡是需要真实执行 bash 的用例一律不进场**，
    // 改成 SKIP（上面已统一打印原因）。它们不是「执行后失败」，而是「无法执行」——
    // 把后者算成 FAIL 等于谎报插件有缺陷。S10.8 是纯文本断言，不受影响、照常跑。
    const SPAWN_DEPENDENT = [
      ["S10.1", "MSYS 形态的 $PWD（/d/...）不得被原样输出"],
      ["S10.2", "resolve_root 在真实仓库上的输出能被 node 的 require 解析"],
      ["S10.3", "resolve_root 不产出 node 认不出的 MSYS 路径"],
      ["S10.4", "端口探测不依赖 nc"],
      ["S10.5", "CONNECT tunnel failed, response 502 归类为「连不上」"],
      ["S10.6", "submit-market.sh --dry-run 离线完成"],
      ["S10.7", "clone 失败 → 非零退出 + 回显原始 stderr + 归因「连不上」"],
      ["S10.9", "git 静默挂起被超时杀掉 → 仍给出可操作归因"],
      ["S10.10", "submit-market.sh 的 clone 静默挂起 → 归因超时/连不上"],
    ];
    if (!canSpawn) {
      for (const [id, label] of SPAWN_DEPENDENT) skip(id, label, SPAWN_BLOCKED_REASON);
    }

    // S10.1–S10.3 仓库根路径必须能被 node 认出来。
    //
    // 这是 publish.sh 的**第一步**（读 package.json 版本号），原先写成 `ROOT="$PWD"`：
    // Git Bash 下 `$PWD` 是 `/d/...`（MSYS）形态，node 的 `require()` 认不出，脚本
    // 一行有效输出都没有就崩掉 —— 也就是「发布脚本在本机一步都跑不动」。
    if (canSpawn) {
      // ⚠️ 这条**必须打桩 cygpath 并直接注入 `$PWD`**，不能靠「在当前目录下跑一遍」：
      //    真实 MSYS 形态只在 Git Bash 里出现，而 node 的 spawnSync 传 cwd 给 bash 时
      //    `$PWD` 拿到的已经是 Windows 形态（`<盘符>:/...`）—— 于是原写法在任何平台上
      //    都测不出这个缺陷（这条是变异测试抓出来的：把 resolve_root 改回 `$PWD`，
      //    旧写法的 S10.1 依然全绿）。
      //
      //    断言的是**属性**（输出不得是 MSYS 形态）而不是「必须调用 cygpath」：
      //    换成别的转换手段（如 sed）同样算通过。
      const r = runBash(contribDir, 'cygpath() { printf "CONVERTED"; }; . ./lib.sh; PWD="/d/fake/repo"; resolve_root');
      const got = (r.stdout ?? "").trim();
      check(
        "S10.1",
        "MSYS 形态的 $PWD（/d/...）不得被原样输出（node 认不出这种路径）",
        got !== "" && !/^\/[a-z]\//.test(got),
        `实测 ${JSON.stringify(got)}`,
      );
    }
    // 端到端补一刀：在真实仓库上，resolve_root 的输出必须真能被 node 的 require 解析。
    if (canSpawn) {
      const rootRes = runBash(targetDir, ". ./contrib/lib.sh; resolve_root");
      const root = (rootRes.stdout ?? "").trim();
      const requireRes = spawnSync("node", ["-p", `require(${JSON.stringify(`${root}/package.json`)}).version`], {
        encoding: "utf8",
        timeout: 30_000,
      });
      const version = (requireRes.stdout ?? "").trim();
      const pkgVersion = JSON.parse(fs.readFileSync(join(targetDir, "package.json"), "utf8")).version;
      check(
        "S10.2",
        "resolve_root 在真实仓库上的输出能被 node 的 require 解析（publish.sh 的第一步不再崩）",
        requireRes.status === 0 && version === pkgVersion,
        `root=${JSON.stringify(root)} 读到的版本=${JSON.stringify(version)} 期望=${pkgVersion}`,
      );
      // 输出里不得出现 MSYS 风格的裸盘符路径 —— 那正是让 node 认不出的形态。
      check(
        "S10.3",
        "resolve_root 不产出 node 认不出的 MSYS 路径（如 /d/...）",
        root !== "" && !/^\/[a-z]\//.test(root),
        `root=${JSON.stringify(root)}`,
      );
    }

    // S10.4 代理探测不得依赖 nc。
    //
    // 本机（Git Bash 自带的 PortableGit）**没有 nc**，而旧写法是
    // `command -v nc && nc -z ...` —— 缺 nc 时整段判断直接短路成「没有代理」。
    // 这里把 nc 覆盖成一个「必定失败」的函数（`command -v nc` 仍会命中它），
    // 于是只有真正不依赖 nc 的实现才能探到那个确实在监听的端口。
    if (canSpawn) {
      const net = await import("node:net");
      const server = net.createServer();
      const port = await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(0, "127.0.0.1", () => res(server.address().port));
      });
      const probe = runBash(contribDir, `nc() { return 1; }; . ./lib.sh; port_open 127.0.0.1 ${port} && echo OPEN || echo CLOSED`);
      await new Promise((r) => server.close(r));
      const verdict = (probe.stdout ?? "").trim();
      check(
        "S10.4",
        "端口探测不依赖 nc（nc 被覆盖成必定失败，仍能探到真实监听的端口）",
        verdict === "OPEN",
        `实测 ${JSON.stringify(verdict)}`,
      );
    }

    // S10.5 失败归因必须覆盖 `CONNECT tunnel failed, response 502`。
    //
    // 走 HTTP 代理访问 GitHub 被中间设备拦截时，git 报的就是这一句；它既不含
    // "failed to connect" 也不含 "could not resolve host"。早先的正则漏了它，
    // 于是落到「原因见上方输出」，恰好丢掉唯一有用的那条指引（去查网络，而不是
    // 去折腾 PAT）。同时两类必须**互斥**：网络问题不得被误判成凭据问题。
    if (canSpawn) {
      const msg = "fatal: unable to access 'https://github.com/x/y.git/': CONNECT tunnel failed, response 502";
      const cls = runBash(
        targetDir,
        '. ./contrib/lib.sh; is_network_failure "$MSG" && echo NET || echo NOTNET; is_auth_failure "$MSG" && echo AUTH || echo NOTAUTH',
        { MSG: msg },
      );
      const lines = (cls.stdout ?? "").trim().split(/\s+/);
      check(
        "S10.5",
        "CONNECT tunnel failed, response 502 → 归类为「连不上」（且不误判为缺凭据）",
        lines[0] === "NET" && lines[1] === "NOTAUTH",
        `实测 ${JSON.stringify(lines.join(" "))}`,
      );
    }

    // S10.6 `submit-market.sh --dry-run` 必须**离线**且成功。
    //
    // 代理指向必然不通的端口：只要脚本仍尝试联网（clone），就一定会失败并返回
    // 非零 —— 它返回 0 即证明「dry-run 只在本地准备」这句说明属实。
    if (canSpawn) {
      const r = runBash(targetDir, "bash ./contrib/submit-market.sh --dry-run", {
        DSH_GIT_PROXY: "http://127.0.0.1:1",
      });
      const text = out(r);
      check(
        "S10.6",
        "submit-market.sh --dry-run 离线完成（代理不可用时仍成功，说明未联网）",
        r.status === 0 && /未联网/.test(text),
        `exit=${r.status} 输出末尾=${JSON.stringify(text.slice(-160))}`,
      );
    }

    // S10.7 真正联网失败时：必须失败、必须回显 git 的原始 stderr、必须归因为「连不上」。
    //
    // 三个要求缺一不可：静默失败会让维护者以为是「没 fork」而去开 fork；
    // 吞掉 stderr 则连原因都看不到。
    if (canSpawn) {
      const r = runBash(targetDir, "bash ./contrib/submit-market.sh", {
        DSH_GIT_PROXY: "http://127.0.0.1:1",
      });
      const text = out(r);
      check(
        "S10.7",
        "clone 失败 → 非零退出 + 回显 git 原始错误 + 归因为「连不上 GitHub」（不误报「你没 fork」）",
        r.status !== 0 && /连不上 GitHub/.test(text) && /fatal|Failed to connect|unable to access/i.test(text),
        `exit=${r.status} 含原始错误=${/fatal|Failed to connect|unable to access/i.test(text)} 输出末尾=${JSON.stringify(text.slice(-200))}`,
      );
    }

    // S10.8 防回退：两个脚本都必须用 lib.sh 的 resolve_root，不得再回到裸 `$PWD`。
    //
    // 纯文本断言，但它守的是一个**已被证实的崩溃点**（见 S10.1），且与上面的行为
    // 断言互为补充：行为断言证明「现在的实现是对的」，这条证明「以后也不会退回」。
    {
      const src = ["publish.sh", "submit-market.sh"].map((f) => fs.readFileSync(join(contribDir, f), "utf8"));
      const sourcesLib = src.every((s) => /\.\s+"\$\(cd "\$\(dirname "\$0"\)" && pwd\)\/lib\.sh"/.test(s));
      const noRawPwd = src.every((s) => !/^ROOT="\$PWD"$/m.test(s));
      check(
        "S10.8",
        "两个脚本都 source contrib/lib.sh，且不再用裸 ROOT=\"$PWD\"（防回退）",
        sourcesLib && noRawPwd,
        `source lib.sh=${sourcesLib} 无裸 $PWD=${noRawPwd}`,
      );
    }
    // S10.9 超时（被 timeout 杀掉、**输出为空**）必须被单独归因。
    //
    // 这条是实跑 `publish.sh --dry-run` 时发现的：直连 GitHub 时 `git push` 会静默
    // 挂起（既不报错也不返回，**连一行输出都没有**），被超时杀掉后输出为空 —— 于是
    // 「按输出文本归因」的逻辑落到「原因见上方 git 输出」，而上方一片空白。
    //
    // 复现方式刻意做成**确定性**的：起一个「接受连接但永不响应」的本地 TCP 服务当
    // 代理（黑洞），git 会卡在等 CONNECT 响应上，再由 1 秒超时把它杀掉 → 退出码 124。
    //
    // 为什么在**临时副本**里跑：`publish.sh` 有「工作区必须干净」的闸门，直接在本仓库
    // 跑会在读到「有未提交改动」时就退出、根本走不到推送那一步（而用例一旦依赖
    // 「当前工作区是干净的」，在开发过程中就会无谓地红）。副本由当前工作副本复制 +
    // `git init` 得到，因此既是最新代码、又天然是干净仓库，且不碰本仓库分毫。
    if (canSpawn) {
      const net = await import("node:net");
      const blackhole = net.createServer(() => { /* 接受连接，但永不回数据 */ });
      const port = await new Promise((res, rej) => {
        blackhole.once("error", rej);
        blackhole.listen(0, "127.0.0.1", () => res(blackhole.address().port));
      });
      const sandbox = mkdtempSync(join(tmpdir(), "pub-sandbox-"));
      const repo = join(sandbox, "repo");
      fs.cpSync(targetDir, repo, {
        recursive: true,
        filter: (src) => !/(^|[\\/])(\.git|\.local|node_modules|dist)([\\/]|$)/.test(src),
      });
      const gitIn = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 60_000 });
      gitIn("init", "-q", "-b", "main");
      gitIn("config", "user.name", "sandbox");
      gitIn("config", "user.email", "sandbox@example.invalid");
      gitIn("remote", "add", "origin", "https://github.com/arnen7000/DSH-Workbuddy-WebSearch.git");
      gitIn("add", "-A");
      gitIn("commit", "-q", "-m", "sandbox");
      // 打桩 node：只回版本号、其余调用直接成功，从而跳过三套件，让这条用例保持秒级。
      const stubNode = join(sandbox, "node");
      writeFileSync(stubNode, '#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in *package.json*) echo 9.9.9; exit 0 ;; esac; done\nexit 0\n');
      try { fs.chmodSync(stubNode, 0o755); } catch {}
      let r;
      try {
        r = spawnSync("bash", ["./contrib/publish.sh", "--dry-run"], {
          cwd: repo,
          encoding: "utf8",
          timeout: 90_000,
          env: {
            ...process.env,
            DSH_NODE: stubNode.replace(/\\/g, "/"),
            DSH_GIT_PROXY: `http://127.0.0.1:${port}`,
            DSH_GIT_TIMEOUT: "1",
          },
        });
      } finally {
        await new Promise((res) => blackhole.close(res));
        // 清理必须是**尽力而为**：Windows 上删一个刚跑过 git 的临时仓库可能报 EBUSY
        // （文件被短暂占用），而这与本用例要断言的东西无关 —— 让清理失败把整个套件
        // 带崩，只会掩盖真正的结论。留下的临时目录在系统 temp 里，无害。
        try {
          rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch { /* 尽力而为，见上 */ }
      }
      const text = out(r);
      check(
        "S10.9",
        "git 静默挂起被超时杀掉（输出为空）→ 仍给出可操作归因，不落到「见上方 git 输出」",
        r.status !== 0 && /连不上 GitHub/.test(text) && !/见上方 git 输出/.test(text),
        `exit=${r.status} 输出末尾=${JSON.stringify(text.slice(-300))}`,
      );
    }

    // S10.10 同一性质在 `submit-market.sh` 上也要成立。
    //        两个脚本各有一套归因文案（一个面向 push、一个面向 clone/push），只修一个
    //        是最容易漏的形态 —— 所以两条都要钉住。
    if (canSpawn) {
      const net = await import("node:net");
      const blackhole = net.createServer(() => { /* 接受连接，但永不回数据 */ });
      const port = await new Promise((res, rej) => {
        blackhole.once("error", rej);
        blackhole.listen(0, "127.0.0.1", () => res(blackhole.address().port));
      });
      let r;
      try {
        r = runBash(targetDir, "bash ./contrib/submit-market.sh", {
          DSH_GIT_PROXY: `http://127.0.0.1:${port}`,
          DSH_GIT_TIMEOUT: "1",
        });
      } finally {
        await new Promise((res) => blackhole.close(res));
      }
      const text = out(r);
      check(
        "S10.10",
        "submit-market.sh 的 clone 静默挂起被超时杀掉 → 归因为超时/连不上，不落到通用兜底",
        r.status !== 0 && /连不上 GitHub/.test(text) && !/原因见上方 git 输出/.test(text),
        `exit=${r.status} 输出末尾=${JSON.stringify(text.slice(-260))}`,
      );
    }
  }
}

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n=== 汇总 ===`);
console.log(`  PASS: ${pass}   FAIL: ${fail}${skipped.length > 0 ? `   SKIP: ${skipped.length}` : ""}`);
if (fail > 0) {
  console.log(`\n失败项：`);
  for (const f of failures) console.log(`  - ${f}`);
}
if (skipped.length > 0) {
  console.log(`\n跳过的用例（环境限制，非插件缺陷；CI 上会真实执行）：`);
  for (const s of skipped) console.log(`  - ${s}`);
}
console.log("");
process.exit(fail === 0 ? 0 : 1);
