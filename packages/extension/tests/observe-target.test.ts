import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { stubDocumentChrome } from "./helpers/document-chrome.js";
import { getSnapshotEntry, setSnapshot } from "../src/lib/snapshot-store.js";
import { resolveTarget } from "../src/lib/resolve-target.js";

vi.mock("../src/action/wait-actionable-auto-force.js", () => ({ waitActionableAutoForce: vi.fn().mockResolvedValue({}) }));

function setup(html: string) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: "https://x/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window as any;
  for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location"]) {
    vi.stubGlobal(name, name === "window" ? win : win[name]);
  }
  vi.stubGlobal("getComputedStyle", win.getComputedStyle.bind(win));
  vi.stubGlobal("CSS", { escape: (v: string) => v });
  win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
  Object.defineProperty(win.document, "elementFromPoint", { value: () => null });
  stubDocumentChrome([{ frameId: 0, parentFrameId: -1, dom }]);
  vi.stubGlobal('MouseEvent', win.MouseEvent);
  const router = new ActionRouter();
  registerObserveHandlers(router);
  registerDomHandlers(router, {} as any);
  (win as any).act = (args: Record<string, unknown>) => router.dispatch({ type: 'tool_request', tool: 'dom.click', args, requestId: 'action-test', tabId: 42 } as NmRequest);
  return async (args: Record<string, unknown> = {}, tabId = 42) => router.dispatch({
    type: "tool_request", tool: "observe.snapshot", args, requestId: "target-test", tabId,
  } as NmRequest);
}

afterEach(() => vi.unstubAllGlobals());

describe("observe target scope", () => {
  const html = '<button>Outside</button><section id="focus" role="region" aria-label="Focused"><button>Inside</button></section>';

  it("keeps whole-page behavior without a target", async () => {
    const observe = setup(html);
    const result: any = await observe({ filter: "all" });
    expect(result.error).toBeUndefined();
    expect(result.result.elements.map((e: any) => e.name)).toEqual(expect.arrayContaining(["Outside", "Focused", "Inside"]));
  });

  it("does not return whole-page hover controls for a target and reports the limitation", async () => {
    const observe = setup(html);
    const sentinel = { triggerSelector: '#outside', triggerText: 'Outside', controlSelector: '#outside-control', controlTag: 'button', controlClasses: '', controlName: 'Outside hover', controlCursor: 'pointer' };
    (window as any).__vortexHoverReveal = { findRevealPairs: () => [sentinel] };
    const whole: any = await observe();
    expect(whole.result.frames[0].hoverControls).toEqual([sentinel]);
    const scoped: any = await observe({ target: '#focus' });
    expect(scoped.error).toBeUndefined();
    expect(scoped.result.frames[0].hoverControls ?? []).not.toContainEqual(sentinel);
    expect(scoped.result.frames[0].hoverControlsUnavailable).toBe('target-scope');
  });

  it("includes the target container and descendants but excludes siblings", async () => {
    const observe = setup(html);
    const result: any = await observe({ target: "#focus", filter: "all" });
    expect(result.error).toBeUndefined();
    const names = result.result.elements.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(["Focused", "Inside"]));
    expect(names).not.toContain("Outside");
  });

  it.each([["#missing", "ELEMENT_NOT_FOUND"], ["button", "SELECTOR_AMBIGUOUS"]])("rejects CSS target %s with %s", async (target, code) => {
    const result: any = await setup(html)({ target });
    expect(result.error?.code).toBe(code);
  });

  it("resolves a prior snapshot target before capturing, and new indexes resolve to scoped elements", async () => {
    const observe = setup(html);
    const first: any = await observe({ filter: "all" });
    const container = first.result.elements.find((e: any) => e.name === "Focused");
    expect(container).toBeDefined();
    const scoped: any = await observe({ index: container.index, snapshotId: first.result.snapshotId, filter: "all" });
    expect(scoped.error).toBeUndefined();
    expect(scoped.result.snapshotId).not.toBe(first.result.snapshotId);
    expect(scoped.result.elements.map((e: any) => e.name)).not.toContain("Outside");
    const inside = scoped.result.elements.find((e: any) => e.name === "Inside");
    expect(inside).toBeDefined();
    const resolved = resolveTarget({ index: inside.index, snapshotId: scoped.result.snapshotId });
    expect(document.querySelector(resolved.selector)?.textContent).toBe("Inside");
  });

  it("the new scoped index resolves to the exact descendant DOM node", async () => {
    const observe = setup('<button id="outside">Outside</button><section id="focus"><button id="inside">Inside</button></section>');
    const scoped: any = await observe({ target: "#focus" });
    expect(scoped.error).toBeUndefined();
    const inside = scoped.result.elements.find((e: any) => e.name === "Inside");
    expect(inside).toBeDefined();
    const resolved = resolveTarget({ index: inside.index, snapshotId: scoped.result.snapshotId });
    expect(document.querySelector(resolved.selector)).toBe(document.querySelector("#inside"));
    expect(scoped.result.elements.map((e: any) => e.name)).toEqual(["Inside"]);
  });

  it.each([
    ["other tab", 43, 0, Date.now(), "tab"],
    ["other frame", 42, 7, Date.now(), "frame"],
    ["expired", 42, 0, Date.now() - 61_000, "STALE_SNAPSHOT"],
  ])("rejects a ref from %s", async (_label, tabId, frameId, capturedAt, expected) => {
    const observe = setup(html);
    const snapshotId = `target-${_label}`;
    setSnapshot(snapshotId, { tabId, frameId, capturedAt, elements: [{ index: 0, selector: "#focus", frameId }] });
    expect(getSnapshotEntry(snapshotId)).toBeDefined();
    const result: any = await observe({ index: 0, snapshotId, frameId: 0 });
    if (expected === "STALE_SNAPSHOT") expect(result.error?.code).toBe(expected);
    else expect(result.error?.message ?? "").toMatch(new RegExp(expected, "i"));
  });

  it("can focus beyond the whole-page limit and resolve an actionable descendant", async () => {
    const observe = setup(`${Array.from({ length: 90 }, (_, i) => `<button>Before ${i}</button>`).join("")}<section id="focus"><button id="later">Later</button></section>`);
    const first: any = await observe();
    expect(first.error).toBeUndefined();
    expect(first.result.frames[0].truncated).toBe(true);
    expect(first.result.elements.map((e: any) => e.name)).not.toContain("Later");

    const scoped: any = await observe({ target: "#focus" });
    expect(scoped.error).toBeUndefined();
    const later = scoped.result.elements.find((e: any) => e.name === "Later");
    expect(later).toBeDefined();
    const clicked = vi.fn();
    document.querySelector('#later')!.addEventListener('click', clicked);
    const action = await (window as any).act({ index: later.index, snapshotId: scoped.result.snapshotId, force: true });
    expect(action.error).toBeUndefined();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each(["light", "shadow"])("limits duplicate context cloning to the target in %s DOM", async (kind) => {
    const observe = setup('<div id="outer"><section id="focus"><div>Alpha<button>Open</button></div><div>Beta<button>Open</button></div></section><aside>Outside secret</aside></div>');
    let scope = document.querySelector("#focus")!;
    if (kind === "shadow") {
      const host = document.createElement("div");
      document.querySelector("#outer")!.appendChild(host);
      host.attachShadow({ mode: "open" }).appendChild(scope);
    }
    const outer = document.querySelector("#outer")!;
    const clone = vi.spyOn(outer, "cloneNode");
    const result: any = await observe({ target: "#focus" });
    expect(result.error).toBeUndefined();
    expect(clone).not.toHaveBeenCalled();
    const contexts = result.result.elements.filter((e: any) => e.name === "Open").map((e: any) => e.dupContext);
    expect(contexts).toEqual(["Alpha", "Beta"]);
  });

  it("does not scan outside candidates or blindspots", async () => {
    const observe = setup(`<section id="focus"><button>Inside</button></section>${'<div class="outside"></div>'.repeat(200)}<div role="grid" aria-rowcount="100" aria-label="Outside grid"></div>`);
    const outside = document.querySelectorAll('.outside');
    let visited = 0;
    for (const el of outside) Object.defineProperty(el, 'scrollHeight', { get() { visited++; return 0; } });
    const result: any = await observe({ target: '#focus' });
    expect(result.error).toBeUndefined();
    expect(visited).toBe(0);
    expect(result.result.frames[0].blindspots ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Outside grid' })]));
  });

  it('does not query rows on a scrolling ancestor outside the target', async () => {
    const observe = setup('<div id="outer" style="overflow-y:auto"><section id="focus"><ul><li>A</li><li>B</li><li>C</li></ul></section><ul><li>Outside</li></ul></div>');
    const outer = document.querySelector('#outer')!;
    Object.defineProperty(outer, 'scrollHeight', { value: 1000 });
    Object.defineProperty(outer, 'clientHeight', { value: 100 });
    const query = vi.spyOn(outer, 'querySelectorAll');
    const result: any = await observe({ target: '#focus' });
    expect(result.error).toBeUndefined();
    expect(query.mock.calls.some(([selector]) => selector === '[role=row],tr,li')).toBe(false);
  });

  it('includes descendants in open shadow roots and resolves shadow targets', async () => {
    const observe = setup('<div id="host"></div>');
    const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section id="inner" role="region" aria-label="Shadow scope"><button>Shadow button</button></section>';
    const host: any = await observe({ target: '#host', filter: 'all' });
    expect(host.result.elements.map((e: any) => e.name)).toContain('Shadow button');
    const ref = host.result.elements.find((e: any) => e.name === 'Shadow scope');
    const viaRef: any = await observe({ index: ref.index, snapshotId: host.result.snapshotId, filter: 'all' });
    expect(viaRef.error).toBeUndefined();
    expect(viaRef.result.elements.map((e: any) => e.name)).toContain('Shadow button');
    const inner: any = await observe({ target: '#inner', filter: 'all' });
    expect(inner.error).toBeUndefined();
    expect(inner.result.elements.map((e: any) => e.name)).toContain('Shadow button');
  });

  it('rejects ambiguous selectors across shadow roots', async () => {
    const observe = setup('<div id="one"></div><div id="two"></div>');
    for (const host of document.querySelectorAll('div')) host.attachShadow({ mode: 'open' }).innerHTML = '<button class="shared">X</button>';
    const result: any = await observe({ target: '.shared' });
    expect(result.error?.code).toBe('SELECTOR_AMBIGUOUS');
  });

  it.each(['[', '#missing', 'button'])('preserves previous rid on failed selector %s', async (target) => {
    const observe = setup('<button class="same">One</button><button class="same">Two</button>');
    const selector = '[data-vortex-rid="old"]';
    document.querySelector('button')!.setAttribute('data-vortex-rid', 'old');
    setSnapshot('old-rid', { tabId: 42, frameId: 0, capturedAt: Date.now(), elements: [{ index: 0, selector, frameId: 0 }] });
    expect(resolveTarget({ index: 0, snapshotId: 'old-rid' }).selector).toBe(selector);
    const failed: any = await observe({ target });
    expect(failed.error).toBeDefined();
    const clicked = vi.fn();
    document.querySelector(selector)!.addEventListener('click', clicked);
    const action = await (window as any).act({ index: 0, snapshotId: 'old-rid', force: true });
    expect(action.error).toBeUndefined();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("preserves truncation metadata for a large target", async () => {
    const observe = setup(`<button>Outside</button><section id="focus">${Array.from({ length: 90 }, (_, i) => `<button>B${i}</button>`).join("")}</section>`);
    const result: any = await observe({ target: "#focus" });
    expect(result.error).toBeUndefined();
    expect(result.result.frames[0].truncated).toBe(true);
    expect(result.result.elements).toHaveLength(80);
    expect(result.result.elements.map((e: any) => e.name)).not.toContain("Outside");
  });
});
