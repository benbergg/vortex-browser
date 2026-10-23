/**
 * Author: qingwa
 * Description: 验证快照上下文按**实际 tab 身份**隔离 —— 旧 tab 的 ref 不得被另一个 tab 沿用。
 *
 * 背景（最终整体评审 Important 1 + 定向修复轮 Important ①）：
 * 快照上下文原先只按 session 存一份，于是 `observe --tab A` 之后 `act --tab B --target @eN`
 * 仍会发 A 的 snapshotId，而扩展 resolveTarget 的 boundTabId 又优先于请求里的 tab ⇒ 实际点在 A 上。
 * 定向修复轮进一步指出：**「用户有没有传 --tab」不是 tab 身份**。
 * 未指定 tab 时，observe 落在**该 session 当时的当前 tab**上；之后 session 切了 tab，
 * 无参数 act 就必须报错，而不是沿用旧 tab 的快照；反过来，同一个 tab 的 `act --tab A` 必须放行。
 *
 * 契约：
 * 1. 快照上下文按**解析后的实际 tab**分槽落盘（不再是「current」这个伪槽位）；
 * 2. act 校验的是**实际 tab 身份**：请求目标 tab 的槽位里有这个 ref 才放行；
 * 3. ref 属于别的 tab 时报**可恢复错误**（提示先对该 tab 重新 observe），绝不跨 tab 沿用旧 snapshotId；
 * 4. 实际 tab 判不出来时**宁可拒绝**，也不沿用可能属于别的 tab 的快照；
 * 5. observe 在**请求发出前**解析目标 tab，请求参数（显式 tabId）与快照登记用**同一个**身份：
 *    请求在途期间同 session 切了 current tab，快照也不会被登记到别的 tab 上（并发竞态）。
 *
 * 传输层 mock 掉 sendRequest，并**照抄 hub 的会话 tab 语义**：
 * 带 tabId 的请求会把该 tab 认领为 session 当前 tab；不带 tabId 的请求落在 session 当前 tab 上
 * （没有当前 tab 时认领 active tab）；tab.create 也会把 session 当前 tab 切到新建的 tab。
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

/** 模拟器里的一个 tab（字段对齐扩展 tab.list + hub 标注）。 */
interface FakeTab {
  id: number;
  active: boolean;
  lastFocused: boolean;
  /** tab 的 URL（扩展 tab.list 会带上；内部页如 chrome:// 不能当工作 tab）。 */
  url?: string;
}

/** 模拟 hub 的会话 tab 状态。 */
interface HubState {
  tabs: FakeTab[];
  /** hub 侧的 session.currentTabId（null = 还没认领任何 tab）。 */
  currentTabId: number | null;
  /** observe.snapshot 的返回体。 */
  observeResult: unknown;
  /** 自增的 tab id。 */
  nextTabId: number;
  /**
   * 模拟「observe 在途期间另一个请求把 session 当前 tab 切走」：
   * observe 已经按当时的归属路由出去，响应回来之前当前 tab 已经变了。
   * undefined = 不发生切换。
   */
  tabSwitchDuringObserve?: number | null;
  /** tab.list 直接失败（模拟扩展没连上等读不到 tab 的情况）。 */
  tabListError?: Error;
}

let state: HubState;
let stateDir: string;
let stdout: string[];
let stderr: string[];

const SESSION = "test-session";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "vortex-cli-tab-"));
  process.env.VORTEX_CLI_STATE_DIR = stateDir;
  process.env.VORTEX_SESSION_NAME = SESSION;
  state = {
    tabs: [
      { id: 5, active: true, lastFocused: true, url: "https://example.com/" },
      { id: 7, active: false, lastFocused: false, url: "https://example.com/other" },
    ],
    currentTabId: null,
    observeResult: OBSERVE_RESULT,
    nextTabId: 8,
  };
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });
  sendRequestMock.mockReset();
  sendRequestMock.mockImplementation(async (action: string, _params: unknown, opts: any) => {
    const explicitTab = typeof opts?.tabId === "number" ? opts.tabId : undefined;
    if (action === "tab.list") {
      if (state.tabListError) throw state.tabListError;
      return {
        action,
        id: "cli-tab-list",
        // hub 的标注：current = session.currentTabId === tabId
        result: state.tabs.map((t) => ({ ...t, current: t.id === state.currentTabId })),
      };
    }
    if (action === "tab.create") {
      const id = state.nextTabId++;
      state.tabs.push({ id, active: false, lastFocused: false, url: "https://example.com/created" });
      // hub：tab.create 之后 session 当前 tab 变成新建的 tab
      state.currentTabId = id;
      return { action, id: "cli-tab-create", result: { id } };
    }
    if (action === "observe.snapshot") {
      // hub 的 tab 归属：显式 tabId 直接认领；没带 tabId 落在 session 当前 tab 上
      if (explicitTab !== undefined) {
        state.currentTabId = explicitTab;
      } else if (state.currentTabId === null) {
        const active = state.tabs.find((t) => t.active);
        if (active) state.currentTabId = active.id;
      }
      // observe 已经在途：此刻另一个请求把 session 当前 tab 切走
      if (state.tabSwitchDuringObserve !== undefined) {
        state.currentTabId = state.tabSwitchDuringObserve;
      }
      return { action, id: "cli-observe", result: state.observeResult };
    }
    if (explicitTab !== undefined) state.currentTabId = explicitTab;
    return { action, id: "cli-act", result: { success: true } };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.VORTEX_CLI_STATE_DIR;
  delete process.env.VORTEX_SESSION_NAME;
});

async function run(argv: string[]): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv, { from: "user" });
}

function combinedOutput(): string {
  return [...stdout, ...stderr].join("\n");
}

/** 状态目录里落盘的快照上下文（按实际 tab 分槽）。 */
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

/** 让 session 的当前 tab 切到某个 tab（模拟同 session 激活了别的 tab）。 */
function switchSessionTab(tabId: number): void {
  state.currentTabId = tabId;
}

/**
 * 已经发出去的**动作请求**（tab.list 只是读当前 tab 的只读查询，不算动作）。
 */
function sentActionCalls(): unknown[][] {
  return sendRequestMock.mock.calls.filter((call) => call[0] !== "tab.list");
}

describe("快照上下文按实际 tab 身份隔离", () => {
  it("observe --tab 5 把快照登记在 tab 5 的槽位上", async () => {
    await run(["observe", "--tab", "5"]);

    const slots = storedSlots();
    expect(Object.keys(slots)).toEqual(["5"]);
    expect(slots["5"].tabId).toBe(5);
    expect(slots["5"].refs).toEqual(["@e12"]);
  });

  it("observe（未指定 tab）按解析出的实际 tab 落槽，不是「current」伪槽位", async () => {
    await run(["observe"]);

    const slots = storedSlots();
    // 会话当前 tab 认领到 active 的 tab 5 ⇒ 快照属于 tab 5
    expect(Object.keys(slots)).toEqual(["5"]);
    expect(slots["5"].tabId).toBe(5);
    expect(slots["5"].refs).toEqual(["@e12"]);
  });

  it("observe --tab 5 后 act --tab 5 能带上 index 与 snapshotId", async () => {
    await run(["observe", "--tab", "5"]);

    await run(["act", "--action", "click", "--target", "@e12", "--tab", "5"]);

    const [action, params] = sendRequestMock.mock.calls[1];
    expect(action).toBe("dom.click");
    expect(params.index).toBe(12);
    expect(params.snapshotId).toBe("snap_tab5");
  });

  it("observe --tab 5 后 act --tab 7 报可恢复错误，绝不跨 tab 沿用旧 snapshotId", async () => {
    await run(["observe", "--tab", "5"]);
    sendRequestMock.mockClear();

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

  it("observe（未指定 tab）后 act --tab 7 被拒：ref 属于别的 tab", async () => {
    await run(["observe"]);
    sendRequestMock.mockClear();

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

  it("observe（未指定 tab）后 act（未指定 tab）仍然可用（同一实际 tab）", async () => {
    await run(["observe"]);

    await run(["act", "--action", "click", "--target", "@e12"]);

    const clickCall = sendRequestMock.mock.calls.find((c) => c[0] === "dom.click");
    expect(clickCall).toBeDefined();
    const [, params] = clickCall as [string, Record<string, unknown>];
    expect(params.index).toBe(12);
    expect(params.snapshotId).toBe("snap_tab5");
  });

  it("observe --tab 5 后 act（未指定 tab，当前 tab 仍是 5）放行", async () => {
    await run(["observe", "--tab", "5"]);

    await run(["act", "--action", "click", "--target", "@e12"]);

    const clickCall = sendRequestMock.mock.calls.find((c) => c[0] === "dom.click");
    expect(clickCall).toBeDefined();
    const [, params] = clickCall as [string, Record<string, unknown>];
    expect(params.index).toBe(12);
    expect(params.snapshotId).toBe("snap_tab5");
  });

  it("同一 session 的两个 tab 各存各的快照，互不覆盖", async () => {
    await run(["observe", "--tab", "5"]);

    state.observeResult = { ...OBSERVE_RESULT, snapshotId: "snap_tab7" };
    await run(["observe", "--tab", "7"]);

    const slots = storedSlots();
    expect(Object.keys(slots).sort()).toEqual(["5", "7"]);

    await run(["act", "--action", "click", "--target", "@e12", "--tab", "7"]);

    const clickCall = sendRequestMock.mock.calls.find((c) => c[0] === "dom.click");
    expect(clickCall).toBeDefined();
    const [, params] = clickCall as [string, Record<string, unknown>];
    expect(params.snapshotId).toBe("snap_tab7");
  });
});

describe("定向修复轮 ①：快照必须按实际 tab 身份绑定", () => {
  it("同 tab 的显式 --tab 放行：observe（未指定 tab，落在 tab 5）后 act --tab 5 必须放行", async () => {
    await run(["observe"]);

    await run(["act", "--action", "click", "--target", "@e12", "--tab", "5"]);

    const clickCall = sendRequestMock.mock.calls.find((c) => c[0] === "dom.click");
    expect(clickCall).toBeDefined();
    const [, params] = clickCall as [string, Record<string, unknown>];
    expect(params.index).toBe(12);
    expect(params.snapshotId).toBe("snap_tab5");
    // 请求要落在被校验的那个 tab 上
    const opts = clickCall as [string, Record<string, unknown>, { tabId?: number }];
    expect(opts[2].tabId).toBe(5);
  });

  it("无参数 act 在 session 切 tab 后报错，且不发动作请求", async () => {
    await run(["observe"]);
    // 同 session 激活了别的 tab ⇒ session 当前 tab 从 5 变成 7
    switchSessionTab(7);
    sendRequestMock.mockClear();

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["act", "--action", "click", "--target", "@e12"])).rejects.toThrow("__exit__");

    // 动作请求根本没发出去：旧快照绝不能被沿用到新 tab 上
    expect(sentActionCalls()).toEqual([]);
    const err = stderr.join("\n");
    expect(err).toContain("recoverable: true");
    expect(err).toContain("5");
    expect(err).toContain("7");
    // hint 指引「对该 tab 重新 observe」
    expect(err).toMatch(/hint:.*observe/);
    exit.mockRestore();
  });

  it("observe 在途期间 current tab 被切走：快照仍登记在请求时解析出的那个 tab 上", async () => {
    // 会话当前 tab 是 5 ⇒ 这次 observe 要落在 tab 5 上
    switchSessionTab(5);
    // observe 在途期间，同 session 的另一个请求把当前 tab 切到 7
    state.tabSwitchDuringObserve = 7;

    await run(["observe"]);

    // ① 请求必须带显式 tabId —— 就是请求发出前解析出的那个身份
    const observeCall = sentActionCalls()[0];
    expect(observeCall[0]).toBe("observe.snapshot");
    expect((observeCall[2] as { tabId?: number }).tabId).toBe(5);

    // ② 登记的 tab 身份仍是请求时解析出的 5，不是切换后的 7
    const slots = storedSlots();
    expect(Object.keys(slots)).toEqual(["5"]);
    expect(slots["5"].tabId).toBe(5);
    expect(slots["5"].refs).toEqual(["@e12"]);
  });

  it("判不出实际 tab 时宁可报错，也不落快照、不沿用可能属于别的 tab 的快照", async () => {
    // hub 侧认不出任何当前 tab：tab.list 是空的
    state.tabs = [];
    state.currentTabId = null;

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    // 解析不出 tab 就不该发出 observe 请求（更不能带着猜出来的 tab 发出去）
    await expect(run(["observe"])).rejects.toThrow("__exit__");
    expect(sentActionCalls()).toEqual([]);
    expect(storedSlots()).toEqual({});
    const err = combinedOutput();
    expect(err).toMatch(/current tab/i);
    expect(err).toContain("recoverable: true");
    exit.mockRestore();

    // 失败的 observe 没有留下任何快照 ⇒ act 也不会沿用旧 snapshotId
    sendRequestMock.mockClear();
    const exit2 = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    await expect(run(["act", "--action", "click", "--target", "@e12"])).rejects.toThrow("__exit__");
    expect(sentActionCalls()).toEqual([]);
    exit2.mockRestore();
  });

  it("tab.list 读不到 tab 时报可读错误，不发 observe 请求", async () => {
    state.tabListError = new Error("Error [EXTENSION_NOT_CONNECTED]: browser agent is unavailable");

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["observe"])).rejects.toThrow("__exit__");

    expect(sentActionCalls()).toEqual([]);
    expect(storedSlots()).toEqual({});
    expect(stderr.join("\n")).toContain("EXTENSION_NOT_CONNECTED");
    exit.mockRestore();
  });

  it("旧格式快照（伪「current」槽位，tab 身份未知）不得被沿用", async () => {
    // 手工写一份旧格式：槽位键是 "current"，没有真实 tab 身份
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `${SESSION}.snapshot.json`),
      JSON.stringify({
        version: 2,
        slots: {
          current: {
            snapshotId: "snap_legacy",
            capturedAt: Date.now(),
            tabId: null,
            refs: { "@e12": { index: 12 } },
          },
        },
      }),
      "utf8",
    );
    // 会话当前 tab 是 5（能解析出来），但快照属于「身份未知」的旧槽位
    switchSessionTab(5);

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["act", "--action", "click", "--target", "@e12"])).rejects.toThrow("__exit__");

    expect(sentActionCalls()).toEqual([]);
    expect(stderr.join("\n")).toContain("recoverable: true");
    exit.mockRestore();
  });
});

/**
 * 内部页（chrome:// 等）不是工作 tab：内容脚本注入不进去。
 * hub 的 ensureCurrentTab 会用 isInternalUrl 把它们排除掉再挑 tab，
 * cli 这条路（自己解析目标 tab 并发显式 tabId）必须用**同一个**口径，
 * 否则 cli 会把内部页当目标发出去，与 hub 的路由口径不一致。
 */
describe("内部页不是工作 tab：cli 与 hub 口径一致", () => {
  it("内部 active tab + 普通未认领 tab ⇒ 选中的是那个普通 tab，不是内部页", async () => {
    state.tabs = [
      { id: 5, active: true, lastFocused: true, url: "chrome://downloads/" },
      { id: 7, active: false, lastFocused: false, url: "https://example.com/" },
    ];
    state.currentTabId = null;

    await run(["observe"]);

    const observeCall = sentActionCalls()[0];
    expect(observeCall[0]).toBe("observe.snapshot");
    // 必须是那个普通 tab（7），绝不是内部页（5）
    expect((observeCall[2] as { tabId?: number }).tabId).toBe(7);
    // 快照也登记在普通 tab 的槽位上
    const slots = storedSlots();
    expect(Object.keys(slots)).toEqual(["7"]);
    expect(slots["7"].tabId).toBe(7);
  });

  it.each([
    "chrome://downloads/",
    "chrome-untrusted://newtab/",
    "chrome-devtools://devtools/bundled/inspector.html",
    "devtools://devtools/bundled/inspector.html",
    "edge://newtab/",
  ])("只有内部页（%s）时报可读错误，不拿内部页凑数", async (url) => {
    state.tabs = [{ id: 5, active: true, lastFocused: true, url }];
    state.currentTabId = null;

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(run(["observe"])).rejects.toThrow("__exit__");

    // 请求根本没发出去（更没有拿内部页当目标发出去）
    expect(sentActionCalls()).toEqual([]);
    expect(storedSlots()).toEqual({});
    const err = combinedOutput();
    expect(err).toMatch(/current tab/i);
    expect(err).toMatch(/internal/i);
    expect(err).toContain("recoverable: true");
    exit.mockRestore();
  });
});
