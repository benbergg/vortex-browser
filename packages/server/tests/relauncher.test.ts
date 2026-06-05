import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execSync: vi.fn(),
}));

import { spawn } from "child_process";
import {
  parseChromeBin,
  resolveChromeBin,
  buildRelaunchScript,
  relaunchTrusted,
  DEFAULT_CHROME_BIN,
} from "../src/relauncher.js";

const MAIN_LINE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --silent-debugger-extension-api";
const HELPER_LINE = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer";

describe("relauncher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parseChromeBin 从 ps 提主进程路径,排除 Helper", () => {
    const ps = `${HELPER_LINE}\n${MAIN_LINE}\n`;
    expect(parseChromeBin(ps)).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("parseChromeBin 无参数启动也能提取", () => {
    expect(parseChromeBin("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n"))
      .toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("parseChromeBin 无 Chrome 行返回 null", () => {
    expect(parseChromeBin("/usr/bin/node foo\n")).toBeNull();
  });

  it("resolveChromeBin 注入空 ps → 默认路径", () => {
    expect(resolveChromeBin("")).toBe(DEFAULT_CHROME_BIN);
  });

  it("buildRelaunchScript 含 killall + sleep 3 + flag + 二进制路径", () => {
    const s = buildRelaunchScript("/X/Google Chrome");
    expect(s).toContain('killall "Google Chrome"');
    expect(s).toContain("sleep 3");
    expect(s).toContain("--silent-debugger-extension-api");
    expect(s).toContain('"/X/Google Chrome"');
  });

  it("relaunchTrusted 以 detached+stdio:ignore spawn 并 unref", () => {
    const unref = vi.fn();
    vi.mocked(spawn).mockReturnValue({ unref } as never);
    relaunchTrusted("/X/Google Chrome");
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(cmd).toBe("/bin/sh");
    expect(args?.[0]).toBe("-c");
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
