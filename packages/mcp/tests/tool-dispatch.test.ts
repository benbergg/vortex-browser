import { describe, it, expect } from "vitest";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("dispatchNewTool", () => {
  it("vortex_navigate → page.navigate 默认", () => {
    const { action } = dispatchNewTool("vortex_navigate", { url: "http://e.com" })!;
    expect(action).toBe("page.navigate");
  });

  it("vortex_navigate reload:true → page.reload", () => {
    const { action } = dispatchNewTool("vortex_navigate", { reload: true })!;
    expect(action).toBe("page.reload");
  });

  it("vortex_navigate reload:true 不透传 reload 字段", () => {
    const { params } = dispatchNewTool("vortex_navigate", { reload: true, url: "http://e.com" })!;
    expect(params).not.toHaveProperty("reload");
  });

  it("vortex_history direction:forward → page.forward", () => {
    const { action } = dispatchNewTool("vortex_history", { direction: "forward" })!;
    expect(action).toBe("page.forward");
  });

  it("vortex_history direction:back → page.back", () => {
    const { action } = dispatchNewTool("vortex_history", { direction: "back" })!;
    expect(action).toBe("page.back");
  });

  it("vortex_history 省略 direction → page.back（默认）", () => {
    const { action } = dispatchNewTool("vortex_history", {})!;
    expect(action).toBe("page.back");
  });

  it("vortex_wait_idle kind:dom → dom.waitSettled", () => {
    const { action } = dispatchNewTool("vortex_wait_idle", { kind: "dom" })!;
    expect(action).toBe("dom.waitSettled");
  });

  it("vortex_wait_idle kind:network → page.waitForNetworkIdle", () => {
    const { action } = dispatchNewTool("vortex_wait_idle", { kind: "network" })!;
    expect(action).toBe("page.waitForNetworkIdle");
  });

  it("vortex_wait_idle kind:xhr → page.waitForXhrIdle", () => {
    const { action } = dispatchNewTool("vortex_wait_idle", { kind: "xhr" })!;
    expect(action).toBe("page.waitForXhrIdle");
  });

  it("vortex_wait_idle idleMs 映射到 idleTime（xhr）", () => {
    const { params } = dispatchNewTool("vortex_wait_idle", { kind: "xhr", idleMs: 300 })!;
    expect(params.idleTime).toBe(300);
    expect(params).not.toHaveProperty("idleMs");
  });

  it("vortex_wait_idle idleMs 映射到 quietMs（dom）", () => {
    const { params } = dispatchNewTool("vortex_wait_idle", { kind: "dom", idleMs: 500 })!;
    expect(params.quietMs).toBe(500);
    expect(params).not.toHaveProperty("idleMs");
  });

  it("vortex_fill widget:cascader → dom.commit", () => {
    const { action } = dispatchNewTool("vortex_fill", { widget: "cascader", value: "x" })!;
    expect(action).toBe("dom.commit");
  });

  it("vortex_fill widget:checkbox-group → dom.commit", () => {
    const { action } = dispatchNewTool("vortex_fill", { widget: "checkbox-group", value: ["a"] })!;
    expect(action).toBe("dom.commit");
  });

  it("vortex_fill 无 widget → dom.fill", () => {
    const { action } = dispatchNewTool("vortex_fill", { value: "x" })!;
    expect(action).toBe("dom.fill");
  });

  it("vortex_evaluate async:false → js.evaluate", () => {
    const { action } = dispatchNewTool("vortex_evaluate", { code: "1+1", async: false })!;
    expect(action).toBe("js.evaluate");
  });

  it("vortex_evaluate async:true → js.evaluateAsync", () => {
    const { action } = dispatchNewTool("vortex_evaluate", { code: "await fetch('/')", async: true })!;
    expect(action).toBe("js.evaluateAsync");
  });

  it("vortex_screenshot 无 target → capture.screenshot", () => {
    const { action } = dispatchNewTool("vortex_screenshot", {})!;
    expect(action).toBe("capture.screenshot");
  });

  it("vortex_screenshot 有 selector → capture.element", () => {
    const { action } = dispatchNewTool("vortex_screenshot", { selector: "#x" })!;
    expect(action).toBe("capture.element");
  });

  it("vortex_console op:get → console.getLogs", () => {
    const { action } = dispatchNewTool("vortex_console", { op: "get" })!;
    expect(action).toBe("console.getLogs");
  });

  it("vortex_console op:clear → console.clear", () => {
    const { action } = dispatchNewTool("vortex_console", { op: "clear" })!;
    expect(action).toBe("console.clear");
  });

  it("vortex_network op:get 无 filter → network.getLogs", () => {
    const { action } = dispatchNewTool("vortex_network", { op: "get" })!;
    expect(action).toBe("network.getLogs");
  });

  it("vortex_network op:get + filter → network.filter", () => {
    const { action } = dispatchNewTool("vortex_network", { op: "get", filter: { url: "/api" } })!;
    expect(action).toBe("network.filter");
  });

  it("vortex_network op:clear → network.clear", () => {
    const { action } = dispatchNewTool("vortex_network", { op: "clear" })!;
    expect(action).toBe("network.clear");
  });

  it("vortex_storage_get scope:cookie → storage.getCookies", () => {
    const { action } = dispatchNewTool("vortex_storage_get", { scope: "cookie" })!;
    expect(action).toBe("storage.getCookies");
  });

  it("vortex_storage_get scope:local → storage.getLocalStorage", () => {
    const { action } = dispatchNewTool("vortex_storage_get", { scope: "local" })!;
    expect(action).toBe("storage.getLocalStorage");
  });

  it("vortex_storage_get scope:session → storage.getSessionStorage", () => {
    const { action } = dispatchNewTool("vortex_storage_get", { scope: "session" })!;
    expect(action).toBe("storage.getSessionStorage");
  });

  it("vortex_storage_set scope:cookie → storage.setCookie", () => {
    const { action } = dispatchNewTool("vortex_storage_set", { scope: "cookie", name: "k", value: "v" })!;
    expect(action).toBe("storage.setCookie");
  });

  it("vortex_storage_set scope:cookie op:delete → storage.deleteCookie", () => {
    const { action } = dispatchNewTool("vortex_storage_set", { scope: "cookie", op: "delete", name: "k" })!;
    expect(action).toBe("storage.deleteCookie");
  });

  it("vortex_storage_set scope:local → storage.setLocalStorage", () => {
    const { action } = dispatchNewTool("vortex_storage_set", { scope: "local", key: "k", value: "v" })!;
    expect(action).toBe("storage.setLocalStorage");
  });

  it("vortex_storage_session op:export → storage.exportSession", () => {
    const { action } = dispatchNewTool("vortex_storage_session", { op: "export", domain: "e.com" })!;
    expect(action).toBe("storage.exportSession");
  });

  it("vortex_storage_session op:import → storage.importSession", () => {
    const { action } = dispatchNewTool("vortex_storage_session", { op: "import", data: {} })!;
    expect(action).toBe("storage.importSession");
  });

  it("vortex_file_list_downloads → file.getDownloads", () => {
    const { action } = dispatchNewTool("vortex_file_list_downloads", {})!;
    expect(action).toBe("file.getDownloads");
  });

  // v0.7.1 P2 fix: vortex_act(scroll) value 是参数对象而非数据值
  // 注：server.ts 已把 params.target 翻成 params.selector（@ref→selector，或
  // raw CSS selector 直透），所以 dispatch 收到的是 params.selector 而非 params.target。
  it("vortex_act(scroll, value={container, position}) 把 value spread + strip selector", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      selector: "body", // server.ts 已翻译过的形态
      action: "scroll",
      value: { container: ".scroll-box", position: "bottom" },
    })!;
    expect(action).toBe("dom.scroll");
    expect(params.container).toBe(".scroll-box");
    expect(params.position).toBe("bottom");
    // selector / target 都必须被 strip，否则底层 dom.scroll 走 scrollIntoView 屏蔽 container/position
    expect(params).not.toHaveProperty("target");
    expect(params).not.toHaveProperty("selector");
    // value 字段不应再透传（避免底层误读）
    expect(params).not.toHaveProperty("value");
  });

  it("vortex_act(scroll, value={x, y}) 同样 spread + strip selector/target/index", () => {
    const { params } = dispatchNewTool("vortex_act", {
      selector: "body",
      index: 5, // ref 形式翻译后会带 index
      snapshotId: "snap_x",
      action: "scroll",
      value: { x: 100, y: 500 },
    })!;
    expect(params.x).toBe(100);
    expect(params.y).toBe(500);
    expect(params).not.toHaveProperty("target");
    expect(params).not.toHaveProperty("selector");
    expect(params).not.toHaveProperty("index");
    expect(params).not.toHaveProperty("value");
  });

  it("vortex_act(scroll, target=...) 不带 value 时 selector 保留（scrollIntoView 路径）", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      selector: "._lastItem",
      action: "scroll",
    })!;
    expect(action).toBe("dom.scroll");
    expect(params.selector).toBe("._lastItem");
  });

  it("vortex_act(fill, value='hello') 仍透传 value（数据值语义不变）", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      action: "fill",
      target: "@e1",
      value: "hello",
    })!;
    expect(action).toBe("dom.fill");
    expect(params.value).toBe("hello");
  });

  it("vortex_act(scroll, target=...) 不传 value 时也通", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      action: "scroll",
      target: "._listItem:last-child",
    })!;
    expect(action).toBe("dom.scroll");
    expect(params.target).toBe("._listItem:last-child");
    expect(params).not.toHaveProperty("value");
  });

  // ── 2026-06-01 真实站点 dogfood(ag-grid)发现 ────────────────────────────
  // BUG G:MCP client 会把 untyped `value:{}` 的对象实参序列化成 JSON 字符串。
  // 旧测试传「真对象」所以一直 green,但 e2e 实际收到的是字符串 →
  // `typeof value === "object"` 判否 → spread+strip 全跳过 → selector 残留 →
  // 底层 dom.scroll 走 scrollIntoView 屏蔽 container/position,且静默返回 success。
  // 修复:scroll 的字符串 value 先 JSON.parse 再判定。
  it("vortex_act(scroll, value 为 JSON 字符串) 解析后 spread + strip selector（e2e 真实形态）", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      selector: "body",
      action: "scroll",
      value: '{"container":".scroll-box","y":3000}', // client 序列化后的字符串
    })!;
    expect(action).toBe("dom.scroll");
    expect(params.container).toBe(".scroll-box");
    expect(params.y).toBe(3000);
    expect(params).not.toHaveProperty("selector");
    expect(params).not.toHaveProperty("target");
    expect(params).not.toHaveProperty("value");
  });

  it("vortex_act(scroll, value 为非 JSON 字符串) 不崩溃，保留 selector 走 scrollIntoView", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      selector: "._lastItem",
      action: "scroll",
      value: "not-json",
    })!;
    expect(action).toBe("dom.scroll");
    expect(params.selector).toBe("._lastItem");
  });

  // BUG H:dom.type handler 读 `args.text`,但 dispatch 把数据放 `next.value`,
  // 导致 vortex_act(type) 永远报 "Missing required param: text"(纯字符串也复现)。
  // fill/select 的 handler 读 `args.value` 所以正常,唯独 type 错位。
  it("vortex_act(type, value='abc') 映射到 text（dom.type 读 args.text）", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      action: "type",
      target: "@e1",
      value: "abc",
    })!;
    expect(action).toBe("dom.type");
    expect(params.text).toBe("abc");
  });

  // 2026-06-03 act 原语白盒审计族 E:原生 <select multiple> 多选传数组 value,
  // 但 client 把数组序列化成 JSON 字符串,旧 dispatch 只对 scroll 走
  // parseStructuredValue,select 数组当字符串 '["x","z"]' 整体匹配 → NO_MATCHING_OPTION。
  // 修复:select 的 value 也走 parseStructuredValue。
  it("vortex_act(select, value 为 JSON 字符串数组) 解析回数组(多选)", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      action: "select",
      target: "@e1",
      value: '["x","z"]', // client 序列化后的字符串
    })!;
    expect(action).toBe("dom.select");
    expect(params.value).toEqual(["x", "z"]);
  });

  it("vortex_act(select, value 为单值文本) 原样透传不误伤(单选)", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      action: "select",
      target: "@e1",
      value: "Banana",
    })!;
    expect(action).toBe("dom.select");
    expect(params.value).toBe("Banana");
  });

  // BUG lead(同 G 根因):client 把 fill 结构化 kind 的数组/对象 value 也序列化成
  // JSON 字符串，dom.commit driver 期望 string[] / {values} → `Array.isArray` 判否
  // 报 "value must be a non-empty label path array"。修复:结构化 kind 的字符串
  // value 先 JSON.parse 还原。Element Plus cascader e2e 实证。
  it("vortex_fill(widget=cascader, value 为 JSON 字符串数组) 解析回数组", () => {
    const { action, params } = dispatchNewTool("vortex_fill", {
      target: "@e1",
      widget: "cascader",
      value: '["Guide","Disciplines","Consistency"]',
    })!;
    expect(action).toBe("dom.commit");
    expect(params.value).toEqual(["Guide", "Disciplines", "Consistency"]);
    expect(params.kind).toBe("cascader"); // 映射回 kind 下发 extension
  });

  it("vortex_fill(widget=checkbox-group, value 为 JSON 字符串对象) 解析回对象", () => {
    const { params } = dispatchNewTool("vortex_fill", {
      target: "@e1",
      widget: "checkbox-group",
      value: '{"values":["A","B"]}',
    })!;
    expect(params.value).toEqual({ values: ["A", "B"] });
  });

  it("vortex_fill(widget=select, 单值普通字符串) 不被 JSON.parse 误伤", () => {
    const { params } = dispatchNewTool("vortex_fill", {
      target: "@e1",
      widget: "select",
      value: "北京", // 非 JSON,保持原字符串
    })!;
    expect(params.value).toBe("北京");
  });

  it("vortex_fill(纯文本 fill,无 kind) value 原样透传不 parse", () => {
    const { action, params } = dispatchNewTool("vortex_fill", {
      target: "@e1",
      value: "[1,2]", // 形似 JSON 的普通文本,纯 fill 不应 parse
    })!;
    expect(action).toBe("dom.fill");
    expect(params.value).toBe("[1,2]");
  });

  // P1: vortex_extract scroll(boolean)随 ...rest 透传到 content.getText,
  // handler 据此在提取前 scroll-until-settled 触发懒加载。
  it("vortex_extract(scroll:true) → content.getText 透传 scroll", () => {
    const { action, params } = dispatchNewTool("vortex_extract", { scroll: true })!;
    expect(action).toBe("content.getText");
    expect(params.scroll).toBe(true);
  });

  it("vortex_extract 不传 scroll → params 无 scroll（向后兼容）", () => {
    const { params } = dispatchNewTool("vortex_extract", { selector: "#x" })!;
    expect(params.scroll).toBeUndefined();
  });

  it("未知工具名返回 null（走 toolDef.action 默认路径）", () => {
    const result = dispatchNewTool("vortex_click", {});
    expect(result).toBeNull();
  });

  it("工具总数应为 37", async () => {
    // v0.8.x: vortex_fill_form removed as dead internal tool (no caller — the
    // L4 facade routes per-field through vortex_act / vortex_fill instead).
    // caps opt-in: vortex_verify(cap:"testing") 加入 internal 全量 → 35→36。
    // dev-reload: vortex_dev_reload(cap:"dev") 加入 internal 全量 → 36→37。
    const { getAllToolDefs } = await import("../src/tools/schemas.js");
    expect(getAllToolDefs().length).toBe(37);
  });
});
