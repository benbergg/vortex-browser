/**
 * Author: qingwa
 * Description: Dogfood 2026-06-23 shoelace.style/components/rating — 坐标敏感控件
 *   (role=slider / input[type=range]) 默认 click silent success 修复。
 *
 * 背景:
 *   - 非 trusted 模式(普通 Chrome,/trusted-mode=false,常见情形)下 click 走合成
 *     el.click() 路径。该路径 deferToCdp 门原只认 submit-intent 与
 *     dataset.vortexReactClickable(React/Vue onClick 桩 / cursor:pointer)。
 *   - Shoelace sl-rating 的 div[role=slider] 值由指针 clientX 命中位置计算,带
 *     click listener(observe 标 data-vtx-listener / [listener]) 但不带
 *     vortexReactClickable → 漏过 defer 门 → 纯 el.click() clientX=0 → rating 算成
 *     0,值不变却返回 success → silent success(agent 误判已设值)。
 *   - 实证: 默认 click slider value 恒 0; useRealMouse 中心点击 value=3。
 *
 * 修复: 在 react-clickable 门之后追加坐标敏感门 —— role=slider 或
 *   input[type=range] 且 cdpAvailable → deferToCdp,落到元素中心真实坐标驱动控件。
 *   cdpAvailable=false 不 defer(与 submit-intent/react-clickable 同策,无 CDP 不堵路)。
 *
 * 关键契约:
 *   1. page-side func 探测 role=slider → deferToCdp(handler 改走 cdpClickElement)
 *   2. 坐标敏感门在 react-clickable 门之后(顺序: submit → react-clickable → coord)
 *   3. cdpAvailable 守卫存在(deferToCdp 仅在 CDP 可用时,无 CDP 退回合成)
 *   4. handler 收到 deferToCdp:true → 走 cdpClickElement(共享 defer 路由,行为级)
 *
 * Why source-lock: page-side func inline 于 executeScript,jsdom 不能直接调;
 *   inline 探测逻辑以源码契约锁定,defer 路由以 executeScript mock 行为验证
 *   (与 click-react-clickable-dataset-cdp.test.ts 同模式)。真行为在 shoelace
 *   rating live 验证。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NmRequest } from "@vortex-browser/shared";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";

vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/cdp.js", () => ({
  cdpClickElement: vi.fn(),
  clickBBox: vi.fn(),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");

describe("CLICK 坐标敏感控件 deferToCdp — 源码契约 (shoelace rating dogfood)", () => {
  it("契约 1: page-side func 探测 role=slider 作坐标敏感信号", () => {
    expect(SRC).toMatch(/__roleAttr === "slider"/);
  });

  it("契约 1b: 原生 input[type=range] 也纳入坐标敏感", () => {
    expect(SRC).toMatch(/__tagLc === "input" && __typeAttr === "range"/);
  });

  it("契约 2: 坐标敏感门在 react-clickable 门之后 (顺序敏感)", () => {
    const reactIdx = SRC.indexOf("vortexReactClickable");
    const coordIdx = SRC.indexOf("__isCoordSensitive");
    expect(reactIdx).toBeGreaterThan(-1);
    expect(coordIdx).toBeGreaterThan(-1);
    expect(coordIdx).toBeGreaterThan(reactIdx);
  });

  it("契约 3: cdpAvailable 守卫存在 (无 CDP 退回合成,不堵路)", () => {
    expect(SRC).toMatch(/__isCoordSensitive && cdpAvailable/);
  });

  it("契约 3b: __hasClickMethod 守卫排除无 .click() 的 SVG slider (不碰 APG dispatchEvent 路径)", () => {
    expect(SRC).toMatch(/__hasClickMethod &&/);
    // 守卫必须前置于 role 判定,确保 SVG <g role=slider> 放行
    const guardIdx = SRC.indexOf("__hasClickMethod =");
    const coordIdx = SRC.indexOf("__isCoordSensitive =");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(coordIdx).toBeGreaterThan(guardIdx);
  });
});

describe("CLICK 坐标敏感控件 → CDP real mouse (行为级, 共享 defer 路由)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let cdpClickElement: ReturnType<typeof vi.fn>;
  let debuggerMgr: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const cdp = await import("../src/adapter/cdp.js");
    cdpClickElement = vi.mocked(cdp.cdpClickElement as any);
    debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue(undefined) };
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("契约 4: page-side 探测坐标敏感 → deferToCdp → 走 cdpClickElement 中心点击", async () => {
    // page-side func 对 role=slider 返回 deferToCdp(模拟坐标敏感门命中)
    executeScript.mockResolvedValue([
      { result: { result: { deferToCdp: true, element: { tag: "div" } } } },
    ]);
    cdpClickElement.mockResolvedValue({
      success: true, element: { tag: "div" }, x: 435, y: 317, mode: "realMouse",
    });

    const resp = await router.dispatch(
      mkReq({ selector: "sl-rating [role=slider]", action: "click", tabId: 42 }),
    );

    expect(resp.error).toBeUndefined();
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });
});
