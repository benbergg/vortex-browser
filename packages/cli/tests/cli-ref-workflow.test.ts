/**
 * Author: qingwa
 * Description: 验证 vortex observe 的 ref 提取与 vortex act 的 ref 目标透传。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendRequestMock } = vi.hoisted(() => ({ sendRequestMock: vi.fn() }));

vi.mock("../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client.js")>();
  return {
    ...actual,
    sendRequest: (...args: unknown[]) => sendRequestMock(...args),
  };
});

import { formatCliError } from "../src/client.js";
import { createProgram } from "../src/index.js";

const OBSERVE_RESULT = {
  snapshotId: "snap_abc123",
  version: 2,
  url: "https://example.com/",
  title: "Example",
  elements: [
    { index: 12, ref: "@e12", frameId: 0, role: "button", name: "保存" },
    { index: 3, ref: "@f1e3", frameId: 1, role: "textbox", name: "备注" },
  ],
};

let stateDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "vortex-cli-ref-"));
  process.env.VORTEX_CLI_STATE_DIR = stateDir;
  sendRequestMock.mockReset();
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.VORTEX_CLI_STATE_DIR;
});

async function run(argv: string[]): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv, { from: "user" });
}

function combinedOutput(): string {
  return [...stdout, ...stderr].join("\n");
}

describe("vortex observe 的 ref 提取", () => {
  it("把服务端返回的 ref 提取出来并打印 [refs] 行", async () => {
    sendRequestMock.mockResolvedValue({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });

    await run(["observe"]);

    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    const [action] = sendRequestMock.mock.calls[0];
    expect(action).toBe("observe.snapshot");

    const output = combinedOutput();
    expect(output).toContain("[refs]");
    expect(output).toContain("@e12");
    expect(output).toContain("@f1e3");
  });

  it("stdout 保持 NDJSON（可直接喂 jq），[refs] 行不污染 stdout", async () => {
    sendRequestMock.mockResolvedValue({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });

    await run(["observe"]);

    expect(stdout.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stdout.join("\n"))).not.toThrow();
  });

  it("非法 --frames 直接报错，不发请求", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["observe", "--frames", "all-permited"])).rejects.toThrow("__exit__");

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("INVALID_PARAMS");
    expect(stderr.join("\n")).toContain("all-permitted");
    exit.mockRestore();
  });
});

describe("vortex act 的 ref 目标", () => {
  it("target 原样是 ref，不是 CSS selector", async () => {
    sendRequestMock.mockResolvedValue({ action: "dom.click", id: "cli-2", result: { ok: true } });

    await run(["act", "--action", "click", "--target", "@e12"]);

    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    const [action, params] = sendRequestMock.mock.calls[0];
    expect(action).toBe("dom.click");
    expect(params.target).toBe("@e12");
    expect(params.selector).toBeUndefined();
  });

  it("observe 之后用同一个 ref 能带上 index 与 snapshotId", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-3",
      result: OBSERVE_RESULT,
    });
    await run(["observe"]);

    sendRequestMock.mockResolvedValueOnce({ action: "dom.click", id: "cli-4", result: { ok: true } });
    await run(["act", "--action", "click", "--target", "@e12"]);

    const [action, params] = sendRequestMock.mock.calls[1];
    expect(action).toBe("dom.click");
    expect(params.target).toBe("@e12");
    expect(params.index).toBe(12);
    expect(params.snapshotId).toBe("snap_abc123");
  });

  it("CSS selector 落到 selector 字段", async () => {
    sendRequestMock.mockResolvedValue({ action: "dom.click", id: "cli-5", result: { ok: true } });

    await run(["act", "--action", "click", "--target", "button.save"]);

    const [action, params] = sendRequestMock.mock.calls[0];
    expect(action).toBe("dom.click");
    expect(params.target).toBe("button.save");
    expect(params.selector).toBe("button.save");
  });

  it("非法 action 直接报错，不发请求", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["act", "--action", "nope", "--target", "@e12"])).rejects.toThrow("__exit__");

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("INVALID_PARAMS");
    exit.mockRestore();
  });

  it("服务端错误按 formatCliError 形态透出", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    sendRequestMock.mockRejectedValue(
      new Error(formatCliError({
        code: "STALE_SNAPSHOT",
        message: "ref 已过期",
        hint: "重新 observe 再试",
        recoverable: true,
      })),
    );

    await expect(run(["act", "--action", "click", "--target", "@e12"])).rejects.toThrow("__exit__");

    const err = stderr.join("\n");
    expect(err).toContain("Error [STALE_SNAPSHOT]:");
    expect(err).toContain("ref 已过期");
    expect(err).toContain("hint: 重新 observe 再试");
    exit.mockRestore();
  });
});
