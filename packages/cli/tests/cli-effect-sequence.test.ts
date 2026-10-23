/**
 * Author: qingwa
 * Description: CLI 的 effect / observeEffect / sequence 契约（最终整体评审 Important 6 + 7）。
 *
 * 覆盖三件事：
 * 1. **effect 通路**：`vortex act --observe-effect` 把开关透传到扩展，
 *    并且默认输出里能看到副作用信号（DOM 变更 / 网络请求 / URL / 焦点 / ARIA / 反馈）。
 * 2. **sequence 通路**：`vortex sequence --steps '[...]'` 一次跑多步，每步自证，
 *    输出里能看到 executed_verified / executed_unverified / failed / not_executed。
 *    判定口径与 MCP 的 vortex_sequence 同源（@vortex-browser/shared 的 sequence.ts）。
 * 3. **输出形态**：observe / act / sequence 默认给人看的几行，`--json` 回到原始 JSON；
 *    既有命令的默认 NDJSON 一律不动。
 *
 * 传输层 mock 掉 sendRequest：这里验的是 CLI 侧的契约（发什么、怎么呈现），
 * 不碰扩展的真行为。
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

const CLICK_EFFECT = {
  domMutations: 2,
  networkRequests: 1,
  urlChanged: false,
  focusChanged: true,
  ariaChanged: false,
  userFeedback: "toast",
};

let stateDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "vortex-cli-effect-"));
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

function outText(): string {
  return stdout.join("\n");
}

/** 先 observe 一次，把 @e12 登记进快照上下文。 */
async function seedObserve(): Promise<void> {
  sendRequestMock.mockResolvedValueOnce({
    action: "observe.snapshot",
    id: "cli-observe",
    result: OBSERVE_RESULT,
  });
  await run(["observe", "--json"]);
}

describe("vortex act 的 effect 通路", () => {
  it("--observe-effect 把开关透传给扩展，默认输出里能看到副作用信号", async () => {
    await seedObserve();
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.click",
      id: "cli-click",
      result: { success: true, element: { tag: "button", id: "save" }, effect: CLICK_EFFECT },
    });

    await run(["act", "--action", "click", "--target", "@e12", "--observe-effect"]);

    const [action, params] = sendRequestMock.mock.calls[1];
    expect(action).toBe("dom.click");
    expect(params.observeEffect).toBe(true);

    const out = outText();
    expect(out).toContain("click @e12");
    expect(out).toContain("domMutations=2");
    expect(out).toContain("networkRequests=1");
    expect(out).toContain("focusChanged=true");
    expect(out).toContain("userFeedback=toast");
  });

  it("--window-ms 一并透传", async () => {
    await seedObserve();
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.click",
      id: "cli-click",
      result: { success: true },
    });

    await run(["act", "--action", "click", "--target", "@e12", "--observe-effect", "--window-ms", "800"]);

    const [, params] = sendRequestMock.mock.calls[1];
    expect(params.observeEffect).toBe(true);
    expect(params.windowMs).toBe(800);
  });

  it("默认输出是人看的几行，--json 才回到原始 JSON", async () => {
    await seedObserve();
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.click",
      id: "cli-click",
      result: { success: true, effect: CLICK_EFFECT },
    });

    await run(["act", "--action", "click", "--target", "@e12", "--observe-effect"]);
    expect(outText()).not.toContain("\"action\":\"dom.click\"");
    expect(outText()).toContain("click @e12 → success");

    stdout = [];
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.click",
      id: "cli-click",
      result: { success: true, effect: CLICK_EFFECT },
    });
    await run(["act", "--action", "click", "--target", "@e12", "--observe-effect", "--json"]);
    const parsed = JSON.parse(outText());
    expect(parsed.action).toBe("dom.click");
    expect(parsed.result.effect.userFeedback).toBe("toast");
  });
});

describe("vortex sequence 的多步自证", () => {
  it("按序执行每一步，click/hover 强制采集副作用信号", async () => {
    await seedObserve();
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.click",
      id: "s1",
      result: { success: true, effect: CLICK_EFFECT },
    });
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.fill",
      id: "s2",
      result: { value: "hello" },
    });

    await run([
      "sequence",
      "--steps",
      JSON.stringify([
        { action: "click", target: "@e12" },
        { action: "fill", target: "@e12", value: "hello" },
      ]),
    ]);

    expect(sendRequestMock.mock.calls[1][0]).toBe("dom.click");
    expect(sendRequestMock.mock.calls[1][1].observeEffect).toBe(true);
    expect(sendRequestMock.mock.calls[2][0]).toBe("dom.fill");
    expect(sendRequestMock.mock.calls[2][1].observeEffect).toBeUndefined();

    const out = outText();
    expect(out).toContain("sequence 2 steps");
    expect(out).toContain("executed_verified");
    expect(out).toContain("summary: total=2 verified=2");
  });

  it("一步失败就停：该步 failed，后续步 not_executed", async () => {
    await seedObserve();
    sendRequestMock.mockRejectedValueOnce(new Error("Error [NOT_FOUND]: 元素没了"));

    await run([
      "sequence",
      "--steps",
      JSON.stringify([
        { action: "click", target: "@e12" },
        { action: "click", target: "@e12" },
      ]),
    ]);

    const out = outText();
    expect(out).toContain("failed");
    expect(out).toContain("not_executed");
    expect(out).toContain("summary: total=2 verified=0 unverified=0 failed=1 not_executed=1");
    // 失败即止：第二步根本没发出去
    expect(sendRequestMock).toHaveBeenCalledTimes(2);
  });

  it("--on-failure continue 时失败后继续跑完", async () => {
    await seedObserve();
    sendRequestMock.mockRejectedValueOnce(new Error("Error [NOT_FOUND]: 元素没了"));
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.click",
      id: "s2",
      result: { success: true, effect: CLICK_EFFECT },
    });

    await run([
      "sequence",
      "--on-failure",
      "continue",
      "--steps",
      JSON.stringify([
        { action: "click", target: "@e12" },
        { action: "click", target: "@e12" },
      ]),
    ]);

    expect(sendRequestMock).toHaveBeenCalledTimes(3);
    expect(outText()).toContain("failed=1");
    expect(outText()).toContain("verified=1");
  });

  it("--json 输出原始报告（summary + steps）", async () => {
    await seedObserve();
    stdout = [];
    sendRequestMock.mockResolvedValueOnce({
      action: "dom.click",
      id: "s1",
      result: { success: true, effect: CLICK_EFFECT },
    });

    await run([
      "sequence",
      "--json",
      "--steps",
      JSON.stringify([{ action: "click", target: "@e12" }]),
    ]);

    const parsed = JSON.parse(outText());
    expect(parsed.summary.total).toBe(1);
    expect(parsed.summary.verified).toBe(1);
    expect(parsed.steps[0].state).toBe("executed_verified");
    expect(parsed.steps[0].effect).toBe("confirmed");
  });

  it("steps 形状不合法直接报错，不发请求", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["sequence", "--steps", "not-json"])).rejects.toThrow("__exit__");

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("INVALID_PARAMS");
    exit.mockRestore();
  });
});

describe("vortex observe 的输出形态", () => {
  it("默认给人看的几行，--json 才回到原始 JSON", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-observe",
      result: OBSERVE_RESULT,
    });

    await run(["observe"]);

    const out = outText();
    expect(out).toContain("snapshot snap_abc123");
    expect(out).toContain("2 elements");
    expect(out).toContain("@e12");
    expect(out).not.toContain("\"action\":\"observe.snapshot\"");

    stdout = [];
    sendRequestMock.mockResolvedValueOnce({
      action: "observe.snapshot",
      id: "cli-observe",
      result: OBSERVE_RESULT,
    });
    await run(["observe", "--json"]);
    const parsed = JSON.parse(outText());
    expect(parsed.result.snapshotId).toBe("snap_abc123");
  });
});

describe("既有命令的默认 NDJSON 不动", () => {
  it("vortex js evaluate 仍然一行 NDJSON", async () => {
    sendRequestMock.mockResolvedValueOnce({
      action: "js.evaluate",
      id: "cli-js",
      result: "42",
    });

    await run(["js", "evaluate", "return 42;"]);

    expect(stdout.length).toBe(1);
    expect(() => JSON.parse(stdout[0])).not.toThrow();
  });
});
