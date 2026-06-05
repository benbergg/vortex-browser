import { execSync } from "child_process";

const TRUSTED_FLAG = "--silent-debugger-extension-api";
const CACHE_TTL_MS = 3000;
let cached: { value: boolean; at: number } | null = null;

/**
 * 纯函数:判断 ps 输出里是否存在「同一行既含 Google Chrome 又含 flag」的进程。
 * 同行匹配避免 flag 出现在无关进程行时误报为 trusted。
 */
export function parseTrustedMode(psOutput: string): boolean {
  return psOutput
    .split("\n")
    .some((line) => line.includes("Google Chrome") && line.includes(TRUSTED_FLAG));
}

/**
 * 检测当前 Chrome 是否带 --silent-debugger-extension-api 启动(macOS,带 TTL 缓存)。
 * flag 仅在 Chrome 重启时变化,3s 缓存避免每次 click 都 spawn ps。检测失败保守返回 false。
 * TODO: Windows/Linux 检测(P1 仅 macOS)。
 */
export function detectTrustedMode(now: number = Date.now()): boolean {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  let value = false;
  try {
    const out = execSync("ps -ax -o command", { encoding: "utf8", timeout: 2000 });
    value = parseTrustedMode(out);
  } catch {
    value = false;
  }
  cached = { value, at: now };
  return value;
}

/** 测试用:清缓存。 */
export function _resetTrustedModeCache(): void {
  cached = null;
}
