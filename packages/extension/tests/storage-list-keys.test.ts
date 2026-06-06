import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { summarizeStorage, registerStorageHandlers } from "../src/handlers/storage.js";
import type { NmRequest } from "@vortex-browser/shared";

/**
 * VORTEX_FEEDBACK v3.3 B3-2 (V2 修正): vortex_storage { op: "list-keys" } 支持
 *
 * 根因(同 V1):vortex_storage { op: "get" } 不传 key 返 100KB+ 截断的全量
 * localStorage;无 keys-only 形式。
 *
 * V2 修正核心(防 V1 致命错误):GET_LOCAL_STORAGE page-side func **不能**调模块级
 * summarizeStorage(chrome.scripting.executeScript 序列化丢模块作用域)。
 * → func 内联同一摘要逻辑;模块级 summarizeStorage 仅供单测。
 *
 * 关键守卫(防假绿,V2 加):
 *   - "func.toString() 不含 summarizeStorage" (handler 真注入测试)
 *   - 喂 stub localStorage 后真跑 func(null, "keys") / func(null, "all")
 */

class StubStorage implements Storage {
  private store: Record<string, string>;
  length: number = 0;
  constructor(init: Record<string, string>) {
    this.store = { ...init };
    this.length = Object.keys(init).length;
  }
  key(i: number): string | null { return Object.keys(this.store)[i] ?? null; }
  getItem(k: string): string | null { return this.store[k] ?? null; }
  setItem(k: string, v: string): void {
    this.store[k] = v;
    this.length = Object.keys(this.store).length;
  }
  removeItem(k: string): void {
    delete this.store[k];
    this.length = Object.keys(this.store).length;
  }
  clear(): void { this.store = {}; this.length = 0; }
}

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

describe("summarizeStorage(store, mode) — 纯函数 (B3-2)", () => {
  const stubStore = new StubStorage({ a: "1", b: "22", c: "333" });

  it("mode='keys' → keys + totalKeys + valueLengths (不返 values)", () => {
    const r = summarizeStorage(stubStore, "keys");
    expect(r).toEqual({
      keys: ["a", "b", "c"],
      totalKeys: 3,
      valueLengths: { a: 1, b: 2, c: 3 },
    });
    expect((r as { values?: unknown }).values).toBeUndefined();
  });

  it("mode='all' → keys + totalKeys + values (全量,显式 opt-in)", () => {
    const r = summarizeStorage(stubStore, "all");
    expect(r).toEqual({
      keys: ["a", "b", "c"],
      totalKeys: 3,
      values: { a: "1", b: "22", c: "333" },
    });
  });

  it("空 storage → totalKeys=0,keys=[],valueLengths/values={}", () => {
    const empty = new StubStorage({});
    expect(summarizeStorage(empty, "keys")).toEqual({
      keys: [],
      totalKeys: 0,
      valueLengths: {},
    });
    expect(summarizeStorage(empty, "all")).toEqual({
      keys: [],
      totalKeys: 0,
      values: {},
    });
  });

  it("value 为空字符串的 key 仍计入 (valueLengths=0, values='')", () => {
    const s = new StubStorage({ a: "" });
    expect(summarizeStorage(s, "keys")).toEqual({
      keys: ["a"],
      totalKeys: 1,
      valueLengths: { a: 0 },
    });
    expect(summarizeStorage(s, "all")).toEqual({
      keys: ["a"],
      totalKeys: 1,
      values: { a: "" },
    });
  });

  it("非 ASCII value(中文/Emoji) → valueLengths 用 JS .length (UTF-16 code unit)", () => {
    const s = new StubStorage({ zh: "你好", em: "🦊" });
    expect(summarizeStorage(s, "keys")).toEqual({
      keys: ["zh", "em"],
      totalKeys: 2,
      valueLengths: { zh: 2, em: 2 },
    });
  });
});

describe("GET_LOCAL_STORAGE page-side func — 自包含 + 真注入 (B3-2 V2)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let stubStore: StubStorage;

  beforeEach(() => {
    vi.unstubAllGlobals();
    stubStore = new StubStorage({ a: "1", b: "22", c: "333" });
    // V2 关键:func 内用的是页面全局 localStorage,不是参数。stub globalThis.localStorage。
    vi.stubGlobal("localStorage", stubStore);
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://x/" },
        ]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerStorageHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function captureGetLocalStorageFunc(): Promise<
    (k: string | null, m: "keys" | "all" | null) => { result?: unknown; error?: string }
  > {
    executeScript.mockResolvedValue([{ result: { result: null } }]);
    await router.dispatch(mkReq("storage.getLocalStorage", {}, 42));
    const fn = executeScript.mock.calls[0][0].func as (
      k: string | null,
      m: "keys" | "all" | null,
    ) => { result?: unknown; error?: string };
    executeScript.mockClear();
    return fn;
  }

  // V2 关键守卫:防 V1 假绿 —— func 源码不能引用 summarizeStorage
  it("func 序列化安全:源码不引用模块函数 summarizeStorage", async () => {
    const fn = await captureGetLocalStorageFunc();
    expect(fn.toString()).not.toMatch(/summarizeStorage/);
  });

  it("传 key='a' + 不传 mode → { result: '1' } (单值旧契约不破)", async () => {
    const fn = await captureGetLocalStorageFunc();
    const out = fn("a", null);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe("1");
  });

  it("不传 key + mode='keys' → { keys, totalKeys, valueLengths } (新契约)", async () => {
    const fn = await captureGetLocalStorageFunc();
    const out = fn(null, "keys");
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({
      keys: ["a", "b", "c"],
      totalKeys: 3,
      valueLengths: { a: 1, b: 2, c: 3 },
    });
  });

  it("不传 key + mode='all' → { keys, totalKeys, values } (新契约)", async () => {
    const fn = await captureGetLocalStorageFunc();
    const out = fn(null, "all");
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({
      keys: ["a", "b", "c"],
      totalKeys: 3,
      values: { a: "1", b: "22", c: "333" },
    });
  });

  it("不传 key + 不传 mode → Record<string,string> 全量 (旧契约不破)", async () => {
    const fn = await captureGetLocalStorageFunc();
    const out = fn(null, null);
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ a: "1", b: "22", c: "333" });
  });
});
