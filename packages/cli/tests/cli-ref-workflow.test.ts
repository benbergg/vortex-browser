/**
 * Author: qingwa
 * Description: 验证 vortex observe 的 ref 提取与 vortex act 的 ref 目标透传。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

/** compact 形态：元素只有 index，服务端没有给 ref。 */
const COMPACT_RESULT = {
  snapshotId: "snap_compact_1",
  version: 2,
  url: "https://example.com/",
  title: "Example",
  elements: [
    { index: 12, frameId: 0, role: "button", name: "保存" },
    { index: 3, frameId: 1, role: "textbox", name: "备注" },
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

/** 快照上下文里登记过的 ref（空数组 = 没有登记任何 ref）。 */
function registeredRefs(): string[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((file) => file.endsWith(".snapshot.json"))
    .flatMap((file) => {
      const context = JSON.parse(readFileSync(join(stateDir, file), "utf8")) as {
        refs?: Record<string, unknown>;
      };
      return Object.keys(context.refs ?? {});
    });
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

  it("stdout 默认是可读输出，--json 时保持 NDJSON（可直接喂 jq），[refs] 行不污染 stdout", async () => {
    sendRequestMock.mockResolvedValue({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });

    await run(["observe"]);

    // 默认：人看的几行（不是 JSON）
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout.join("\n")).toContain("snapshot snap_abc123");
    expect(() => JSON.parse(stdout.join("\n"))).toThrow();

    // --json：一行 NDJSON，jq 能直接吃
    stdout = [];
    await run(["observe", "--json"]);
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

  it("compact 返回不登记任何 ref", async () => {
    sendRequestMock.mockResolvedValue({
      action: "observe.snapshot",
      id: "cli-1",
      result: COMPACT_RESULT,
    });

    await run(["observe", "--detail", "compact"]);

    // compact 元素没有服务端 ref：不打印、不登记
    expect(combinedOutput()).not.toContain("[refs]");
    expect(combinedOutput()).not.toContain("@e12");
    expect(registeredRefs()).toEqual([]);
  });

  it("上下文里没有该 ref 时同样报错且不发请求", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    sendRequestMock.mockResolvedValue({
      action: "observe.snapshot",
      id: "cli-1",
      result: COMPACT_RESULT,
    });
    await run(["observe", "--detail", "compact"]);
    sendRequestMock.mockReset();

    await expect(run(["act", "--action", "click", "--target", "@e12"])).rejects.toThrow("__exit__");

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("vortex observe");
    exit.mockRestore();
  });
});

describe("vortex act 的 ref 目标", () => {
  it("未知 ref 直接报错提示先跑 observe，不发请求", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["act", "--action", "click", "--target", "@e12"])).rejects.toThrow("__exit__");

    expect(sendRequestMock).not.toHaveBeenCalled();
    const err = stderr.join("\n");
    expect(err).toContain("INVALID_PARAMS");
    expect(err).toContain("@e12");
    expect(err).toContain("vortex observe");
    exit.mockRestore();
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
    expect(params.selector).toBeUndefined();
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
    // 先 observe 登记 ref，请求才真的发得出去（未知 ref 会在客户端就被拦下）。
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-6",
      result: OBSERVE_RESULT,
    });
    await run(["observe"]);

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
