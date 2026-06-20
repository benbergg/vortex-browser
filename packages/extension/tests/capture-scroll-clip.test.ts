import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerCaptureHandlers } from "../src/handlers/capture.js";
import { _resetPageSideLoader } from "../src/adapter/page-side-loader.js";

/**
 * capture.element / computeFrameClip clip 文档坐标回归锁(白盒实机复现,2026-06-20)。
 *
 * 现象:capture.element 用 getBoundingClientRect()(视口相对坐标)算 clip,但 CDP
 *   Page.captureScreenshot 在 captureBeyondViewport:true 下 clip 用「文档坐标」。页面滚动
 *   后两坐标系相差 window.scrollX/Y —— 截视口内某元素时 clip.y 落到文档同 y 的另一处,
 *   返回的是错误元素的截图(silent-false-success,agent 被严重误导)。
 *   live: example.com 注入 belowbox(文档 y=3000)+ topbox(文档 y=40),scrollTo(0,2900)
 *   后 screenshot(#belowbox)(视口 top=100)→ 截到的是 topbox(文档 y=100 处),不是 belowbox。
 *   scrollY=0 时两坐标系重合故场景1 假性通过,仅滚动页面暴露。
 *
 * 修复:clip 加顶层 frame 滚动偏移 getTopScroll(window.scrollX/Y),把顶层视口相对坐标
 *   转成 captureBeyondViewport 期望的文档坐标。
 */
const RECT = { x: 10, y: 20, width: 100, height: 50 };

function mkReq(action: string, args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: action, args, requestId: "r-1", tabId: 42 };
}

function setup(scrollX: number, scrollY: number) {
  _resetPageSideLoader();
  let capturedClip: any;
  let captureBeyond: boolean | undefined;
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    scripting: {
      // rect 查询(args=[selector]) → 返回 RECT;getTopScroll(func 无 args) → 返回滚动量;
      // loadPageSideModule(files) → 空。
      executeScript: vi.fn((opts: any) => {
        if (opts.files) return Promise.resolve([{}]);
        if (opts.func && (!opts.args || opts.args.length === 0)) {
          return Promise.resolve([{ result: { result: { x: scrollX, y: scrollY } } }]);
        }
        return Promise.resolve([{ result: { result: RECT } }]);
      }),
    },
    webNavigation: { getAllFrames: vi.fn().mockResolvedValue([]) },
  });
  const debuggerMgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn((_tab: number, method: string, params: any) => {
      if (method === "Page.captureScreenshot") {
        capturedClip = params.clip;
        captureBeyond = params.captureBeyondViewport;
        return Promise.resolve({ data: "BASE64" });
      }
      return Promise.resolve({});
    }),
  } as any;
  const router = new ActionRouter();
  registerCaptureHandlers(router, debuggerMgr);
  return { router, getClip: () => capturedClip, getBeyond: () => captureBeyond };
}

describe("capture.element clip 文档坐标(滚动偏移修正)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("页面滚动时 clip 加顶层滚动量(rect 视口坐标 → 文档坐标)", async () => {
    const { router, getClip, getBeyond } = setup(0, 2900);
    const resp = await router.dispatch(mkReq("capture.element", { selector: "#belowbox" }));
    expect(resp.error).toBeUndefined();
    // clip.y 必须是 rect.y(20) + scrollY(2900) = 2920,否则截到文档 y=20 的错误元素
    expect(getClip().y).toBe(RECT.y + 2900);
    expect(getClip().x).toBe(RECT.x + 0);
    // captureBeyondViewport 须为 true(clip 存在),clip 才按文档坐标解释
    expect(getBeyond()).toBe(true);
  });

  it("scrollY=0 时不变(无双重计入,旧行为不回归)", async () => {
    const { router, getClip } = setup(0, 0);
    const resp = await router.dispatch(mkReq("capture.element", { selector: "#topbox" }));
    expect(resp.error).toBeUndefined();
    expect(getClip().y).toBe(RECT.y);
    expect(getClip().x).toBe(RECT.x);
  });

  it("横向滚动 scrollX 也计入", async () => {
    const { router, getClip } = setup(500, 1200);
    const resp = await router.dispatch(mkReq("capture.element", { selector: "#el" }));
    expect(resp.error).toBeUndefined();
    expect(getClip().x).toBe(RECT.x + 500);
    expect(getClip().y).toBe(RECT.y + 1200);
  });

  it("返回的 rect 字段与实际截取区一致(文档坐标)", async () => {
    const { router } = setup(0, 2900);
    const resp = await router.dispatch(mkReq("capture.element", { selector: "#belowbox" }));
    expect((resp.result as any).rect.y).toBe(RECT.y + 2900);
  });
});
