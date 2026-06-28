import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * O-3 自重启机制的源码级合约测试。
 *
 * 真正的 fs.watch + process.exit 副作用不好在 unit test 里跑
 * （会污染 test runner 进程），这里用"读源码字符串断言关键不变式"
 * 的低开销方式固化设计意图，防止后续误改。
 *
 * 针对的四条不变式：
 *  1. 存在 AUTO_RESTART env flag，允许 opt-out
 *  2. fs.watch 监听的是"自身所在目录"而不是写死的相对路径（运行期 dist、测试期 src 都要适配）
 *  3. exit 前必须等 inflight === 0（不能丢正在处理的 tool_call）
 *  4. CallToolRequestSchema handler 必须包裹 inflight++/-- 和 maybeExitAfterDrain
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(
  join(__dirname, "..", "src", "server.ts"),
  "utf8",
);

describe("MCP server self-restart contract (@since 0.4.0)", () => {
  it("exposes VORTEX_MCP_NO_AUTO_RESTART env opt-out", () => {
    expect(SERVER_SRC).toMatch(/VORTEX_MCP_NO_AUTO_RESTART/);
    // 必须默认开启，而非默认关闭
    expect(SERVER_SRC).toMatch(
      /AUTO_RESTART\s*=\s*process\.env\.VORTEX_MCP_NO_AUTO_RESTART\s*!==\s*["']1["']/,
    );
  });

  it("watches the running module's own directory (dist/src at runtime, src at test)", () => {
    // 必须通过 import.meta.url 解析，不能写死 "dist/src"
    expect(SERVER_SRC).toMatch(/fileURLToPath\(import\.meta\.url\)/);
    expect(SERVER_SRC).toMatch(/watch\(here,\s*\{\s*recursive:\s*true\s*\}/);
  });

  it("exit is gated on inflight reaching zero", () => {
    expect(SERVER_SRC).toMatch(/pendingRestart\s*&&\s*inflight\s*===\s*0/);
    // 在 maybeExitAfterDrain 里用 setImmediate 保证 stderr flush 后再 exit
    expect(SERVER_SRC).toMatch(/setImmediate\(\s*\(\s*\)\s*=>\s*process\.exit\(0\)/);
  });

  it("CallToolRequestSchema handler wraps work with inflight tracking + drain check", () => {
    // try { inflight++ ... } finally { inflight--; maybeExitAfterDrain(); }
    const match = SERVER_SRC.match(
      /inflight\+\+;[\s\S]{0,300}?finally[\s\S]{0,200}?inflight--;\s*maybeExitAfterDrain\(\)/,
    );
    expect(match).toBeTruthy();
  });

  it("installAutoRestart is invoked before connecting stdio transport", () => {
    const installIdx = SERVER_SRC.indexOf("installAutoRestart()");
    const connectIdx = SERVER_SRC.indexOf("server.connect(transport)");
    expect(installIdx).toBeGreaterThan(0);
    expect(connectIdx).toBeGreaterThan(installIdx);
  });

  it("watcher.on('error') degrades gracefully without crashing server", () => {
    expect(SERVER_SRC).toMatch(/watcher\.on\(\s*["']error["']/);
    expect(SERVER_SRC).toMatch(/auto-restart disabled/);
  });

  it("watch only reacts to .js files (avoid triggering on .map / .d.ts noise)", () => {
    expect(SERVER_SRC).toMatch(/filename\.endsWith\(["']\.js["']\)/);
  });

  it("supervised 模式下禁用自重启(由 supervisor 接管生命周期)", () => {
    expect(SERVER_SRC).toMatch(/VORTEX_MCP_SUPERVISED["']?\s*===\s*["']1["']/);
    // 守卫必须在 AUTO_RESTART 检查之后、fs.watch 之前 early-return
    const supervisedIdx = SERVER_SRC.indexOf("VORTEX_MCP_SUPERVISED");
    const watchIdx = SERVER_SRC.indexOf("watch(here,");
    expect(supervisedIdx).toBeGreaterThan(0);
    expect(supervisedIdx).toBeLessThan(watchIdx);
  });
});
