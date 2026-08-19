import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchPlatformFonts } from "../src/lib/platform-fonts.js";
import { createFakeChromeDebugger } from "./helpers/fake-debugger.js";
import type { DebuggerManager } from "../src/lib/debugger-manager.js";

/**
 * 走真 DebuggerManager + 共享假 chrome.debugger:命令名拼错会被 -32601 挡下,
 * 自建 mock 做不到这件事(mock 让危险路径变安全的老坑)。
 */
async function makeMgr(over: Record<string, unknown> = {}, opts: { errors?: Record<string, Error> } = {}) {
  const responses: Record<string, unknown> = {
    "DOM.getDocument": { root: { nodeId: 1 } },
    "Runtime.evaluate": { result: { objectId: "arr-1" } },
    "Runtime.callFunctionOn": { result: { value: ["DIV||5", "DIV||5"] } },
    "Runtime.releaseObject": {},
    "Runtime.getProperties": {
      result: [
        { name: "0", value: { objectId: "o0" } },
        { name: "1", value: { objectId: "o1" } },
        { name: "length", value: { type: "number" } },
        // 真实 CDP 对数组会返回带 objectId 的 __proto__,只看 objectId 会把它当成第三个元素
        { name: "__proto__", value: { objectId: "proto-1" } },
      ],
    },
    "DOM.requestNode": { nodeId: 42 },
    "CSS.getPlatformFontsForNode": {
      fonts: [{ familyName: "ES Build", postScriptName: "ESBuild-Bold", glyphCount: 5, isCustomFont: true }],
    },
    ...over,
  };
  const chrome = createFakeChromeDebugger({ responses, errors: opts.errors });
  vi.stubGlobal("chrome", chrome);
  const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
  const mgr = new DebuggerManager() as DebuggerManager;
  const calls = () => chrome.debugger.sendCommand.mock.calls.map((c: unknown[]) => String(c[1]));
  return { mgr, chrome, calls };
}

beforeEach(() => vi.resetModules());

describe("fetchPlatformFonts", () => {
  it("正常路径 → 每个元素一份字体用量,顺序即元素下标", async () => {
    const { mgr } = await makeMgr();
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    expect("fonts" in r).toBe(true);
    expect((r as any).fonts).toHaveLength(2);
    expect((r as any).fonts[0][0].familyName).toBe("ES Build");
  });

  it("DOM.getDocument 必须在 requestNode 之前 —— 少了它真站报 Could not find node with given id", async () => {
    const { mgr, calls } = await makeMgr();
    await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    const c = calls();
    expect(c.indexOf("DOM.getDocument")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("DOM.getDocument")).toBeLessThan(c.indexOf("DOM.requestNode"));
  });

  it("三个域都要 enable(CSS 域没 enable 时 getPlatformFontsForNode 不可用)", async () => {
    const { mgr, calls } = await makeMgr();
    await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    for (const d of ["DOM", "CSS", "Runtime"]) expect(calls()).toContain(`${d}.enable`);
  });

  it("CDP 侧元素数与探针不一致 → 不返回会错位的数据,自陈原因", async () => {
    const { mgr } = await makeMgr();
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["a", "b", "c", "d", "e"]);
    expect("reason" in r).toBe(true);
    expect((r as any).reason).toMatch(/2.*5|5.*2/);
  });

  it("debugger 被别的扩展占住 → 返回 reason,不抛", async () => {
    vi.stubGlobal("chrome", createFakeChromeDebugger({
      attachError: new Error("Another debugger is already attached to the tab with id: 1"),
    }));
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    const r = await fetchPlatformFonts(new DebuggerManager() as DebuggerManager, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    expect("reason" in r).toBe(true);
    expect((r as any).reason).toMatch(/debugger|attach/i);
  });

  it("evaluate 没给 objectId(CSP 或页面异常) → reason,不当成零元素", async () => {
    const { mgr } = await makeMgr({ "Runtime.evaluate": { result: {} } });
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    expect("reason" in r).toBe(true);
  });

  // 共享 fake 的 errors 是整条命令级的,测不了"第一个失败第二个成功";这里只能直接换掉 sendCommand
  it("单个元素的 getPlatformFontsForNode 失败 → 该元素为 null,其余照常给", async () => {
    let n = 0;
    const { mgr } = await makeMgr();
    const orig = (mgr as any).sendCommand;
    (mgr as any).sendCommand = vi.fn(async (t: number, m: string, p?: object) => {
      if (m === "CSS.getPlatformFontsForNode" && n++ === 0) throw new Error("Could not find node with given id");
      return orig(t, m, p);
    });
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    expect((r as any).fonts[0]).toBeNull();
    expect((r as any).fonts[1]).not.toBeNull();
  });

  it("getProperties 的 length 等非下标项不参与 → 不会多出一个幽灵元素", async () => {
    const { mgr } = await makeMgr();
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    expect((r as any).fonts).toHaveLength(2);
  });

  it("表达式带 limit,与探针 maxResults 同义(否则大页面上 CDP 侧会多出一截)", async () => {
    const { mgr, chrome } = await makeMgr();
    await fetchPlatformFonts(mgr, 1, ".t", 3, ["DIV||5", "DIV||5"]);
    const evalCall = chrome.debugger.sendCommand.mock.calls.find((c: unknown[]) => c[1] === "Runtime.evaluate");
    expect((evalCall![2] as { expression: string }).expression).toContain("slice(0, 3)");
  });

  it("没有元素 → 一次 CDP 都不发", async () => {
    const { mgr, calls } = await makeMgr();
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, []);
    expect((r as any).fonts).toEqual([]);
    expect(calls()).toHaveLength(0);
  });

  it("指纹序列不同(数量相同、顺序不同) → 拒绝返回,数量校验抓不到这类错位", async () => {
    const { mgr } = await makeMgr({
      "Runtime.callFunctionOn": { result: { value: ["DIV||5", "SPAN||9"] } },
    });
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["SPAN||9", "DIV||5"]);
    expect("reason" in r).toBe(true);
    expect((r as any).reason).toMatch(/fingerprint|mismatch/i);
  });

  it("指纹一致 → 正常返回", async () => {
    const { mgr } = await makeMgr({
      "Runtime.callFunctionOn": { result: { value: ["A||1", "B||2"] } },
    });
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["A||1", "B||2"]);
    expect("fonts" in r).toBe(true);
  });

  it("拿不到指纹(callFunctionOn 没给值) → reason 要说清是指纹读不到", async () => {
    // 少了显式判断也会因 undefined.length 落进 catch,但 reason 变成
    // "Cannot read properties of undefined",调用方看不出发生了什么
    const { mgr } = await makeMgr({ "Runtime.callFunctionOn": { result: {} } });
    const r = await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    expect((r as any).reason).toMatch(/fingerprint/i);
  });

  it("远程对象要释放 —— font 组默认开,不释放会一直堆在 renderer 里", async () => {
    const { mgr, chrome } = await makeMgr();
    await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    const released = chrome.debugger.sendCommand.mock.calls
      .filter((c: unknown[]) => c[1] === "Runtime.releaseObject")
      .map((c: unknown[]) => (c[2] as { objectId: string }).objectId);
    expect(released).toContain("arr-1");
    expect(released).toEqual(expect.arrayContaining(["o0", "o1"]));
  });

  it("中途失败也要释放数组对象", async () => {
    const { mgr, chrome } = await makeMgr({}, {
      errors: { "DOM.requestNode": new Error("boom") },
    });
    await fetchPlatformFonts(mgr, 1, ".t", 10, ["DIV||5", "DIV||5"]);
    const released = chrome.debugger.sendCommand.mock.calls
      .filter((c: unknown[]) => c[1] === "Runtime.releaseObject")
      .map((c: unknown[]) => (c[2] as { objectId: string }).objectId);
    expect(released).toContain("arr-1");
  });
});

describe("释放的 deadline", () => {
  it("releaseObject 永不 settle 也不能把结果挂住", async () => {
    const chrome = createFakeChromeDebugger({
      responses: {
        "DOM.getDocument": { root: { nodeId: 1 } },
        "Runtime.evaluate": { result: { objectId: "arr-1" } },
        "Runtime.callFunctionOn": { result: { value: ["A", "B"] } },
        "Runtime.getProperties": { result: [
          { name: "0", value: { objectId: "o0" } }, { name: "1", value: { objectId: "o1" } },
        ] },
        "DOM.requestNode": { nodeId: 9 },
        "CSS.getPlatformFontsForNode": { fonts: [] },
      },
    });
    const orig = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = vi.fn((t: unknown, m: string, p?: unknown) =>
      m === "Runtime.releaseObject" ? new Promise(() => {}) : orig(t as never, m, p as never),
    ) as never;
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    vi.useFakeTimers();
    const p = fetchPlatformFonts(new DebuggerManager() as DebuggerManager, 1, ".t", 10, ["A", "B"]);
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    expect("fonts" in (await p)).toBe(true);
  });
});
