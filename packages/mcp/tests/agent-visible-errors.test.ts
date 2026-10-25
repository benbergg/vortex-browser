/**
 * Author: qingwa
 * Description: 注入超时（PAGE_NOT_READY）的结构化证据向 stderr 输出，且不改变 agent 可见面。
 *
 * 背景（历史采样 / 2026-08-13 transcript 挖掘）：
 * - **当前 MCP 错误文本**（formatDispatchError）不输出 context，agent 只拿到
 *   `Error [CODE]: message` + `Hint:`；历史采样未见服务端工具错误的结构化日志，
 *   此类失败的取证只能靠 client 侧 transcript 转述，运维无法交叉核对。
 * - 本 Task 只补「证据采集能力」：错误信封带结构化 extras → MCP 侧向 stderr **输出**
 *   一行 JSON（单行可 grep）。**不改**任何错误语义、不改 agent 可见文本。
 *
 * **留存边界（务必勿夸大）**：这里只向 stderr 输出一行。该行**是否被持久留存取决于 MCP
 * 客户端对子进程 stderr 的处理**（MCP stdio 规范允许客户端捕获、转发或忽略）；
 * 本项目**未内置日志文件 sink**，本轮**也未验证客户端侧的留存行为**。
 *
 * 契约（本文件锁死）：
 * 1. PAGE_NOT_READY + 合规 context.extras ⇒ stderr 恰好一行合法单行 JSON，
 *    含 ts / code / vortex / source / module / tabId / frameId / timeoutMs；
 * 2. 其它错误码**不输出**这行（避免噪音）；extras 缺 module 或 timeoutMs 也不输出；
 * 3. 字段白名单：extras 里的多余键（如 selector / message 等页面内容）**不输出**；
 *    extras 里的 code / ts 同名键**不能覆盖**固定字段；
 * 4. 返回给 agent 的文本仍是 `Error [CODE]: message\nHint: hint`，
 *    不含 JSON、不含 extras 字段（这是**额外**通道，不是把内部字段泄给 agent）。
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

/** 构造一个 PAGE_NOT_READY 错误信封。 */
function pageNotReadyError(extras?: unknown) {
  return {
    code: "PAGE_NOT_READY",
    message: INJECT_MESSAGE,
    hint: REMOTE_HINT,
    recoverable: true,
    ...(extras === undefined ? {} : { context: { extras } }),
  };
}

describe("PAGE_NOT_READY 的结构化证据输出到 stderr", () => {
  it("向 stderr 输出恰好一行合法单行 JSON，含 ts/code/vortex/source/module/tabId/frameId/timeoutMs", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError(pageNotReadyError(EXTRAS));

      const jsonWrites = jsonWritesFrom(writeSpy);
      expect(jsonWrites, "PAGE_NOT_READY 应当输出一行 JSON 证据").toHaveLength(1);

      const raw = jsonWrites[0];
      // 单行：正文内不得有换行，只有结尾一个换行符
      expect(raw.trimEnd(), "证据行必须是单行（可 grep）").not.toContain("\n");
      expect(raw.endsWith("\n"), "证据行应以换行结尾").toBe(true);

      const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
      expect(parsed.code).toBe("PAGE_NOT_READY");
      expect(parsed.vortex).toBe("page_not_ready");
      // 来源标记：把注入超时与将来别的 PAGE_NOT_READY 生产者区分开
      expect(parsed.source).toBe("page-side-loader");
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

  it("非 PAGE_NOT_READY 的错误不输出这行（避免噪音）", async () => {
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

  it("PAGE_NOT_READY 但无 context.extras 时不输出空壳行", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError(pageNotReadyError());

      expect(jsonWritesFrom(writeSpy)).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("extras 缺 module 时不输出（不是注入超时就别混进注入超时统计）", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError(
        pageNotReadyError({ tabId: 42, frameId: null, timeoutMs: 3000 }),
      );

      expect(jsonWritesFrom(writeSpy)).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("extras 缺 timeoutMs 时不输出", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError(
        pageNotReadyError({ module: "dom-resolve", tabId: 42, frameId: null }),
      );

      expect(jsonWritesFrom(writeSpy)).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("extras 里的多余敏感键（selector / message / 页面文本）不输出", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError(
        pageNotReadyError({
          ...EXTRAS,
          selector: "#secret-password-field",
          message: "内部错误原文，可能含页面内容",
          snapshotId: "snap_abc123",
          body: "用户页面里的秘密文本",
        }),
      );

      const jsonWrites = jsonWritesFrom(writeSpy);
      expect(jsonWrites).toHaveLength(1);
      const raw = jsonWrites[0];
      // 白名单之外的东西一律不出现在证据行里
      expect(raw).not.toContain("secret-password-field");
      expect(raw).not.toContain("内部错误原文");
      expect(raw).not.toContain("snap_abc123");
      expect(raw).not.toContain("用户页面里的秘密文本");
      expect(raw).not.toContain("selector");
      expect(raw).not.toContain("snapshotId");

      const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        "code",
        "frameId",
        "module",
        "source",
        "tabId",
        "timeoutMs",
        "ts",
        "vortex",
      ]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("extras 里的 code / ts / vortex 同名键不能覆盖固定字段", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError(
        pageNotReadyError({
          ...EXTRAS,
          code: "SPOOFED_CODE",
          ts: "1999-01-01T00:00:00.000Z",
          vortex: "spoofed",
          source: "spoofed-source",
        }),
      );

      const jsonWrites = jsonWritesFrom(writeSpy);
      expect(jsonWrites).toHaveLength(1);
      const parsed = JSON.parse(jsonWrites[0].trim()) as Record<string, unknown>;
      expect(parsed.code).toBe("PAGE_NOT_READY");
      expect(parsed.vortex).toBe("page_not_ready");
      expect(parsed.source).toBe("page-side-loader");
      expect(String(parsed.ts)).not.toBe("1999-01-01T00:00:00.000Z");
      expect(String(parsed.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("extras 是数组时不输出（extras 的契约是键值对）", async () => {
    const writeSpy = captureStderr();
    try {
      await callExtractWithError(pageNotReadyError(["dom-resolve", 42]));

      expect(jsonWritesFrom(writeSpy)).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("证据输出不改变 agent 可见面", () => {
  it("返回给 agent 的仍是 Error [CODE]: message\\nHint: hint，不含 JSON 与 extras 字段", async () => {
    const writeSpy = captureStderr();
    try {
      const res = await callExtractWithError(pageNotReadyError(EXTRAS));

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
