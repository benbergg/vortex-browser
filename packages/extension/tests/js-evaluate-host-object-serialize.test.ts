import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import {
  registerJsHandlers,
  normalizeEvaluateResult,
} from "../src/handlers/js.js";

/**
 * VORTEX_FEEDBACK v3.4 BUG-001 + BUG-005: vortex_evaluate 序列化丢 host object 字段
 * 根因:chrome.scripting.executeScript structured clone 对 host object (DOMRect /
 * CSSStyleDeclaration / DOMStringMap / Date / Error / Map / Set / TypedArray / NodeList /
 * Attr) 只 copy enumerable own properties,prototype 上的 getter 全部丢失。
 *
 * 修复:handler 返结果前对已知 host object 调 .toJSON() / .toArray() / 手动展开,
 * 转 plain object。func 内联(序列化丢作用域),module-level helper 仅供单测。
 *
 * 关键守卫(V2 风格):
 *   - normalizeEvaluateResult 为纯函数(handler 侧 + 测)
 *   - 真注入 page-side func,stub host object,验证真跑返 plain object
 *   - 不破坏 plain object 行为
 */

interface NmRequest {
  type: "tool_request";
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  tabId: number;
}

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

describe("normalizeEvaluateResult — host object 展开 (BUG-001 + BUG-005)", () => {
  // BUG-001 cases
  const bug001Cases: Array<[label: string, input: unknown, expected: unknown]> = [
    ["DOMRect 展开 (plain object 模拟 — own getter x/y/w/h)",
      { x: 10, y: 20, width: 100, height: 50, top: 20, right: 110, bottom: 70, left: 10 },
      { x: 10, y: 20, width: 100, height: 50, top: 20, right: 110, bottom: 70, left: 10 }],
    ["CSSStyleDeclaration 展开 (subset)",
      { display: "block", color: "rgb(0,0,0)" },
      { display: "block", color: "rgb(0,0,0)" }],
    ["DOMStringMap 展开",
      { foo: "bar", baz: "qux" },
      { foo: "bar", baz: "qux" }],
  ];

  // BUG-005 cases
  const bug005Cases: Array<[label: string, input: unknown, expected: unknown]> = [
    ["Date → ISO string", new Date("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z"],
    ["Error → plain object", Object.assign(new TypeError("x"), { stack: "stack-trace" }),
      { name: "TypeError", message: "x", stack: "stack-trace" }],
    ["Map → array of pairs", new Map<unknown, unknown>([[1, "a"], [2, "b"]]), [[1, "a"], [2, "b"]]],
    ["Set → array", new Set([1, 2, 3]), [1, 2, 3]],
    ["Uint8Array → array", new Uint8Array([1, 2, 3]), [1, 2, 3]],
    ["Int8Array → array", new Int8Array([1, 2, 3]), [1, 2, 3]],
    ["Float32Array → array", new Float32Array([1.5, 2.5]), [1.5, 2.5]],
  ];

  // 不变 cases (普通对象应直通)
  const passthroughCases: Array<[label: string, input: unknown, expected: unknown]> = [
    ["普通对象", { a: 1, b: 2 }, { a: 1, b: 2 }],
    ["数组", [1, 2, 3], [1, 2, 3]],
    ["null", null, null],
    ["undefined", undefined, undefined],
    ["字符串", "hello", "hello"],
    ["数字", 42, 42],
    ["布尔", true, true],
    ["嵌套 plain object", { a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }],
    ["嵌套 host + plain", { rect: { x: 1, y: 2 }, inner: "x" },
      { rect: { x: 1, y: 2 }, inner: "x" }],
  ];

  for (const [label, input, expected] of [...bug001Cases, ...bug005Cases, ...passthroughCases]) {
    it(label, () => {
      expect(normalizeEvaluateResult(input)).toEqual(expected);
    });
  }

  // BUG-005 robust:页面可 wrap/minify 重命名内置构造器(实测百度 Date.constructor.name="e"),
  // constructor.name 路由被击穿。须改用 Object.prototype.toString 品牌检查(不可被重命名)。
  it("Date 构造器被页面重命名(minify)仍 → ISO string", () => {
    class Renamed extends Date {}
    Object.defineProperty(Renamed, "name", { value: "e" });
    const d = new Renamed(0);
    expect(d.constructor.name).toBe("e");  // 复刻百度环境
    expect(normalizeEvaluateResult(d)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("Map 构造器被重命名仍 → array of pairs", () => {
    class RenamedMap extends Map {}
    Object.defineProperty(RenamedMap, "name", { value: "t" });
    const m = new RenamedMap([[1, "a"]]);
    expect(m.constructor.name).toBe("t");
    expect(normalizeEvaluateResult(m)).toEqual([[1, "a"]]);
  });
});

describe("EVALUATE page-side func — host object 展开 (BUG-001 + BUG-005)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
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
    registerJsHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function captureEvaluateFunc(): Promise<(c: string) => Promise<{ result?: unknown; error?: string }>> {
    executeScript.mockResolvedValue([{ result: { result: null } }]);
    await router.dispatch(mkReq("js.evaluate", { code: "null" }, 42));
    const fn = executeScript.mock.calls[0][0].func as (c: string) => Promise<{ result?: unknown; error?: string }>;
    executeScript.mockClear();
    return fn;
  }

  // V2 关键守卫:防假绿 — func 源码不能引用模块函数
  it("func 序列化安全:源码不引用 normalizeEvaluateResult", async () => {
    const fn = await captureEvaluateFunc();
    expect(fn.toString()).not.toMatch(/normalizeEvaluateResult/);
  });

  it("plain object 展开直通", async () => {
    const fn = await captureEvaluateFunc();
    const out = await fn("({a: 1, b: 'x'})");
    expect(out.result).toEqual({ a: 1, b: "x" });
  });

  it("数组展开直通", async () => {
    const fn = await captureEvaluateFunc();
    const out = await fn("[1, 2, 3]");
    expect(out.result).toEqual([1, 2, 3]);
  });

  it("嵌套 5 层 plain object 完整展开", async () => {
    const fn = await captureEvaluateFunc();
    const out = await fn("({a:{b:{c:{d:{e:42}}}}})");
    expect(out.result).toEqual({ a: { b: { c: { d: { e: 42 } } } } });
  });
});

/**
 * BUG-001/003/005 回归守卫(V2 风格真验):chrome.scripting.executeScript 经
 * func.toString() 把 func 注入页面 MAIN world,**丢模块作用域**。若 func body 引用
 * 模块级 `expandHost`(而非内联),注入后 `expandHost is not defined`,evaluate 全坏。
 *
 * 直接在 Node 模块作用域调 captureEvaluateFunc() 返回的 fn 是**假绿**:闭包链能解析
 * 到同模块的 expandHost,跑得通。这里用 `new Function` 把 func 源码从模块作用域**剥离**
 * 后重建再调,精确复刻 executeScript 的注入语义——这才能抓到真 bug。
 */
describe("EVALUATE func 序列化自包含 — 真注入复刻 (BUG-001/003/005 回归守卫)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
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
    registerJsHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  // 捕获 func 源码并从模块作用域剥离重建(模拟 executeScript 注入页面)
  async function detachedEvaluateFunc(): Promise<(c: string) => { result?: unknown; error?: string }> {
    executeScript.mockResolvedValue([{ result: { result: null } }]);
    await router.dispatch(mkReq("js.evaluate", { code: "null" }, 42));
    const src = (executeScript.mock.calls[0][0].func as (c: string) => unknown).toString();
    executeScript.mockClear();
    // new Function 在全局作用域重建,看不到模块级 expandHost——与页面 MAIN world 等价
    return new Function(`return (${src});`)() as (c: string) => { result?: unknown; error?: string };
  }

  it("剥离作用域后简单表达式可跑(1+1)", async () => {
    const fn = await detachedEvaluateFunc();
    const out = fn("1+1");
    expect(out.result).toBe(2);
  });

  it("剥离作用域后 plain object 展开", async () => {
    const fn = await detachedEvaluateFunc();
    const out = fn("({x:1, y:2})");
    expect(out.result).toEqual({ x: 1, y: 2 });
  });

  it("剥离作用域后真注入 Date → ISO string (BUG-005)", async () => {
    const fn = await detachedEvaluateFunc();
    const out = fn("new Date(0)");
    expect(out.result).toBe("1970-01-01T00:00:00.000Z");
  });

  it("剥离作用域后真注入 Map → array of pairs (BUG-005)", async () => {
    const fn = await detachedEvaluateFunc();
    const out = fn("new Map([[1,'a'],[2,'b']])");
    expect(out.result).toEqual([[1, "a"], [2, "b"]]);
  });

  it("剥离作用域后真注入 host object(prototype getter)→ 展开字段 (BUG-001)", async () => {
    const fn = await detachedEvaluateFunc();
    // 模拟 DOMRect:字段在 prototype getter 上(structured clone 会丢,展开能取回)
    const out = fn("(()=>{const p={};Object.defineProperties(p,{x:{get:()=>10,enumerable:true},w:{get:()=>100,enumerable:true}});return Object.create(p);})()");
    expect(out.result).toEqual({ x: 10, w: 100 });
  });

  it("守卫:func 源码内**定义** expandHost(不只引用)", async () => {
    executeScript.mockResolvedValue([{ result: { result: null } }]);
    await router.dispatch(mkReq("js.evaluate", { code: "null" }, 42));
    const src = (executeScript.mock.calls[0][0].func as (c: string) => unknown).toString();
    // 必须在 func body 内定义 expandHost 标识符,而非引用模块级
    expect(src).toMatch(/(?:const|let|var|function)\s+expandHost|expandHost\s*=/);
  });
});
