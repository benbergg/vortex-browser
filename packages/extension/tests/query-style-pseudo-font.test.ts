// mode=style 的伪元素/字体接线:纯函数证明不了 handler 有没有真把它们串起来,
// 这里全部走 router.dispatch,断言真实返回形状与真实 CDP 实参。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerQueryHandlers } from "../src/handlers/query.js";

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "query.queryPage", args, requestId: "r1", tabId: 42 };
}

/** 探针返回的原始形状:pseudoRaw 未经渲染判定,declaredFont 是声明栈 */
const PROBE_RESULT = {
  elements: [
    {
      index: 0, tag: "i", fp: "I||0",
      declaredFont: "ESBuild, sans-serif",
      pseudoRaw: {
        before: { content: '"\\f0c9"', display: "inline", visibility: "visible", opacity: "1", "background-image": "none", width: "auto", height: "auto" },
        after: { content: '"x"', display: "none", visibility: "visible", opacity: "1", "background-image": "none", width: "auto", height: "auto" },
      },
    },
    { index: 1, tag: "p", fp: "P||3", declaredFont: "PPMori, sans-serif" },
  ],
  total: 2, showing: 2,
  fontFaces: [{ "font-family": "ESBuild", src: 'url("/f/ESBuild.woff2")' }],
  fontFacesPartial: false,
};

describe("mode=style 伪元素与字体接线", () => {
  let router: ActionRouter;
  let mgr: { enableDomain: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript: vi.fn(async () => [{ result: structuredClone(PROBE_RESULT) }]) },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    mgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_t: number, m: string) => {
        if (m === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (m === "Runtime.evaluate") return { result: { objectId: "arr" } };
        if (m === "Runtime.callFunctionOn") return { result: { value: ["I||0", "P||3"] } };
        if (m === "Runtime.releaseObject") return {};
        if (m === "Runtime.getProperties") return { result: [
          { name: "0", value: { objectId: "o0" } }, { name: "1", value: { objectId: "o1" } },
        ] };
        if (m === "DOM.requestNode") return { nodeId: 9 };
        return { fonts: [{ familyName: "ES Build", postScriptName: "ESBuild-Bold", glyphCount: 5, isCustomFont: true }] };
      }),
    };
    registerQueryHandlers(router, mgr as never);
  });

  const call = (args: Record<string, unknown> = {}) =>
    router.dispatch(mkReq({ mode: "style", pattern: ".t", ...args })) as Promise<any>;

  it("display:none 的 ::after 被判定为不渲染 → 不出现在返回里", async () => {
    const r = await call();
    expect(r.result.elements[0].pseudo).toBeDefined();
    expect(r.result.elements[0].pseudo.before).toBeDefined();
    expect(r.result.elements[0].pseudo.after).toBeUndefined();
  });

  it("没有渲染中伪元素的元素 → 整个 pseudo 键都不出现,不占字节", async () => {
    const r = await call();
    expect(r.result.elements[1].pseudo).toBeUndefined();
  });

  it("原始 pseudoRaw 不外泄 —— 返回的是判定后的结果不是探针中间态", async () => {
    const r = await call();
    expect(r.result.elements[0].pseudoRaw).toBeUndefined();
    expect(JSON.stringify(r.result)).not.toContain("pseudoRaw");
  });

  it("字体走 CDP → 每元素给实际渲染字体与首选是否用上", async () => {
    const r = await call();
    expect(r.result.elements[0].font.evidence).toBe("cdp-platform-fonts");
    expect(r.result.elements[0].font.firstChoiceInUse).toBe(true);
    expect(r.result.elements[0].font.rendered[0].family).toBe("ES Build");
    expect(r.result.elements[0].declaredFont).toBeUndefined();
    expect(r.result.elements[0].fp).toBeUndefined();
  });

  it("CDP 不可用 → font.evidence=unavailable 且带原因,不谎报没用上", async () => {
    mgr.enableDomain.mockRejectedValue(new Error("Another debugger is already attached"));
    const r = await call();
    expect(r.result.elements[0].font.evidence).toBe("unavailable");
    expect(r.result.elements[0].font.firstChoiceInUse).toBeNull();
    expect(r.result.elements[0].font.reason).toContain("Another debugger");
  });

  it("@font-face 按 family 聚合后带出,跨域标记一并带出", async () => {
    const r = await call();
    expect(r.result.fontFaces[0].family).toBe("ESBuild");
    expect(r.result.fontFaces[0].src).toContain("ESBuild.woff2");
    expect(r.result.fontFacesPartial).toBe(false);
    expect(r.result.fontFacesTruncated).toBe(false);
  });

  it("聚合后不再有原始规则形状 —— 上百个分片会把返回撑爆(知乎 302 片 81KB)", async () => {
    const r = await call();
    expect(r.result.fontFaces[0]["font-family"]).toBeUndefined();
    expect(r.result.fontFamiliesTotal).toBe(1);
  });

  it("attr 不含 font → 一次 CDP 都不发(只读查询不白付调试横幅)", async () => {
    const r = await call({ attr: "typography" });
    expect(mgr.enableDomain).not.toHaveBeenCalled();
    expect(mgr.sendCommand).not.toHaveBeenCalled();
    expect(r.result.elements[0].font).toBeUndefined();
  });

  it("attr 不含 pseudo → 不做伪元素判定", async () => {
    const r = await call({ attr: "typography" });
    expect(r.result.elements[0].pseudo).toBeUndefined();
  });

  it("attr 显式给 pseudo/font → 两组都是合法组名,不报 INVALID_PARAMS", async () => {
    const r = await call({ attr: "pseudo|font" });
    expect(r.error).toBeUndefined();
    expect(r.result.elements[0].pseudo).toBeDefined();
    expect(r.result.elements[0].font).toBeDefined();
  });

  it("探针请求的组要透传到注入实参 —— 少传一组 handler 侧再怎么判定也是空的", async () => {
    await call({ attr: "pseudo" });
    const args = (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mock.calls[0][0].args;
    expect(args[2]).toEqual(["pseudo"]);
  });

  it("没接 DebuggerManager(未接线) → font 自陈不可用,而不是静默没有这个字段", async () => {
    const r2 = new ActionRouter();
    registerQueryHandlers(r2);
    const r = (await r2.dispatch(mkReq({ mode: "style", pattern: ".t" }))) as any;
    expect(r.result.elements[0].font.evidence).toBe("unavailable");
  });

  it("探针指纹与 CDP 侧不一致 → font 自陈不可用,不把字体挂到别的元素上", async () => {
    mgr.sendCommand = vi.fn(async (_t: number, m: string) => {
      if (m === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (m === "Runtime.evaluate") return { result: { objectId: "arr" } };
      if (m === "Runtime.callFunctionOn") return { result: { value: ["P||3", "I||0"] } };
      return {};
    });
    const r = await call();
    expect(r.result.elements[0].font.evidence).toBe("unavailable");
    expect(r.result.elements[0].font.reason).toMatch(/fingerprint/i);
  });
});

describe("box 组的布局属性裁剪", () => {
  it("非容器上的布局初始值不出现在返回里,真设过的留下", async () => {
    const router = new ActionRouter();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript: vi.fn(async () => [{ result: {
        elements: [{ index: 0, tag: "nav", box: {
          display: "flex", gap: "12px", flexDirection: "row",
          justifyContent: "space-between", alignItems: "normal",
          gridTemplateColumns: "none", padding: "8px",
        } }],
        total: 1, showing: 1,
      } }]) },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerQueryHandlers(router);
    const r = (await router.dispatch(mkReq({ mode: "style", pattern: "nav", attr: "box" }))) as any;
    expect(r.result.elements[0].box).toEqual({
      display: "flex", gap: "12px", justifyContent: "space-between", padding: "8px",
    });
  });
});
