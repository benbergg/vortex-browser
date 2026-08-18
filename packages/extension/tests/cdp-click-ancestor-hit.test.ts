/**
 * Author: qingwa
 * Description: cdp.ts realMouse 路径的遮挡检查改用 __vortexDomResolve.classifyHit。
 *   注入函数经 executeScript 序列化 toString 后丢模块作用域,故用 new Function
 *   剥离作用域复刻注入环境——直接调 import 的函数测不出 "X is not defined"。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cdpClickElement } from "../src/adapter/cdp.js";
import { classifyHit } from "../src/page-side/hit-ownership.js";

// 照 tests/click-synthetic-inline-scope.test.ts 的范式:捕获**真实**注入 func,
// 用 new Function 剥离模块闭包后真执行。手写一段等价代码测不出裸引用模块级
// helper 的 ReferenceError,也测不到真实的 topEl 获取与返回路径。
let dom: JSDOM;
let lastResult: unknown;
// force=true 用例里完整流程还会触发 dialog arm/disarm 两次额外 executeScript,
// 若只留 lastResult 会被它们的返回值覆盖掉——探针(occlusion 判定)结果须单独按首次调用锁定。
let probeResult: unknown;

function installChrome(withResolve: boolean) {
  const win = dom.window as any;
  win.__vortexDomResolve = withResolve
    ? { deepElementFromPoint: (x: number, y: number) => win.document.elementFromPoint(x, y),
        queryAllDeep: (s: string) => Array.from(win.document.querySelectorAll(s)),
        isEnabled: () => true,
        classifyHit: (a: Element, b: Element | null) => classifyHit(a, b) }
    : undefined;
  let callCount = 0;
  (globalThis as any).chrome = {
    scripting: {
      executeScript: async ({ func, args }: { func: Function; args?: unknown[] }) => {
        // 关键:String(func) 后重新求值 —— 模块作用域在此彻底丢失。
        // args 与真实 chrome.scripting.executeScript 一致为可选(readDialogCapturedAndDisarmCdp 不传)。
        const stripped = new Function("return (" + String(func) + ")")();
        lastResult = await stripped(...(args ?? []));
        callCount += 1;
        if (callCount === 1) probeResult = lastResult;
        return [{ result: lastResult }];
      },
    },
    debugger: { sendCommand: async () => ({}) },
  };
}

beforeEach(() => {
  dom = new JSDOM(`<body><div id="w" class="row"><button id="b">x</button></div></body>`, { pretendToBeVisual: true });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  const btn = dom.window.document.getElementById("b")!;
  const wrap = dom.window.document.getElementById("w")!;
  (btn as any).getBoundingClientRect = () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, left: 10, right: 30, bottom: 30 });
  Object.defineProperty(dom.window.document, "elementFromPoint", { value: () => wrap, configurable: true });
  vi.restoreAllMocks();
});

// cdpClickElement 实际调用 debuggerMgr.attach + debuggerMgr.sendCommand（cdp.ts:59-64），
// 缺 sendCommand 时 force=true 用例会崩在 "not a function" 而非测到判定逻辑。
const mkMgr = () => ({ attach: vi.fn(async () => {}), sendCommand: vi.fn(async () => ({})) }) as any;

describe("cdp realMouse 祖先命中", () => {
  // page-side 结果带 error 时 cdpClickElement 走 mapPageError（native.ts:65，`: never`）
  // 直接抛异常，所以断言必须用 rejects —— 直接 await 再查 lastResult 测不到抛错路径。
  it("剥离模块作用域后真执行：非交互祖先 → 抛 ELEMENT_OCCLUDED 且点名祖先", async () => {
    installChrome(true);
    await expect(cdpClickElement(mkMgr(), 1, undefined, "#b", {})).rejects.toMatchObject({
      code: "ELEMENT_OCCLUDED",
    });
    expect(lastResult).toMatchObject({ extras: { blocker: "div#w.row", hitKind: "ancestor" } });
  });

  it("抛出的错误：祖先话术 + 覆盖 hint，不指向浮层", async () => {
    installChrome(true);
    const err: any = await cdpClickElement(mkMgr(), 1, undefined, "#b", {}).catch((e) => e);
    const payload = err.toJSON();
    expect(payload.code).toBe("ELEMENT_OCCLUDED");
    expect(payload.message).toMatch(/ancestor/i);
    expect(payload.message).not.toMatch(/covered by/i);
    expect(payload.hint).toMatch(/ancestor/i);
    expect(payload.hint).not.toMatch(/cookie banner|dismiss it via/i);
  });

  it("兄弟浮层命中仍是既有遮挡话术与 hint（回归保护）", async () => {
    const mask = dom.window.document.createElement("div");
    mask.id = "ov";
    dom.window.document.body.appendChild(mask);
    Object.defineProperty(dom.window.document, "elementFromPoint", { value: () => mask, configurable: true });
    installChrome(true);
    const err: any = await cdpClickElement(mkMgr(), 1, undefined, "#b", {}).catch((e) => e);
    const payload = err.toJSON();
    expect(payload.message).toMatch(/covered by <div#ov>/);
    expect(payload.hint).toMatch(/cookie banner/i);
  });

  it("classifyHit 不可用（模块未注入 / 刚导航）→ fail closed 抛 NOT_ATTACHED", async () => {
    installChrome(false);
    await expect(cdpClickElement(mkMgr(), 1, undefined, "#b", {})).rejects.toMatchObject({
      code: "NOT_ATTACHED",
    });
    expect(JSON.stringify(lastResult)).toContain("page likely navigated");
  });

  it("force=true → 跳过判定照常派发（回归保护）", async () => {
    installChrome(true);
    const mgr = mkMgr();
    const res = await cdpClickElement(mgr, 1, undefined, "#b", { force: true });
    // 探针(首次 executeScript,occlusion 判定所在)结果:force 跳过判定,无 errorCode。
    expect((probeResult as any).errorCode).toBeUndefined();
    expect((probeResult as any).result).toMatchObject({ tag: "button" });
    expect(res.element).toMatchObject({ tag: "button" });
    expect(mgr.sendCommand).toHaveBeenCalled(); // 真派发过，不是提前 return
  });
});
