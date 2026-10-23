/**
 * Author: qingwa
 * Description: 验证快照上下文按 tab 隔离 —— 旧 tab 的 ref 不得被另一个 tab 沿用。
 *
 * 背景（最终整体评审 Important 1）：快照上下文原先只按 session 存一份，
 * 于是 `observe --tab A` 之后 `act --tab B --target @eN` 仍会发 A 的 snapshotId，
 * 而扩展 resolveTarget 的 boundTabId 又优先于请求里的 tab ⇒ 实际点在 A 上。
 *
 * 契约：快照上下文带 tab 维度（session + tab）；请求的 tab 与 ref 所属 tab 不一致时
 * 报**可恢复错误**（提示先对该 tab 重新 observe），绝不跨 tab 沿用旧 snapshotId。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

import { createProgram } from "../src/index.js";

const OBSERVE_RESULT = {
  snapshotId: "snap_tab5",
  version: 2,
  url: "https://example.com/",
  title: "Example",
  elements: [{ index: 12, ref: "@e12", frameId: 0, role: "button", name: "保存" }],
};

let stateDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "vortex-cli-tab-"));
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

/** 状态目录里落盘的快照上下文（新版按 tab 分槽）。 */
function storedSlots(): Record<string, { tabId: number | null; refs: string[] }> {
  const files = readdirSync(stateDir).filter((f) => f.endsWith(".snapshot.json"));
  if (files.length === 0) return {};
  const raw = JSON.parse(readFileSync(join(stateDir, files[0]), "utf8")) as {
    slots?: Record<string, { tabId?: number | null; refs?: Record<string, unknown> }>;
  };
  const out: Record<string, { tabId: number | null; refs: string[] }> = {};
  for (const [slot, ctx] of Object.entries(raw.slots ?? {})) {
    out[slot] = { tabId: ctx.tabId ?? null, refs: Object.keys(ctx.refs ?? {}) };
  }
  return out;
}

describe("快照上下文按 tab 隔离", () => {
  it("observe --tab 5 把快照登记在 tab 5 的槽位上", async () => {
    sendRequestMock.mockResolvedValue({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });

    await run(["observe", "--tab", "5"]);

    const slots = storedSlots();
    expect(Object.keys(slots)).toEqual(["5"]);
    expect(slots["5"].tabId).toBe(5);
    expect(slots["5"].refs).toEqual(["@e12"]);
  });

  it("observe --tab 5 后 act --tab 5 能带上 index 与 snapshotId", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });
    await run(["observe", "--tab", "5"]);

    sendRequestMock.mockResolvedValueOnce({ action: "dom.click", id: "cli-2", result: { ok: true } });
    await run(["act", "--action", "click", "--target", "@e12", "--tab", "5"]);

    const [action, params] = sendRequestMock.mock.calls[1];
    expect(action).toBe("dom.click");
    expect(params.index).toBe(12);
    expect(params.snapshotId).toBe("snap_tab5");
  });

  it("observe --tab 5 后 act --tab 7 报可恢复错误，绝不跨 tab 沿用旧 snapshotId", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });
    await run(["observe", "--tab", "5"]);
    sendRequestMock.mockReset();

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(
      run(["act", "--action", "click", "--target", "@e12", "--tab", "7"]),
    ).rejects.toThrow("__exit__");

    // 请求根本没发出去（更没有带着 tab 5 的 snapshotId 发出去）
    expect(sendRequestMock).not.toHaveBeenCalled();
    const err = stderr.join("\n");
    expect(err).toContain("@e12");
    expect(err).toContain("5");
    expect(err).toContain("7");
    expect(err).toContain("recoverable: true");
    // hint 必须指引"先对该 tab 重新 observe"
    expect(err).toMatch(/hint:.*observe/);
    exit.mockRestore();
  });

  it("observe --tab 5 后 act（未指定 tab）同样被拒：不能跨 tab 沿用", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });
    await run(["observe", "--tab", "5"]);
    sendRequestMock.mockReset();

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["act", "--action", "click", "--target", "@e12"])).rejects.toThrow("__exit__");

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("recoverable: true");
    exit.mockRestore();
  });

  it("observe（未指定 tab）后 act --tab 7 被拒：未指定 tab 的快照不等于任意 tab 的快照", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });
    await run(["observe"]);
    sendRequestMock.mockReset();

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(
      run(["act", "--action", "click", "--target", "@e12", "--tab", "7"]),
    ).rejects.toThrow("__exit__");

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("recoverable: true");
    exit.mockRestore();
  });

  it("observe（未指定 tab）后 act（未指定 tab）仍然可用（同一槽位）", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-1",
      result: OBSERVE_RESULT,
    });
    await run(["observe"]);

    sendRequestMock.mockResolvedValueOnce({ action: "dom.click", id: "cli-2", result: { ok: true } });
    await run(["act", "--action", "click", "--target", "@e12"]);

    const [, params] = sendRequestMock.mock.calls[1];
    expect(params.index).toBe(12);
    expect(params.snapshotId).toBe("snap_tab5");
  });

  it("同一 session 的两个 tab 各存各的快照，互不覆盖", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-1",
      result: { ...OBSERVE_RESULT, snapshotId: "snap_tab5" },
    });
    await run(["observe", "--tab", "5"]);

    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-2",
      result: { ...OBSERVE_RESULT, snapshotId: "snap_tab7" },
    });
    await run(["observe", "--tab", "7"]);

    const slots = storedSlots();
    expect(Object.keys(slots).sort()).toEqual(["5", "7"]);

    sendRequestMock.mockResolvedValueOnce({ action: "dom.click", id: "cli-3", result: { ok: true } });
    await run(["act", "--action", "click", "--target", "@e12", "--tab", "7"]);

    const [, params] = sendRequestMock.mock.calls[2];
    expect(params.snapshotId).toBe("snap_tab7");
  });
});
