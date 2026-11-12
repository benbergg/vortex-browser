import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { DOM_CLICK_PAGE_FUNC, DOM_HOVER_PAGE_FUNC, DOM_SELECT_PAGE_FUNC } from "../src/handlers/dom.js";
import { resolveTarget } from "../src/lib/resolve-target.js";
import { mapPageError } from "../src/adapter/native.js";
import { formatDispatchError } from "../../mcp/src/lib/dispatch-error.js";
import { VtxErrorCode, vtxError } from "@vortex-browser/shared";

import { stubDocumentChrome } from "./helpers/document-chrome.js";

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

it.each([
  ["before", true], ["blur", true], ["focus", true],
  ["pointerdown", true], ["mousedown", true], ["pointerup", true], ["mouseup", true],
  ["pointerdown", false], ["mousedown", false], ["focus-control", false],
  ["value", false], ["checked", false], ["selected", false],
])("aborts a paginated click when %s mutates the page (replace=%s)", async (eventName, replace) => {
  dom = new JSDOM('<!doctype html><body><button id="previous">Previous</button><button id="target">Menu</button><div id="menu"></div><input id="value" value="old"><input id="checked" type="checkbox"><select><option id="first">first</option><option id="selected">second</option></select></body>', { url: "https://example.test/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window as any;
  for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location", "MutationObserver", "MouseEvent", "Event", "InputEvent", "KeyboardEvent", "HTMLSelectElement", "HTMLTextAreaElement"]) vi.stubGlobal(name, name === "window" ? win : win[name]);
  vi.stubGlobal("PointerEvent", win.MouseEvent);
  vi.stubGlobal("getComputedStyle", win.getComputedStyle.bind(win));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
  win.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(win.document, "elementFromPoint", { value: () => win.document.querySelector("#target") });
  stubDocumentChrome([{ frameId: 0, parentFrameId: -1, dom }]);
  const target = document.querySelector("#target")!;
  const previous = document.querySelector("#previous") as HTMLElement;
  if (eventName === "blur") previous.focus();
  const events: string[] = [];
  const sequence = ["focus", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const name of ["blur", ...sequence]) document.addEventListener(name, (event) => {
    events.push(`${name}:${event.target === target ? "original" : event.target === previous ? "previous" : "replacement"}`);
  }, true);
  const replaceTarget = () => {
    document.querySelector("#menu")!.textContent = "Opened";
    if (replace) target.replaceWith(target.cloneNode(true));
  };
  if (eventName === "blur") previous.addEventListener("blur", replaceTarget);
  else if (eventName === "focus-control") target.addEventListener("focus", () => { (document.querySelector("#checked") as HTMLInputElement).checked = true; });
  else if (!["before", "value", "checked", "selected"].includes(eventName)) target.addEventListener(eventName, replaceTarget);
  const router = new ActionRouter();
  registerObserveHandlers(router, {} as any);
  const snapshot: any = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: { target: "#target", paginate: true, includeAX: false }, requestId: "test", tabId: 42 } as any);
  expect(snapshot.error).toBeUndefined();
  const entry = snapshot.result.elements.find((item: any) => item.name === "Menu");
  expect(entry).toBeDefined();
  const resolved = resolveTarget({ snapshotId: snapshot.result.snapshotId, index: entry.index }, true);
  const pagination = resolved.pagination!;
  expect(win.__vortexPageSnapshots[pagination.snapshotId].validate(pagination.nodeIndex, resolved.selector)).toBe(target);
  if (eventName === "before") replaceTarget();
  if (eventName === "value") (document.querySelector("#value") as HTMLInputElement).value = "new";
  if (eventName === "checked") (document.querySelector("#checked") as HTMLInputElement).checked = true;
  if (eventName === "selected") (document.querySelector("#selected") as HTMLOptionElement).selected = true;
  const result = await DOM_CLICK_PAGE_FUNC(resolved.selector, false, false, 300, "dismiss", null, true, pagination);
  expect(document.querySelector("#menu")!.textContent).toBe(["value", "checked", "selected", "focus-control"].includes(eventName) ? "" : "Opened");
  expect(document.querySelector("#target") === target).toBe(!replace);
  expect(result).toMatchObject({ errorCode: "STALE_SNAPSHOT" });
  if (["before", "value", "checked", "selected"].includes(eventName)) {
    expect(result.error).toBe("Page changed since the snapshot was captured");
    expect(result.extras).toBeUndefined();
    expect(events).toEqual([]);
  } else {
    expect(result.error).toMatch(/Page changed since the snapshot was captured.*may have.*executed.*check.*page.*do not.*retry/i);
    expect(result.extras).toEqual({ actionMayHaveExecuted: true });
    expect(events).toEqual(eventName === "blur" ? ["blur:previous"] : sequence.slice(0, sequence.indexOf(eventName === "focus-control" ? "focus" : eventName) + 1).map((name) => `${name}:original`));
  }
  expect(result.result).toBeUndefined();

  router.register("test.pageError", async () => mapPageError(result, resolved.selector));
  const routed = await router.dispatch({ type: "tool_request", tool: "test.pageError", args: {}, requestId: "error", tabId: 42 } as any);
  expect(routed.error?.code).toBe("STALE_SNAPSHOT");
  const text = formatDispatchError(routed.error!);
  if (["before", "value", "checked", "selected"].includes(eventName)) {
    expect(text).toMatch(/vortex_observe.*retry/i);
  } else {
    expect(routed.error?.context?.extras).toEqual({ actionMayHaveExecuted: true });
    expect(text).toMatch(/check the page state.*do not retry directly/i);
    expect(text).not.toMatch(/vortex_observe.*retry/i);
  }
});

it.each(["select", "hover"] as const)("rejects silent control changes before paginated %s", async (action) => {
  dom = new JSDOM('<!doctype html><body><input id="other" value="old"><select id="target" aria-label="Target"><option value="a">a</option><option value="b">b</option></select></body>', { url: "https://example.test/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window as any;
  for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location", "MutationObserver", "MouseEvent", "Event", "InputEvent", "KeyboardEvent", "HTMLSelectElement", "HTMLTextAreaElement"]) vi.stubGlobal(name, name === "window" ? win : win[name]);
  vi.stubGlobal("PointerEvent", win.MouseEvent);
  vi.stubGlobal("getComputedStyle", win.getComputedStyle.bind(win));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
  Object.defineProperty(win.document, "elementFromPoint", { value: () => win.document.querySelector("#target") });
  stubDocumentChrome([{ frameId: 0, parentFrameId: -1, dom }]);
  const router = new ActionRouter();
  registerObserveHandlers(router, {} as any);
  const snapshot: any = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: { target: "#target", paginate: true, includeAX: false }, requestId: "test", tabId: 42 } as any);
  expect(snapshot.error).toBeUndefined();
  const resolved = resolveTarget({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index }, true);
  (document.querySelector("#other") as HTMLInputElement).value = "changed";
  const target = document.querySelector("#target") as HTMLSelectElement;
  const handler = vi.fn();
  target.addEventListener(action === "select" ? "change" : "mouseover", handler);
  const result = action === "select" ? await DOM_SELECT_PAGE_FUNC(resolved.selector, "b", 100, resolved.pagination) : DOM_HOVER_PAGE_FUNC(resolved.selector, resolved.pagination);
  expect(result).toMatchObject({ errorCode: "STALE_SNAPSHOT" });
  expect(target.value).toBe("a");
  expect(handler).not.toHaveBeenCalled();
});

it("preserves a CDP error through router and MCP rendering", async () => {
  const router = new ActionRouter();
  router.register("test.cdp", async () => { throw vtxError(VtxErrorCode.CDP_NOT_ATTACHED, "CDP attach failed"); });
  const routed = await router.dispatch({ type: "tool_request", tool: "test.cdp", args: {}, requestId: "cdp", tabId: 42 } as any);
  expect(formatDispatchError(routed.error!)).toContain("Error [CDP_NOT_ATTACHED]: CDP attach failed");
});
