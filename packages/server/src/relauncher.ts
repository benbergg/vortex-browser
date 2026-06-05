import { spawn, execSync } from "child_process";

export const DEFAULT_CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TRUSTED_FLAG = "--silent-debugger-extension-api";

/**
 * 纯函数:从 `ps -ax -o command` 输出提取 Chrome 主进程二进制路径。
 * 先排除 Helper 行(渲染/GPU 子进程),再匹配到 `/Contents/MacOS/Google Chrome`
 * 后紧跟空格或行尾(避免把 "Google Chrome Helper" 截断成主路径)。
 */
export function parseChromeBin(psOutput: string): string | null {
  const line = psOutput
    .split("\n")
    .find((l) => l.includes("/Contents/MacOS/Google Chrome") && !l.includes("Google Chrome Helper"));
  if (!line) return null;
  const m = line.match(/(\/.*?\/Contents\/MacOS\/Google Chrome)(?= |$)/);
  return m ? m[1] : null;
}

/** 解析当前 Chrome 二进制路径;不传 psOutput 时实跑 ps;失败/提取不到回退默认路径。 */
export function resolveChromeBin(psOutput?: string): string {
  let out = psOutput;
  if (out === undefined) {
    try {
      out = execSync("ps -ax -o command", { encoding: "utf8", timeout: 2000 });
    } catch {
      return DEFAULT_CHROME_BIN;
    }
  }
  return parseChromeBin(out) ?? DEFAULT_CHROME_BIN;
}

/**
 * 纯函数:构造 helper 重启脚本。
 * sleep 1 给 host 时间回 HTTP 响应 + 优雅断开;killall 后 sleep 3 等 Chrome 彻底退出
 * (未退干净时再启动只会唤醒原实例、flag 被忽略——P1 实测的坑)。
 */
export function buildRelaunchScript(chromeBin: string): string {
  return [
    "sleep 1",
    'killall "Google Chrome"',
    "sleep 3",
    `"${chromeBin}" ${TRUSTED_FLAG} >/dev/null 2>&1`,
  ].join("\n");
}

/**
 * 带 flag 重启 Chrome。host 是 Chrome 子进程,killall 会让 host 自己被终止,
 * 故把动作交给脱离进程树的 helper:detached(新进程组,不随父进程组信号死)+
 * stdio:ignore(不持有 Chrome 断开的 pipe)+ unref(host 可独立退出)。
 */
export function relaunchTrusted(chromeBin: string = resolveChromeBin()): void {
  const script = buildRelaunchScript(chromeBin);
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
}
