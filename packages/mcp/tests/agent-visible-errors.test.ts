/**
 * Author: qingwa
 * Description: 注入超时（PAGE_NOT_READY）的结构化证据落 stderr，且不改变 agent 可见面。
 *
 * 背景（7 天日志分析 / 2026-08-13 transcript 挖掘）：
 * - 服务端此前**零工具级原始日志**——hub 只在启动时写一行 `[hub] listening on ...`，
 *   5 次 PAGE_NOT_READY 只有 client 侧 transcript 可查，运维与 agent 都拿不到
 *   `context.extras` 里的诊断信息（渲染层 formatDispatchError 不输出 context）。
 * - 本 Task 只补「证据采集能力」：错误信封带结构化 extras → MCP 侧向 stderr 落
 *   **一行** JSON（单行可 grep）。**不改**任何错误语义、不改 agent 可见文本。
 *
 * 契约（本文件锁死）：
 * 1. PAGE_NOT_READY + context.extras ⇒ stderr 恰好一行合法单行 JSON，
 *    含 ts / code / module / tabId / frameId / timeoutMs；
 * 2. 其它错误码**不写**这行（避免噪音）；
 * 3. 返回给 agent 的文本仍是 `Error [CODE]: message\nHint: hint`，
 *    不含 JSON、不含 extras 字段（落盘是**额外**通道，不是把内部字段泄给 agent）。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: {
    drain: vi.fn(() => []),
    subscribe: vi.fn(() => "sub_test"),
    unsubscribe: vi.fn(() => true),
  },
}));

const INJECT_MESSAGE =
  'page-side module "dom-resolve" injection timed out after 3000ms ' +
  "(target tab likely in a bad SW/navigation state); cache evicted, retryable";

/**
 * 远端 hint 用字面量而非从 @vortex-browser/shared 导入：
 * MCP 层的契约是「远端 hint 原样透传」，不是「知道 shared 里那条文案长什么样」。
 * 写成导入会让本用例依赖 shared 包的构建顺序（shared 的 main 指向 dist/）。
 */
const REMOTE_HINT =
  "Vortex could not inject its own page-side helper into the target tab within 3000ms. " +
  "Call vortex_navigate to reload the tab and retry the same call; vortex_observe on the same tab may still work.";

const EXTRAS = {
  module: "dom-resolve",
  tabId: 42,
  frameId: null,
  timeoutMs: 3000,
};

/** 走真实错误出口：handleCallTool → sendRequest（mock）→ resp.error 分支。 */
async function callExtractWithError(error: unknown) {
  const { sendRequest } = await import("../src/client.js");
  vi.mocked(sendRequest).mockResolvedValue({
    action: "content.getText",
    id: "mcp-1-1780000000000",
    error,
  } as never);
  const { handleCallTool } = await import("../src/server.js");
  return handleCallTool({ params: { name: "vortex_extract", arguments: {} } });
}

/** 取出 stderr 写入里形如 JSON 的整行（用于筛出本 Task 的证据行）。 */
function jsonWritesFrom(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c) => (typeof c[0] === "string" ? (c[0] as string) : ""))
    .filter((s) => s.trim().startsWith("{") && s.trim().endsWith("}"));
}

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("PAGE_NOT_READY 的结构化证据落 stderr", () => {
  it("向 stderr 落恰好一行合法单行 JSON，含 ts/code/module/tabId/frameId/timeoutMs", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError({
        code: "PAGE_NOT_READY",
        message: INJECT_MESSAGE,
        hint: REMOTE_HINT,
        recoverable: true,
        context: { extras: EXTRAS },
      });

      const jsonWrites = jsonWritesFrom(writeSpy);
      expect(jsonWrites, "PAGE_NOT_READY 应当落一行 JSON 证据").toHaveLength(1);

      const raw = jsonWrites[0];
      // 单行：正文内不得有换行，只有结尾一个换行符
      expect(raw.trimEnd(), "证据行必须是单行（可 grep）").not.toContain("\n");
      expect(raw.endsWith("\n"), "证据行应以换行结尾").toBe(true);

      const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
      expect(parsed.code).toBe("PAGE_NOT_READY");
      expect(parsed.module).toBe("dom-resolve");
      expect(parsed.tabId).toBe(42);
      expect(parsed.frameId).toBeNull();
      expect(parsed.timeoutMs).toBe(3000);
      expect(typeof parsed.ts).toBe("string");
      expect(String(parsed.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("非 PAGE_NOT_READY 的错误不落这行（避免噪音）", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError({
        code: "TIMEOUT",
        message: "Action content.getText exceeded its 30000ms budget",
        context: { extras: { action: "content.getText", budgetMs: 30000 } },
      });

      expect(jsonWritesFrom(writeSpy)).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("PAGE_NOT_READY 但无 context.extras 时不落空壳行", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError({
        code: "PAGE_NOT_READY",
        message: INJECT_MESSAGE,
        hint: REMOTE_HINT,
      });

      expect(jsonWritesFrom(writeSpy)).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("证据落盘不改变 agent 可见面", () => {
  it("返回给 agent 的仍是 Error [CODE]: message\\nHint: hint，不含 JSON 与 extras 字段", async () => {
    const writeSpy = captureStderr();
    try {
      const res = await callExtractWithError({
        code: "PAGE_NOT_READY",
        message: INJECT_MESSAGE,
        hint: REMOTE_HINT,
        recoverable: true,
        context: { extras: EXTRAS },
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { text: string }).text;
      expect(text).toBe(
        `Error [PAGE_NOT_READY]: ${INJECT_MESSAGE}\nHint: ${REMOTE_HINT}`,
      );
      // 不得把内部结构化字段泄给 agent
      expect(text).not.toMatch(/[{}]/);
      expect(text).not.toContain("timeoutMs");
      expect(text).not.toContain("tabId");
      expect(text).not.toContain("frameId");
      expect(text).not.toContain('"module"');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
