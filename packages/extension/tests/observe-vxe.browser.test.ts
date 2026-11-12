import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { stubBrowserChrome } from "./helpers/chromium-chrome.js";

// PLAYWRIGHT_PATH points to an already installed playwright package; no project dependency is added.
// 缺环境直接失败,不用 skip:skip 会被读成「浏览器用例已通过」,那是假绿灯。
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH;
const CHROME_PATH = process.env.CHROME_PATH;
if (!PLAYWRIGHT_PATH || !CHROME_PATH) {
  throw new Error(
    "浏览器用例缺少环境变量:PLAYWRIGHT_PATH(playwright 包目录)、CHROME_PATH(Chrome 可执行文件路径)。" +
    "用 pnpm --filter @vortex-browser/extension test:browser 运行并显式给出这两个变量。",
  );
}
const require = createRequire(import.meta.url);
// pi-lens-ignore: ts-dynamic-require -- 测试专用:路径来自开发者本地环境变量 PLAYWRIGHT_PATH,仓库不引入 playwright 依赖
const { chromium } = require(PLAYWRIGHT_PATH);
let browser: any;
let page: any;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route("**/*", (route: any) => route.abort());
});
afterAll(async () => { await browser?.close(); vi.unstubAllGlobals(); });

async function setup(content: string, style = "") {
  await page.setContent(`<!doctype html><style>body{margin:20px;font:16px Arial} table{border-collapse:collapse} td{padding:2px} ${style}</style>
    <div class="vxe-table" id="host">${content}</div>`);
  await page.evaluate(() => {
    const host = document.querySelector("#host") as any;
    const rows = [{ id: "K" }, { id: "L" }];
    const instance = { $options: { name: "VxeTable" }, $parent: null, $el: host, treeConfig: null,
      getTableData: () => ({ fullData: rows }), getRowid: (row: any) => row.id };
    host.__vue__ = instance;
    for (const wrapper of host.querySelectorAll(".vxe-table--body-wrapper")) {
      wrapper.__vue__ = { $options: { name: "VxeTableBody" }, $parent: instance };
    }
  });
}
const fragment = (side: string, rows: string) => `<div class="vxe-table--body-wrapper ${side}"><table><tbody>${rows}</tbody></table></div>`;
const row = (id: string, cells: string) => `<tr class="vxe-body--row" rowid="${id}">${cells}</tr>`;
const actions = () => fragment("fixed-right--wrapper", row("K", "<td><button>详情</button></td>") + row("L", "<td><button>详情</button></td>"));

async function snapshot(args: Record<string, unknown> = {}, all = false, full = false, debuggerMgr?: any) {
  stubBrowserChrome(page);
  const router = new ActionRouter();
  registerObserveHandlers(router, debuggerMgr);
  const result = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args, requestId: "browser", tabId: 42 } as any);
  expect(result.error).toBeUndefined();
  if (full) return result.result;
  const elements = (result.result as any).elements;
  return all ? elements : elements.filter((e: any) => e.tag === "button" && e.name === "详情");
}

describe("observe VXE-like row contexts in Chromium layout", () => {
  it("cleans AX markers inside open shadow roots after a scoped observation", async () => {
    await setup('<div id="shadow-host"></div>');
    await page.evaluate(() => document.querySelector("#shadow-host")!.attachShadow({ mode: "open" }).innerHTML = '<button>详情</button>');
    await snapshot({ selector: "#shadow-host", includeAX: true });
    const remaining = await page.evaluate(() => document.querySelector("#shadow-host")!.shadowRoot!.querySelectorAll("[data-vtx-ax]").length);
    expect(remaining).toBe(0);
  });

  it("does not fall back to checkbox or radio values when label text is masked", async () => {
    await setup(['checkbox', 'radio'].map((type) => `<label><input type="${type}" value="REDACTION_TEST_${type}"><span style="-webkit-text-security:disc">REDACTION_TEST_${type}</span></label>`).join('') + '<input id="hidden-control" type="radio" value="REDACTION_TEST_hidden" style="width:0;height:0;position:absolute"><label for="hidden-control" tabindex="0"><span style="-webkit-text-security:disc">REDACTION_TEST_hidden</span></label>');
    const result = await snapshot({ includeAX: false, filter: "all" }, false, true) as any;
    expect(JSON.stringify(result)).not.toContain("REDACTION_TEST_");
  });

  it("redacts visible controls with externally masked labels but keeps ordinary values", async () => {
    await setup(['checkbox', 'radio'].map((type) => `<input id="${type}" type="${type}" value="SECRET_EXTERNAL_${type}"><label for="${type}"><span style="-webkit-text-security:disc">SECRET_EXTERNAL_${type}</span></label><input type="${type}" aria-label="Public ${type}" value="PUBLIC_EXTERNAL_${type}">`).join(''));
    const result = await snapshot({ includeAX: false, filter: 'all', format: 'full' }, false, true) as any;
    for (const type of ['checkbox', 'radio']) {
      expect(JSON.stringify(result)).not.toContain(`SECRET_EXTERNAL_${type}`);
      expect(JSON.stringify(result)).toContain(`PUBLIC_EXTERNAL_${type}`);
    }
  });

  it("names visible labels from unmasked hidden controls without exposing passwords", async () => {
    await setup('<input id="hidden-value" type="radio" value="Public hidden value" style="width:0;height:0;position:absolute"><label for="hidden-value" tabindex="0" style="display:inline-block;width:20px;height:20px"></label><input id="hidden-aria" type="radio" aria-label="Public hidden aria" value="Fallback" style="width:0;height:0;position:absolute"><label for="hidden-aria" tabindex="0" style="display:inline-block;width:20px;height:20px"></label><input id="hidden-password" type="password" value="SECRET_HIDDEN_PASSWORD" style="width:0;height:0;position:absolute"><label for="hidden-password" tabindex="0" style="display:inline-block;width:20px;height:20px"></label>');
    const result = await snapshot({ includeAX: false, filter: 'all' }, false, true) as any;
    expect(result.elements.some((el: any) => el.name === 'Public hidden value')).toBe(true);
    expect(result.elements.some((el: any) => el.name === 'Public hidden aria')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET_HIDDEN_PASSWORD');
  });

  it("redacts masked button input values while preserving ordinary button names", async () => {
    const types = ["button", "submit", "reset", "image"];
    await setup(types.map((type) => `<input type="${type}" style="-webkit-text-security:disc;width:120px;height:24px" value="SECRET_BUTTON_${type}"><input type="${type}" style="width:120px;height:24px" value="Public action ${type}">`).join("") +
      '<input type="image" style="-webkit-text-security:disc;width:120px;height:24px" alt="Safe image" value="SECRET_BUTTON_alt">');
    const result = await snapshot({ includeAX: true, filter: "all" }, false, true) as any;
    expect(JSON.stringify(result)).not.toContain("SECRET_BUTTON_");
    for (const type of types) expect(result.elements.some((e: any) => e.name === `Public action ${type}`)).toBe(true);
    expect(result.elements.some((e: any) => e.name === "Safe image")).toBe(true);
  });

  it("retains 200 characters of fragmented editable values while redacting masked spans", async () => {
    const text = "0123456789".repeat(22);
    const fragments = [...text].map((part, i) => `${i === 50 ? '<span style="-webkit-text-security:disc">SECRET_EDIT_FRAGMENT</span>' : ""}<span><span>${part}</span></span>`).join("");
    await setup(`<div contenteditable="true" aria-label="Plain editor">${text}</div><div contenteditable="true" aria-label="Fragmented editor">${fragments}</div>`);
    const result = await snapshot({ includeAX: true, filter: "all" }, false, true) as any;
    expect(JSON.stringify(result)).not.toContain("SECRET_EDIT_FRAGMENT");
    const plain = result.elements.find((e: any) => e.name === "Plain editor");
    const fragmented = result.elements.find((e: any) => e.name === "Fragmented editor");
    expect(plain?.valueNow).toBe(text.slice(0, 200));
    expect(fragmented?.valueNow).toBe(text.slice(0, 200));
  });

  it("does not expose masked input or nested editable content through the observe result", async () => {
    await setup('<label>Token<input style="-webkit-text-security: disc" value="MASKED_TOKEN_928"></label><div role="button" tabindex="0">Visible <div contenteditable="true" style="-webkit-text-security: disc"><span>MASKED_EDIT_731</span></div></div><div contenteditable="true" aria-label="Mixed editor">safe<span style="-webkit-text-security: disc">MASKED_NESTED_315</span></div><input aria-label="Visible input" value="PUBLIC_VALUE_594">');
    const result = await snapshot({ includeAX: true, filter: "all" }, true);
    expect(result.some((e: any) => e.tag === "input")).toBe(true);
    expect(JSON.stringify(result)).toContain("PUBLIC_VALUE_594");
    expect(JSON.stringify(result)).not.toContain("MASKED_TOKEN_928");
    expect(JSON.stringify(result)).not.toContain("MASKED_EDIT_731");
    expect(JSON.stringify(result)).not.toContain("MASKED_NESTED_315");
  });

  it("does not disclose masked content through labels, errors or duplicate context", async () => {
    await setup('<span id="masked-ref" style="-webkit-text-security:disc">MASKED_REF_481</span><input aria-label="Related" aria-errormessage="masked-ref" aria-labelledby="masked-ref"><label><span style="-webkit-text-security:disc">MASKED_LABEL_471</span><input></label><div><span style="-webkit-text-security:disc">MASKED_DUP_A</span><button>Repeated</button></div><div><span style="-webkit-text-security:disc">MASKED_DUP_B</span><button>Repeated</button></div>');
    const result = await snapshot({ includeAX: false, filter: "all" }, true);
    expect(result.some((e: any) => e.name === "Repeated")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/MASKED_(REF_481|LABEL_471|DUP_A|DUP_B)/);
  });

  it("does not expose hidden control values or slotted masked names", async () => {
    await setup('<input id="pw" type="password" value="HIDDEN_PASSWORD_711" style="width:0;height:0"><label for="pw" tabindex="0"></label><div id="slot-host" role="button" tabindex="0">MASKED_SLOT_932</div>');
    await page.evaluate(() => { document.querySelector("#slot-host")!.attachShadow({ mode: "open" }).innerHTML = '<slot style="-webkit-text-security:disc"></slot>'; });
    const result = await snapshot({ filter: "all", includeAX: false }, true);
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN_PASSWORD_711|MASKED_SLOT_932/);
  });

  it("redacts inherited shadow masking while retaining a local none override", async () => {
    await setup('<div id="secret-shadow" style="-webkit-text-security:disc"></div>');
    await page.evaluate(() => {
      document.querySelector("#secret-shadow")!.attachShadow({ mode: "open" }).innerHTML = '<input aria-label="Masked" value="MASKED_SHADOW_816"><input aria-label="Unmasked" style="-webkit-text-security:none" value="VISIBLE_SHADOW_217">';
    });
    const result = await snapshot({ filter: "all" }, true);
    expect(result.some((e: any) => e.tag === "input" && e.name === "Masked")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("MASKED_SHADOW_816");
    expect(JSON.stringify(result)).toContain("VISIBLE_SHADOW_217");
  });

  it("uses visible label text for names without including nested controls", async () => {
    await setup('<button><span>Visible</span><span style="visibility:hidden">Hidden</span><span style="display:none">Gone</span></button><button><span>Hello</span> <span>World</span></button><button>Leaf text</button><button style="width:30px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Long ellipsis text</button><label>Customer <input placeholder="Placeholder"><textarea>CONTROL_VALUE</textarea><select><option>OPTION_VALUE</option></select></label>');
    const result = await snapshot({ includeAX: false, filter: 'all' }, false, true) as any;
    for (const name of ['Visible', 'Hello World', 'Leaf text', 'Long ellipsis text']) {
      expect(result.elements.some((el: any) => el.tag === 'button' && el.name === name)).toBe(true);
    }
    expect(result.elements.some((el: any) => el.tag === 'input' && el.name === 'Customer')).toBe(true);
    expect(result.elements.find((el: any) => el.tag === 'input')?.name).not.toMatch(/Placeholder|CONTROL_VALUE|OPTION_VALUE/);
  });

  it("checks Chromium AX ownership and mixed state with masked descriptions", async () => {
    await setup('<div role="listbox" aria-label="Public list" aria-owns="owned" tabindex="0" style="width:100px;height:30px"></div><div id="owned" role="option" style="-webkit-text-security:disc">CHROME_AX_PRIVATE</div><div role="checkbox" aria-label="Public check" aria-checked="mixed" aria-describedby="description" tabindex="0">Check</div><span id="description" style="-webkit-text-security:disc">CHROME_DESC_PRIVATE</span>');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const list = ax.nodes.find((node: any) => node.role?.value === 'listbox');
    const option = ax.nodes.find((node: any) => node.role?.value === 'option');
    expect(list?.childIds).toContain(option?.nodeId);
    // Record the actual protocol behavior without printing page text.
    console.log('Chromium AX option contains original:', option?.name?.value?.includes('CHROME_AX_PRIVATE') === true);
    const debuggerMgr = { enableDomain: async (_tab: number, domain: string) => cdp.send(`${domain}.enable`),
      sendCommand: async (_tab: number, method: string, params: any) => cdp.send(method, params) };
    const result = await snapshot({ includeAX: true, filter: 'all' }, false, true, debuggerMgr) as any;
    expect(result.elements.find((el: any) => el.name === 'Public check')?.state?.checked).toBe('mixed');
    expect(JSON.stringify(result)).not.toMatch(/CHROME_AX_PRIVATE|CHROME_DESC_PRIVATE/);
  });

  it("rejects masked aria-owned options from a mocked AX compound", async () => {
    await setup('<div role="listbox" aria-label="Public list" aria-owns="owned" tabindex="0" style="width:100px;height:30px"></div><div id="owned" role="option" style="-webkit-text-security:disc">AX_OWNED_PRIVATE</div>');
    const cdp = await page.context().newCDPSession(page);
    const debuggerMgr = {
      enableDomain: async (_tab: number, domain: string) => cdp.send(`${domain}.enable`),
      sendCommand: async (_tab: number, method: string, params: any) => {
        const result = await cdp.send(method, params);
        if (method === 'Accessibility.getFullAXTree') {
          const list = result.nodes.find((node: any) => node.role?.value === 'listbox');
          const option = result.nodes.find((node: any) => node.role?.value === 'option');
          expect(list).toBeDefined(); expect(option).toBeDefined();
          list.childIds = [option.nodeId]; option.name = { type: 'computedString', value: 'AX_OWNED_PRIVATE' };
        }
        return result;
      },
    };
    const result = await snapshot({ includeAX: true, filter: 'all' }, false, true, debuggerMgr) as any;
    expect(result.elements.some((el: any) => el.name === 'Public list')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('AX_OWNED_PRIVATE');
  });

  it.each(['chain', 'nested', 'cycle', 'deep', 'unknown', 'public'])('checks AX compound through %s ownership', async (kind) => {
    const deep = kind === 'deep' ? Array.from({ length: 80 }, (_, i) => `<div id="link-${i}" aria-owns="${i === 79 ? 'owned-option' : `link-${i + 1}`}"></div>`).join('') : '';
    const target = kind === 'deep' ? 'link-0' : kind === 'unknown' ? 'missing-option' : 'owned-option';
    const list = `<div id="owned-list" role="listbox" aria-label="Owned list" aria-owns="${target}${kind === 'cycle' ? ' combo' : ''}" tabindex="0" style="width:100px;height:30px"></div>`;
    await setup(`<div id="combo" role="combobox" aria-label="Public combo" aria-expanded="true" ${kind !== 'nested' ? 'aria-owns="owned-list"' : ''} tabindex="0" style="width:150px;height:50px">${kind === 'nested' ? list : ''}</div>${kind !== 'nested' ? list : ''}${deep}<div id="owned-option" role="option" ${kind === 'public' ? '' : 'style="-webkit-text-security:disc"'}>${kind === 'public' ? 'AX_PUBLIC_OPTION' : 'AX_CHAIN_PRIVATE'}</div>`);
    const cdp = await page.context().newCDPSession(page);
    let injected = false;
    const debuggerMgr = {
      enableDomain: async (_tab: number, domain: string) => cdp.send(`${domain}.enable`),
      sendCommand: async (_tab: number, method: string, params: any) => {
        const result = await cdp.send(method, params);
        if (method === 'Accessibility.getFullAXTree') {
          const combo = result.nodes.find((n: any) => n.role?.value === 'combobox');
          const listbox = result.nodes.find((n: any) => n.role?.value === 'listbox');
          let option = result.nodes.find((n: any) => n.role?.value === 'option');
          if (!combo || !listbox) return result;
          if (!option) {
            option = { nodeId: 'mock-option', role: { value: 'option' } };
            result.nodes.push(option);
          }
          injected = true;
          combo.childIds = [listbox.nodeId]; listbox.childIds = [option.nodeId];
          combo.properties = [...(combo.properties ?? []), { name: 'disabled', value: { type: 'boolean', value: true } }];
          option.name = { type: 'computedString', value: kind === 'public' ? 'AX_PUBLIC_OPTION' : 'AX_CHAIN_PRIVATE' };
        }
        return result;
      },
    };
    const result = await snapshot({ includeAX: true, filter: 'all' }, false, true, debuggerMgr) as any;
    expect(injected).toBe(true);
    const combo = result.elements.find((el: any) => el.name === 'Public combo');
    expect(combo).toBeDefined();
    expect(combo.state?.expanded).toBe(true);
    expect(combo.state?.disabled).toBe(true);
    if (kind === 'public') expect(combo.compound?.options).toContain('AX_PUBLIC_OPTION');
    else expect(JSON.stringify(result)).not.toContain('AX_CHAIN_PRIVATE');
  });

  it('redacts an externally masked option name from real Chromium AX', async () => {
    await setup('<div role="listbox" aria-label="External list" aria-owns="real-option" tabindex="0" style="width:100px;height:30px"></div><div id="real-option" role="option" aria-labelledby="real-label">Public fallback</div><span id="real-label" style="-webkit-text-security:disc">REAL_EXTERNAL_SECRET</span>');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const list = ax.nodes.find((n: any) => n.role?.value === 'listbox');
    const option = ax.nodes.find((n: any) => n.role?.value === 'option');
    expect(list?.childIds).toContain(option?.nodeId);
    console.log('Chromium AX external label contains original:', option?.name?.value?.includes('REAL_EXTERNAL_SECRET') === true);
    const debuggerMgr = { enableDomain: async (_tab: number, domain: string) => cdp.send(`${domain}.enable`),
      sendCommand: async (_tab: number, method: string, params: any) => cdp.send(method, params) };
    const result = await snapshot({ includeAX: true, filter: 'all' }, false, true, debuggerMgr) as any;
    expect(result.elements.some((el: any) => el.name === 'External list')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('REAL_EXTERNAL_SECRET');
  });

  it('fails closed when the masking traversal exceeds its deadline', async () => {
    await setup('<div role="listbox" aria-label="Budget list" aria-owns="budget-link" tabindex="0" style="width:100px;height:30px"></div><div id="budget-link" aria-owns="budget-option"></div><div id="budget-option" role="option" aria-labelledby="budget-secret">Fallback</div><span id="budget-secret" style="-webkit-text-security:disc">BUDGET_SECRET</span>');
    await page.evaluate(() => {
      const originalStyle = window.getComputedStyle;
      const originalNow = Date.now;
      (window as any).__restoreBudgetTest = () => { window.getComputedStyle = originalStyle; Date.now = originalNow; };
      window.getComputedStyle = function (el: Element, pseudo?: string | null) {
        if (el.id === 'budget-link') { (window as any).__budgetReached = true; Date.now = () => originalNow() + 1_000_000; }
        return originalStyle.call(window, el, pseudo);
      };
    });
    try {
      const result = await snapshot({ includeAX: true, filter: 'all' }, false, true) as any;
      expect(await page.evaluate(() => (window as any).__budgetReached)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('BUDGET_SECRET');
      expect(result.elements).toHaveLength(0);
    } finally {
      await page.evaluate(() => (window as any).__restoreBudgetTest());
    }
  });

  it.each(['chain', 'nested', 'cycle', 'second', 'first', 'public', 'deep'])('protects externally labelled options in %s AX compounds', async (kind) => {
    const masked = kind !== 'public';
    const links = kind === 'deep' ? Array.from({ length: 80 }, (_, i) => `<div id="link-${i}" aria-owns="${i === 79 ? 'private-option' : `link-${i + 1}`}"></div>`).join('') : '';
    const owns = kind === 'deep' ? 'link-0' : kind === 'first' ? 'private-option public-option' : 'public-option private-option';
    const list = `<div id="external-list" role="listbox" aria-label="External list" aria-owns="${owns}${kind === 'cycle' ? ' external-combo' : ''}" tabindex="0" style="width:100px;height:30px"></div>`;
    await setup(`<div id="external-combo" role="combobox" aria-label="External combo" aria-expanded="true" ${kind === 'nested' ? '' : 'aria-owns="external-list"'} tabindex="0" style="width:150px;height:50px">${kind === 'nested' ? list : ''}</div>${kind === 'nested' ? '' : list}${links}<div id="public-option" role="option">PUBLIC_OPTION</div><div id="private-option" role="option" aria-labelledby="external-label">Public fallback</div><span id="external-label" ${masked ? 'style="-webkit-text-security:disc"' : ''}>${masked ? 'EXTERNAL_AX_SECRET' : 'PUBLIC_LABEL'}</span>`);
    const cdp = await page.context().newCDPSession(page);
    const debuggerMgr = {
      enableDomain: async (_tab: number, domain: string) => cdp.send(`${domain}.enable`),
      sendCommand: async (_tab: number, method: string, params: any) => {
        const result = await cdp.send(method, params);
        if (method === 'Accessibility.getFullAXTree') {
          const combo = result.nodes.find((n: any) => n.role?.value === 'combobox');
          const listbox = result.nodes.find((n: any) => n.role?.value === 'listbox');
          expect(combo).toBeDefined(); expect(listbox).toBeDefined();
          const publicOption = { nodeId: 'mock-public-option', role: { value: 'option' }, name: { type: 'computedString', value: 'PUBLIC_OPTION' } };
          const labelledOption = { nodeId: 'mock-labelled-option', role: { value: 'option' }, name: { type: 'computedString', value: masked ? 'EXTERNAL_AX_SECRET' : 'PUBLIC_LABEL' } };
          result.nodes.push(publicOption, labelledOption);
          combo.childIds = [listbox.nodeId];
          listbox.childIds = kind === 'first' ? [labelledOption.nodeId, publicOption.nodeId] : [publicOption.nodeId, labelledOption.nodeId];
          combo.properties = [...(combo.properties ?? []), { name: 'disabled', value: { type: 'boolean', value: true } }];
        }
        return result;
      },
    };
    const result = await snapshot({ includeAX: true, filter: 'all' }, false, true, debuggerMgr) as any;
    const combo = result.elements.find((el: any) => el.name === 'External combo');
    expect(combo).toBeDefined();
    expect(combo.state?.expanded).toBe(true);
    expect(combo.state?.disabled).toBe(true);
    if (masked) expect(JSON.stringify(result)).not.toContain('EXTERNAL_AX_SECRET');
    else expect(combo.compound?.options).toEqual(['PUBLIC_OPTION', 'PUBLIC_LABEL']);
  });

  it("retains a text-security none override but still excludes clipped text", async () => {
    const main = fragment("body--wrapper", row("K", '<td><span style="-webkit-text-security:none">PUBLIC_OVERRIDE</span><span>MASKED_FRAGMENT</span></td>') + row("L", '<td>OTHER</td>'));
    const clipped = fragment("body--wrapper", row("K", '<td><span style="-webkit-text-security:none">CLIPPED_OVERRIDE</span></td>'));
    await setup(`<div style="-webkit-text-security:disc">${main}<div class="clip-none">${clipped}</div></div>` + actions(), '.clip-none{width:1px;height:1px;overflow:hidden}');
    const found = await snapshot();
    expect(found[0].dupContext).toContain("PUBLIC_OVERRIDE");
    expect(found[0].dupContext).not.toContain("MASKED_FRAGMENT");
    expect(found[0].dupContext).not.toContain("CLIPPED_OVERRIDE");
  });

  it("does not expose text masked by -webkit-text-security", async () => {
    const main = fragment("body--wrapper", row("K", '<td><span class="masked">MASKED_SECRET</span></td>') + row("L", "<td>VISIBLE_L</td>"));
    await setup(main + actions(), ".masked{-webkit-text-security:disc}");
    const found = await snapshot();
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").not.toContain("MASKED_SECRET");
    expect(found[1].dupContext).toContain("VISIBLE_L");
  });

  it.each([{}, { selector: "#host" }])("omits text clipped by a shadow slot ancestor with scope %j", async (scope) => {
    const main = fragment("body--wrapper", row("K", "<td>SLOT_SECRET_K</td>") + row("L", "<td>SLOT_SECRET_L</td>"));
    const visible = fragment("fixed-right--wrapper", row("K", "<td>VISIBLE_K<button>详情</button></td>") + row("L", "<td>VISIBLE_L<button>详情</button></td>"));
    await setup(visible + main, ".body--wrapper{position:relative;left:180px}");
    const geometry = await page.evaluate(() => {
      const host = document.querySelector("#host")!;
      const shell = document.createElement("div");
      host.before(shell);
      shell.append(host);
      const shadow = shell.attachShadow({ mode: "open" });
      shadow.innerHTML = '<div style="width:140px;overflow:hidden"><slot></slot></div>';
      const clip = shadow.querySelector("div")!.getBoundingClientRect();
      const button = host.querySelector("button")!.getBoundingClientRect();
      const text = host.querySelector(".body--wrapper td")!.getBoundingClientRect();
      return { assigned: host.assignedSlot !== null, clipRight: clip.right, buttonRight: button.right, textLeft: text.left };
    });
    expect(geometry.assigned).toBe(true);
    expect(geometry.buttonRight).toBeLessThan(geometry.clipRight);
    expect(geometry.textLeft).toBeGreaterThan(geometry.clipRight);
    const found = await snapshot(scope);
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toContain("VISIBLE_K");
    expect(found[1].dupContext).toContain("VISIBLE_L");
    expect(found[0].dupContext ?? "").not.toContain("SLOT_SECRET_K");
    expect(found[1].dupContext ?? "").not.toContain("SLOT_SECRET_L");
  });

  it("fails closed if the visual parent chain cycles", async () => {
    const main = fragment("body--wrapper", row("K", "<td>CYCLE_SECRET_K</td>") + row("L", "<td>CYCLE_SECRET_L</td>"));
    await setup(main + actions());
    await page.evaluate(() => {
      const host = document.querySelector("#host")!;
      Object.defineProperty(host, "assignedSlot", { value: host });
    });
    const found = await snapshot({ selector: "#host" });
    expect(found).toHaveLength(2);
    expect(found.map((e: any) => e.dupContext)).toEqual(["[row-context-unavailable]", "[row-context-unavailable]"]);
  });

  it("omits row text clipped by an ancestor outside the target while buttons stay visible", async () => {
    const main = fragment("body--wrapper", row("K", "<td>OUTSIDE_CLIP_SECRET</td>") + row("L", "<td>OTHER_SECRET</td>"));
    const visible = fragment("fixed-right--wrapper", row("K", "<td>VISIBLE_K<button>详情</button></td>") + row("L", "<td>VISIBLE_L<button>详情</button></td>"));
    await setup(visible + main, ".outer-clip{width:120px;overflow:hidden} .body--wrapper{position:relative;left:160px}");
    const geometry = await page.evaluate(() => {
      const host = document.querySelector("#host")!;
      const clip = document.createElement("div");
      clip.className = "outer-clip";
      host.before(clip);
      clip.append(host);
      const clipRect = clip.getBoundingClientRect();
      const button = host.querySelector("button")!.getBoundingClientRect();
      const text = host.querySelector(".body--wrapper td")!.getBoundingClientRect();
      return { clipRight: clipRect.right, buttonRight: button.right, textLeft: text.left };
    });
    expect(geometry.buttonRight).toBeLessThan(geometry.clipRight);
    expect(geometry.textLeft).toBeGreaterThan(geometry.clipRight);
    const found = await snapshot({ selector: "#host" });
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toContain("VISIBLE_K");
    expect(found[1].dupContext).toContain("VISIBLE_L");
    expect(found[0].dupContext ?? "").not.toContain("OUTSIDE_CLIP_SECRET");
    expect(found[1].dupContext ?? "").not.toContain("OTHER_SECRET");
  });

  it("joins fixed fragments and excludes nested ordinary tables with matching rowid", async () => {
    const nested = '<table><tbody><tr rowid="K"><td>NESTED_SECRET</td></tr></tbody></table>';
    await setup(fragment("body--wrapper", row("K", `<td>ORDER_K${nested}</td>`) + row("L", "<td>ORDER_L</td>")) + fragment("fixed-left--wrapper", row("K", "<td>LEFT_K</td>") + row("L", "<td>LEFT_L</td>")) + actions());
    const found = await snapshot();
    console.log("fixed+nested", JSON.stringify(found.map((e: any) => e.dupContext)));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toContain("ORDER_K");
    expect(found[0].dupContext).toContain("LEFT_K");
    expect(found[0].dupContext).not.toContain("NESTED_SECRET");
    expect(found[1].dupContext).toContain("ORDER_L");
  });

  it("does not expose text beyond the real clipping edge at CSS zoom 0.5", async () => {
    const main = fragment("body--wrapper", row("K", "<td>VISIBLE</td><td>LEAK</td>") + row("L", "<td>OTHER</td>"));
    await setup(`<div class="clip">${main}</div>` + actions(), "#host{zoom:.5} .clip{width:120px;overflow:hidden} .clip table{width:240px;table-layout:fixed}");
    const geometry = await page.evaluate(() => {
      const clip = document.querySelector('.clip')!.getBoundingClientRect();
      const text = document.querySelector('.clip td:nth-child(2)')!.firstChild!;
      const range = document.createRange(); range.selectNodeContents(text);
      return { clipRight: clip.right, textLeft: range.getBoundingClientRect().left };
    });
    const found = await snapshot();
    console.log("zoom-out boundary", JSON.stringify(geometry), JSON.stringify(found.map((e: any) => e.dupContext)));
    expect(geometry.textLeft).toBeGreaterThan(geometry.clipRight);
    expect(found[0].dupContext).toContain("VISIBLE");
    expect(found[0].dupContext).not.toContain("LEAK");
  });

  it("keeps visible text inside a translated clipping container", async () => {
    const main = fragment("body--wrapper", row("K", "<td>VISIBLE</td><td>CLIPPED_SECRET</td>") + row("L", "<td>OTHER</td>"));
    await setup(`<div class="clip">${main}</div>` + actions(), ".clip{transform:translate(30px, 10px);width:120px;overflow:hidden} .clip table{width:400px;table-layout:fixed}");
    const found = await snapshot();
    expect(found[0].dupContext).toContain("VISIBLE");
    expect(found[0].dupContext).not.toContain("CLIPPED_SECRET");
  });

  it.each(["scale:2", "rotate:15deg", "perspective:300px"])("omits text when clipping geometry has unsupported %s", async (transform) => {
    const main = fragment("body--wrapper", row("K", "<td>VISIBLE</td><td>CLIPPED_SECRET</td>") + row("L", "<td>OTHER</td>"));
    await setup(`<div class="clip">${main}</div>` + actions(), `.clip{${transform};width:120px;overflow:hidden} .clip table{width:400px;table-layout:fixed}`);
    const found = await snapshot();
    expect(found[0].dupContext).toBe("[row-context-unavailable]");
    expect(found[0].dupContext).not.toContain("CLIPPED_SECRET");
  });

  it.each([1, 2, 0.5])("keeps visible text and rejects clipped and ellipsized text at CSS zoom %s", async (zoom) => {
    const main = fragment("body--wrapper", row("K", '<td><span>VISIBLE</span></td><td><span>CLIPPED_SECRET</span></td>') + row("L", "<td>OTHER</td>"));
    await setup(`<div class="clip">${main}</div><div class="ellipsis">${fragment("body--wrapper", row("K", '<td><div class="short">FIT</div><div class="cut">ELLIPSIS_SECRET_LONG_LONG_LONG</div></td>'))}</div>` + actions(),
      `#host{zoom:${zoom}} .clip{width:120px;overflow:hidden} .clip table{width:400px;table-layout:fixed} .short,.cut{white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .short{width:100px} .cut{width:30px}`);
    const geometry = await page.evaluate(() => {
      const el = document.querySelector(".clip")!;
      const cut = document.querySelector(".cut") as HTMLElement;
      return { clip: el.getBoundingClientRect().toJSON(), clientWidth: (el as HTMLElement).clientWidth, cutClient: cut.clientWidth, cutScroll: cut.scrollWidth };
    });
    const found = await snapshot();
    console.log("zoom", zoom, JSON.stringify(geometry), JSON.stringify(found.map((e: any) => e.dupContext)));
    expect(found).toHaveLength(2);
    expect(geometry.cutScroll).toBeGreaterThan(geometry.cutClient);
    expect(found[0].dupContext).toContain("VISIBLE");
    expect(found[0].dupContext).toContain("FIT");
    expect(found[0].dupContext).not.toContain("CLIPPED_SECRET");
    expect(found[0].dupContext).not.toContain("ELLIPSIS_SECRET");
  });

  it("does not expose text clipped away by clip-path on the cell", async () => {
    const main = fragment("body--wrapper", row("K", '<td>ORDER_K</td><td class="clipcell">CLIP_SECRET</td>') + row("L", "<td>ORDER_L</td>"));
    await setup(main + actions(), ".clipcell{clip-path:inset(0 0 0 100%)}");
    const found = await snapshot();
    console.log("clip-path cell", JSON.stringify(found.map((e: any) => e.dupContext)));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toContain("ORDER_K");
    expect(found[0].dupContext).not.toContain("CLIP_SECRET");
  });

  it("does not expose text when clip-path is applied on an ancestor of the fragment", async () => {
    const main = fragment("body--wrapper", row("K", "<td>ORDER_K</td>") + row("L", "<td>ORDER_L</td>"));
    await setup(`<div class="clipwrap">${main}</div>` + actions(), ".clipwrap{clip-path:inset(0 0 0 100%)}");
    const found = await snapshot();
    console.log("clip-path ancestor", JSON.stringify(found.map((e: any) => e.dupContext)));
    expect(found[0].dupContext).toBe("[row-context-unavailable]");
    expect(found[0].dupContext ?? "").not.toContain("ORDER_K");
  });

  it("does not expose text hidden by a CSS mask on the cell", async () => {
    const main = fragment("body--wrapper", row("K", '<td>ORDER_K</td><td class="maskcell">MASK_SECRET</td>') + row("L", "<td>ORDER_L</td>"));
    await setup(main + actions(), ".maskcell{-webkit-mask-image:linear-gradient(#000,transparent);mask-image:linear-gradient(#000,transparent)}");
    const found = await snapshot();
    console.log("mask cell", JSON.stringify(found.map((e: any) => e.dupContext)));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toContain("ORDER_K");
    expect(found[0].dupContext).not.toContain("MASK_SECRET");
  });

  it("does not expose text when a CSS mask is applied on an ancestor of the fragment", async () => {
    const main = fragment("body--wrapper", row("K", "<td>ORDER_K</td>") + row("L", "<td>ORDER_L</td>"));
    await setup(`<div class="maskwrap">${main}</div>` + actions(), ".maskwrap{-webkit-mask-image:linear-gradient(#000,transparent);mask-image:linear-gradient(#000,transparent)}");
    const found = await snapshot();
    console.log("mask ancestor", JSON.stringify(found.map((e: any) => e.dupContext)));
    expect(found[0].dupContext).toBe("[row-context-unavailable]");
    expect(found[0].dupContext ?? "").not.toContain("ORDER_K");
  });
});
