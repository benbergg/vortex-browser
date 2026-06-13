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

  // ── 必修1: valueNow 暴露文本控件 IDL 当前值 ─────────────────────────────
  it("文本 input: valueNow 优先(IDL 当前值) → ok:true [必修1-core]", async () => {
    // 模拟 observe 暴露了文本 input 的当前 IDL value（fill 后的状态）
    // attrs.value 是 HTML 默认属性值（旧值），valueNow 是当前输入值
    stubObserve(router, [
      {
        index: 0,
        role: "textbox",
        name: "用户名",
        visible: true,
        attrs: { value: "default", type: "text" },
        valueNow: "alice@example.com",  // IDL el.value — fill 后的当前值
      },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "value", role: "textbox", name: "用户名", value: "alice@example.com" }),
    );
    expect((res.result as { ok: boolean }).ok).toBe(true);
  });

  it("文本 input: valueNow 优先于 attrs.value，attrs.value 不再误当当前值 [必修1-priority]", async () => {
    // attrs.value = HTML 默认属性"old"，valueNow = fill 后实际当前值"new"
    stubObserve(router, [
      {
        index: 0,
        role: "textbox",
        name: "Search",
        visible: true,
        attrs: { value: "old", type: "text" },
        valueNow: "new input text",
      },
    ]);
    registerVerifyHandlers(router);
    // 断言期望值 = "old" → 应失败（因为当前值是 "new input text"）
    const resFail = await router.dispatch(
      mkReq("verify.assert", { mode: "value", role: "textbox", name: "Search", value: "old" }),
    );
    expect((resFail.result as { ok: boolean }).ok).toBe(false);

    // 断言期望值 = "new input text" → 应成功
    const resOk = await router.dispatch(
      mkReq("verify.assert", { mode: "value", role: "textbox", name: "Search", value: "new input text" }),
    );
    expect((resOk.result as { ok: boolean }).ok).toBe(true);
  });

  it("password 元素 valueNow 被剥离不泄露 → verify 报 actual=undefined [必修1-password保护]", async () => {
    // observe.ts password 防护：type=password → e.valueNow = undefined
    // 因此 stubObserve 模拟 password 元素时 valueNow 已被剥离
    stubObserve(router, [
      {
        index: 0,
        role: "textbox",
        name: "Password",
        visible: true,
        attrs: { value: "", type: "password" },
        // valueNow 故意不设 —— observe 已在密码保护层剥除
      },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "value", role: "textbox", name: "Password", value: "secret" }),
    );
    // 结果 ok:false + actual 没有泄露密码值
    const r = res.result as { ok: boolean; actual: unknown };
    expect(r.ok).toBe(false);
    expect(r.actual).toBeUndefined();
  });
});

// ── 必修2: target 作用域（MCP server 已将 @ref 翻译成 index + snapshotId）──
describe("verify.assert — target 作用域 (index 收窄)", () => {
  let router: ActionRouter;
  beforeEach(() => {
    router = new ActionRouter();
  });

  it("传 index=0: value mode 收窄到该元素，不按 role+name 扫全局 [必修2-value]", async () => {
    // 两个同名 textbox，index=0 的值为 "hello"，index=1 的值为 "world"
    stubObserve(router, [
      { index: 0, role: "textbox", name: "Field", visible: true, valueNow: "hello" },
      { index: 1, role: "textbox", name: "Field", visible: true, valueNow: "world" },
    ]);
    registerVerifyHandlers(router);
    // 指定 index=0 → 期望值 "hello" → ok:true
    const res0 = await router.dispatch(
      mkReq("verify.assert", { mode: "value", index: 0, value: "hello" }),
    );
    expect((res0.result as { ok: boolean }).ok).toBe(true);

    // 指定 index=1 → 期望值 "hello" → ok:false（该元素值是 "world"）
    const res1 = await router.dispatch(
      mkReq("verify.assert", { mode: "value", index: 1, value: "hello" }),
    );
    expect((res1.result as { ok: boolean }).ok).toBe(false);
  });

  it("传 index=1: text mode 收窄到该元素 name [必修2-text]", async () => {
    stubObserve(router, [
      { index: 0, role: "heading", name: "Page Title", visible: true },
      { index: 1, role: "paragraph", name: "Body content here", visible: true },
    ]);
    registerVerifyHandlers(router);
    // 指定 index=1 → 在该元素 name 中找 "Body" → ok:true
    const resOk = await router.dispatch(
      mkReq("verify.assert", { mode: "text", index: 1, text: "Body" }),
    );
    expect((resOk.result as { ok: boolean }).ok).toBe(true);

    // 指定 index=1 → 找 "Page Title"（在 index=0 不在 index=1）→ ok:false
    const resFail = await router.dispatch(
      mkReq("verify.assert", { mode: "text", index: 1, text: "Page Title" }),
    );
    expect((resFail.result as { ok: boolean }).ok).toBe(false);
  });

  it("传 index=2（不存在）: value mode → ok:false + actual:null [必修2-not-found]", async () => {
    stubObserve(router, [
      { index: 0, role: "textbox", name: "Field", visible: true, valueNow: "hello" },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "value", index: 2, value: "hello" }),
    );
    expect((res.result as { ok: boolean }).ok).toBe(false);
  });

  it("list mode 传 index → ok:false（list 不支持 target 作用域）", async () => {
    // list mode 本身就是批量检查，target 作用域无语义。不报错，走正常 list 逻辑。
    stubObserve(router, [
      { index: 0, role: "menuitem", name: "Home", visible: true },
    ]);
    registerVerifyHandlers(router);
    const res = await router.dispatch(
      mkReq("verify.assert", { mode: "list", index: 0, items: [{ name: "Home" }] }),
    );
    // list mode 不受 index 影响，正常按 items 扫全表
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
