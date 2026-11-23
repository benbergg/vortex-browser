import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { VtxErrorCode, vtxError, type NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { queryAllDeep } from "../src/page-side/shadow-walk.js";
import { waitActionableAutoForce } from "../src/action/wait-actionable-auto-force.js";
import * as heal from "../src/action/heal.js";
import { cdpClickElement } from "../src/adapter/cdp.js";
import { checkActionability } from "../src/action/actionability.js";
import { loadPageSideModule } from "../src/adapter/page-side-loader.js";
import { formatDispatchError } from "../../mcp/src/lib/dispatch-error.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/action/wait-actionable-auto-force.js", () => ({ waitActionableAutoForce: vi.fn().mockResolvedValue({}) }));

const windows: Array<JSDOM["window"]> = [];

function setup(manager: any = {}, observeManager: any = {}) {
  const dom = new JSDOM(`<!doctype html><body><section id="focus">${Array.from({ length: 90 }, (_, i) => `<button id="b${i}">Button ${i}</button>`).join("")}</section></body>`, { url: "https://x/", pretendToBeVisual: true });
  windows.push(dom.window);
  let win = dom.window as any;
  const bindWindow = () => {
    for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location", "MutationObserver", "MouseEvent", "Event", "InputEvent", "KeyboardEvent", "HTMLSelectElement", "HTMLTextAreaElement"]) vi.stubGlobal(name, name === "window" ? win : win[name]);
    vi.stubGlobal("getComputedStyle", win.getComputedStyle.bind(win));
  };
  bindWindow();
  vi.stubGlobal("CSS", { escape: (v: string) => v });
  win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
  win.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(win.document, "elementFromPoint", { value: () => null });
  let documentId = "main-document";
  const replaceDocument = () => {
    documentId = "next-document";
    const next = new JSDOM('<!doctype html><body><button id="next">Next document</button></body>', { url: "https://x/", pretendToBeVisual: true });
    windows.push(next.window);
    win = next.window as any;
    bindWindow();
    win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
    Object.defineProperty(win.document, "elementFromPoint", { value: () => null });
    win.__vortexDomResolve = { queryAllDeep: (selector: string) => queryAllDeep(selector, document), isEnabled: () => true, deepElementFromPoint: () => null, classifyHit: () => ({}) };
  };
  const listeners: Record<string, Array<(details: any) => void>> = {};
  const navigationEvents = Object.fromEntries(["onHistoryStateUpdated", "onReferenceFragmentUpdated", "onCommitted"].map((name) => [name, { addListener: (listener: (details: any) => void) => (listeners[name] ??= []).push(listener) }]));
  const navigate = (name: string, tabId = 42, frameId = 0) => listeners[name]?.forEach((listener) => listener({ tabId, frameId }));
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: { ...navigationEvents, getAllFrames: vi.fn(async () => [{ frameId: 0, documentId, documentLifecycle: "active", parentFrameId: -1, url: "https://x/" }]) },
    scripting: { executeScript: vi.fn(async ({ target, func, args }: any) => {
      if (target.documentIds && !target.documentIds.includes(documentId)) return [];
      if (target.frameIds && !target.frameIds.includes(0)) return [];
      const injectedDocumentId = documentId;
      return [{ frameId: 0, documentId: injectedDocumentId, result: typeof func === "function" ? await new Function("setTimeout", "clearTimeout", `return (${String(func)})`)(win.setTimeout.bind(win), win.clearTimeout.bind(win))(...(args ?? [])) : null }];
    }) },
    runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
  });
  win.__vortexDomResolve = { queryAllDeep: (selector: string) => queryAllDeep(selector, document), isEnabled: () => true, deepElementFromPoint: () => null, classifyHit: () => ({}) };
  const router = new ActionRouter();
  registerObserveHandlers(router, observeManager);
  registerDomHandlers(router, manager);
  const dispatch = (tool: string, args: Record<string, unknown>, tabId = 42) => router.dispatch({ type: "tool_request", tool, args, requestId: "pagination-test", tabId } as NmRequest);
  return { navigate, replaceDocument, dispatch, observe: (args: Record<string, unknown>, tabId = 42) => dispatch("observe.snapshot", args, tabId), act: (args: Record<string, unknown>) => dispatch("dom.click", args), type: (args: Record<string, unknown>) => dispatch("dom.type", args), fill: (args: Record<string, unknown>) => dispatch("dom.fill", args), select: (args: Record<string, unknown>) => dispatch("dom.select", args), hover: (args: Record<string, unknown>) => dispatch("dom.hover", args) };
}

afterEach(() => {
  for (const win of windows.splice(0)) win.close();
  vi.unstubAllGlobals();
});

describe("AX marker request ownership", () => {
  const markerDocument = () => ({ root: { children: Array.from(document.querySelectorAll("[data-vtx-ax]")).map((el, i) => ({
    backendNodeId: i + 10, attributes: ["data-vtx-ax", el.getAttribute("data-vtx-ax")],
  })) } });

  // Capture actual entrypoint injections without delivering claim/retire, then replay
  // them in chosen arrival orders against the same enumerated document.
  async function heldRequests() {
    const { observe } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    const claims: any[] = [], retires: any[] = [];
    execute.mockImplementation(async (details: any) => {
      if (details.target.documentIds && details.args?.[0] === "claim") { claims.push(details); return []; }
      if (details.target.documentIds && details.args?.[0] === "retire") { retires.push(details); return []; }
      return original(details);
    });
    await observe({ target: "#b0", includeAX: true });
    await observe({ target: "#b1", includeAX: true });
    expect(claims).toHaveLength(2);
    expect(retires).toHaveLength(2);
    const check = async (claim: any) => (await original({ ...claim, args: ["check", claim.args[1]] }))[0]?.result;
    return { claims, retires, original, check };
  }

  it.each(["A then B", "B then A"])("never lets an older claim reclaim after %s arrival", async (order) => {
    const { claims: [a, b], original, check } = await heldRequests();
    if (order === "A then B") expect((await original(a))[0].result).toBe(true);
    expect((await original(b))[0].result).toBe(true);
    expect((await original(a))[0].result).toBe(false);
    expect(await check(b)).toBe(true);
  });

  it("keeps tombstones when retire arrives before claim or closes the newer owner", async () => {
    const { claims: [a, b], retires: [retireA, retireB], original, check } = await heldRequests();
    await original(retireA);
    expect((await original(a))[0].result).toBe(false);
    expect((await original(b))[0].result).toBe(true);
    await original(retireB);
    expect(await check(b)).toBe(false);
    expect((await original(a))[0].result).toBe(false);
    expect((await original(b))[0].result).toBe(false);
  });

  it("rejects expired claims and checks without forgetting the high-water mark", async () => {
    const { claims: [a, b], original, check } = await heldRequests();
    expect((await original(b))[0].result).toBe(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(b.args[1].deadline + 1);
    try {
      expect(await check(b)).toBe(false);
      expect((await original(a))[0].result).toBe(false);
      const extendedOld = { ...a, args: ["claim", { ...a.args[1], deadline: Date.now() + 10_000 }] };
      expect((await original(extendedOld))[0].result).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it("conservatively rejects a different epoch without changing the current owner", async () => {
    const { claims: [a, b], retires: [, retireB], original, check } = await heldRequests();
    expect((await original(a))[0].result).toBe(true);
    const other = { ...b.args[1], epoch: "another-worker-epoch" };
    expect((await original({ ...b, args: ["claim", other] }))[0].result).toBe(false);
    await original({ ...retireB, args: ["retire", other] });
    expect(await check(a)).toBe(true);
    expect((await original(b))[0].result).toBe(true);
  });

  it("keeps marker remnants unreadable without the current scan write authority", async () => {
    const { claims: [a, b], retires: [retireA], original, check } = await heldRequests();
    await original(a); await original(b);
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML = `<button data-vtx-ax="${a.args[1].token}:0">Old</button><button data-vtx-ax="${b.args[1].token}:0">New</button><button data-vtx-ax="0">Legacy</button>`;
    document.body.appendChild(host);
    document.querySelector("#b0")!.setAttribute("data-vtx-ax", `${a.args[1].token}:0`);
    document.documentElement.setAttribute("data-vtx-frame-ax", b.args[1].token);
    await original(retireA);
    expect(await check(b)).toBe(true);
    expect(document.querySelector("#b0")!.getAttribute("data-vtx-ax")).toBe(`${a.args[1].token}:0`);
    expect(host.shadowRoot!.querySelectorAll("button")[0].getAttribute("data-vtx-ax")).toBe(`${a.args[1].token}:0`);
    expect(host.shadowRoot!.querySelectorAll("button")[1].getAttribute("data-vtx-ax")).toBe(`${b.args[1].token}:0`);
    expect(host.shadowRoot!.querySelectorAll("button")[2].getAttribute("data-vtx-ax")).toBe("0");
    expect(document.documentElement.getAttribute("data-vtx-frame-ax")).toBe(b.args[1].token);
  });

  it.each(["missing", "cached"])("fails closed for an untrusted %s document identity", async (kind) => {
    const debuggerMgr = { enableDomain: vi.fn(), sendCommand: vi.fn() };
    const { observe } = setup({}, debuggerMgr);
    vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/", ...(kind === "cached" ? { documentId: "main-document", documentLifecycle: "cached" } : {}) }] as any);
    const response: any = await observe({ target: "#b0", includeAX: true });
    expect(response.error?.code).toBe("PAGE_NOT_READY");
    expect(response.result).toBeUndefined();
    expect(document.querySelector("#b0")!.getAttribute("data-vtx-ax")).toBeNull();
    expect(debuggerMgr.sendCommand.mock.calls.some(([, method]) => method === "Accessibility.getFullAXTree")).toBe(false);
  });

  it("does not stamp when navigation replaces the document between claim and scan", async () => {
    const { observe, replaceDocument } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let changed = false;
    execute.mockImplementation(async (details: any) => {
      if (!changed && String(details.func).includes("const scanRoot")) { changed = true; replaceDocument(); }
      return original(details);
    });
    const response: any = await observe({ includeAX: true, frames: "main" });
    expect(response.error?.code).toBe("TIMEOUT");
    expect(response.result).toBeUndefined();
    expect(changed).toBe(true);
    expect(document.querySelector("#next")!.getAttribute("data-vtx-ax")).toBeNull();
    expect(document.documentElement.getAttribute("data-vtx-frame-ax")).toBeNull();
  });

  it("claims the replacement document only after re-resolving it", async () => {
    const debuggerMgr = { enableDomain: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue({ root: { children: [] }, nodes: [] }) };
    const { observe, replaceDocument } = setup({}, debuggerMgr);
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let attemptedClaim = false;
    const claims: Array<{ documentIds?: string[]; result?: unknown }> = [];
    const checks: Array<{ documentIds?: string[]; result?: unknown }> = [];
    execute.mockImplementation(async (details: any) => {
      if (!attemptedClaim && details.target.documentIds?.includes("main-document")) {
        attemptedClaim = true;
        replaceDocument();
      }
      const injected = await original(details);
      if (details.args?.[0] === "scan.claim") claims.push({ documentIds: details.target.documentIds, result: injected?.[0]?.result });
      if (details.args?.[0] === "scan.check") checks.push({ documentIds: details.target.documentIds, result: injected?.[0]?.result });
      return injected;
    });
    const response: any = await observe({ includeAX: true });
    expect(attemptedClaim).toBe(true);
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    // ① 第一轮 claim 打在旧文档上 → 注入返回空结果（请求不被重定向）
    expect(claims[0].documentIds).toEqual(["main-document"]);
    expect(claims[0].result).toBeUndefined();
    // ② 第二轮显式 claim 新文档并成功
    expect(claims[1].documentIds).toEqual(["next-document"]);
    expect(claims[1].result).toBe(true);
    // ③ 扫描期间新文档的归属复核通过（token 归属正确）
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.documentIds?.includes("next-document"))).toBe(true);
    expect(checks.every((check) => check.result === true)).toBe(true);
    // 旧文档不再被打标
    expect(windows[0].document.querySelector("[data-vtx-ax]")).toBeNull();
    expect(document.documentElement.getAttribute("data-vtx-frame-ax")).toBeNull();
  });

  it("claims the enumerated document before stamping a request-specific marker", async () => {
    let marker: string | null = null;
    const debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => {
        if (method === "Accessibility.getFullAXTree") marker = document.querySelector("#b0")!.getAttribute("data-vtx-ax");
        return method === "Accessibility.getFullAXTree" ? { nodes: [] } : markerDocument();
      }),
    };
    const { observe } = setup({}, debuggerMgr);
    await observe({ target: "#b0", includeAX: true });
    const calls = vi.mocked(chrome.scripting.executeScript).mock.calls.map(([details]) => details as any);
    const scan = calls.findIndex((details) => String(details.func).includes("const scanRoot"));
    expect(scan).toBeGreaterThanOrEqual(0);
    expect(calls.slice(0, scan).some((details) => details.target.documentIds?.[0] === "main-document")).toBe(true);
    expect(marker).toMatch(/^[^:]+:0$/);
  });

  it("uses this observe's marker rather than a stale open-shadow marker", async () => {
    const debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => {
        if (method === "Accessibility.getFullAXTree") return { nodes: [
          { nodeId: "current", backendDOMNodeId: 10, role: { value: "button" }, name: { value: "Current AX" } },
          { nodeId: "stale", backendDOMNodeId: 20, role: { value: "button" }, name: { value: "Stale AX" } },
        ] };
        if (method === "DOM.getDocument") return { root: { children: [
          { backendNodeId: 10, attributes: ["data-vtx-ax", document.querySelector("#b0")!.getAttribute("data-vtx-ax")] },
          { shadowRoots: [{ children: [{ backendNodeId: 20, attributes: ["data-vtx-ax", document.querySelector("#host")!.shadowRoot!.querySelector("button")!.getAttribute("data-vtx-ax")] }] }] },
        ] } };
        return {};
      }),
    };
    const { observe } = setup({}, debuggerMgr);
    const host = document.createElement("div"); host.id = "host";
    host.attachShadow({ mode: "open" }).innerHTML = '<button data-vtx-ax="0">Stale</button>';
    document.body.appendChild(host);
    const response: any = await observe({ target: "#b0", includeAX: true });
    expect(response.error).toBeUndefined();
    expect(response.result.elements[0].name).toBe("Current AX");
  });

  it.each(["claim", "scan", "check"].flatMap((stage) =>
    ["empty", "duplicate", "document", "frame", "reject"].map((invalid) => ({ stage, invalid })),
  ))("rejects unproven $stage injection identity: $invalid", async ({ stage, invalid }) => {
    const debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => method === "Accessibility.getFullAXTree"
        ? { nodes: [{ nodeId: "ax", backendDOMNodeId: 10, role: { value: "button" }, name: { value: "Unproven AX" } }] }
        : markerDocument()),
    };
    const { observe } = setup({}, debuggerMgr);
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    const retires: any[] = [];
    execute.mockImplementation(async (details: any) => {
      if (details.args?.[0] === "retire") retires.push(details);
      const matches = stage === "scan" ? String(details.func).includes("const scanRoot") : details.args?.[0] === stage;
      if (!matches) return original(details);
      if (invalid === "reject") throw new Error("Injection rejected");
      const results = await original(details);
      if (invalid === "empty") return [];
      if (invalid === "duplicate") return [...results, ...results];
      return results.map((result: any) => ({ ...result, ...(invalid === "document" ? { documentId: "other-document" } : { frameId: 99 }) }));
    });
    const response: any = await observe({ target: "#b0", includeAX: true });
    expect(JSON.stringify(response)).not.toContain("Unproven AX");
    if (stage !== "scan") {
      expect(response.error).toBeUndefined();
      expect(response.result.elements[0].name).toBe("Button 0");
    } else {
      expect(response.error?.code).toBe("TIMEOUT");
      expect(response.result).toBeUndefined();
    }
    expect(retires).toHaveLength(1);
    expect(retires[0].target).toEqual({ tabId: 42, documentIds: ["main-document"] });
    expect(document.querySelector("[data-vtx-ax]")).toBeNull();
  });

  it("never redirects retirement to a replacement document", async () => {
    const { observe, replaceDocument } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let oldClaim: any;
    let oldRetire: any;
    execute.mockImplementation(async (details: any) => {
      if (details.args?.[0] === "claim") {
        oldClaim = details;
        const result = await original(details);
        replaceDocument();
        document.documentElement.setAttribute("data-vtx-frame-ax", "replacement");
        document.querySelector("#next")!.setAttribute("data-vtx-ax", "replacement:0");
        return result;
      }
      if (details.args?.[0] === "retire") oldRetire = details;
      return original(details);
    });
    expect((await observe({ frames: "main", includeAX: true }) as any).error?.code).toBe("TIMEOUT");
    expect(oldRetire.target).toEqual({ tabId: 42, documentIds: ["main-document"] });
    expect(await original(oldClaim)).toEqual([]);
    expect(await original(oldRetire)).toEqual([]);
    expect(document.documentElement.getAttribute("data-vtx-frame-ax")).toBe("replacement");
    expect(document.querySelector("#next")!.getAttribute("data-vtx-ax")).toBe("replacement:0");
    expect((document as any).__vortexAXOwner).toBeUndefined();
  });

  it.each(["onHistoryStateUpdated", "onCommitted"])("discards main AX when %s occurs during capture", async (event) => {
    let navigate!: (name: string) => void;
    const debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          navigate(event);
          return { nodes: [{ nodeId: "ax", backendDOMNodeId: 10, role: { value: "button" }, name: { value: "Before navigation" } }] };
        }
        return markerDocument();
      }),
    };
    const api = setup({}, debuggerMgr);
    navigate = api.navigate;
    const response: any = await api.observe({ target: "#b0", includeAX: true });
    expect(response.error).toBeUndefined();
    expect(response.result.elements[0].name).toBe("Button 0");
    expect(document.querySelector("[data-vtx-ax]")).toBeNull();
  });

  it("keeps AX pagination valid through owned stamping and retirement but rejects page mutations", async () => {
    const { observe } = setup({}, {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => method === "Accessibility.getFullAXTree" ? { nodes: [] } : markerDocument()),
    });
    const first: any = await observe({ target: "#focus", includeAX: true, paginate: true });
    expect(first.error).toBeUndefined();
    expect(first.result.nextCursor).toBeTruthy();
    expect(document.querySelector("[data-vtx-ax]")).toBeNull();
    expect((await observe({ cursor: first.result.nextCursor }) as any).error).toBeUndefined();
    document.querySelector("#b0")!.setAttribute("data-vtx-ax", "page:0");
    expect((await observe({ cursor: first.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("does not let a delayed older scan overwrite the newer marker", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captures = 0;
    const debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          if (++captures === 2) { enter(); await gate; }
          return { nodes: [] };
        }
        return markerDocument();
      }),
    };
    const { observe } = setup({}, debuggerMgr);
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let oldScan: any;
    execute.mockImplementation(async (details: any) => {
      if (String(details.func).includes("const scanRoot") && !oldScan) oldScan = details;
      return original(details);
    });
    const first: any = await observe({ target: "#focus", includeAX: true });
    expect(first.error).toBeUndefined();
    expect(oldScan).toBeDefined();
    const second = observe({ target: "#b1", includeAX: true });
    await entered;
    const marker = document.querySelector("#b1")!.getAttribute("data-vtx-ax");
    expect(marker).not.toBeNull();
    try {
      await original(oldScan);
      expect(document.querySelector("#b1")!.getAttribute("data-vtx-ax")).toBe(marker);
    } finally { release(); await second; }
  });

  it("does not let an older cleanup remove a newer observe's marker", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captures = 0;
    const debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          if (++captures === 2) { enter(); await gate; }
          return { nodes: [] };
        }
        return markerDocument();
      }),
    };
    const { observe } = setup({}, debuggerMgr);
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let oldCleanup: any;
    execute.mockImplementation(async (details: any) => {
      if (details.target.documentIds && details.args?.[0] === "retire" && !oldCleanup) oldCleanup = details;
      return original(details);
    });
    const first: any = await observe({ target: "#b0", includeAX: true });
    expect(first.error).toBeUndefined();
    expect(oldCleanup).toBeDefined();
    const second = observe({ target: "#b0", includeAX: true });
    await entered;
    const marker = document.querySelector("#b0")!.getAttribute("data-vtx-ax");
    expect(marker).not.toBeNull();
    try {
      await original(oldCleanup);
      expect(document.querySelector("#b0")!.getAttribute("data-vtx-ax")).toBe(marker);
    } finally { release(); await second; }
  });
});

describe("paginated input error safety", () => {
  async function inputTarget(paginate = true) {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const snapshot: any = await api.observe({ target: "#field", paginate, includeAX: false });
    expect(snapshot.error).toBeUndefined();
    const ref = { snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index };
    return { api, field, ref };
  }

  function expectSafeHint(error: Parameters<typeof formatDispatchError>[0]) {
    const visible = formatDispatchError(error);
    expect(visible).toMatch(/execution state is uncertain/i);
    expect(visible).toMatch(/vortex_observe.*check the page state/i);
    expect(visible).toMatch(/do not retry directly/i);
    expect(visible).not.toMatch(/vortex_observe.*(?:then|and) retry/i);
    expect(visible).not.toContain("Hint (lastReason=");
  }

  it.each([
    ["type", "before"], ["type", "focus"], ["type", "input"],
    ["fill", "before"], ["fill", "focus"], ["fill", "input"],
  ] as const)("%s stale at %s has a safe MCP-visible hint", async (action, phase) => {
    const { api, field, ref } = await inputTarget();
    let inputs = 0;
    field.addEventListener("input", () => inputs++);
    const invalidate = () => document.querySelector("#b0")!.setAttribute("data-changed", "yes");
    if (phase === "before") invalidate();
    else field.addEventListener(phase, invalidate, { once: true });
    const result = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(field.value).toBe(phase === "before" || (action === "type" && phase === "focus") ? "old" : action === "type" ? "" : "new");
    expect(inputs).toBe(phase === "before" || (action === "type" && phase === "focus") ? 0 : 1);
    expectSafeHint(result.error!);
  });

  it.each([
    ["type", VtxErrorCode.DISABLED], ["fill", VtxErrorCode.DISABLED],
    ["type", VtxErrorCode.TIMEOUT], ["fill", VtxErrorCode.TIMEOUT],
  ] as const)("%s preserves %s payload except hint", async (action, code) => {
    const { api, field, ref } = await inputTarget();
    const original = vtxError(code, "original gate error", {
      ...ref, tabId: 42, frameId: 0, selector: "#field", extras: { marker: "keep", nested: { value: 7 }, lastReason: "NOT_ATTACHED" },
    }, { hint: "Retry immediately", recoverable: false });
    vi.mocked(waitActionableAutoForce).mockRejectedValueOnce(original);
    const result = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    const { hint: _hint, ...expected } = original.toJSON();
    const { hint: _actualHint, ...actual } = result.error!;
    expect(actual).toEqual(expected);
    expect(field.value).toBe("old");
    expectSafeHint(result.error!);
  });

  it.each(["type", "fill"] as const)("%s parse failure before side effects also has a safe hint", async (action) => {
    const { api, field, ref } = await inputTarget();
    const result = await api[action]({ ...ref, index: -1, text: "new", value: "new" });
    expect(result.error?.code).toBe("INVALID_INDEX");
    expect(result.error?.context).toEqual({ snapshotId: ref.snapshotId, index: -1 });
    expect(field.value).toBe("old");
    expectSafeHint(result.error!);
  });

  it.each([
    ["type", "stale"], ["fill", "stale"],
    ["type", "vtx"], ["fill", "vtx"],
    ["type", "raw"], ["fill", "raw"],
    ["type", "undefined"], ["fill", "undefined"],
  ] as const)("%s preserves primary %s error when cleanup fails", async (action, failure) => {
    const { api, field, ref } = await inputTarget();
    const primary = failure === "vtx"
      ? vtxError(VtxErrorCode.NO_EFFECT, "primary input error", { ...ref, extras: { attempted: "new" } }, { recoverable: false })
      : failure === "undefined" ? undefined : new Error("primary input error");
    if (failure === "stale") field.addEventListener("input", () => document.querySelector("#b0")!.setAttribute("data-changed", "yes"), { once: true });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let cleanupCalls = 0;
    let primaryThrown = false;
    execute.mockImplementation(async (details: any) => {
      const source = String(details.func);
      if (source.includes("const cap =")) { cleanupCalls++; throw new Error("cleanup error"); }
      if (failure !== "stale" && (source.includes("const setValue =") || source.includes("nativeValueSetter"))) {
        await original(details);
        primaryThrown = true;
        throw primary;
      }
      return original(details);
    });
    const result = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(cleanupCalls).toBe(1);
    expect(primaryThrown).toBe(failure !== "stale");
    expect(field.value).toBe(failure === "stale" && action === "type" ? "" : "new");
    expect(result.error?.code).toBe(failure === "stale" ? "STALE_SNAPSHOT" : failure === "vtx" ? "NO_EFFECT" : "JS_EXECUTION_ERROR");
    if (failure === "stale") expect(result.error?.message).toContain("Page changed since the snapshot was captured");
    else expect(result.error?.message).toBe(failure === "undefined" ? "undefined" : "primary input error");
    if (failure === "vtx") {
      const { hint: _hint, ...expected } = (primary as ReturnType<typeof vtxError>).toJSON();
      const { hint: _actualHint, ...actual } = result.error!;
      expect(actual).toEqual({ ...expected, context: { ...expected.context, extras: { ...expected.context?.extras, actionMayHaveExecuted: true } } });
    }
    expectSafeHint(result.error!);
  });

  it.each(["type", "fill"] as const)("%s reports cleanup-only failure without losing its payload", async (action) => {
    const { api, field, ref } = await inputTarget();
    const cleanupError = vtxError(VtxErrorCode.CSP_BLOCKED, "cleanup-only error", { ...ref, extras: { stage: "cleanup" } }, { recoverable: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      if (String(details.func).includes("const cap =")) throw cleanupError;
      return original(details);
    });
    const result = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(field.value).toBe("new");
    const { hint: _hint, ...expected } = cleanupError.toJSON();
    const { hint: _actualHint, ...actual } = result.error!;
    expect(actual).toEqual({ ...expected, context: { ...expected.context, extras: { ...expected.context?.extras, actionMayHaveExecuted: true } } });
    expectSafeHint(result.error!);
  });

  it.each(["type", "fill"] as const)("%s leaves non-paginated errors unchanged", async (action) => {
    const { api, field, ref } = await inputTarget(false);
    const original = vtxError(VtxErrorCode.DISABLED, "ordinary error", { ...ref, extras: { marker: "ordinary" } }, { hint: "original hint", recoverable: false });
    vi.mocked(waitActionableAutoForce).mockRejectedValueOnce(original);
    const result = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(result.error).toEqual(original.toJSON());
    expect(field.value).toBe("old");
  });

  it.each(["type", "fill"] as const)("%s keeps successful results unchanged", async (action) => {
    const { api, field, ref } = await inputTarget();
    const result = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(action === "type"
      ? { success: true, typed: 3, path: "page-side-dispatch", value: "new" }
      : { success: true, focused: true, value: "new" });
    expect(field.value).toBe("new");
    expect((window as any).__vortexDialogPolicy.armed).toBe(false);
  });
});

describe("stable observe pagination", () => {
  it.each([["type", "before"], ["type", "input"], ["fill", "before"], ["fill", "input"]] as const)("reports %s stale at %s through the router and MCP error formatter", async (action, phase) => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    expect(snapshot.error).toBeUndefined();
    const ref = { snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index };
    let inputs = 0;
    field.addEventListener("input", () => {
      inputs++;
      if (phase === "input") document.querySelector("#b0")!.setAttribute("data-changed", "yes");
    }, { once: true });
    if (phase === "before") document.querySelector("#b0")!.setAttribute("data-changed", "yes");
    const result: any = action === "type"
      ? await api.type({ ...ref, text: "new" })
      : await api.fill({ ...ref, value: "new", fallbackToNative: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(field.value).toBe(phase === "before" ? "old" : action === "type" ? "" : "new");
    expect(inputs).toBe(phase === "before" ? 0 : 1);
    if (phase === "before") {
      expect(result.error?.context?.extras?.actionMayHaveExecuted).toBeUndefined();
      expect(formatDispatchError(result.error)).toMatch(/vortex_observe/i);
    } else {
      expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
      expect(formatDispatchError(result.error)).toMatch(/check the page state/i);
      expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
      expect(formatDispatchError(result.error)).not.toMatch(/then retry/i);
    }
  });
  it.each(["type", "fill"] as const)("%s rejects a control changed while actionability is pending", async (action) => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old"><input id="other" value="before">');
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    const field = document.querySelector("#field") as HTMLInputElement;
    let events = 0;
    field.addEventListener("focus", () => events++);
    field.addEventListener("input", () => events++);
    vi.mocked(waitActionableAutoForce).mockImplementationOnce(async () => {
      (document.querySelector("#other") as HTMLInputElement).value = "after";
      return {};
    });
    const ref = { snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index };
    const result: any = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(field.value).toBe("old");
    expect(events).toBe(0);
  });

  it.each([["type", false], ["fill", false], ["type", true], ["fill", true]] as const)("rejects an invalid %s page reply after possible input (malformed=%s)", async (action, malformed) => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      if (details.func?.name === (action === "type" ? "DOM_TYPE_PAGE_FUNC" : "DOM_FILL_PAGE_FUNC")) {
        await original(details);
        return malformed ? [{ result: {} }] : [];
      }
      return original(details);
    });
    const ref = { snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index };
    const result: any = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(result.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
  });

  it.each(["type", "fill"] as const)("rejects a malformed %s success payload after input", async (action) => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      if (action === "type" ? String(details.func).includes("const setValue =") : details.func?.name === "DOM_FILL_PAGE_FUNC") {
        await original(details);
        return [{ result: { result: {} } }];
      }
      return original(details);
    });
    const ref = { snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index };
    const result: any = await api[action]({ ...ref, text: "new", value: "new", fallbackToNative: true });
    expect(result.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
  });

  it("rejects a missing TYPE input reply after typing", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      if (String(details.func).includes("const setValue =")) {
        await original(details);
        return [];
      }
      return original(details);
    });
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, text: "new" });
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("new");
    expect(result.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
  });

  it("reports possible execution when TYPE probe reply is lost after focus", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      if (details.func?.name === "DOM_TYPE_PAGE_FUNC") {
        await original(details);
        throw new Error("probe reply lost");
      }
      return original(details);
    });
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, text: "new" });
    expect(document.activeElement).toBe(document.querySelector("#field"));
    expect(result.error?.message).toBe("probe reply lost");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
  });

  it.each(["replacement", "removal"] as const)("rejects contenteditable %s before CDP readback", async (change) => {
    const manager = { attach: vi.fn(), sendCommand: vi.fn(async () => {
      const editor = document.querySelector("#editor")!;
      if (change === "replacement") editor.replaceWith(editor.cloneNode(true));
      else editor.remove();
    }) };
    const api = setup(manager);
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<div id="editor" contenteditable="true" aria-label="Editor" tabindex="0">old</div>');
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get() { return this.getAttribute("contenteditable") === "true"; } });
    const snapshot: any = await api.observe({ target: "#editor", paginate: true, includeAX: false });
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, text: "new" });
    expect(manager.sendCommand).toHaveBeenCalled();
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
  });

  it("rejects missing contenteditable readback after CDP input", async () => {
    const manager = { attach: vi.fn(), sendCommand: vi.fn(async () => { document.querySelector("#editor")!.textContent = "new"; }) };
    const api = setup(manager);
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<div id="editor" contenteditable="true" aria-label="Editor" tabindex="0">old</div>');
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get() { return this.getAttribute("contenteditable") === "true"; } });
    const snapshot: any = await api.observe({ target: "#editor", paginate: true, includeAX: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => String(details.func).includes("const now = els.length") ? [] : original(details));
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, text: "new" });
    expect(manager.sendCommand).toHaveBeenCalled();
    expect(result.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
  });

  it("reports possible execution when TYPE focus succeeds but CDP attach fails", async () => {
    const manager = { attach: vi.fn().mockRejectedValue(vtxError(VtxErrorCode.CDP_NOT_ATTACHED, "attach failed")), sendCommand: vi.fn() };
    const api = setup(manager);
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<div id="editor" contenteditable="true" aria-label="Editor" tabindex="0">old</div>');
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get() { return this.getAttribute("contenteditable") === "true"; } });
    const snapshot: any = await api.observe({ target: "#editor", paginate: true, includeAX: false });
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, text: "new" });
    expect(document.activeElement).toBe(document.querySelector("#editor"));
    expect(result.error?.code).toBe("CDP_NOT_ATTACHED");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
    expect(manager.sendCommand).not.toHaveBeenCalled();
  });

  it("reports possible execution when FILL focus invalidates the snapshot", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    field.addEventListener("focus", () => document.querySelector("#b0")!.setAttribute("data-changed", "yes"), { once: true });
    const result: any = await api.fill({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, value: "new", fallbackToNative: true });
    expect(field.value).toBe("new");
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
  });

  it("reports possible execution when FILL value is rejected after input", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" type="number" aria-label="Field" value="1">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const input = vi.fn();
    field.addEventListener("input", input);
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    expect(snapshot.error).toBeUndefined();
    // Test rejected input, independently of the pagination traversal's wall-clock budget.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const result: any = await api.fill({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, value: "invalid", fallbackToNative: true });
      expect(input).toHaveBeenCalledTimes(1);
      expect(field.value).toBe("");
      expect(result.error?.code).toBe("NO_EFFECT");
      expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
      expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
    } finally { clock.mockRestore(); }
  });

  it("rejects FILL before input when the final gate traversal exhausts its budget", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" type="number" aria-label="Field" value="1">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const input = vi.fn();
    field.addEventListener("input", input);
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    expect(snapshot.error).toBeUndefined();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()! as (details: any) => Promise<any>;
    let validations = 0;
    let exhaust = false;
    execute.mockImplementation(async (details: any) => {
      if (details.args?.[0] === snapshot.result.snapshotId && ++validations === 2) exhaust = true;
      return original(details);
    });
    const query = document.querySelectorAll.bind(document);
    const traversal = vi.spyOn(document, "querySelectorAll").mockImplementation((selector: string) => {
      const nodes = query(selector);
      if (selector === "*" && exhaust) { exhaust = false; clock.mockReturnValue(now + 201); }
      return nodes;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result: any = await api.fill({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, value: "invalid", fallbackToNative: true });
      expect(Date.now() - now).toBe(201);
      expect(warning).toHaveBeenCalledWith("[vortex.dom] pagination validation failed", expect.objectContaining({ message: "Observe deadline expired" }));
      expect(input).not.toHaveBeenCalled();
      expect(field.value).toBe("1");
      expect(result.error?.code).toBe("STALE_SNAPSHOT");
      expect(result.error?.context?.extras?.actionMayHaveExecuted).not.toBe(true);
    } finally { warning.mockRestore(); traversal.mockRestore(); execute.mockImplementation(original); clock.mockRestore(); }
  });

  it.each(["type", "fill"] as const)("rejects unrelated silent control changes during %s", async (action) => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old"><input id="other" type="checkbox">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const other = document.querySelector("#other") as HTMLInputElement;
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    field.addEventListener("input", () => { other.checked = true; }, { once: true });
    const ref = { snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index };
    const result: any = action === "type" ? await api.type({ ...ref, text: "x" }) : await api.fill({ ...ref, value: "x", fallbackToNative: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
  });

  it("rejects a replaced input after the final TYPE keyup", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    field.addEventListener("keyup", () => { const replacement = field.cloneNode(true) as HTMLInputElement; replacement.value = ""; field.replaceWith(replacement); }, { once: true });
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, text: "x" });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
  });

  it("reports possible execution when TYPE focus invalidates the snapshot", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old">');
    const field = document.querySelector("#field") as HTMLInputElement;
    const snapshot: any = await api.observe({ target: "#field", paginate: true, includeAX: false });
    field.addEventListener("focus", () => document.querySelector("#b0")!.setAttribute("data-changed", "yes"), { once: true });
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, text: "new" });
    expect(field.value).toBe("old");
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/check the page state/i);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
  });

  it.each([false, true])("preserves paginated target identity with debugger listener marks; page mutation=%s", async (mutatePage) => {
    const debuggerManager = {
      sendCommand: vi.fn(async (_tabId: number, method: string, params: any) => {
        if (method === "Runtime.evaluate") return { result: { objectId: "document" } };
        if (method === "DOMDebugger.getEventListeners") return { listeners: [{ type: "click", backendNodeId: 10 }] };
        if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: [10] };
        if (method === "DOM.resolveNode") return { object: { objectId: "button" } };
        if (method === "Runtime.callFunctionOn") {
          const node = document.querySelector("#b10")!;
          const fn = new Function(`return (${params.functionDeclaration})`)();
          return { result: { value: fn.apply(node, params.arguments.map((arg: any) => arg.value)) } };
        }
        return {};
      }),
    };
    const { observe } = setup({}, debuggerManager);
    document.querySelector("#b10")!.addEventListener("click", () => {});
    const first: any = await observe({ paginate: true, maxElements: 10, includeAX: false });
    const page: any = await observe({ cursor: first.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Button 10");
    expect(hit.listenerInteractive).toBe(true);
    if (mutatePage) {
      const node = document.querySelector("#b10")!;
      const original = node.setAttribute.bind(node);
      node.setAttribute = (name, value) => {
        original(name, value);
        document.querySelector("#b11")!.setAttribute(name, "page-change");
      };
    }
    const scoped: any = await observe({ snapshotId: first.result.snapshotId, index: hit.index, includeAX: false });
    if (mutatePage) expect(scoped.error?.code).toBe("STALE_SNAPSHOT");
    else {
      expect(scoped.error).toBeUndefined();
      expect(scoped.result.elements.map((element: any) => element.name)).toEqual(["Button 10"]);
    }
  });

  it("uses an unchanged paginated ref as an observe target and invalidates the old snapshot", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ paginate: true, maxElements: 10, includeAX: false });
    const page: any = await observe({ cursor: first.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Button 10");
    expect(hit).toBeDefined();
    const scoped: any = await observe({ snapshotId: first.result.snapshotId, index: hit.index, includeAX: false });
    expect(scoped.error).toBeUndefined();
    expect(scoped.result.elements.map((e: any) => e.name)).toEqual(["Button 10"]);
    let clicks = 0;
    document.querySelector("#b10")!.addEventListener("click", () => clicks++);
    const current: any = await act({ snapshotId: scoped.result.snapshotId, index: scoped.result.elements[0].index, force: true });
    expect(current.error).toBeUndefined();
    expect(clicks).toBe(1);
    const old: any = await act({ snapshotId: first.result.snapshotId, index: hit.index, force: true });
    expect(old.error?.code).toBe("STALE_SNAPSHOT");
  });

  it.each(["mutation", "replacement", "tab", "frame", "expired"])("rejects a paginated target after %s", async (change) => {
    const { observe } = setup();
    const first: any = await observe({ paginate: true, maxElements: 10, includeAX: false });
    const page: any = await observe({ cursor: first.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Button 10");
    const node = document.querySelector("#b10")!;
    if (change === "mutation") node.textContent = "Changed";
    if (change === "replacement") node.replaceWith(node.cloneNode(true));
    const clock = change === "expired" ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000) : undefined;
    try {
      const result: any = await observe({ snapshotId: first.result.snapshotId, index: hit.index, includeAX: false, ...(change === "frame" ? { frameId: 7 } : {}) }, change === "tab" ? 43 : 42);
      expect(result.error?.code).toBe("STALE_SNAPSHOT");
    } finally { clock?.mockRestore(); }
  });

  it("rejects a paginated target when a control value changes without a DOM mutation", async () => {
    const { observe } = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input aria-label="Field" value="old">');
    const first: any = await observe({ paginate: true, maxElements: 10, includeAX: false });
    const page: any = await observe({ cursor: first.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Button 9");
    document.querySelector("input")!.value = "new";
    const result: any = await observe({ snapshotId: first.result.snapshotId, index: hit.index, includeAX: false });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
  });

  it("rejects replacement after target resolution but before the scan", async () => {
    const { observe } = setup();
    const first: any = await observe({ paginate: true, maxElements: 10, includeAX: false });
    const page: any = await observe({ cursor: first.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Button 10");
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      if (String(details.func).includes("const ridPrefix")) {
        const node = document.querySelector("#b10")!;
        node.replaceWith(node.cloneNode(true));
      }
      return original(details);
    });
    const result: any = await observe({ snapshotId: first.result.snapshotId, index: hit.index, includeAX: false });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
  });

  it.each(["input", "textarea", "select", "checkbox", "shadow", "input-event", "change-event"])("rejects a changed 81st native control without DOM mutations: %s", async (kind) => {
    const { observe } = setup();
    const section = document.querySelector("#focus")!;
    section.replaceChildren(...Array.from({ length: 81 }, (_, i) => {
      const input = document.createElement("input");
      input.setAttribute("aria-label", `Field ${i}`);
      input.value = "old";
      return input;
    }));
    let control: any = section.lastElementChild!;
    if (kind === "textarea") control.outerHTML = '<textarea aria-label="Field 80">old</textarea>';
    if (kind === "select") control.outerHTML = '<select aria-label="Field 80"><option value="old">Old</option><option value="new">New</option></select>';
    if (kind === "checkbox") control.outerHTML = '<input type="checkbox" aria-label="Field 80">';
    if (kind === "shadow") {
      control.remove();
      const host = document.createElement("div");
      section.appendChild(host);
      host.attachShadow({ mode: "open" }).innerHTML = '<input aria-label="Field 80" value="old">';
      control = host.shadowRoot!.querySelector("input");
    } else control = section.lastElementChild!;
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.result.nextCursor).toBeTruthy();
    const unchanged: any = await observe({ cursor: first.result.nextCursor });
    expect(unchanged.error).toBeUndefined();
    if (kind === "checkbox") control.checked = true;
    else control.value = "new";
    if (kind === "input-event") control.dispatchEvent(new Event("input", { bubbles: true }));
    if (kind === "change-event") control.dispatchEvent(new Event("change", { bubbles: true }));
    const continued: any = await observe({ cursor: first.result.nextCursor });
    expect(continued.error?.code).toBe("STALE_SNAPSHOT");
  });

  it.each(["replacement", "hit"])("rejects real mouse %s after movement even with force", async (change) => {
    let clicks = 0;
    const sendCommand = vi.fn(async (_tab: number, _method: string, params: { type: string }) => {
      if (params.type === "mouseMoved") {
        if (change === "replacement") {
          const original = document.querySelector("#b0")!;
          const replacement = original.cloneNode(true);
          replacement.addEventListener("click", () => clicks++);
          original.replaceWith(replacement);
        } else {
          (window as any).__vortexDomResolve.deepElementFromPoint = () => document.querySelector("#b1");
        }
      }
      if (params.type === "mousePressed") document.querySelector(change === "replacement" ? "#b0" : "#b1")!.dispatchEvent(new MouseEvent("click"));
    });
    const api = setup({ attach: vi.fn(), sendCommand });
    (window as any).__vortexDomResolve.deepElementFromPoint = () => document.querySelector("#b0");
    document.querySelector("#b1")!.addEventListener("click", () => clicks++);
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = snapshot.result.elements.find((e: any) => e.name === "Button 0");
    const result: any = await api.act({ snapshotId: snapshot.result.snapshotId, index: hit.index, useRealMouse: true, force: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
    expect(sendCommand.mock.calls.some(([, , params]) => params.type === "mousePressed")).toBe(false);
    expect(clicks).toBe(0);
  });

  it.each(["rejected", "missing"] as const)("reports uncertain synthetic click when the injection reply is %s", async (failure) => {
    const api = setup();
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = snapshot.result.elements.find((e: any) => e.name === "Button 0");
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      const result = await original(details);
      if (String(details.func).includes("cdpAvailable, observeEffect")) {
        if (failure === "rejected") throw new Error("synthetic reply lost");
        return [];
      }
      return result;
    });
    const result: any = await api.act({ snapshotId: snapshot.result.snapshotId, index: hit.index, force: true });
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
  });

  it("preserves bare CDP No tab classification after mouse input starts", async () => {
    const sendCommand = vi.fn(async (_tab: number, _method: string, params: { type: string }) => {
      if (params.type === "mouseMoved") throw new Error("No tab with id: 42");
    });
    const api = setup({ attach: vi.fn(), sendCommand });
    (window as any).__vortexDomResolve.deepElementFromPoint = () => document.querySelector("#b0");
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = snapshot.result.elements.find((e: any) => e.name === "Button 0");
    const result: any = await api.act({ snapshotId: snapshot.result.snapshotId, index: hit.index, useRealMouse: true, force: true });
    expect(result.error?.code).toBe("TAB_NOT_FOUND");
    expect(result.error?.message).toBe("No tab with id: 42");
    expect(result.error?.context?.extras?.actionMayHaveExecuted).toBe(true);
    expect(formatDispatchError(result.error)).toMatch(/do not retry directly/i);
  });

  it("starts both pagination TTLs at capture completion and never extends them on continuation", async () => {
    const api = setup();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (details: any) => {
      const result = await original(details);
      if (String(details.func).includes("item.nodes = collectedEls")) now += 10_000;
      return result;
    });
    try {
      const first: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
      expect(first.error).toBeUndefined();
      now += 55_000;
      const continued: any = await api.observe({ cursor: first.result.nextCursor });
      expect(continued.error).toBeUndefined();
      const action: any = await api.act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true });
      expect(action.error).toBeUndefined();
      now += 5_001;
      expect((await api.observe({ cursor: first.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
      expect((await api.act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true }) as any).error?.code).toBe("STALE_SNAPSHOT");
    } finally { clock.mockRestore(); }
  });

  it("allows unchanged pagination actions 25 seconds after capture", async () => {
    const api = setup();
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    let clicks = 0;
    document.querySelector("#b0")!.addEventListener("click", () => clicks++);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25_000);
    try {
      const result: any = await api.act({ snapshotId: snapshot.result.snapshotId, index: snapshot.result.elements[0].index, force: true });
      expect(result.error).toBeUndefined();
      expect(clicks).toBe(1);
    } finally { clock.mockRestore(); }
  });
  it.each(["attach", "module"])("rejects browser history roundtrip during %s before dispatch", async (phase) => {
    let navigate!: (name: string) => void;
    let push!: History["pushState"];
    const roundtrip = () => { push({}, "", "/other"); navigate("onHistoryStateUpdated"); push({}, "", "/"); navigate("onHistoryStateUpdated"); };
    const sendCommand = vi.fn();
    const manager = { attach: vi.fn(async () => { if (phase === "attach") roundtrip(); }), sendCommand };
    const ctx = setup(manager);
    navigate = ctx.navigate;
    push = window.history.pushState.bind(window.history);
    const first: any = await ctx.observe({ target: "#focus", paginate: true, includeAX: false });
    let clicks = 0;
    document.querySelector("#b0")!.addEventListener("click", () => clicks++);
    if (phase === "module") vi.mocked(loadPageSideModule).mockImplementationOnce(async () => { roundtrip(); });
    const result: any = await ctx.act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true, useRealMouse: phase === "attach" });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(clicks).toBe(0);
  });

  it.each(["type", "fill", "select", "hover"])("rejects %s after browser navigation during module loading", async (action) => {
    const ctx = setup({ attach: vi.fn(), sendCommand: vi.fn() });
    const push = window.history.pushState.bind(window.history);
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field" value="old"><select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>');
    const first: any = await ctx.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await ctx.observe({ cursor: first.result.nextCursor });
    const node = document.querySelector(action === "select" ? "#choice" : "#field")!;
    const hit = [...first.result.elements, ...page.result.elements].find((e: any) => e.name === (action === "select" ? "Choice" : "Field"));
    let events = 0;
    for (const name of ["input", "change", "mouseover", "focus"]) node.addEventListener(name, () => events++);
    vi.mocked(loadPageSideModule).mockImplementationOnce(async () => {
      push({}, "", "/other"); ctx.navigate("onHistoryStateUpdated");
      push({}, "", "/"); ctx.navigate("onHistoryStateUpdated");
    });
    const result: any = await ctx.dispatch(`dom.${action}`, { snapshotId: first.result.snapshotId, index: hit.index, force: true, text: "new", value: action === "select" ? "b" : "new", fallbackToNative: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(events).toBe(0);
    expect((node as HTMLInputElement).value).toBe(action === "select" ? "a" : "old");
  });

  it("stops inside virtual-list postprocessing when its deadline expires", async () => {
    const { observe } = setup();
    const container = document.createElement("div");
    container.innerHTML = '<div id="virtual-a"></div><div id="virtual-b"></div>';
    document.body.appendChild(container);
    let expired = false;
    let afterExpiry = 0;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now + (expired ? 30_000 : 0));
    Object.defineProperty(document.querySelector("#virtual-a")!, "scrollHeight", { get() { expired = true; return 0; } });
    Object.defineProperty(document.querySelector("#virtual-b")!, "scrollHeight", { get() { if (expired) afterExpiry++; return 0; } });
    try {
      const result: any = await observe({ includeAX: false });
      expect(expired).toBe(true);
      expect(result.error?.code).toBe("TIMEOUT");
      expect(afterExpiry).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it("stops page marker writes when scanning crosses the request deadline", async () => {
    const { observe } = setup();
    const now = Date.now();
    let expired = false;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now + (expired ? 30_000 : 0));
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { if (this.id === "b0") expired = true; return rect.call(this); };
    const set = Element.prototype.setAttribute;
    const lateWrites: string[] = [];
    Element.prototype.setAttribute = function (name, value) { if (expired && name.startsWith("data-v")) lateWrites.push(name); return set.call(this, name, value); };
    try {
      const result: any = await observe({ target: "#focus", paginate: true, includeAX: false });
      expect(expired).toBe(true);
      expect(result.error?.code).toBe("TIMEOUT");
      expect(lateWrites).toEqual([]);
      expect(result.result).toBeUndefined();
    } finally { clock.mockRestore(); }
  });
  it("keeps the newer paginated snapshot valid when an older scan is delayed", async () => {
    const { observe, act } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    execute.mockImplementation(async (details: any) => {
      if (!held && String(details.func).includes('scanRoot')) {
        held = true; entered(); await gate;
      }
      return original(details);
    });
    const older = observe({ includeAX: false });
    await paused;
    const newer = observe({ target: "#focus", paginate: true, includeAX: false });
    let completed = false;
    void newer.then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);
    release();
    const [a, b]: any[] = await Promise.all([older, newer]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const page: any = await observe({ cursor: b.result.nextCursor });
    expect(page.error).toBeUndefined();
    const hit = page.result.elements.find((e: any) => e.name === "Button 80");
    let clicks = 0;
    document.querySelector("#b80")!.addEventListener("click", () => clicks++);
    expect((await act({ snapshotId: b.result.snapshotId, index: hit.index, force: true }) as any).error).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("waits for a timed-out scan to finish writing before starting the next same-tab scan", async () => {
    const { observe } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let scans = 0;
    let finished!: () => void;
    const scanFinished = new Promise<void>((resolve) => { finished = resolve; });
    execute.mockImplementation(async (details: any) => {
      if (String(details.func).includes("scanRoot") && ++scans === 1) {
        entered();
        await gate;
        try { return await original(details); } finally { finished(); }
      }
      return original(details);
    });
    const older = observe({ includeAX: false });
    await paused;
    const newer = observe({ target: "#focus", paginate: true, includeAX: false });
    try {
      const [oldResult, result]: any[] = await Promise.all([older, newer]);
      expect(oldResult.error?.code).toBe("TIMEOUT");
      expect(result.error?.code).toBe("TIMEOUT");
      expect(scans).toBe(1);
    } finally {
      release();
      await scanFinished;
    }
  }, 35_000);

  it("shares one deadline between same-tab queueing and scanning", async () => {
    const { observe } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let scans = 0;
    execute.mockImplementation(async (details: any) => {
      if (String(details.func).includes("scanRoot")) {
        scans++;
        if (scans === 1) { entered(); await gate; }
        else await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return original(details);
    });
    const older = observe({ includeAX: false });
    await paused;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const newer = observe({ target: "#focus", paginate: true, includeAX: false });
      await vi.advanceTimersByTimeAsync(19_000);
      release();
      await older;
      await vi.advanceTimersByTimeAsync(1100);
      const result: any = await Promise.race([newer, Promise.resolve("pending")]);
      expect(result).not.toBe("pending");
      expect(result.error?.code).toBe("TIMEOUT");
      expect(scans).toBe(2);
      await vi.advanceTimersByTimeAsync(2000);
    } finally { vi.useRealTimers(); }
  });

  it("times out during post-scan validation without issuing a snapshot later", async () => {
    const { observe } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    let token = "";
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    execute.mockImplementation(async (details: any) => {
      if (String(details.func).includes("item.expiresAt = completedAt + ttl")) {
        token = details.args[0]; entered(); await gate;
      }
      return original(details);
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const pending = observe({ target: "#focus", paginate: true, includeAX: false });
      await paused;
      await vi.advanceTimersByTimeAsync(20_001);
      const result: any = await Promise.race([pending, Promise.resolve("pending")]);
      expect(result.error?.code).toBe("TIMEOUT");
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect((await observe({ cursor: `${token}:80` }) as any).error?.code).toBe("STALE_SNAPSHOT");
    } finally { release(); vi.useRealTimers(); }
  });

  it.each(["pushState", "hash"])("invalidates cursor and pagination actions after %s navigation", async (navigation) => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await observe({ cursor: first.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Button 80");
    let clicks = 0;
    document.querySelector("#b80")!.addEventListener("click", () => clicks++);
    if (navigation === "pushState") window.history.pushState({}, "", "/other");
    else window.location.hash = "other";
    const action: any = await act({ snapshotId: first.result.snapshotId, index: hit.index, force: true });
    const continued: any = await observe({ cursor: first.result.nextCursor });
    expect(action.error?.code).toBe("STALE_SNAPSHOT");
    expect(continued.error?.code).toBe("STALE_SNAPSHOT");
    expect(clicks).toBe(0);
  });

  it("rejects cursor and action after history returns to the captured URL", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await observe({ cursor: first.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Button 80");
    window.history.pushState({}, "", "/other");
    window.history.pushState({}, "", "/");
    expect((await act({ snapshotId: first.result.snapshotId, index: hit.index, force: true }) as any).error?.code).toBe("STALE_SNAPSHOT");
    expect((await observe({ cursor: first.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("rejects a snapshot after saved pushState navigates away and back", async () => {
    const { observe, act, navigate } = setup();
    const push = window.history.pushState.bind(window.history);
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    push({}, "", "/other");
    navigate("onHistoryStateUpdated");
    push({}, "", "/");
    navigate("onHistoryStateUpdated");
    const action: any = await act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true });
    const continued: any = await observe({ cursor: first.result.nextCursor });
    expect([action.error?.code, continued.error?.code]).toEqual(["STALE_SNAPSHOT", "STALE_SNAPSHOT"]);
  });

  it.each(["onHistoryStateUpdated", "onReferenceFragmentUpdated", "onCommitted"])("invalidates only the navigated tab and frame on %s", async (event) => {
    const { observe, act, navigate } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    navigate(event, 43, 0);
    navigate(event, 42, 9);
    expect((await observe({ cursor: first.result.nextCursor }) as any).error).toBeUndefined();
    navigate(event);
    expect((await act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true }) as any).error?.code).toBe("STALE_SNAPSHOT");
    expect((await observe({ cursor: first.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("invalidates snapshots after back and forward history navigation", async () => {
    const { observe, act, navigate } = setup();
    window.history.pushState({}, "", "/other");
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const back = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.back();
    await back;
    navigate("onHistoryStateUpdated");
    expect((await observe({ cursor: first.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
    const second: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const forward = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.forward();
    await forward;
    navigate("onHistoryStateUpdated");
    expect((await act({ snapshotId: second.result.snapshotId, index: second.result.elements[0].index, force: true }) as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("rejects a click when navigation occurs during async validation", async () => {
    const { observe, act, navigate } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    execute.mockImplementation(async (details: any) => {
      const result = await original(details);
      if (String(details.func).includes("?.validate?.(index, sel)")) { entered(); await gate; }
      return result;
    });
    const pending = act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true });
    await paused;
    navigate("onHistoryStateUpdated");
    release();
    expect((await pending as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("rejects navigation while a snapshot scan is in flight", async () => {
    const { observe, navigate } = setup();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    execute.mockImplementation(async (details: any) => {
      const result = await original(details);
      if (String(details.func).includes("scanRoot")) { entered(); await gate; }
      return result;
    });
    const pending = observe({ target: "#focus", paginate: true, includeAX: false });
    await paused;
    navigate("onHistoryStateUpdated");
    release();
    expect((await pending as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("keeps a cursor valid after scan writes its clickable marker", async () => {
    const { observe } = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<div id="clickable" role="button" style="cursor:pointer">Clickable</div>');
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(document.querySelector("#clickable")!.getAttribute("data-vortex-react-clickable")).toBe("1");
    const next: any = await observe({ cursor: first.result.nextCursor });
    expect(next.error).toBeUndefined();
  });

  it("rejects real mutations triggered while writing a scan marker", async () => {
    const { observe } = setup();
    class ReactiveButton extends HTMLElement {
      static get observedAttributes() { return ["data-vortex-react-clickable"]; }
      attributeChangedCallback() { this.setAttribute("aria-label", "changed by page"); }
    }
    window.customElements.define("reactive-button", ReactiveButton);
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<reactive-button role="button" style="cursor:pointer">Click</reactive-button>');
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.error?.code).toBe("STALE_SNAPSHOT");
    expect(first.result).toBeUndefined();
  });

  it("invalidates the old cursor and node identity on a new same-tab observe", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const token = first.result.snapshotId;
    const second: any = await observe({ target: "#focus", includeAX: false });
    expect(second.error).toBeUndefined();
    expect((window as any).__vortexPageSnapshots?.[token]).toBeUndefined();
    expect((await observe({ cursor: first.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
    expect((await act({ snapshotId: token, index: first.result.elements[0].index, force: true }) as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("preserves the old cursor when a new observe has invalid parameters", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const invalid: any = await observe({ target: "#focus", paginate: true, maxElements: 0 });
    expect(invalid.error?.code).toBe("INVALID_PARAMS");
    expect((await observe({ cursor: first.result.nextCursor }) as any).error).toBeUndefined();
  });

  it("rejects a cursor invalidated while its validation is in flight", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    execute.mockImplementation(async (details: any) => {
      const result = await original(details);
      if (!held && String(details.func).includes("item.check()")) { held = true; entered(); await gate; }
      return result;
    });
    const continuation = observe({ cursor: first.result.nextCursor });
    await paused;
    await observe({ target: "#focus", includeAX: false });
    release();
    expect((await continuation as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("keeps pagination in another tab valid when a new observe runs", async () => {
    const firstApi = setup();
    const names = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location", "MutationObserver", "MouseEvent", "Event", "InputEvent", "KeyboardEvent", "HTMLSelectElement", "HTMLTextAreaElement", "getComputedStyle", "CSS", "chrome"];
    const firstGlobals = Object.fromEntries(names.map((name) => [name, (globalThis as any)[name]]));
    const first: any = await firstApi.observe({ target: "#focus", paginate: true, includeAX: false }, 42);
    const secondApi = setup();
    const second: any = await secondApi.observe({ target: "#focus", paginate: true, includeAX: false }, 43);
    expect(second.error).toBeUndefined();
    for (const [name, value] of Object.entries(firstGlobals)) vi.stubGlobal(name, value);
    const continued: any = await firstApi.observe({ cursor: first.result.nextCursor }, 42);
    expect(continued.error).toBeUndefined();
  });

  it("rejects delayed rich text pagination before any focus or input", async () => {
    const sendCommand = vi.fn(async (_tab: number, _method: string, params: { text: string }) => { document.activeElement!.textContent += params.text; });
    const api = setup({ attach: vi.fn(), sendCommand });
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<div id="editor" contenteditable="true" aria-label="Editor" tabindex="0">old</div>');
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get() { return this.getAttribute("contenteditable") === "true"; } });
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Editor");
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: hit.index, text: "hello", delay: 1, force: true });
    expect(result.error?.code).toBe("INVALID_PARAMS");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(document.querySelector("#editor")!.textContent).toBe("old");
    expect(document.activeElement).not.toBe(document.querySelector("#editor"));
  });
  it.each(["dom.query", "dom.queryAll", "dom.scroll", "dom.getAttribute", "dom.waitForMutation", "dom.waitSettled", "dom.commit"])("%s safely rejects pagination refs", async (tool) => {
    const api = setup();
    const first: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const result: any = await api.dispatch(tool, { snapshotId: first.result.snapshotId, index: first.result.elements[0].index, kind: "checkbox-group", value: { values: [] } });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
  });
  it("select changes the captured select", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>');
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = [...snapshot.result.elements, ...page.result.elements].find((e: any) => e.name === "Choice");
    const result: any = await api.select({ snapshotId: snapshot.result.snapshotId, index: hit.index, value: "b", force: true });
    expect(result.error).toBeUndefined();
    expect((document.querySelector("#choice") as HTMLSelectElement).value).toBe("b");
  });

  it("select rejects replacement while waiting for options", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<select id="choice" aria-label="Choice"><option value="a">A</option></select>');
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = [...snapshot.result.elements, ...page.result.elements].find((e: any) => e.name === "Choice");
    const original = document.querySelector("#choice")!;
    setTimeout(() => {
      const replacement = original.cloneNode(true) as HTMLSelectElement;
      replacement.insertAdjacentHTML("beforeend", '<option value="b">B</option>');
      original.replaceWith(replacement);
      original.insertAdjacentHTML("beforeend", '<option value="b">B</option>');
    }, 10);
    const result: any = await api.select({ snapshotId: snapshot.result.snapshotId, index: hit.index, value: "b", timeout: 200, force: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect((document.querySelector("#choice") as HTMLSelectElement).value).toBe("a");
  });

  it("hover dispatches to the captured node", async () => {
    const sendCommand = vi.fn();
    const api = setup({ attach: vi.fn(), sendCommand });
    let hovered = 0;
    document.querySelector("#b0")!.addEventListener("mouseover", () => hovered++);
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = snapshot.result.elements.find((e: any) => e.name === "Button 0");
    const result: any = await api.hover({ snapshotId: snapshot.result.snapshotId, index: hit.index });
    expect(result.error).toBeUndefined();
    expect(hovered).toBe(1);
    expect(sendCommand).toHaveBeenCalledWith(42, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseMoved" }));
  });

  it("hover refreshes coordinates after debugger attach", async () => {
    const sendCommand = vi.fn();
    const api = setup({ attach: vi.fn(async () => {
      (document.querySelector("#b0") as HTMLElement).getBoundingClientRect = () => ({ x: 100, y: 200, width: 80, height: 30, top: 200, left: 100, right: 180, bottom: 230, toJSON() {} });
    }), sendCommand });
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = snapshot.result.elements.find((e: any) => e.name === "Button 0");
    const result: any = await api.hover({ snapshotId: snapshot.result.snapshotId, index: hit.index });
    expect(result.error).toBeUndefined();
    expect(sendCommand).toHaveBeenCalledWith(42, "Input.dispatchMouseEvent", expect.objectContaining({ x: 140, y: 215 }));
  });

  it("hover rejects replacement during debugger attach before CDP dispatch", async () => {
    const sendCommand = vi.fn();
    const api = setup({ attach: vi.fn(async () => {
      const original = document.querySelector("#b0")!;
      original.replaceWith(original.cloneNode(true));
    }), sendCommand });
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = snapshot.result.elements.find((e: any) => e.name === "Button 0");
    const result: any = await api.hover({ snapshotId: snapshot.result.snapshotId, index: hit.index });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it.each(["select", "hover"] as const)("%s rejects replacement during actionability without healing", async (action) => {
    const api = setup({ attach: vi.fn(), sendCommand: vi.fn() });
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>');
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = [...snapshot.result.elements, ...page.result.elements].find((e: any) => e.name === "Choice");
    const healSpy = vi.spyOn(heal, "tryHealSelector");
    vi.mocked(waitActionableAutoForce).mockImplementationOnce(async () => {
      const node = document.querySelector("#choice")!;
      node.replaceWith(node.cloneNode(true));
      return {} as any;
    });
    let events = 0;
    document.querySelector("#focus")!.addEventListener("mouseover", () => events++);
    const result: any = await api[action]({ snapshotId: snapshot.result.snapshotId, index: hit.index, value: "b", force: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect((document.querySelector("#choice") as HTMLSelectElement).value).toBe("a");
    expect(events).toBe(0);
    expect(healSpy).not.toHaveBeenCalled();
    healSpy.mockRestore();
  });
  it.each(["type", "fill"] as const)("%s writes to the captured input", async (action) => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field">');
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Field");
    const result: any = await api[action]({ snapshotId: snapshot.result.snapshotId, index: hit.index, text: "hello", value: "hello", fallbackToNative: true, force: true });
    expect(result.error).toBeUndefined();
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("hello");
    expect((await api.observe({ cursor: snapshot.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it.each(["type", "fill"] as const)("%s rejects a replacement during actionability", async (action) => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field">');
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Field");
    vi.mocked(waitActionableAutoForce).mockImplementationOnce(async () => {
      const original = document.querySelector("#field")!;
      original.replaceWith(original.cloneNode(true));
      return {} as any;
    });
    const result: any = await api[action]({ snapshotId: snapshot.result.snapshotId, index: hit.index, text: "hello", value: "hello", fallbackToNative: true, force: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("");
  });

  it("type sends CDP input to the focused captured editor", async () => {
    const api = setup({ attach: vi.fn(), sendCommand: vi.fn(async (_tab: number, _method: string, params: { text: string }) => {
      document.activeElement!.textContent = params.text;
    }) });
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<div id="editor" contenteditable="true" aria-label="Editor" tabindex="0">old</div>');
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get() { return this.getAttribute("contenteditable") === "true"; } });
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Editor");
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: hit.index, text: "hello", force: true });
    expect(result.error).toBeUndefined();
    expect(document.querySelector("#editor")!.textContent).toBe("hello");
  });

  it("type does not send CDP input when attach replaces the captured editor", async () => {
    const sendCommand = vi.fn();
    const api = setup({ attach: vi.fn(async () => {
      const node = document.querySelector("#editor")!;
      node.replaceWith(node.cloneNode(true));
    }), sendCommand });
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<div id="editor" contenteditable="true" aria-label="Editor" tabindex="0">old</div>');
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get() { return this.getAttribute("contenteditable") === "true"; } });
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Editor");
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: hit.index, text: "hello", force: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(document.querySelector("#editor")!.textContent).toBe("old");
  });

  it("type stops when focus replaces the captured input", async () => {
    const api = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("afterbegin", '<input id="field" aria-label="Field">');
    const snapshot: any = await api.observe({ target: "#focus", paginate: true, includeAX: false });
    const page: any = await api.observe({ cursor: snapshot.result.nextCursor });
    const hit = page.result.elements.find((e: any) => e.name === "Field");
    const original = document.querySelector("#field")!;
    original.addEventListener("focus", () => original.replaceWith(original.cloneNode(true)));
    const result: any = await api.type({ snapshotId: snapshot.result.snapshotId, index: hit.index, text: "hello", force: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("");
  });
  it("freezes 90 siblings into pages of 80 and 10 without duplicates", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.error).toBeUndefined();
    expect(first.result.elements).toHaveLength(80);
    expect(first.result.nextCursor).toBeTruthy();
    const second: any = await observe({ cursor: first.result.nextCursor });
    expect(second.error).toBeUndefined();
    expect(second.result.snapshotId).toBe(first.result.snapshotId);
    expect(second.result.elements).toHaveLength(10);
    expect(new Set([...first.result.elements, ...second.result.elements].map((e: any) => e.index)).size).toBe(90);
    expect(second.result.nextCursor).toBeUndefined();
  });

  it("binds a repeatable cursor to its tab and rejects changed parameters", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.result.nextCursor).toBeTruthy();
    const cursor = first.result.nextCursor;
    const page: any = await observe({ cursor });
    const retry: any = await observe({ cursor });
    expect(retry.result).toEqual(page.result);
    const wrongTab: any = await observe({ cursor }, 43);
    expect(wrongTab.error?.code).toBe("STALE_SNAPSHOT");
    const changedParams: any = await observe({ cursor, filter: "all" });
    expect(changedParams.error?.code).toBe("INVALID_PARAMS");
  });

  it("rejects wrong frame and expired cursors without rescanning", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const cursor = first.result.nextCursor;
    const wrongFrame: any = await observe({ cursor, frameId: 9 });
    expect(wrongFrame.error?.code).toBe("STALE_SNAPSHOT");
    const execute = vi.mocked(chrome.scripting.executeScript);
    const before = execute.mock.calls.length;
    const page: any = await observe({ cursor });
    expect(page.result.elements).toHaveLength(10);
    expect(execute.mock.calls.length - before).toBe(1);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    const expired: any = await observe({ cursor });
    expect(expired.error?.code).toBe("STALE_SNAPSHOT");
    clock.mockRestore();
  });

  it("rejects an expired pagination action even when the page timer has not fired", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    try {
      const action: any = await act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true });
      expect(action.error?.code).toBe("STALE_SNAPSHOT");
    } finally {
      clock.mockRestore();
    }
  });

  it("marks bounded captures incomplete", async () => {
    const { observe } = setup();
    const section = document.querySelector("#focus")!;
    for (let i = 90; i < 505; i++) {
      const button = document.createElement("button");
      button.textContent = `Button ${i}`;
      section.appendChild(button);
    }
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.result.meta.incomplete).toBe("capture-budget");
    expect(first.result.nextCursor).toBeTruthy();
  });

  it("rejects continuation after same-node text changes in an open shadow root", async () => {
    const { observe } = setup();
    const host = document.createElement("div");
    document.querySelector("#focus")!.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<button>Shadow button</button>";
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.result.nextCursor).toBeTruthy();
    shadow.querySelector("button")!.textContent = "Changed";
    const continued: any = await observe({ cursor: first.result.nextCursor });
    expect(continued.error?.code).toBe("STALE_SNAPSHOT");
  });

  it("does not offer a cursor when native state exceeds its monitoring budget", async () => {
    const { observe, act } = setup();
    const field = document.createElement("input");
    field.value = "x".repeat(1_000_001);
    document.querySelector("#focus")!.appendChild(field);
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.result.meta.incomplete).toBe("monitor-budget");
    expect(first.result.nextCursor).toBeUndefined();
    expect((await act({ snapshotId: first.result.snapshotId, index: first.result.elements[0].index, force: true }) as any).error?.code).toBe("STALE_SNAPSHOT");
  });

  it("does not offer a cursor or claim completeness when shadow monitoring exceeds its node budget", async () => {
    const { observe, act } = setup();
    const container = document.createElement("div");
    for (let i = 0; i < 11000; i++) container.appendChild(document.createElement("i"));
    document.body.appendChild(container);
    const first: any = await observe({ selector: "#focus", paginate: true, includeAX: false });
    expect(first.result.meta.incomplete).toBe("monitor-budget");
    expect(first.result.nextCursor).toBeUndefined();
    const hit = first.result.elements[0];
    const action: any = await act({ snapshotId: first.result.snapshotId, index: hit.index, force: true });
    expect(action.error?.code).toBe("STALE_SNAPSHOT");
  });

  it("keeps only the latest page monitor after repeated observes", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    for (let i = 0; i < 16; i++) await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(Object.keys((window as any).__vortexPageSnapshots)).toHaveLength(1);
    const continued: any = await observe({ cursor: first.result.nextCursor });
    expect(continued.error?.code).toBe("STALE_SNAPSHOT");
  });

  it("rejects a shadow root attached after capture", async () => {
    const { observe } = setup();
    const host = document.createElement("div");
    document.querySelector("#focus")!.appendChild(host);
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    host.attachShadow({ mode: "open" }).innerHTML = "<button>New</button>";
    const continued: any = await observe({ cursor: first.result.nextCursor });
    expect(continued.error?.code).toBe("STALE_SNAPSHOT");
  });

  it("clicks the original node referenced on the second page", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const second: any = await observe({ cursor: first.result.nextCursor });
    const hit = second.result.elements.find((e: any) => e.name === "Button 80");
    let clicks = 0;
    document.querySelector("#b80")!.addEventListener("click", () => clicks++);
    const action: any = await act({ index: hit.index, snapshotId: second.result.snapshotId, force: true });
    expect(action.error).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("does not run the actionability probe after a control value changes silently", async () => {
    const { observe } = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("beforeend", '<input id="control" value="old">');
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = first.result.elements.find((e: any) => e.name === "Button 0");
    const probe = vi.fn();
    (window as any).__vortexActionability = { version: 3, probe };
    (document.querySelector("#control") as HTMLInputElement).value = "new";
    await expect(checkActionability(42, undefined, "#b0", {
      pagination: { snapshotId: first.result.snapshotId, nodeIndex: hit.index },
    } as any)).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not run the actionability probe on a replacement node", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = first.result.elements[0];
    const probe = vi.fn();
    (window as any).__vortexActionability = { probe };
    const node = document.querySelector("#b0")!;
    node.replaceWith(node.cloneNode(true));
    await expect(checkActionability(42, undefined, "#b0", {
      pagination: { snapshotId: first.result.snapshotId, nodeIndex: hit.index },
    } as any)).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("stops the click if focus replaces the captured node", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = first.result.elements.find((e: any) => e.name === "Button 0");
    const node = document.querySelector("#b0")!;
    let clicks = 0;
    node.addEventListener("click", () => clicks++);
    node.addEventListener("focus", () => node.replaceWith(node.cloneNode(true)));
    const action: any = await act({ snapshotId: first.result.snapshotId, index: hit.index, force: true });
    expect(action.error?.code).toBe("STALE_SNAPSHOT");
    expect(clicks).toBe(0);
  });

  it("does not dispatch CDP input after a control value changes during attach", async () => {
    const { observe } = setup();
    document.querySelector("#focus")!.insertAdjacentHTML("beforeend", '<input id="control" value="old">');
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = first.result.elements.find((e: any) => e.name === "Button 0");
    const sendCommand = vi.fn();
    const manager = {
      attach: vi.fn(async () => { (document.querySelector("#control") as HTMLInputElement).value = "new"; }),
      sendCommand,
    };
    await expect(cdpClickElement(manager as any, 42, undefined, "#b0", {
      force: true,
      pagination: { snapshotId: first.result.snapshotId, nodeIndex: hit.index },
    } as any)).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("does not dispatch CDP input after the captured node is replaced during attach", async () => {
    const { observe } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = first.result.elements.find((e: any) => e.name === "Button 0");
    const sendCommand = vi.fn();
    const manager = {
      attach: vi.fn(async () => {
        const node = document.querySelector("#b0")!;
        node.replaceWith(node.cloneNode(true));
      }),
      sendCommand,
    };
    await expect(cdpClickElement(manager as any, 42, undefined, "#b0", {
      force: true,
      pagination: { snapshotId: first.result.snapshotId, nodeIndex: hit.index },
    } as any)).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("does not attempt descriptor healing for a stale pagination ref", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    const hit = first.result.elements[0];
    const healSpy = vi.spyOn(heal, "tryHealSelector");
    document.querySelector("#b0")!.replaceWith(document.querySelector("#b0")!.cloneNode(true));
    const action: any = await act({ index: hit.index, snapshotId: first.result.snapshotId, force: true });
    expect(action.error?.code).toBe("STALE_SNAPSHOT");
    expect(healSpy).not.toHaveBeenCalled();
    healSpy.mockRestore();
  });

  it("rejects an action if the node changes during actionability preparation", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.result.nextCursor).toBeTruthy();
    const hit = first.result.elements.find((e: any) => e.name === "Button 0");
    let clicks = 0;
    const original = document.querySelector("#b0")!;
    original.addEventListener("click", () => clicks++);
    const healSpy = vi.spyOn(heal, "tryHealSelector");
    vi.mocked(waitActionableAutoForce).mockImplementationOnce(async () => {
      const replacement = original.cloneNode(true);
      replacement.addEventListener("click", () => clicks++);
      original.replaceWith(replacement);
      throw vtxError(VtxErrorCode.NOT_ATTACHED, "Target detached");
    });
    const action: any = await act({ index: hit.index, snapshotId: first.result.snapshotId, force: true });
    expect(action.error?.code).toBe("STALE_SNAPSHOT");
    expect(clicks).toBe(0);
    expect(healSpy).not.toHaveBeenCalled();
    healSpy.mockRestore();
  });

  it("rejects continuation and action after replacing a captured node", async () => {
    const { observe, act } = setup();
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.error).toBeUndefined();
    expect(first.result.nextCursor).toBeTruthy();
    const hit = first.result.elements.find((e: any) => e.name === "Button 0");
    expect(hit).toBeDefined();
    let replacementClicks = 0;
    const replacement = document.querySelector("#b0")!.cloneNode(true);
    replacement.addEventListener("click", () => replacementClicks++);
    document.querySelector("#b0")!.replaceWith(replacement);
    const continued: any = await observe({ cursor: first.result.nextCursor });
    expect(continued.error?.code).toBe("STALE_SNAPSHOT");
    const action: any = await act({ index: hit.index, snapshotId: first.result.snapshotId, force: true });
    expect(action.error?.code).toBe("STALE_SNAPSHOT");
    expect(replacementClicks).toBe(0);
  });
});
