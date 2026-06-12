/**
 * Author: qingwa
 * Description: GAP-G(N0062) CDP useRealMouse 路径效果信号契约。
 *   - observeEffect:false → 仅 1 次 pageQuery(probe), 返回不带 effect
 *   - observeEffect:true → probe → begin → clickBBox → end 顺序, 返回带 effect
 *   end 必须在 clickBBox(CDP 派发)之后, 才能覆盖派发期间 + windowMs 窗口的 mutation。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const events: string[] = [];

vi.mock("../src/lib/iframe-offset.js", () => ({
  getIframeOffset: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
}));

vi.mock("../src/adapter/native.js", () => ({
  pageQuery: vi.fn(),
  mapPageError: vi.fn(() => {
    throw new Error("mapPageError");
  }),
}));

const FIXED_EFFECT = {
  domMutations: 3,
  urlChanged: false,
  focusChanged: false,
  ariaChanged: true,
  observed: true,
  windowMs: 300,
};

describe("cdpClickElement 效果信号(GAP-G observeEffect)", () => {
  let cdpClickElement: typeof import("../src/adapter/cdp.js").cdpClickElement;
  let pageQuery: ReturnType<typeof vi.fn>;
  let debuggerMgr: { attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    events.length = 0;
    // armDialogPolicyCdp / readDialogCapturedAndDisarmCdp 调用 chrome.scripting.executeScript
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    const native = await import("../src/adapter/native.js");
    pageQuery = vi.mocked(native.pageQuery as never);
    const cdp = await import("../src/adapter/cdp.js");
    cdpClickElement = cdp.cdpClickElement;
    debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockImplementation(async (_tab: number, method: string) => {
        if (method === "Input.dispatchMouseEvent") events.push("clickBBox");
      }),
    };
  });

  it("observeEffect:false → 1 次 pageQuery(probe), 返回无 effect", async () => {
    pageQuery.mockResolvedValueOnce({ result: { x: 5, y: 5, tag: "div", text: "加购" } });
    const r = await cdpClickElement(debuggerMgr as never, 1, undefined, "div.cart", {});
    expect(pageQuery).toHaveBeenCalledTimes(1);
    expect(r.effect).toBeUndefined();
    expect(r.mode).toBe("realMouse");
  });

  it("observeEffect:true → probe→begin→clickBBox→end 顺序, 返回带 effect", async () => {
    pageQuery
      .mockImplementationOnce(async () => {
        events.push("probe");
        return { result: { x: 5, y: 5, tag: "div", text: "加购" } };
      })
      .mockImplementationOnce(async () => {
        events.push("begin");
        return "tok-1";
      })
      .mockImplementationOnce(async () => {
        events.push("end");
        return FIXED_EFFECT;
      });

    const r = await cdpClickElement(debuggerMgr as never, 1, undefined, "div.cart", {
      observeEffect: true,
      windowMs: 250,
    });

    expect(pageQuery).toHaveBeenCalledTimes(3);
    // 关键顺序:begin 在 clickBBox 前, end 在 clickBBox 后(覆盖派发期间 mutation)
    expect(events.indexOf("begin")).toBeLessThan(events.indexOf("clickBBox"));
    expect(events.indexOf("clickBBox")).toBeLessThan(events.indexOf("end"));
    expect(r.effect).toEqual(FIXED_EFFECT);
    // begin 收到 selector + windowMs
    expect(pageQuery.mock.calls[1][3]).toEqual(["div.cart", 250]);
  });

  it("observeEffect:true 但 helper 未就绪(begin 返回 undefined) → 不调 end, 返回无 effect", async () => {
    pageQuery
      .mockResolvedValueOnce({ result: { x: 5, y: 5, tag: "div", text: "加购" } })
      .mockResolvedValueOnce(undefined); // begin → undefined(__vortexClickEffect 未注入)
    const r = await cdpClickElement(debuggerMgr as never, 1, undefined, "div.cart", {
      observeEffect: true,
    });
    expect(pageQuery).toHaveBeenCalledTimes(2); // probe + begin, 无 end
    expect(r.effect).toBeUndefined();
  });
});
