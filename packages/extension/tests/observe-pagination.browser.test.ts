import { afterAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { cdpClickElement } from "../src/adapter/cdp.js";
import { setSnapshot } from "../src/lib/snapshot-store.js";
import { stubBrowserChrome } from "./helpers/chromium-chrome.js";
vi.mock("../src/action/wait-actionable-auto-force.js", () => ({ waitActionableAutoForce: vi.fn().mockResolvedValue({}) }));

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH!);
let browser: any;
afterAll(async () => { await browser?.close(); vi.unstubAllGlobals(); });

describe("pagination real mouse", () => {
  it("rejects continuation after trusted input and change events on the 81st control", async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const page = await browser.newPage();
    await page.setContent(`<section id="focus">${Array.from({ length: 81 }, (_, i) => `<input id="field${i}" aria-label="Field ${i}" value="old">`).join("")}</section>`);
    await page.evaluate(() => {
      (window as any).events = [];
      const field = document.querySelector("#field80")!;
      for (const name of ["input", "change"]) field.addEventListener(name, (event) => (window as any).events.push([name, event.isTrusted]));
    });
    stubBrowserChrome(page);
    const router = new ActionRouter();
    registerObserveHandlers(router, {} as any);
    const observe = (args: object) => router.dispatch({ type: "tool_request", tool: "observe.snapshot", args, requestId: "browser-pagination", tabId: 42 } as any);
    const first: any = await observe({ target: "#focus", paginate: true, includeAX: false });
    expect(first.error).toBeUndefined();
    expect(first.result.nextCursor).toBeTruthy();
    await page.locator("#field80").fill("new");
    await page.locator("#field80").blur();
    expect(await page.evaluate(() => (window as any).events)).toEqual(expect.arrayContaining([["input", true], ["change", true]]));
    expect((await observe({ cursor: first.result.nextCursor }) as any).error?.code).toBe("STALE_SNAPSHOT");
    await browser.close();
    browser = undefined;
  });
  it.each(["overlay", "clear", "opaque", "translate", "padding"])("checks nested frame hits after mouse movement (%s)", async (mode) => {
    const blocked = mode === "overlay";
    const rejected = mode !== "clear";
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<style>iframe { border: 0; width: 500px; height: 400px } #cover { position: fixed; left: 0; top: 0; width: 800px; height: 600px; z-index: 2; display: none }</style><iframe ${mode === "opaque" ? 'sandbox="allow-scripts"' : ""}></iframe><button id="cover">Cover</button>`);
    if (mode === "translate") await page.evaluate(() => { document.querySelector("iframe")!.style.translate = "1px"; });
    if (mode === "padding") await page.evaluate(() => { document.querySelector("iframe")!.style.paddingLeft = "40px"; });
    const outer = page.frames()[1];
    await outer.setContent('<style>iframe { border: 0; width: 300px; height: 200px }</style><iframe></iframe>');
    const inner = page.frames()[2];
    await inner.setContent(mode === "padding"
      ? '<button id="decoy" style="position:absolute;left:60px;top:30px;width:30px">Decoy</button><button id="target" style="position:absolute;left:100px;top:30px;width:30px">Target</button>'
      : '<button id="target" style="margin:30px">Target</button>');
    await inner.evaluate((blocked: boolean) => {
      const node = document.querySelector("#target")!;
      (window as any).targetClicks = 0;
      (window as any).decoyClicks = 0;
      document.querySelector("#decoy")?.addEventListener("mousedown", () => (window as any).decoyClicks++);
      node.addEventListener("mousedown", () => (window as any).targetClicks++);
      if (blocked) node.addEventListener("mousemove", () => { (window.top!.document.querySelector("#cover") as HTMLElement).style.display = "block"; }, { once: true });
      (window as any).__vortexDomResolve = { isEnabled: () => true, deepElementFromPoint: (x: number, y: number) => document.elementFromPoint(x, y) };
      (window as any).__vortexPageSnapshots = { test: { validate: () => node } };
    }, blocked);
    await page.evaluate(() => { (window as any).coverClicks = 0; document.querySelector('#cover')!.addEventListener('mousedown', () => (window as any).coverClicks++); });
    const cdp = await page.context().newCDPSession(page);
    const sendCommand = vi.fn((_tab: number, method: string, params: object) => cdp.send(method, params));
    stubBrowserChrome(page);
    setSnapshot("test", { tabId: 42, frameId: 2, capturedAt: Date.now(), pagination: true, elements: [] });
    const click = cdpClickElement({ attach: vi.fn(), sendCommand } as any, 42, 2, "#target", { force: true, pagination: { snapshotId: "test", nodeIndex: 0 } });
    const outcome = await click.then((result) => ({ result, error: undefined }), (error) => ({ result: undefined, error }));
    expect(await inner.evaluate(() => (window as any).decoyClicks)).toBe(0);
    if (rejected) expect(outcome.error).toMatchObject({ code: "STALE_SNAPSHOT" });
    else expect(outcome.result).toMatchObject({ success: true });
    expect(sendCommand.mock.calls.some(([, , params]: any[]) => params.type === "mouseMoved")).toBe(true);
    expect(sendCommand.mock.calls.some(([, , params]: any[]) => params.type === "mousePressed")).toBe(!rejected);
    expect(await page.evaluate(() => (window as any).coverClicks)).toBe(0);
    expect(await inner.evaluate(() => (window as any).targetClicks)).toBe(rejected ? 0 : 1);
    await browser.close();
    browser = undefined;
  });
  it("rejects a target replaced by real mouse movement before pressing", async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<button id="target" style="margin:100px">Target</button>');
    await page.evaluate(() => {
      (window as any).__vortexDomResolve = {
        queryAllDeep: (selector: string) => Array.from(document.querySelectorAll(selector)),
        isEnabled: () => true,
        deepElementFromPoint: (x: number, y: number) => document.elementFromPoint(x, y),
      };
      (window as any).replacementClicks = 0;
      document.querySelector("#target")!.addEventListener("mousemove", (event) => {
        if (!event.isTrusted) return;
        const original = document.querySelector("#target")!;
        const replacement = original.cloneNode(true);
        replacement.addEventListener("click", () => (window as any).replacementClicks++);
        original.replaceWith(replacement);
      }, { once: true });
    });
    const cdp = await page.context().newCDPSession(page);
    const sendCommand = vi.fn((_tab: number, method: string, params: object) => cdp.send(method, params));
    stubBrowserChrome(page);
    const router = new ActionRouter();
    registerObserveHandlers(router, {} as any);
    registerDomHandlers(router, { attach: vi.fn(), sendCommand } as any);
    const dispatch = (tool: string, args: object) => router.dispatch({ type: "tool_request", tool, args, requestId: "browser-pagination", tabId: 42 } as any);
    const snapshot: any = await dispatch("observe.snapshot", { target: "#target", paginate: true, includeAX: false });
    expect(snapshot.error).toBeUndefined();
    const hit = snapshot.result.elements.find((element: any) => element.name === "Target");
    const result: any = await dispatch("dom.click", { snapshotId: snapshot.result.snapshotId, index: hit.index, force: true, useRealMouse: true });
    expect(result.error?.code).toBe("STALE_SNAPSHOT");
    expect(sendCommand.mock.calls.some(([, , params]: any[]) => params.type === "mouseMoved")).toBe(true);
    expect(sendCommand.mock.calls.some(([, , params]: any[]) => params.type === "mousePressed")).toBe(false);
    expect(await page.evaluate(() => (window as any).replacementClicks)).toBe(0);
  });
});
