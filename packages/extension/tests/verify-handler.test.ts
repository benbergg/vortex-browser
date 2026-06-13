// verify-handler.test.ts
// vortex_verify 的 extension 侧 handler 走 observe AX 树比对，绝不旁路 evaluate。
// 测试通过在同一 router 上注册一个 stub observe.snapshot（返回合成 AX elements），
// 再注册真 verify handler，验证四 mode 命中/未命中 + 失败 diff。

import { describe, it, expect, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ObserveActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerVerifyHandlers } from "../src/handlers/verify.js";

function mkReq(tool: string, args: Record<string, unknown> = {}): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1" };
}

// 合成一个 observe.snapshot full 结果（elements 含 role/name/visible/valueNow/attrs）。
type AxEl = {
  index: number;
  role: string;
  name: string;
  visible: boolean;
  valueNow?: string;
  attrs?: Record<string, string>;
};

function stubObserve(router: ActionRouter, elements: AxEl[]): void {
  router.register(ObserveActions.SNAPSHOT, async () => ({
    snapshotId: "snap_test",
    version: 2,
    url: "https://x/",
    title: "Test Page",
    elements,
    meta: { returnedCount: elements.length },
  }));
}

describe("verify.assert — visible mode", () => {
  let router: ActionRouter;
  beforeEach(() => {
    router = new ActionRouter();
  });

  it("匹配 role+name 的可见元素存在 → ok:true", async () => {
    stubObserve(router, [
      { index: 0, role: "button", name: "Save", visible: true },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "visible", role: "button", name: "Save" }),
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ ok: true });
  });

  it("元素存在但 visible:false → ok:false + diff", async () => {
    stubObserve(router, [
      { index: 0, role: "button", name: "Save", visible: false },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "visible", role: "button", name: "Save" }),
    );
    const r = res.result as { ok: boolean; expected: unknown; actual: unknown };
    expect(r.ok).toBe(false);
    expect(r.expected).toBeDefined();
    expect(r.actual).toBeDefined();
  });

  it("无匹配元素 → ok:false", async () => {
    stubObserve(router, [
      { index: 0, role: "link", name: "Home", visible: true },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "visible", role: "button", name: "Save" }),
    );
    expect((res.result as { ok: boolean }).ok).toBe(false);
  });
});

describe("verify.assert — value mode", () => {
  let router: ActionRouter;
  beforeEach(() => {
    router = new ActionRouter();
  });

  it("目标元素值 == value → ok:true", async () => {
    stubObserve(router, [
      { index: 0, role: "textbox", name: "Email", visible: true, attrs: { value: "a@b.com" } },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "value", role: "textbox", name: "Email", value: "a@b.com" }),
    );
    expect((res.result as { ok: boolean }).ok).toBe(true);
  });

  it("值不等 → ok:false + expected/actual diff", async () => {
    stubObserve(router, [
      { index: 0, role: "textbox", name: "Email", visible: true, attrs: { value: "x@y.com" } },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "value", role: "textbox", name: "Email", value: "a@b.com" }),
    );
    const r = res.result as { ok: boolean; expected: unknown; actual: unknown };
    expect(r.ok).toBe(false);
    expect(r.expected).toBe("a@b.com");
    expect(r.actual).toBe("x@y.com");
  });

  it("valueNow（slider 等值域控件）也参与比对", async () => {
    stubObserve(router, [
      { index: 0, role: "slider", name: "Volume", visible: true, valueNow: "30" },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "value", role: "slider", name: "Volume", value: "30" }),
    );
    expect((res.result as { ok: boolean }).ok).toBe(true);
  });
});

describe("verify.assert — text mode", () => {
  let router: ActionRouter;
  beforeEach(() => {
    router = new ActionRouter();
  });

  it("页面含 text（出现在某元素 name 或 title）→ ok:true", async () => {
    stubObserve(router, [
      { index: 0, role: "heading", name: "Welcome back", visible: true },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "text", text: "Welcome" }),
    );
    expect((res.result as { ok: boolean }).ok).toBe(true);
  });

  it("页面不含 text → ok:false + actual 给出已扫描线索", async () => {
    stubObserve(router, [
      { index: 0, role: "heading", name: "Goodbye", visible: true },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "text", text: "Welcome" }),
    );
    const r = res.result as { ok: boolean; expected: unknown };
    expect(r.ok).toBe(false);
    expect(r.expected).toBe("Welcome");
  });
});

describe("verify.assert — list mode", () => {
  let router: ActionRouter;
  beforeEach(() => {
    router = new ActionRouter();
  });

  it("所有 items 都存在 → ok:true", async () => {
    stubObserve(router, [
      { index: 0, role: "menuitem", name: "Home", visible: true },
      { index: 1, role: "menuitem", name: "About", visible: true },
      { index: 2, role: "menuitem", name: "Contact", visible: true },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", {
        mode: "list",
        items: [{ name: "Home" }, { name: "About" }, { name: "Contact" }],
      }),
    );
    expect((res.result as { ok: boolean }).ok).toBe(true);
  });

  it("有 item 缺失 → ok:false + actual.missing 列出缺失项", async () => {
    stubObserve(router, [
      { index: 0, role: "menuitem", name: "Home", visible: true },
      { index: 1, role: "menuitem", name: "About", visible: true },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", {
        mode: "list",
        items: [{ name: "Home" }, { name: "About" }, { name: "Contact" }],
      }),
    );
    const r = res.result as { ok: boolean; actual: { missing: string[] } };
    expect(r.ok).toBe(false);
    expect(r.actual.missing).toContain("Contact");
  });
});

describe("verify.assert — 入参校验", () => {
  it("未知 mode → INVALID_PARAMS", async () => {
    const router = new ActionRouter();
    stubObserve(router, []);
    registerVerifyHandlers(router);
    const res = await router.dispatch(mkReq("verify.assert", { mode: "bogus" }));
    expect(res.error).toBeDefined();
  });
});
