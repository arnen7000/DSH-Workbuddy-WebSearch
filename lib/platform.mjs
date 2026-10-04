/**
 * 平台相关的路径与二进制定位（自带实现，不依赖任何外部插件）。
 *
 * ───────────────────────────── 来源与致谢 ─────────────────────────────
 * 本模块的**平台规则**借鉴自 `dsh-workbuddy-connect`（Corrine Hu, MIT c 2026）
 * 的 `defaultDesktopAuthCandidates` / `defaultWorkBuddyElectronPath`：
 * - Windows 需同时探测 Local 与 Roaming（只探一个会把「已登录」误判为未登录）；
 * - macOS 路径 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`；
 * - macOS Electron 默认路径取自其记录的官方安装布局；
 * - 「国际版 Windows 端不给默认路径，宁可不猜」这一取舍直接沿用其决定；
 * - `WORKBUDDY_*_AUTH_FILE` / `WORKBUDDY_*_ELECTRON_BIN` 变量名沿用其约定，
 *   使两插件共存时用户配置无需改写。
 *
 * 我们是**重写**而非复制：connect 的相关逻辑与其业务强耦合（含探测服务、
 * 心跳、目录存储等），这里只抽出「路径与定位」这一最小必要面，
 * 并补上了 WSL 与 XDG 分支的独立实现。详见 `CREDITS.md` §1.2–1.4。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 目标：本插件在「没有任何其他 dsh 插件」的干净环境里也能独立定位
 * WorkBuddy / WorkBuddy AI 桌面端的凭据文件与 Electron 二进制。
 *
 * 平台覆盖（macOS 为**实验性**）：
 * - win32（稳定）：`%LOCALAPPDATA%` / `%APPDATA%` 下的共享 auth 目录；
 * - darwin（实验性）：`~/Library/Application Support/` 下的同名目录；
 * - linux / 其他（实验性兜底）：XDG 规范目录，另对 WSL 探测宿主 Windows 路径。
 *
 * 说明：WorkBuddy 桌面端目前只发布 Windows 与 macOS 版本；Linux 分支仅为
 * 「在 Linux/WSL 上读取宿主已安装的 Windows 桌面端凭据」这一场景保留。
 *
 * @module dsh-workbuddy-websearch/platform
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** 共享 auth 目录（两版 App 写同一目录，仅文件名不同）。 */
const AUTH_DIR_SEGMENTS = ["CodeBuddyExtension", "Data", "Public", "auth"];

/** 国内版 / 国际版桌面端凭据文件名。 */
export const DESKTOP_AUTH_FILENAME_CN = "workbuddy-desktop.info";
export const DESKTOP_AUTH_FILENAME_AI = "workbuddy-desktop-ai.info";

/** 插件自有副本文件名（写在 dsh-home 下，作为跨设备/备份兜底）。 */
export const OWN_AUTH_FILENAME_CN = ".workbuddy-auth.json";
export const OWN_AUTH_FILENAME_AI = ".workbuddy-ai-auth.json";

/** 环境变量名。 */
export const ENV_AUTH_FILE_CN = "WORKBUDDY_AUTH_FILE";
export const ENV_AUTH_FILE_AI = "WORKBUDDY_AI_AUTH_FILE";
export const ENV_ELECTRON_BIN_CN = "WORKBUDDY_ELECTRON_BIN";
export const ENV_ELECTRON_BIN_AI = "WORKBUDDY_AI_ELECTRON_BIN";

/**
 * 两个「变体」的定义。字段形状与 dsh-workbuddy-connect 的
 * `WORKBUDDY_VARIANTS` 保持**结构兼容**，这样当 connect 存在时，本插件
 * 生成的 variant 可以直接喂给它的 store（见 connect-bridge）。
 *
 * 这里刻意只保留本插件真正用得到的信息（区域、文件名、环境变量、
 * Electron 平台默认路径），不复制 connect 的业务逻辑。
 */
export const VARIANTS = [
  {
    id: "workbuddy",
    displayName: "WorkBuddy",
    appName: "WorkBuddy",
    region: "cn",
    desktopFilename: DESKTOP_AUTH_FILENAME_CN,
    ownFilename: OWN_AUTH_FILENAME_CN,
    env: ENV_AUTH_FILE_CN,
    electron: {
      productName: "WorkBuddy",
      envVar: ENV_ELECTRON_BIN_CN,
      /** macOS（实验性）：官方安装包的默认布局。 */
      macosPath: "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
      /** macOS bundle id（仅诊断用）。 */
      macosBundleId: "com.tencent.workbuddy.mac",
      /** Windows：相对 %LOCALAPPDATA% 的默认布局。 */
      windowsPathSegments: ["Programs", "WorkBuddy", "WorkBuddy.exe"],
      /** Windows：可执行文件名（注册表/目录扫描时用）。 */
      windowsExeBasename: "workbuddy.exe",
    },
  },
  {
    id: "workbuddy-ai",
    displayName: "WorkBuddy AI",
    appName: "WorkBuddy AI",
    region: "global",
    desktopFilename: DESKTOP_AUTH_FILENAME_AI,
    ownFilename: OWN_AUTH_FILENAME_AI,
    env: ENV_AUTH_FILE_AI,
    electron: {
      productName: "WorkBuddy AI",
      envVar: ENV_ELECTRON_BIN_AI,
      macosPath: "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron",
      macosBundleId: "com.workbuddy.workbuddy-ai",
      /**
       * 国际版 Windows 端没有经过验证的默认安装位置（社区反馈为自定义路径），
       * 因此不给默认段，交给注册表发现或用户显式指定环境变量。
       * 与 dsh-workbuddy-connect 的取舍保持一致：宁可不猜，也不猜错。
       */
      windowsPathSegments: undefined,
      windowsExeBasename: "workbuddyai.exe",
    },
  },
];

/** 按 region 取 variant。 */
export function variantForRegion(region) {
  return region === "global" ? VARIANTS[1] : VARIANTS[0];
}

/** 是否运行在 WSL 内（Linux 分支判定用）。 */
export function isWsl(env = process.env) {
  if (process.platform !== "linux") return false;
  if (env["WSL_DISTRO_NAME"] !== undefined || env["WSL_INTEROP"] !== undefined) return true;
  return /microsoft/i.test(env["OS"] ?? "") || /microsoft/i.test(env["WSLENV"] ?? "");
}

/** 把 Windows 盘符路径转成 WSL 的 `/mnt/<drive>` 形式；非 Windows 路径原样返回。 */
export function windowsPathForWsl(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (path === "") return undefined;
  if (path.startsWith("/")) return path;
  const match = /^([a-z]):[\\/](.*)$/iu.exec(path);
  if (match === null) return undefined;
  return join("/mnt", match[1].toLowerCase(), ...match[2].split(/[\\/]+/u));
}

/** XDG 基准目录：环境变量优先（须为绝对路径），否则回落默认。 */
function xdgBase(env, envName, fallback) {
  const value = typeof env[envName] === "string" ? env[envName].trim() : "";
  if (value !== "" && value.startsWith("/")) return value;
  return fallback;
}

/**
 * 桌面端 auth 目录候选（**不含文件名**），按探测顺序。
 *
 * - darwin：单一位置（`~/Library/Application Support/...`）。
 * - win32：Local 与 Roaming 都探——新版写 Local，旧版写 Roaming；
 *   只探一个会把「已登录」误判成「未登录」。
 * - linux：XDG config/data 都探（多数发行版写 config，UOS/deepin 写 data）；
 *   在 WSL 下额外前置宿主 Windows 的对应目录。
 */
export function desktopAuthDirs(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", ...AUTH_DIR_SEGMENTS)];
  }
  if (platform === "win32") {
    return [
      join(home, "AppData", "Local", ...AUTH_DIR_SEGMENTS),
      join(home, "AppData", "Roaming", ...AUTH_DIR_SEGMENTS),
    ];
  }
  if (platform === "linux") {
    const configHome = xdgBase(env, "XDG_CONFIG_HOME", join(home, ".config"));
    const dataHome = xdgBase(env, "XDG_DATA_HOME", join(home, ".local", "share"));
    const native = dedupe([
      join(configHome, ...AUTH_DIR_SEGMENTS),
      join(dataHome, ...AUTH_DIR_SEGMENTS),
    ]);
    if (!isWsl(env)) return native;
    // WSL：先看宿主 Windows 的登录态，再看 Linux 原生目录。
    const profile = windowsPathForWsl(env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
    const hostLocal = windowsPathForWsl(env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
    const hostRoaming = windowsPathForWsl(env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
    return dedupe([
      join(hostLocal, ...AUTH_DIR_SEGMENTS),
      join(hostRoaming, ...AUTH_DIR_SEGMENTS),
      ...native,
    ]);
  }
  // 其他平台（如未来的鸿蒙 PC）：不代表支持，只是给出可探测路径，
  // 由 available() 的实际读文件结果决定最终是否可用。
  return [join(home, ".config", ...AUTH_DIR_SEGMENTS)];
}

function dedupe(values) {
  return [...new Set(values)];
}

/**
 * 桌面端凭据文件候选（含文件名），按探测顺序。两版使用同一目录，
 * 只切换文件名，因此顺序完全复用上面的目录顺序。
 *
 * ⚠️ 签名注意：本函数**首参是 variant**（用于取文件名），与相邻的
 * `desktopAuthDirs(platform, env, home)` 不同。这样设计是为了让最常见的
 * 「按 variant 枚举全部候选文件」写成最简形式 `desktopAuthFiles(v)`。
 * 需要跨平台模拟时显式传第二、三、四参。
 *
 * 对 `null` / `undefined` / 缺失 `desktopFilename` 的 variant 返回 `[]`，
 * 不抛生僻的 `Cannot read properties of undefined`——调用方（含探针脚本）
 * 可安全地枚举而无需先自行校验。
 */
export function desktopAuthFiles(
  variant,
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (variant === null || typeof variant !== "object" || typeof variant.desktopFilename !== "string" || variant.desktopFilename === "") {
    return [];
  }
  return desktopAuthDirs(platform, env, home).map((dir) => join(dir, variant.desktopFilename));
}

/**
 * Windows：在**常见安装根**下按可执行文件名做有界扫描。
 *
 * 补上两类「默认布局」覆盖不到的情况：
 * - **系统级安装**（`%ProgramFiles%\WorkBuddy\`，而非 per-user 的 `%LOCALAPPDATA%\Programs\`）；
 * - **目录名带后缀/变体**（如 `%LOCALAPPDATA%\Programs\WorkBuddy AI\`）。
 *
 * 边界（刻意保守）：
 * - 只扫**固定几个根目录**下的**一层**子目录，且只认目录名以 `WorkBuddy` 开头的，
 *   不做全盘遍历、不枚举盘符（枚举盘符可能卡在失联的网络驱动器上）；
 * - 任何一步失败（权限 / IO / 目录不存在）都静默跳过——探测函数不应抛错。
 *
 * ⚠️ 仍覆盖不到：用户把 App 装到**自选盘符或自定义路径**
 * （例如 `<安装盘>:\<任意目录>\`）。那种情况请用 `WORKBUDDY_*_ELECTRON_BIN`
 * 显式指定——这是本插件对该场景的既定出路，不靠猜。
 *
 * @returns 命中的绝对路径；未命中返回 `undefined`。
 */
export function scanWindowsInstallRoots(exeBasename, env = process.env) {
  if (typeof exeBasename !== "string" || exeBasename === "") return undefined;
  const roots = [
    typeof env["LOCALAPPDATA"] === "string" ? join(env["LOCALAPPDATA"], "Programs") : undefined,
    env["ProgramFiles"],
    env["ProgramW6432"],
    env["ProgramFiles(x86)"],
  ];
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== "string" || root.trim() === "") continue;
    const dir = root.trim();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^workbuddy/iu.test(entry.name)) continue;
      const candidate = join(dir, entry.name, exeBasename);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 定位桌面端 Electron 二进制（解密 `$wbEncrypted` 凭据需要用它跑 key helper）。
 *
 * 解析顺序：
 *   1) 显式环境变量（最可靠，用户可强制覆盖）；
 *   2) 平台默认路径（macOS 已验证；Windows 国内版有已验证的 per-user 默认位置）；
 *   3) Windows 常见安装根扫描（见 `scanWindowsInstallRoots`）——
 *      覆盖系统级安装与目录名变体；国际版正是靠这一步才可能被自动找到；
 *   4) 都失败返回 undefined（调用方据此给出明确指引，而不是瞎猜）。
 *
 * 注意：**本函数只读不跑**。真正执行二进制的是 `decrypt.mjs`。
 *
 * ⚠️ 首参是 **variant 对象**（不是字符串 id）。若误传字符串会取不到
 * `variant.electron`，故先做守卫：非对象或缺 `electron` 时直接返回 `undefined`，
 * 而不是抛 `Cannot read properties of undefined`。调用方据此走「未找到」分支。
 */
export function resolveElectronBinary(variant, env = process.env) {
  if (variant === null || typeof variant !== "object" || typeof variant.electron !== "object" || variant.electron === null) {
    return undefined;
  }
  const explicit = env[variant.electron.envVar];
  if (typeof explicit === "string" && explicit.trim() !== "" && existsSync(explicit.trim())) {
    return explicit.trim();
  }
  if (process.platform === "darwin" && variant.electron.macosPath !== undefined) {
    if (existsSync(variant.electron.macosPath)) return variant.electron.macosPath;
  }
  if (process.platform === "win32") {
    const local = env["LOCALAPPDATA"];
    const segments = variant.electron.windowsPathSegments;
    if (segments !== undefined && typeof local === "string" && local.trim() !== "") {
      const guess = join(local.trim(), ...segments);
      if (existsSync(guess)) return guess;
    }
    const scanned = scanWindowsInstallRoots(variant.electron.windowsExeBasename, env);
    if (scanned !== undefined) return scanned;
  }
  return undefined;
}
