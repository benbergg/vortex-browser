# 多步动作序列底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把效果指纹从 click-only 扩到五种动作，并在其上建一个独立的 `vortex_sequence` 工具，让多步动作在一次调用内执行且每步自证。

**Architecture:** 分两阶段。阶段一补齐确定量：`fill`/`type` 的成功返回补回读值（`select`/`scroll` 已有），然后在 `@vortex-browser/shared` 新增两个归一化函数，解除 `fingerprint-apply.ts` 与 `server.ts` 两处 click 硬守卫。阶段二在 MCP 编排层新增 `vortex_sequence`，按 `fill_form` 的串行形态逐步发请求，但每步挂 postcondition 并返回逐步轨迹。extension 侧不引入新的 page-side 模块。

**Tech Stack:** TypeScript / pnpm workspace / vitest / MV3 扩展 + CDP / MCP SDK / vortex-bench

## Global Constraints

- **跑测试必须限并发**：`--maxWorkers=2 --minWorkers=1`。禁止在仓库根跑 `pnpm -r test`（会卡死机器）。
- **零开销契约**：不传 `fingerprint` / 不调 `vortex_sequence` 时，现有工具行为字节级不变。沿用 `packages/mcp/src/server.ts:785-786` 既有守卫写法。
- **诚实优先**：拿不到确定量时返回空或显式 `fingerprintSkipped`，**绝不臆造**。参见 `packages/mcp/src/lib/fingerprint-apply.ts:23`（`effect 缺失时返回空(观测信号未到位,绝不臆造)`）。
- **I15 字节预算**：`packages/mcp/tests/invariants/I15.tools-list-budget.test.ts` 是唯一真源，当前 cap 10300 B、公开工具 23 个。加能力调 cap，不压既有字符；调整必须在该文件内登记实测值与理由。
- **注入函数测试法**：测 page-side 注入 func 必须用 `new Function` 剥离模块闭包真执行（先例 `packages/extension/tests/dom-fill-refocus.test.ts:29-40`），禁止只 mock `executeScript` 或用正则匹配源码——那是假覆盖。
- **注释规范**：中文，方法体内单行 `//`、每条 ≤1 行 ≤60 字、同一方法体内 ≤3 条；只写「为什么」不写「做什么」。
- **提交规范**：Conventional Commits，中文描述，动词开头、结尾无句号，禁止任何署名。

---

## File Structure

| 文件 | 职责 | 本计划中的变化 |
|---|---|---|
| `packages/extension/src/handlers/dom.ts` | 各 DOM 动作的执行与回读 | `fill`/`type` 成功返回补确定量字段 |
| `packages/shared/src/effect-fingerprint.ts` | 指纹类型 + 归一化 + 比对（唯一真源） | 新增两个归一化函数 |
| `packages/mcp/src/lib/fingerprint-apply.ts` | record/verify 纯逻辑 | 按 action 派发，解除 click 守卫 |
| `packages/mcp/src/lib/sequence-run.ts` | **新建**：序列执行的纯逻辑（步骤状态机、轨迹汇总） | 新建 |
| `packages/mcp/src/server.ts` | MCP 编排 | 放宽 `fpActive`；新增 `vortex_sequence` 分支 |
| `packages/mcp/src/tools/schemas-public.ts` | 公开工具 schema | 新增 `vortex_sequence` |

`sequence-run.ts` 单独成文件而不是塞进 `server.ts`：`server.ts` 已超千行，且纯逻辑独立后才能脱离 MCP transport 单测——这正是 `fingerprint-apply.ts` 当初独立出来的理由（见该文件第 1 行注释）。

---

# 阶段一：指纹覆盖 1 → 5 种动作

## Task 1: `fill` 成功返回补回读值

**Files:**
- Modify: `packages/extension/src/handlers/dom.ts:1109`
- Test: `packages/extension/tests/dom-fill-value-readback.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `fill` 动作成功结果新增字段 `value: string`（`el.value` 的填后实读值）

**背景**：`fill` 当前返回 `{ success: true, focused }`。`el.value` 其实已在同一作用域被读过（`dom.ts:1090` 的 NO_EFFECT 判据），但没进成功返回——调用方拿到 `success:true` 却不知道实际填进去的是什么。

- [x] **Step 1: 写失败测试**

新建 `packages/extension/tests/dom-fill-value-readback.test.ts`，**完整内容如下**（setup 块严格对齐先例 `packages/extension/tests/dom-fill-refocus.test.ts:11-87`——该文件的 `beforeEach` 除了 window/document 还必须塞入若干全局与 page-side 桩，缺一个 handler 就跑不起来）：

```ts
/**
 * Author: qingwa
 * Description: FILL 回读值契约。fill 返回 success:true 却不说明填进去的是什么，
 *   受控组件把值改回去时调用方完全看不见（静默假成功族）。锁住成功返回必须带
 *   el.value 的实读值，而非入参回声。
 *   复刻注入语义:mock pageQuery 用 new Function 剥离模块闭包真执行 inline func。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/wait-actionable-auto-force.js", () => ({
  waitActionableAutoForce: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/native.js", () => ({
  pageQuery: async (
    _tid: number,
    _frameId: number | undefined,
    fn: (...a: unknown[]) => unknown,
    args: unknown[],
  ) => {
    const stripped = new Function(`return (${String(fn)})`)() as (...a: unknown[]) => unknown;
    return await Promise.resolve(stripped(...args));
  },
  mapPageError: (res: { error?: string }) => {
    throw new Error(res.error ?? "page error");
  },
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.FILL, args, requestId: "r-fill-value" } as NmRequest;
}

describe("FILL 回读值", () => {
  let router: ActionRouter;
  let dom: JSDOM;

  function setup(bodyHtml: string): void {
    dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, { pretendToBeVisual: true });
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "InputEvent"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }
    for (const el of Array.from(dom.window.document.querySelectorAll("input"))) {
      el.getBoundingClientRect = () =>
        ({ x: 10, y: 10, width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }) as DOMRect;
    }
    win.__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
    };
    win.__vortexFillReject = { checkRejectPattern: () => ({ rejected: false }) };
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    router = new ActionRouter();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    };
    registerDomHandlers(router, debuggerMgr as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setup(`<input id="inp" />`);
  });

  it("成功返回带 value，等于填后实读值", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#inp", value: "hello" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, value: "hello" });
  });

  it("页面把值改回去时，返回的是回滚后的实读值而非入参回声", async () => {
    // 受控组件的最小复刻：input 监听器同步把值改掉。
    // 若实现回声入参，这里会拿到 "typed"；只有真读 el.value 才是 "REVERTED"。
    setup(`<input id="ctl" />`);
    const el = dom.window.document.getElementById("ctl") as HTMLInputElement;
    el.addEventListener("input", () => { el.value = "REVERTED"; });

    const resp = await router.dispatch(mkReq({ selector: "#ctl", value: "typed" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { value: string }).value).toBe("REVERTED");
  });
});
```

> **为什么第二个用例这么设计**：初稿用的是 `type=number` 填 `"007"` 断言规范化成 `"7"`——**那是错的**，
> `"007"` 本身就是合法浮点数字符串，不会被规范化，该用例证明不了任何事。改成 `input` 监听器同步回滚：
> 它是受控组件的最小复刻，且能**唯一地**区分「真回读」与「回声入参」——这正是本 Task 要锁的契约。

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension exec vitest run tests/dom-fill-value-readback.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，两个用例都因返回对象里没有 `value` 而失败（形如 `expected { success: true, focused: true } to match object { success: true, value: 'hello' }`）

- [x] **Step 3: 实现**

`packages/extension/src/handlers/dom.ts:1109`，把

```ts
            return { result: { success: true, focused } };
```

改为

```ts
            // 回读值随成功返回:success 不说明填进去的是什么,受控组件常回滚
            return { result: { success: true, focused, value: el.value } };
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/extension exec vitest run tests/dom-fill-value-readback.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（2 个用例）

- [x] **Step 5: 跑扩展全量单测确认零回归**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿。若有测试断言 fill 结果对象的**完整形状**（`toEqual` 而非 `toMatchObject`），把它改成 `toMatchObject` 并在该测试里补一句注释说明新增了 `value` 字段。

- [x] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/dom.ts packages/extension/tests/dom-fill-value-readback.test.ts
git commit -m "feat: fill 成功返回带回读值

success:true 不说明填进去的是什么。值本就在 NO_EFFECT 判据处读过，
只是没进返回；受控组件回滚、type=number 规范化都靠它才看得见。"
```

---

## Task 2: `type` 成功返回补回读值，并给回读值加长度上限

**Files:**
- Modify: `packages/extension/src/handlers/dom.ts:793-816`（type 回读）
- Modify: `packages/extension/src/handlers/dom.ts:1109`（给 Task 1 已加的 fill 回读值补上限）
- Test: `packages/extension/tests/dom-type-value-readback.test.ts`（新建）
- Test: `packages/extension/tests/dom-fill-value-readback.test.ts`（Task 1 建的，追加一个截断用例）

**Interfaces:**
- Consumes: Task 1 的 `fill` 回读值字段
- Produces: `type` 动作成功结果新增字段 `value: string`；`fill` 与 `type` 的回读值统一封顶 **500 字符**，超出截断并追加 `…`

**背景（两件事）**：

1. `type` 走 CDP 路径时返回 `{ success: true, typed: text.length, path: "cdp-insertText" }`——`typed` 是**入参字符数**，不是回读结果。而 `:800-802` 的 verify 探针已经读到了 `textContent`（变量 `now`），成功时却丢弃返回 `{}`。
2. **回读值必须封顶**（Task 1 评审提出）。`fill` 一个大 textarea 会把整段内容回传给模型；`type` 读的是 contentEditable 的 `textContent`，富文本编辑器可能是**整篇文档**。仓内既有口径：`dom.ts` 所有 `innerText` 回读都截断（200/500），`schema-readback.ts:191` 有显式 `SCHEMA_MAX_VALUE_CHARS = 500`。取 **500** 与后者对齐。
   `select` 现有的 `value: el.value` 不在本次范围（值天然短）。

> **截断不破坏指纹比对**：record 与 verify 两侧走同一段截断逻辑，比的是同一口径。
> 代价是超长值只比前 500 字符、末尾差异会漏判——这个洞 `causedDomMutation` 之类的信号本来也覆盖不到，不是新增风险。
>
> **注入约束**：截断发生在 `executeScript` 注入的内联函数里，**模块作用域已丢失**，不能引用模块级常量。
> 按 `dom.ts` 既有写法把 `500` 作为字面量内联（`:176`、`:212` 等处同样是内联字面量），并在旁边写明为什么是 500。

- [x] **Step 1: 写失败测试**

新建 `packages/extension/tests/dom-type-value-readback.test.ts`。**走 `router.dispatch` 真跑生产代码**，不复刻探针函数体（复刻等于测自己的副本，是假覆盖）。

两个让 jsdom 能跑通 CDP 分支的关键（都已实测确认必需）：

- **`jsdom` 的 `el.isContentEditable` 恒为 `undefined`**，而 `dom.ts:772` 靠它决定走 CDP 路径。必须
  `Object.defineProperty(el, "isContentEditable", { value: true })` 才进得去这条分支。
- **mock 的 `sendCommand` 必须真的改 DOM**，否则 `Input.insertText` 什么也没做，verify 探针读到
  `now === before` 会直接报 NO_EFFECT。让它模拟真实插入行为。

```ts
/**
 * Author: qingwa
 * Description: TYPE 回读值契约与长度上限。typed 返回的是入参字符数不是写入结果，
 *   编辑器规范化或部分拒收时两者分叉；且 contentEditable 的 textContent 可能是
 *   整篇文档，必须封顶。走 router.dispatch 真跑生产代码，不复刻探针函数体。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/wait-actionable-auto-force.js", () => ({
  waitActionableAutoForce: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/native.js", () => ({
  pageQuery: async (
    _tid: number,
    _frameId: number | undefined,
    fn: (...a: unknown[]) => unknown,
    args: unknown[],
  ) => {
    const stripped = new Function(`return (${String(fn)})`)() as (...a: unknown[]) => unknown;
    return await Promise.resolve(stripped(...args));
  },
  mapPageError: (res: { error?: string }) => {
    throw new Error(res.error ?? "page error");
  },
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.TYPE, args, requestId: "r-type-value" } as NmRequest;
}

describe("TYPE 回读值", () => {
  let router: ActionRouter;
  let dom: JSDOM;
  let editor: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM(`<!DOCTYPE html><html><body><div id="ed"></div></body></html>`, {
      pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "InputEvent"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }
    editor = dom.window.document.getElementById("ed") as HTMLElement;
    // jsdom 不实现 isContentEditable（实测恒 undefined），不定义就走不到 CDP 分支
    Object.defineProperty(editor, "isContentEditable", { value: true, configurable: true });
    editor.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 200, height: 40, top: 10, bottom: 50, left: 10, right: 210 }) as DOMRect;

    win.__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
    };
    win.__vortexFillReject = { checkRejectPattern: () => ({ rejected: false }) };
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });

    router = new ActionRouter();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      // 模拟真实 insertText：不动 DOM 的话 verify 探针会读到未变化并报 NO_EFFECT
      sendCommand: vi.fn(async (_tid: number, method: string, params?: { text?: string }) => {
        if (method === "Input.insertText" && params?.text != null) {
          editor.textContent = (editor.textContent ?? "") + params.text;
        }
      }),
    };
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("成功返回带实读 value，而非入参字符数", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: "hello" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, typed: 5, value: "hello" });
  });

  it("编辑器改写内容时，返回的是实读值而非入参回声", async () => {
    // 编辑器把插入内容改掉（如自动补全/格式化）：只有真回读才拿得到改写后的值
    editor.textContent = "";
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: "raw" }));
    expect(resp.error).toBeUndefined();
    // 实读值来自 DOM，等于 mock 插入的结果
    expect((resp.result as { value: string }).value).toBe(editor.textContent);
  });

  it("超长内容截断到 500 字符并加省略号", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: "字".repeat(1200) }));
    const v = (resp.result as { value: string }).value;
    expect(v.length).toBe(501);              // 500 + "…"
    expect(v.endsWith("…")).toBe(true);
    expect(editor.textContent!.length).toBe(1200);  // DOM 里仍是完整内容，只有回传被截断
  });

  it("恰好 500 字符不截断、不加省略号", async () => {
    const exact = "x".repeat(500);
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: exact }));
    expect((resp.result as { value: string }).value).toBe(exact);
  });
});
```

同时在 Task 1 建的 `packages/extension/tests/dom-fill-value-readback.test.ts` 末尾（`describe` 内）追加：

```ts
  it("超长填入值回传时截断到 500 字符", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#inp", value: "a".repeat(900) }));
    const v = (resp.result as { value: string }).value;
    expect(v.length).toBe(501);
    expect(v.endsWith("…")).toBe(true);
  });
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension exec vitest run tests/dom-type-value-readback.test.ts tests/dom-fill-value-readback.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL。type 的四个用例都因返回对象没有 `value` 而失败；fill 的截断用例因当前不截断而失败（`expected 900 to be 501`）。

> 如果 type 的用例报的是 `NO_EFFECT` 而不是缺 `value`，说明 `sendCommand` 的模拟插入没生效——
> 先修 mock，**不要**改断言。

- [x] **Step 3: 实现**

`packages/extension/src/handlers/dom.ts`，两处改动。

其一，把 `:809` 的

```ts
              return {};
```

改为

```ts
              // 500 与 schema 回读同口径:contentEditable 可能是整篇文档,不能原样回传
              return { value: now.length > 500 ? now.slice(0, 500) + "…" : now };
```

其二，把 `:816` 的

```ts
        const cdpTypeResult = { success: true, typed: text.length, path: "cdp-insertText" };
```

改为

```ts
        // typed 是入参字符数,不等于实写入;编辑器规范化时以 verify 实读为准
        const cdpTypeResult = {
          success: true,
          typed: text.length,
          path: "cdp-insertText",
          ...(typeof verifiedValue === "string" ? { value: verifiedValue } : {}),
        };
```

并在 `:793` 的 `if (text !== "") {` 之前声明变量、在探针调用后取值：

```ts
        let verifiedValue: string | undefined;
```

以及把 `if (verify?.error) mapPageError(verify, selector);` 之后补一行：

```ts
        if (typeof verify?.value === "string") verifiedValue = verify.value;
```

同时把该 `nativePageQuery` 的泛型参数补上 `value?: string` 字段。

- [x] **Step 4: 给 fill 的回读值补同样的上限**

`packages/extension/src/handlers/dom.ts:1109`（Task 1 加的那行），把

```ts
            return { result: { success: true, focused, value: el.value } };
```

改为

```ts
            // 与 type 同口径封顶 500:大 textarea 会把整段内容回传给模型
            return {
              result: {
                success: true, focused,
                value: el.value.length > 500 ? el.value.slice(0, 500) + "…" : el.value,
              },
            };
```

- [x] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/extension exec vitest run tests/dom-type-value-readback.test.ts tests/dom-fill-value-readback.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（type 4 个 + fill 3 个 = 7 个用例）

- [x] **Step 6: 跑扩展全量单测**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿

- [x] **Step 7: 提交**

```bash
git add packages/extension/src/handlers/dom.ts \
        packages/extension/tests/dom-type-value-readback.test.ts \
        packages/extension/tests/dom-fill-value-readback.test.ts
git commit -m "feat: type 补回读值，fill/type 回读值统一封顶 500 字符

typed 返回的是入参字符数不是写入结果，编辑器规范化时两者分叉；
verify 探针本就读到了 textContent，成功路径却把它丢了。

封顶与 schema 回读同口径：contentEditable 可能是整篇文档，大 textarea
同理，原样回传会把整段内容塞给模型。DOM 里仍是完整内容，只截断回传。"
```

---

## Task 3: shared 新增两个归一化函数

**Files:**
- Modify: `packages/shared/src/effect-fingerprint.ts`
- Test: `packages/shared/tests/effect-fingerprint.test.ts`

**Interfaces:**
- Consumes: 已有 `EffectFingerprint`（`effect-fingerprint.ts:15-31`）、`compareFingerprint`
- Produces:
  - `normalizeValueFingerprint(action: "fill" | "type" | "select", targetIdentity: string, valueAfter: string): EffectFingerprint`
  - `normalizeScrollFingerprint(targetIdentity: string, scrollAfter: { top: number; left: number }): EffectFingerprint`

- [x] **Step 1: 写失败测试**

在 `packages/shared/tests/effect-fingerprint.test.ts` 末尾追加：

```ts
describe("normalizeValueFingerprint", () => {
  it("确定量精确保留，不折成布尔", () => {
    const fp = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    expect(fp.action).toBe("fill");
    expect(fp.targetIdentity).toBe("textbox::邮箱::0");
    expect(fp.valueAfter).toBe("a@b.com");
    // 值类动作没有副作用类别签名，必须不带，否则 compare 会拿 undefined 去比
    expect(fp.causedDomMutation).toBeUndefined();
    expect(fp.causedNetwork).toBeUndefined();
  });

  it("urlChanged 恒 false：填值不导航", () => {
    expect(normalizeValueFingerprint("select", "combobox::城市::0", "北京").urlChanged).toBe(false);
  });

  it("值不同 → drift 类别 value", () => {
    const a = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    const b = normalizeValueFingerprint("fill", "textbox::邮箱::0", "x@y.com");
    expect(compareFingerprint(a, b)?.classes).toEqual(["value"]);
  });

  it("值相同 → matched", () => {
    const a = normalizeValueFingerprint("type", "textbox::正文::0", "hello");
    const b = normalizeValueFingerprint("type", "textbox::正文::0", "hello");
    expect(compareFingerprint(a, b)).toBeNull();
  });
});

describe("normalizeScrollFingerprint", () => {
  it("位置差在 ±5px 容差内视为 matched", () => {
    const a = normalizeScrollFingerprint("main::列表::0", { top: 1200, left: 0 });
    const b = normalizeScrollFingerprint("main::列表::0", { top: 1204, left: 0 });
    expect(compareFingerprint(a, b)).toBeNull();
  });

  it("超出容差 → drift 类别 scroll", () => {
    const a = normalizeScrollFingerprint("main::列表::0", { top: 1200, left: 0 });
    const b = normalizeScrollFingerprint("main::列表::0", { top: 1400, left: 0 });
    expect(compareFingerprint(a, b)?.classes).toEqual(["scroll"]);
  });
});
```

并把该文件第 2 行的 import 改为：

```ts
import {
  normalizeClickFingerprint, normalizeValueFingerprint, normalizeScrollFingerprint,
  compareFingerprint,
} from "../src/effect-fingerprint.js";
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/shared exec vitest run tests/effect-fingerprint.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，`normalizeValueFingerprint is not a function`

- [x] **Step 3: 实现**

在 `packages/shared/src/effect-fingerprint.ts` 的 `normalizeClickFingerprint`（`:47` 结尾）之后插入：

```ts
/** fill/type/select 有确定量可回读 → 只比值,不用副作用类别(那是 click 才需要的替代品)。 */
export function normalizeValueFingerprint(
  action: "fill" | "type" | "select",
  targetIdentity: string,
  valueAfter: string,
): EffectFingerprint {
  return { action, targetIdentity, urlChanged: false, valueAfter };
}

/** scroll 的确定量是位置,比对走 compareFingerprint 里已有的 ±SCROLL_TOL 容差。 */
export function normalizeScrollFingerprint(
  targetIdentity: string,
  scrollAfter: { top: number; left: number },
): EffectFingerprint {
  return { action: "scroll", targetIdentity, urlChanged: false, scrollAfter };
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/shared exec vitest run tests/effect-fingerprint.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（新增 6 个用例，原有用例不变）

- [x] **Step 5: 提交**

```bash
git add packages/shared/src/effect-fingerprint.ts packages/shared/tests/effect-fingerprint.test.ts
git commit -m "feat: 值类与滚动类动作的效果指纹归一化

click 靠副作用类别签名判生效，是因为它没有确定量可读；
fill/type/select/scroll 有确定量，直接比值比位置更准。"
```

---

## Task 4: `applyFingerprint` 按 action 派发

**Files:**
- Modify: `packages/mcp/src/lib/fingerprint-apply.ts:19-45`
- Modify: `packages/mcp/tests/verifiable-replay.test.ts`（既有测试，10 处调用点要随签名迁移，其中一处要删）
- Test: `packages/mcp/tests/fingerprint-apply-actions.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `normalizeValueFingerprint` / `normalizeScrollFingerprint`
- Produces: `applyFingerprint(opt, action, targetIdentity, signals)`，其中第四参改为联合类型
  ```ts
  export type ActionSignals =
    | { kind: "click"; effect: ClickEffectLike }
    | { kind: "value"; value: string }
    | { kind: "scroll"; scrollAfter: { top: number; left: number } };
  ```

**注意**：这是**破坏性改签名**。`applyFingerprint` 只有一个调用方（`packages/mcp/src/server.ts:938`），Task 5 会同步改。

- [x] **Step 1: 写失败测试**

新建 `packages/mcp/tests/fingerprint-apply-actions.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { applyFingerprint, type ActionSignals } from "../src/lib/fingerprint-apply.js";
import { normalizeValueFingerprint } from "@vortex-browser/shared";

const valueSignal = (value: string): ActionSignals => ({ kind: "value", value });

describe("applyFingerprint 按 action 派发", () => {
  it("record fill：返回值类指纹", () => {
    const out = applyFingerprint({ mode: "record" }, "fill", "textbox::邮箱::0", valueSignal("a@b.com"));
    expect(out.fingerprint?.action).toBe("fill");
    expect(out.fingerprint?.valueAfter).toBe("a@b.com");
  });

  it("verify fill 值一致 → drift 为 null", () => {
    const expected = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    const out = applyFingerprint(
      { mode: "verify", expect: expected }, "fill", "textbox::邮箱::0", valueSignal("a@b.com"),
    );
    expect(out.drift).toBeNull();
  });

  it("verify fill 值被回滚 → drift 类别 value", () => {
    const expected = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    const out = applyFingerprint(
      { mode: "verify", expect: expected }, "fill", "textbox::邮箱::0", valueSignal(""),
    );
    expect(out.drift?.classes).toEqual(["value"]);
  });

  it("record scroll：返回位置指纹", () => {
    const out = applyFingerprint(
      { mode: "record" }, "scroll", "main::列表::0",
      { kind: "scroll", scrollAfter: { top: 1200, left: 0 } },
    );
    expect(out.fingerprint?.scrollAfter).toEqual({ top: 1200, left: 0 });
  });

  it("信号缺失 → 返回空，绝不臆造", () => {
    expect(applyFingerprint({ mode: "record" }, "fill", "textbox::邮箱::0", undefined)).toEqual({});
  });

  it("targetIdentity 为 null → 显式说明原因而非静默空", () => {
    const out = applyFingerprint({ mode: "record" }, "fill", null, valueSignal("x"));
    expect(out.fingerprintSkipped).toContain("@ref");
  });

  it("hover/drag 等无确定量动作 → 返回空", () => {
    expect(applyFingerprint({ mode: "record" }, "hover", "button::赞::0", undefined)).toEqual({});
  });

  // 上面两条都传了非 null 的 targetIdentity，两种判断顺序下都会通过，锁不住顺序。
  // 只有两者同时缺失时，返回 {} 还是 fingerprintSkipped 才能区分实现的先后。
  it("无信号且无身份 → 返回空而非 skipped：无信号先判", () => {
    expect(applyFingerprint({ mode: "record" }, "hover", null, undefined)).toEqual({});
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/fingerprint-apply-actions.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，类型/断言错误（`ActionSignals` 尚不存在）

- [x] **Step 3: 实现**

`packages/mcp/src/lib/fingerprint-apply.ts`：import 补两个新函数，新增 `ActionSignals` 类型导出，并把 `applyFingerprint` 整体替换为：

```ts
export type ActionSignals =
  | { kind: "click"; effect: ClickEffectLike }
  | { kind: "value"; value: string }
  | { kind: "scroll"; scrollAfter: { top: number; left: number } };

/** 按 action 取对应确定量归一化。信号缺失=观测未到位,返回空绝不臆造。 */
export function applyFingerprint(
  opt: FingerprintOpt,
  action: string,
  targetIdentity: string | null,
  signals: ActionSignals | undefined,
): FingerprintOut {
  if (!signals) return {};
  if (targetIdentity == null) {
    return {
      fingerprintSkipped:
        "fingerprint requires an @ref from vortex_observe; a CSS selector has no stable identity to record/verify",
    };
  }
  let fp: EffectFingerprint;
  if (signals.kind === "click") {
    fp = normalizeClickFingerprint(targetIdentity, signals.effect);
  } else if (signals.kind === "value") {
    fp = normalizeValueFingerprint(action as "fill" | "type" | "select", targetIdentity, signals.value);
  } else {
    fp = normalizeScrollFingerprint(targetIdentity, signals.scrollAfter);
  }
  if (opt.mode === "record") return { fingerprint: fp };
  return { fingerprint: fp, drift: compareFingerprint(opt.expect, fp) };
}
```

**注意执行顺序**：`if (!signals) return {}` 必须在 `targetIdentity` 检查**之前**——无信号是「观测未到位」，与「用了 CSS selector」是两回事，顺序反了会对 hover 这类无信号动作报出误导性的 `fingerprintSkipped`。锁这一点的是**用例 8**（用例 5、7 都传了非 null 身份，两种顺序下都通过）。

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/fingerprint-apply-actions.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（8 个用例）

- [x] **Step 5: 迁移既有 `verifiable-replay.test.ts`**

这是唯一受签名变更影响的既有测试文件（`ping-fingerprint.test.ts` 测的是 MCP ping 的 schemaHash，与本函数无关，不要动它）。它有 10 处 `applyFingerprint` 调用，按下面两类处理：

**其一，机械迁移**：`:13`、`:28`、`:35`、`:43`、`:64`、`:69`、`:87`、`:94` 这 8 处，把第四参 `effect`（或内联的 effect 对象字面量）包一层：

```ts
// 原:  applyFingerprint({ mode: "record" }, "click", null, effect)
// 改为:applyFingerprint({ mode: "record" }, "click", null, { kind: "click", effect })
```

`:64` 那处第四参本来就是 `undefined`，**保持 `undefined` 不变**（它测的正是「信号缺失返回空」）。

**其二，删掉一条**：`:53-61` 的 `it("非 click action 返回空(Phase 1 仅 click 有 effect)")` **整条删除**。它断言的正是本 Task 要解除的 Phase-1 限制——新实现按 `signals.kind` 派发而非按 action，传 `{ kind: "click", effect }` 就会正常产出 click 指纹。

**这条不许靠削弱断言来变绿**（比如把 `toEqual({})` 改成 `toBeDefined()`）：行为变了就删掉过时的用例，新行为由 `fingerprint-apply-actions.test.ts` 覆盖。删除后在文件顶部注释补一句说明为什么少了这条。

- [x] **Step 6: 跑 mcp 全量单测**

```bash
pnpm --filter @vortex-browser/mcp test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿。vitest 走 esbuild 只剥类型不做类型检查，所以 `server.ts:933` 那个还没迁移的调用点**不会**让测试变红。

**本 Task 结束时仓库处于 `tsc` 不可编译状态，这是预期的**：`server.ts:933` 仍按旧签名传 `actResult.effect`，`pnpm -C packages/mcp build` 会报类型错，由 Task 5 修复。**不要为了让 build 过而顺手改 `server.ts`**——它属于 Task 5 的 Files。也不要在本 Task 跑 build。

- [x] **Step 7: 提交**

```bash
git add packages/mcp/src/lib/fingerprint-apply.ts packages/mcp/tests/fingerprint-apply-actions.test.ts packages/mcp/tests/verifiable-replay.test.ts
git commit -m "feat: 效果指纹按动作派发，解除 click 硬守卫

第四参从 ClickEffectLike 改为 ActionSignals 联合类型。无信号先于
无身份返回空：两者原因不同，顺序反了会对 hover 报误导性 skipped。"
```

---

## Task 5: `server.ts` 放宽守卫并接入确定量

**Files:**
- Modify: `packages/mcp/src/server.ts:785-787`（守卫）、`:920-933`（信号提取与调用点）
- Modify: `packages/mcp/src/lib/fingerprint-apply.ts`（末尾追加 `extractSignals`）
- Test: `packages/mcp/tests/act-fingerprint-actions.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `applyFingerprint` / `ActionSignals`
- Produces: 纯函数 `extractSignals(action: string, result: Record<string, unknown>): ActionSignals | undefined`，导出自 `packages/mcp/src/lib/fingerprint-apply.ts`

**为什么抽纯函数**：信号提取要读 act 结果的具体字段（`effect` / `value` / `scrollTop`），这段逻辑埋在 `server.ts` 里就只能靠端到端测。抽出来才能用真实返回形状喂断言——这是仓内既定处方。

- [x] **Step 1: 写失败测试**

新建 `packages/mcp/tests/act-fingerprint-actions.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { extractSignals } from "../src/lib/fingerprint-apply.js";

describe("extractSignals：从 act 真实返回形状取确定量", () => {
  it("click：取 effect（dom.ts:588 的形状）", () => {
    const r = {
      success: true,
      effect: {
        domMutations: 3, networkRequests: 0, urlChanged: false,
        focusChanged: true, ariaChanged: false, userFeedback: "mutation",
      },
    };
    expect(extractSignals("click", r)).toEqual({ kind: "click", effect: r.effect });
  });

  it("click 未开 observeEffect → undefined", () => {
    expect(extractSignals("click", { success: true })).toBeUndefined();
  });

  it("fill：取 value（dom.ts:1109 的形状）", () => {
    expect(extractSignals("fill", { success: true, focused: true, value: "a@b.com" }))
      .toEqual({ kind: "value", value: "a@b.com" });
  });

  it("type：取 value（dom.ts:816 的形状）", () => {
    expect(extractSignals("type", { success: true, typed: 5, path: "cdp-insertText", value: "hello" }))
      .toEqual({ kind: "value", value: "hello" });
  });

  it("select 多选：value 是数组，序列化后比对", () => {
    expect(extractSignals("select", { success: true, value: ["a", "b"] }))
      .toEqual({ kind: "value", value: '["a","b"]' });
  });

  it("scroll：取位置（dom.ts:1447 的形状）", () => {
    expect(extractSignals("scroll", { success: true, moved: true, scrollTop: 1200, scrollLeft: 0 }))
      .toEqual({ kind: "scroll", scrollAfter: { top: 1200, left: 0 } });
  });

  it("hover：无确定量 → undefined", () => {
    expect(extractSignals("hover", { success: true })).toBeUndefined();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/act-fingerprint-actions.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，`extractSignals is not a function`

- [x] **Step 3: 实现纯函数**

在 `packages/mcp/src/lib/fingerprint-apply.ts` 末尾追加：

```ts
/** 从 act 结果取确定量。字段形状对齐 extension/src/handlers/dom.ts 各动作返回。 */
export function extractSignals(
  action: string,
  result: Record<string, unknown>,
): ActionSignals | undefined {
  if (action === "click") {
    const effect = result.effect as ClickEffectLike | undefined;
    return effect ? { kind: "click", effect } : undefined;
  }
  if (action === "fill" || action === "type" || action === "select") {
    const v = result.value;
    if (v === undefined) return undefined;
    // 多选 select 回读是数组,序列化后才能进 valueAfter 的字符串比对
    return { kind: "value", value: typeof v === "string" ? v : JSON.stringify(v) };
  }
  if (action === "scroll") {
    const top = result.scrollTop, left = result.scrollLeft;
    if (typeof top !== "number" || typeof left !== "number") return undefined;
    return { kind: "scroll", scrollAfter: { top, left } };
  }
  return undefined;
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/act-fingerprint-actions.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（7 个用例）

- [x] **Step 5: 接进 server.ts**

其一，`packages/mcp/src/server.ts:786`，把

```ts
  const fpActive = !!fpOpt && params.action === "click";
```

改为

```ts
  const FP_ACTIONS = new Set(["click", "fill", "type", "select", "scroll"]);
  const fpActive = !!fpOpt && FP_ACTIONS.has(String(params.action));
```

其二，同文件 `:787-792` 的 `observeEffect` 补齐块加上 action 条件——**只有 click 需要 effect 观测**，其余动作强开 observeEffect 是白费开销：

```ts
  if (fpActive && params.action === "click") {
```

其三，`:933`（**行号已核对为当前值**）把

```ts
      const fpOut = applyFingerprint(fpOpt, "click", identity, actResult.effect);
```

改为

```ts
      const fpOut = applyFingerprint(
        fpOpt, String(params.action), identity, extractSignals(String(params.action), actResult),
      );
```

并把 `:921-923` 的 `actResult` 类型标注里的 `effect?: import("@vortex-browser/shared").ClickEffectLike` 去掉——现由 `extractSignals` 内部处理，标注简化为：

```ts
      const actResult = resp.result as Record<string, unknown>;
```

`:22` 的 import 补 `extractSignals`。

- [x] **Step 5.5: 确认 `tsc` 恢复可编译**

Task 4 结束时 `server.ts` 还按旧签名调用，仓库处于 `tsc` 不可编译状态；本 Task 的职责之一就是解掉它。

```bash
pnpm -C packages/mcp build
```

Expected: 无输出即成功。**若仍报类型错，说明上面三处没改全，停下来汇报报错原文**，不要靠 `as any` 之类的强转压掉。

- [x] **Step 6: 跑 MCP 全量单测**

```bash
pnpm --filter @vortex-browser/mcp test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿

- [x] **Step 7: 提交**

```bash
git add packages/mcp/src/server.ts packages/mcp/src/lib/fingerprint-apply.ts packages/mcp/tests/act-fingerprint-actions.test.ts
git commit -m "feat: act 指纹守卫放宽到五种动作

信号提取抽成纯函数 extractSignals，字段形状对齐 dom.ts 各动作返回，
才能用真实形状喂断言而不是靠端到端撞运气。observeEffect 仍只为
click 强开，其余动作有确定量可读，不需要副作用观测。"
```

---

## Task 6: bench 覆盖四种动作的指纹

**Files:**
- Create: `packages/vortex-bench/cases/fingerprint-actions.case.ts`
- Create: `packages/vortex-bench/playground/public/synth/fingerprint-actions.html`

**Interfaces:**
- Consumes: Task 1-5 的全部产出
- Produces: bench case `fingerprint-actions`

**前置依赖**：本 Task 的 scroll 断言依赖 `docs/superpowers/plans/2026-08-13-scroll-respect-ref.md` 的 Task 1-4 已合入（commit `e68931d`/`9836b89`/`b0d6d25`/`63195d0`）。在那之前 scroll 传 `target=@ref` 实际滚的是 window，指纹会把 window 的位置挂在具名元素身上。

**已有半成品**：2026-08-13 首次执行本 Task 时，两个文件已写在 worktree `.worktrees/task6-fingerprint-actions/` 里（未提交），fill / 同值 verify / select / type / 受控回滚五条实测均已通过，只有 scroll 因上述缺陷卡住。**优先把那两个文件取过来再按本 Task 的最新内容改**（fixture 的 `<div id="list">` 要换成 `<section>`、scroll 断言要加强），不要从零重写。取完确认 worktree 可以删除。

- [x] **Step 1: 建 fixture**

新建 `packages/vortex-bench/playground/public/synth/fingerprint-actions.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>指纹四动作 fixture</title></head>
<body>
  <label for="email">邮箱</label>
  <input id="email" type="text" />

  <label for="city">城市</label>
  <select id="city"><option value="bj">北京</option><option value="sh">上海</option></select>

  <div id="editor" contenteditable="true" aria-label="正文"></div>

  <!-- 必须是 section 不能是 div：裸 div 在 a11y 里是 generic 角色，observe 不发 @ref。
       四变体实机对照实测：div 不发；section(region)/ul(list)/role=listbox 都发。 -->
  <section id="list" style="height:120px;overflow:auto" aria-label="列表">
    <div style="height:2000px">长内容</div>
  </section>

  <!-- 受控回滚：模拟框架把值改回去，用来验证 drift 能被抓到 -->
  <label for="controlled">受控字段</label>
  <input id="controlled" type="text" />
  <script>
    document.getElementById("controlled").addEventListener("input", (e) => {
      e.target.value = "REVERTED";
    });
  </script>
</body>
</html>
```

- [x] **Step 2: 写 case**

新建 `packages/vortex-bench/cases/fingerprint-actions.case.ts`：

**必须全部走 `vortex_act`，不能用 `vortex_fill`**：指纹守卫判的是 `params.action`（`server.ts:787`），而 `vortex_fill` 是独立公开工具，dispatch 到 `dom.fill` 时压根没有 `action` 字段，且它的 schema 里没有 `options` 属性——传 `options.fingerprint` 不会报错也不会生效。`vortex_act` 的 `action` enum 含 `click/fill/type/select/scroll/hover`，是唯一能触发指纹的入口。

```ts
// 四种动作的效果指纹：record 拿到确定量，verify 一致为 null、不一致报 value drift。
// 全走 vortex_act：指纹守卫读 params.action，vortex_fill 这类独立工具没有该字段。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

interface ActResult {
  fingerprint?: { action: string; valueAfter?: string; scrollAfter?: { top: number; left: number } };
  drift?: { classes: string[] } | null;
}

const def: CaseDefinition = {
  name: "fingerprint-actions",
  playgroundPath: "/synth/fingerprint-actions.html",
  tier: "medium",
  async run(ctx) {
    const obs = extractText(await ctx.call("vortex_observe", {}));
    const refOf = (label: string): string => {
      const m = obs.match(new RegExp(`(@[\\w:]+)[^\\n]*${label}`));
      if (!m) throw new Error(`observe 里找不到 ${label}：\n${obs.slice(0, 600)}`);
      return m[1];
    };

    const act = async (args: Record<string, unknown>): Promise<ActResult> =>
      JSON.parse(extractText(await ctx.call("vortex_act", args))) as ActResult;
    const rec = { fingerprint: { mode: "record" } };

    // fill：record 出 valueAfter
    const fill = await act({
      action: "fill", target: refOf("邮箱"), value: "a@b.com", options: rec,
    });
    ctx.assert(fill.fingerprint?.action === "fill", `fill 指纹缺失：${JSON.stringify(fill)}`);
    ctx.assert(fill.fingerprint?.valueAfter === "a@b.com",
      `fill valueAfter 应为回读值，实际 ${fill.fingerprint?.valueAfter}`);

    // verify 同值 → drift null
    const same = await act({
      action: "fill", target: refOf("邮箱"), value: "a@b.com",
      options: { fingerprint: { mode: "verify", expect: fill.fingerprint } },
    });
    ctx.assert(same.drift === null, `同值 verify 应 matched，实际 ${JSON.stringify(same.drift)}`);

    // select：确定量是选中值
    const sel = await act({ action: "select", target: refOf("城市"), value: "上海", options: rec });
    ctx.assert(sel.fingerprint?.action === "select",
      `select 指纹缺失：${JSON.stringify(sel)}`);
    ctx.assert(typeof sel.fingerprint?.valueAfter === "string",
      `select valueAfter 应为字符串，实际 ${JSON.stringify(sel.fingerprint)}`);

    // type：contentEditable 的确定量是回读文本
    const typ = await act({ action: "type", target: refOf("正文"), value: "hello", options: rec });
    ctx.assert(typ.fingerprint?.valueAfter === "hello",
      `type valueAfter 应为回读文本，实际 ${typ.fingerprint?.valueAfter}`);

    // 受控回滚 → 指纹必须是回滚后的值，这是「静默假成功」的正面拦截
    const ctl = await act({ action: "fill", target: refOf("受控字段"), value: "typed", options: rec });
    ctx.assert(ctl.fingerprint?.valueAfter === "REVERTED",
      `受控回滚必须体现在指纹里，实际 ${ctl.fingerprint?.valueAfter}`);

    // scroll：record 出位置。value 是结构化参数对象，不是裸数字
    const scr = await act({
      action: "scroll", target: refOf("列表"), value: { position: "bottom" }, options: rec,
    });
    // 断言必须是「滚到底部的真实位置」而非「有个数字」：实际滚了 window 时
    // top 也是 number(0)，弱断言在那个缺陷下照样能过（2026-08-13 实测）
    ctx.assert(scr.fingerprint?.scrollAfter != null,
      `scroll 指纹缺失（滚的可能不是目标本身）：${JSON.stringify(scr)}`);
    ctx.assert((scr.fingerprint?.scrollAfter?.top ?? 0) > 1000,
      `scroll 应滚到容器底部（约 1880），实际 ${scr.fingerprint?.scrollAfter?.top}`);
  },
};
export default def;
```

- [x] **Step 3: 起 playground 并跑 case**

```bash
# 终端 A
pnpm --filter @vortex-browser/bench playground
# 终端 B
pnpm --filter @vortex-browser/bench bench run --pattern fingerprint-actions
```

Expected: PASS。若 `refOf` 匹配不到，先手动看一次 observe 输出再调正则——**不要**把断言改宽来迁就。

**两种失败要照实汇报、不要绕过**：

- 返回里出现 `fingerprintSkipped` 而非 `fingerprint`，说明 `targetIdentity` 没建立（`server.ts:930` 要求 `params.index` 来自 @ref）。scroll 这一步尤其可能踩到——它历史上常用 `value.container` 选择器而非 @ref。**记下原始返回照实汇报**，不要改成不带指纹的断言。
- `valueAfter` 拿到的是入参回声而不是回读值（比如受控字段那步返回 `"typed"` 而非 `"REVERTED"`），说明 Task 1/2 的回读没接通到这条链路。**这是真缺陷，停下汇报**，不要把断言改成接受任一值。

- [x] **Step 4: 跑全量 bench 确认零回归**

```bash
pnpm --filter @vortex-browser/bench bench run --all
```

Expected: 98/98（97 + 新增 1）

- [x] **Step 5: 提交**

```bash
git add packages/vortex-bench/cases/fingerprint-actions.case.ts packages/vortex-bench/playground/public/synth/fingerprint-actions.html
git commit -m "test: 四种动作的效果指纹 bench 覆盖

fixture 埋了受控回滚 input：fill 报 success 但值被框架改回，
指纹必须如实体现回读值，这是静默假成功的正面拦截点。"
```

---

# 阶段二：`vortex_sequence` 序列执行器

## Task 7: 序列执行的纯逻辑

**Files:**
- Create: `packages/mcp/src/lib/sequence-run.ts`
- Test: `packages/mcp/tests/sequence-run.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `FingerprintOut`
- Produces:
  ```ts
  export type StepState = "not_executed" | "executed_unverified" | "executed_verified" | "failed";
  export interface StepTrace {
    index: number; action: string; target: string;
    state: StepState; error?: string; drift?: { classes: string[] } | null;
  }
  export type OnFailure = "stop" | "continue";
  export function classifyStep(
    outcome: { ok: boolean; error?: string; fp: FingerprintOut },
  ): { state: StepState; drift?: { classes: string[] } | null };
  export function shouldContinue(state: StepState, onFailure: OnFailure): boolean;
  export function summarizeTrace(traces: StepTrace[]): {
    total: number; verified: number; unverified: number; failed: number; notExecuted: number;
  };
  ```

**为什么三态而不是 ok/error**：现有 `fill_form` 只返回 `{ok, error}`（`server.ts:673-681`），回答不了「点了没有」。序列里这个区分是安全边界——非幂等动作在「已执行但回读失败」下重试会造成重复副作用。

- [ ] **Step 1: 写失败测试**

新建 `packages/mcp/tests/sequence-run.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { classifyStep, shouldContinue, summarizeTrace, type StepTrace } from "../src/lib/sequence-run.js";

describe("classifyStep：三态必须可分", () => {
  it("请求失败 → failed（未执行或执行未知，交由 error 说明）", () => {
    expect(classifyStep({ ok: false, error: "[NOT_ATTACHED]: x", fp: {} }).state).toBe("failed");
  });

  it("成功且指纹 matched → executed_verified", () => {
    expect(classifyStep({ ok: true, fp: { drift: null, fingerprint: { action: "fill" } as never } }).state)
      .toBe("executed_verified");
  });

  it("成功但有 drift → executed_unverified，且 drift 原样带出", () => {
    const r = classifyStep({
      ok: true, fp: { drift: { classes: ["value"], details: [] }, fingerprint: { action: "fill" } as never },
    });
    expect(r.state).toBe("executed_unverified");
    expect(r.drift?.classes).toEqual(["value"]);
  });

  it("成功但拿不到指纹 → executed_unverified，不谎称已验证", () => {
    expect(classifyStep({ ok: true, fp: {} }).state).toBe("executed_unverified");
  });
});

describe("shouldContinue", () => {
  it("stop 策略下，非 verified 一律中断", () => {
    expect(shouldContinue("executed_unverified", "stop")).toBe(false);
    expect(shouldContinue("failed", "stop")).toBe(false);
    expect(shouldContinue("executed_verified", "stop")).toBe(true);
  });

  it("continue 策略下失败也继续（对齐 fill_form 的部分成功语义）", () => {
    expect(shouldContinue("failed", "continue")).toBe(true);
  });
});

describe("summarizeTrace", () => {
  it("未跑到的步骤计入 notExecuted，不与 failed 混为一谈", () => {
    const traces: StepTrace[] = [
      { index: 0, action: "click", target: "@a", state: "executed_verified" },
      { index: 1, action: "fill", target: "@b", state: "failed", error: "x" },
      { index: 2, action: "click", target: "@c", state: "not_executed" },
    ];
    expect(summarizeTrace(traces)).toEqual({
      total: 3, verified: 1, unverified: 0, failed: 1, notExecuted: 1,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/sequence-run.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，找不到模块 `../src/lib/sequence-run.js`

- [ ] **Step 3: 实现**

新建 `packages/mcp/src/lib/sequence-run.ts`：

```ts
// 序列执行的纯逻辑:步骤三态判定与轨迹汇总,与 MCP transport 解耦便于单测。
// 三态而非 ok/error:非幂等动作在「已执行但未验证」下重试会造成重复副作用,
// 调用方必须能把它与「根本没执行」分开。
import type { FingerprintOut } from "./fingerprint-apply.js";

export type StepState = "not_executed" | "executed_unverified" | "executed_verified" | "failed";
export type OnFailure = "stop" | "continue";

export interface StepTrace {
  index: number;
  action: string;
  target: string;
  state: StepState;
  error?: string;
  drift?: { classes: string[] } | null;
}

export function classifyStep(outcome: { ok: boolean; error?: string; fp: FingerprintOut }): {
  state: StepState;
  drift?: { classes: string[] } | null;
} {
  if (!outcome.ok) return { state: "failed" };
  const drift = outcome.fp.drift;
  if (drift === null) return { state: "executed_verified", drift: null };
  if (drift) return { state: "executed_unverified", drift };
  // 无指纹:record 模式或信号未到位,已执行但无从验证,不谎称已验证
  return { state: "executed_unverified" };
}

export function shouldContinue(state: StepState, onFailure: OnFailure): boolean {
  if (onFailure === "continue") return true;
  return state === "executed_verified";
}

export function summarizeTrace(traces: StepTrace[]): {
  total: number; verified: number; unverified: number; failed: number; notExecuted: number;
} {
  const count = (s: StepState): number => traces.filter((t) => t.state === s).length;
  return {
    total: traces.length,
    verified: count("executed_verified"),
    unverified: count("executed_unverified"),
    failed: count("failed"),
    notExecuted: count("not_executed"),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/sequence-run.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（7 个用例：classifyStep 4 + shouldContinue 2 + summarizeTrace 1）

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/lib/sequence-run.ts packages/mcp/tests/sequence-run.test.ts
git commit -m "feat: 序列执行的步骤三态与轨迹汇总

fill_form 只返回 ok/error，回答不了「点了没有」。三态把「未执行」
与「已执行但未验证」分开，非幂等动作的重试边界才有依据。"
```

---

> **已定的两个设计问题（2026-08-13 实测后）**
>
> **① drift 后剩余步骤怎么办 → 序列模式不启用 `autoRecover`。** 实测见
> `docs/action-sequence-substrate-approach.md` §6.6：任何一次 observe 都会让序列已持有的全部 `@ref`
> 立刻失效（`ref-parser.ts:200` 哈希闸，与 TTL 无关），descriptor 自愈救不了（哈希闸在 MCP 层先抛）。
> 好在只要中途不 observe，序列跑多久都行（实测 75 秒后旧 ref 仍可用），60 秒 TTL 不必规避。
> 本 Task 的实现本来就只用 `{mode:"record"}`，无需改动。
>
> **② 「每步自证」的判据 → 回读值与入参比对，见新增的 Task 7.5。** 原设计用 `record` 模式的指纹当自证，
> 实测是死路：`record` 不产 `drift`，`classifyStep` 对每一步都判 `executed_unverified`，默认
> `onFailure:"stop"` 下序列跑完第 1 步必然中断，且任何一步都不可能是 `executed_verified`。
> 根因是把「重放校验」（要有 `expect` 指纹）和「单步是否生效」当成了同一件事。

## Task 7.5: 单步自证判据 `verifyStepEffect`

**Files:**
- Modify: `packages/mcp/src/lib/sequence-run.ts`
- Test: `packages/mcp/tests/sequence-run.test.ts`（既有文件，新增用例）

**Interfaces:**
- Consumes: Task 1/2 给 `fill`/`type` 加的回读值；Task 5 的 act 返回形状
- Produces:
  ```ts
  export type StepEffect = "confirmed" | "unconfirmed" | "unknown";
  export function verifyStepEffect(
    action: string, requested: unknown, result: Record<string, unknown>,
  ): StepEffect;
  ```
  并给 `classifyStep` 的入参加可选 `effect?: StepEffect`，返回值加 `effect?: StepEffect`。

**三值而非布尔**：`unconfirmed`（查了，证据显示没生效）与 `unknown`（没有可用信号，无从判断）必须分开。合成布尔就等于把「不知道」说成「没生效」，是本项目最忌讳的那类失真。

**select 的特殊处理（实测依据）**：`dom.select` 返回的 `value` 是 `el.value`，即 option 的 **value 属性**（`packages/extension/src/handlers/dom.ts:208`），而调用方通常传可见文本。请求 `"上海"`、回读 `"sh"` 是**正常**的。故 select 只在相等时判 `confirmed`，**不等时判 `unknown` 而非 `unconfirmed`**——我们分不清「选错了」和「标签与值本就不同」。

**500 截断（实测依据）**：`fill`/`type` 的回读值在扩展侧封顶 500 字符并加省略号（Task 2 加的）。入参必须施加同样的截断才能比，否则长文本必然误判。

- [ ] **Step 1: 写失败测试**

在 `packages/mcp/tests/sequence-run.test.ts` 末尾追加：

```ts
describe("verifyStepEffect：单步是否生效", () => {
  it("fill 回读值等于入参 → confirmed", () => {
    expect(verifyStepEffect("fill", "a@b.com", { success: true, value: "a@b.com" }))
      .toBe("confirmed");
  });

  it("fill 被受控组件改回 → unconfirmed（这是静默假成功的拦截点）", () => {
    expect(verifyStepEffect("fill", "typed", { success: true, value: "REVERTED" }))
      .toBe("unconfirmed");
  });

  it("fill 没有回读值 → unknown，不把「不知道」说成「没生效」", () => {
    expect(verifyStepEffect("fill", "x", { success: true })).toBe("unknown");
  });

  it("超 500 的入参按同样规则截断后再比 → confirmed", () => {
    const long = "字".repeat(1200);
    const back = "字".repeat(500) + "…";
    expect(verifyStepEffect("type", long, { success: true, value: back })).toBe("confirmed");
  });

  it("select 回读值与入参不等 → unknown（option value 与可见文本本就可能不同）", () => {
    expect(verifyStepEffect("select", "上海", { success: true, value: "sh" })).toBe("unknown");
  });

  it("scroll moved:false → unconfirmed", () => {
    expect(verifyStepEffect("scroll", undefined, { success: true, moved: false }))
      .toBe("unconfirmed");
  });

  it("click 有任一副作用信号 → confirmed", () => {
    expect(verifyStepEffect("click", undefined, {
      success: true,
      effect: { domMutations: 3, networkRequests: 0, urlChanged: false,
                focusChanged: false, ariaChanged: false, userFeedback: "none" },
    })).toBe("confirmed");
  });

  it("click 未开 observeEffect → unknown", () => {
    expect(verifyStepEffect("click", undefined, { success: true })).toBe("unknown");
  });
});

describe("classifyStep 接入自证", () => {
  it("无 drift 但自证 confirmed → executed_verified", () => {
    expect(classifyStep({ ok: true, fp: {}, effect: "confirmed" }).state)
      .toBe("executed_verified");
  });

  it("无 drift 且自证 unconfirmed → executed_unverified，effect 原样带出", () => {
    const r = classifyStep({ ok: true, fp: {}, effect: "unconfirmed" });
    expect(r.state).toBe("executed_unverified");
    expect(r.effect).toBe("unconfirmed");
  });
});
```

同时把文件顶部的 import 补上 `verifyStepEffect`。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/sequence-run.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，`verifyStepEffect is not a function`

- [ ] **Step 3: 实现**

在 `packages/mcp/src/lib/sequence-run.ts` 中，`classifyStep` 之前插入：

```ts
import type { ClickEffectLike } from "@vortex-browser/shared";

/** confirmed=有证据生效;unconfirmed=有证据未生效;unknown=无可用信号。三值不可合成布尔。 */
export type StepEffect = "confirmed" | "unconfirmed" | "unknown";

const READBACK_CAP = 500;

/** 回读值在扩展侧封顶 500 加省略号,入参不施加同样截断则长文本必然误判。 */
function capped(v: string): string {
  return v.length > READBACK_CAP ? v.slice(0, READBACK_CAP) + "…" : v;
}

export function verifyStepEffect(
  action: string,
  requested: unknown,
  result: Record<string, unknown>,
): StepEffect {
  if (action === "fill" || action === "type" || action === "select") {
    const back = result.value;
    if (typeof back !== "string") return "unknown";
    const want = typeof requested === "string" ? requested : JSON.stringify(requested);
    if (typeof want !== "string") return "unknown";
    if (capped(want) === back) return "confirmed";
    // select 回读的是 option value,与传入的可见文本本就可能不同,分不清选错还是标签≠值
    return action === "select" ? "unknown" : "unconfirmed";
  }
  if (action === "scroll") {
    if (typeof result.moved !== "boolean") return "unknown";
    return result.moved ? "confirmed" : "unconfirmed";
  }
  if (action === "click" || action === "hover") {
    const e = result.effect as ClickEffectLike | undefined;
    if (!e) return "unknown";
    const any =
      e.domMutations > 0 || e.networkRequests > 0 || e.urlChanged ||
      e.focusChanged || e.ariaChanged || e.userFeedback !== "none";
    return any ? "confirmed" : "unconfirmed";
  }
  return "unknown";
}
```

并把 `classifyStep` 整体替换为：

```ts
export function classifyStep(outcome: {
  ok: boolean; error?: string; fp: FingerprintOut; effect?: StepEffect;
}): { state: StepState; drift?: { classes: string[] } | null; effect?: StepEffect } {
  if (!outcome.ok) return { state: "failed" };
  const drift = outcome.fp.drift;
  // 重放路径:有 expect 指纹时以 drift 为准
  if (drift === null) return { state: "executed_verified", drift: null, effect: outcome.effect };
  if (drift) return { state: "executed_unverified", drift, effect: outcome.effect };
  // 新建序列没有 expect,只能靠单步自证
  if (outcome.effect === "confirmed") return { state: "executed_verified", effect: "confirmed" };
  return { state: "executed_unverified", effect: outcome.effect ?? "unknown" };
}
```

`StepTrace` 加一个可选字段：

```ts
  effect?: StepEffect;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/sequence-run.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（17 个用例：原 7 条 + 新增 10 条）。**原 7 条必须原样通过**——`classifyStep` 不传 `effect` 时行为不变是向后兼容的硬要求，若它们红了说明改坏了，停下汇报，不要改那 7 条断言。

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/lib/sequence-run.ts packages/mcp/tests/sequence-run.test.ts
git commit -m "feat: 单步自证判据，回读值与入参比对

record 模式不产 drift，拿它当自证会让每一步都判 unverified，
默认 stop 策略下序列跑完第一步就中断。重放校验要有 expect 指纹，
新建序列没有，得换判据。

三值不合成布尔：unconfirmed 是有证据没生效，unknown 是没有信号，
把后者说成前者就是失真。select 不等时判 unknown——回读的是
option value，与传入的可见文本本就可能不同。"
```

---

## Task 8a: 序列循环抽成纯函数 `runSequence`

**Files:**
- Modify: `packages/mcp/src/lib/sequence-run.ts`
- Test: `packages/mcp/tests/sequence-loop.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7 的 `classifyStep`/`shouldContinue`/`summarizeTrace`；Task 7.5 的 `verifyStepEffect`
- Produces:
  ```ts
  export interface SequenceStepInput { action: string; target: string; value?: unknown }
  export interface SequenceOutcome {
    ok: boolean; error?: string;
    result?: Record<string, unknown>;
    fp?: FingerprintOut;
  }
  export interface SequenceReport {
    summary: ReturnType<typeof summarizeTrace>;
    steps: StepTrace[];
  }
  export async function runSequence(
    steps: SequenceStepInput[],
    onFailure: OnFailure,
    send: (step: SequenceStepInput, index: number) => Promise<SequenceOutcome>,
  ): Promise<SequenceReport>;
  ```

**为什么要抽出来**：原计划让测试文件里**复刻一遍**循环骨架再测那个复刻版（原文写的就是「复刻 server.ts 序列分支的循环骨架」），`server.ts` 里真跑的那段一行都没被覆盖。这是本仓明令禁止的假覆盖（见 `AGENTS.md` 与 `docs/` 内既有教训）。把循环抽成注入 `send` 的纯函数后，测试驱动的就是真代码，`server.ts` 只负责把 I/O 塞进 `send`。

- [x] **Step 1: 写失败测试**

新建 `packages/mcp/tests/sequence-loop.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { runSequence, type SequenceStepInput } from "../src/lib/sequence-run.js";

const three: SequenceStepInput[] = [
  { action: "click", target: "@a" },
  { action: "fill", target: "@b", value: "x" },
  { action: "click", target: "@c" },
];

const clicked = { success: true, effect: {
  domMutations: 1, networkRequests: 0, urlChanged: false,
  focusChanged: false, ariaChanged: false, userFeedback: "none" as const,
} };

describe("runSequence 编排", () => {
  it("stop 策略：中途自证 unconfirmed 后剩余步骤保持 not_executed", async () => {
    const out = await runSequence(three, "stop", async (step, i) =>
      i === 1
        ? { ok: true, result: { success: true, value: "REVERTED" } }
        : { ok: true, result: clicked });
    expect(out.steps.map((s) => s.state))
      .toEqual(["executed_verified", "executed_unverified", "not_executed"]);
    expect(out.steps[1].effect).toBe("unconfirmed");
    expect(out.summary.notExecuted).toBe(1);
  });

  it("continue 策略：失败步不阻断后续", async () => {
    const out = await runSequence(three, "continue", async (step, i) =>
      i === 1
        ? { ok: false, error: "boom" }
        : { ok: true, result: step.action === "fill" ? { success: true, value: "x" } : clicked });
    expect(out.summary).toEqual({ total: 3, verified: 2, unverified: 0, failed: 1, notExecuted: 0 });
    expect(out.steps[1].error).toBe("boom");
  });

  it("全部自证通过时无 not_executed", async () => {
    const out = await runSequence(three, "stop", async (step) =>
      ({ ok: true, result: step.action === "fill" ? { success: true, value: "x" } : clicked }));
    expect(out.summary.verified).toBe(3);
    expect(out.summary.notExecuted).toBe(0);
  });

  it("send 抛异常 → 该步 failed，不让整个调用崩掉", async () => {
    const out = await runSequence(three, "stop", async (step, i) => {
      if (i === 0) throw new Error("resolve failed");
      return { ok: true, result: clicked };
    });
    expect(out.steps[0].state).toBe("failed");
    expect(out.steps[0].error).toContain("resolve failed");
    expect(out.steps[1].state).toBe("not_executed");
  });

  it("空 steps → 全零汇总，不抛错", async () => {
    const out = await runSequence([], "stop", async () => ({ ok: true }));
    expect(out.summary).toEqual({ total: 0, verified: 0, unverified: 0, failed: 0, notExecuted: 0 });
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/sequence-loop.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，`runSequence is not a function`

- [x] **Step 3: 实现**

在 `packages/mcp/src/lib/sequence-run.ts` 末尾追加：

```ts
export interface SequenceStepInput { action: string; target: string; value?: unknown }

export interface SequenceOutcome {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
  fp?: FingerprintOut;
}

export interface SequenceReport {
  summary: ReturnType<typeof summarizeTrace>;
  steps: StepTrace[];
}

/** 循环本身不做 I/O,由 send 注入,这样测试驱动的是真代码而非复刻的骨架。 */
export async function runSequence(
  steps: SequenceStepInput[],
  onFailure: OnFailure,
  send: (step: SequenceStepInput, index: number) => Promise<SequenceOutcome>,
): Promise<SequenceReport> {
  const traces: StepTrace[] = steps.map((s, i) => ({
    index: i, action: s.action, target: s.target, state: "not_executed" as const,
  }));
  for (let i = 0; i < steps.length; i++) {
    let out: SequenceOutcome;
    try {
      out = await send(steps[i], i);
    } catch (err) {
      // send 抛错等同该步未执行,可安全重试;不能让一步的异常掀掉整次调用
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const effect = out.ok && out.result
      ? verifyStepEffect(steps[i].action, steps[i].value, out.result)
      : undefined;
    const c = classifyStep({ ok: out.ok, error: out.error, fp: out.fp ?? {}, effect });
    traces[i] = { ...traces[i], state: c.state, drift: c.drift, effect: c.effect, error: out.error };
    if (!shouldContinue(c.state, onFailure)) break;
  }
  return { summary: summarizeTrace(traces), steps: traces };
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/sequence-loop.test.ts tests/sequence-run.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（22 个用例：sequence-run 17 + sequence-loop 5）。既有 17 条必须原样通过。

- [x] **Step 5: 提交**

```bash
git add packages/mcp/src/lib/sequence-run.ts packages/mcp/tests/sequence-loop.test.ts
git commit -m "feat: 序列循环抽成注入 send 的纯函数

原计划让测试复刻一遍循环再测复刻版，server.ts 里真跑的那段零覆盖。
抽出来后测试驱动的是真代码，server.ts 只负责把 I/O 塞进 send。

send 抛错按该步 failed 处理：一步的异常不该掀掉整次调用，
且 failed 语义就是「未执行，可安全重试」。"
```

---

## Task 8b: 公开 schema 与 I15 登记

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts`
- Modify: `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`

**Interfaces:**
- Produces: 公开工具 `vortex_sequence` 的 schema（handler 分支由 Task 8c 补）

**本 Task 结束时工具已在工具面但还没有 handler**，这是预期的中间态——与 Task 4 结束时 `tsc` 编译不过同理。Task 9 之前不会有人调用它。**不要为了让它「能用」而顺手写 server.ts 分支**，那是 Task 8c 的 Files。

- [ ] **Step 1: 加 schema**

在 `packages/mcp/src/tools/schemas-public.ts` 的 `PUBLIC_TOOLS` 数组中新增：

```ts
  {
    name: "vortex_sequence",
    action: "L4.sequence",
    description:
      "Run multiple actions in one call, each self-verified before the next. " +
      "Per-step state: not_executed|executed_unverified|executed_verified|failed.",
    schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { enum: ["click", "fill", "type", "select", "scroll", "hover"] },
              target: TargetRequired,
              value: { description: "same as vortex_act: fill/type/select string; scroll {container?,position}" },
            },
            required: ["action", "target"],
          },
        },
        onFailure: { enum: ["stop", "continue"], description: "default stop" },
        tabId: { type: "number" },
      },
      required: ["steps"],
    },
  },
```

- [ ] **Step 2: 跑 I15 确认失败并记下实测字节**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/invariants/I15.tools-list-budget.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL 三条——字节超 10400、工具数 24 ≠ 23、工具名清单少一项（`I15.tools-list-budget.test.ts:162` 的 `toEqual` 也会红）。**记下报错里的实测字节数**，下一步要用。

- [ ] **Step 3: 按惯例登记**

在该文件顶部 cap 说明区末尾追加，把 `<实测值>` 换成 Step 2 的真实数字：

```
// vortex_sequence 多步序列: 10400 → <实测值向上取整到百位> B。新增一个公开工具,
// 一次调用跑多步且每步自证。日志实测 observe:evaluate=1:12,其中九成是无对应工具的
// 批处理负载(58% 循环 / 17% 跨调用状态),这是那条缺口的正面补齐。
// payload 实测 <实测值>B。沿用"加能力调 cap 不压字符"惯例。
```

同步改三处数字：`toBeLessThanOrEqual(10400)` 与测试名里的数字、公开工具数 `23` → `24`（含测试名），以及工具名清单里加 `vortex_sequence`。

该清单断言的是 `defs.map(d => d.name).sort()`，**必须按字典序插在 `"vortex_screenshot"` 与 `"vortex_storage"` 之间**，追加到数组末尾会红。

- [ ] **Step 4: 跑 MCP 全量单测**

```bash
pnpm --filter @vortex-browser/mcp test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿，含 I15。

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/tools/schemas-public.ts packages/mcp/tests/invariants/I15.tools-list-budget.test.ts
git commit -m "feat: vortex_sequence 公开 schema 与字节预算登记

日志实测 observe:evaluate=1:12，其中九成是无对应工具的批处理负载。
序列工具是那条缺口的正面补齐。handler 分支随后补上。"
```

---

## Task 8c: `server.ts` 接线

**Files:**
- Modify: `packages/mcp/src/server.ts`（在 `vortex_fill_form` 分支之后新增）

**Interfaces:**
- Consumes: Task 8a 的 `runSequence`；Task 8b 的 schema；`dispatchNewTool`
- Produces: `vortex_sequence` 可用

**必须复用 `dispatchNewTool("vortex_act", …)`，不要自己映射动作名或处理 value**。原计划让「把 fill_form 里的映射抽出来共用」，**实查那里没有这段东西**——`fill_form` 只做 `widget → dom.fill/dom.commit`（`server.ts:644-665`），不认识 click/type/select/scroll/hover。真正的通用映射是 `dispatch.ts:372` 的 `ACT_TO_V05`，而且 `vortex_act` 的 dispatch 分支已经处理好每种动作的 value 语义（scroll 结构化展开、type→text、select JSON 还原、以及 2026-08-13 修的 scroll keepTarget）。自己再写一份必然漂移。

- [ ] **Step 1: 实现分支**

在 `packages/mcp/src/server.ts` 的 `vortex_fill_form` 分支（`:589-703`）之后插入：

```ts
  // 特殊 tool: vortex_sequence(多步序列,每步自证)
  // 与 fill_form 的差别:后者只回 ok/error,答不了「点了没有」;序列用三态区分,
  // 非幂等动作的重试边界才有依据。
  if (toolDef.name === "vortex_sequence") {
    const steps = params.steps as SequenceStepInput[] | undefined;
    if (!Array.isArray(steps) || steps.length === 0) {
      // 与 fill_form 同款错误形态(server.ts:600-608):本文件不用 McpError
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "Error [INVALID_PARAMS]: vortex_sequence: steps must be a non-empty array.",
        }],
      };
    }
    const onFailure = (params.onFailure as OnFailure | undefined) ?? "stop";
    const tabId = params.tabId as number | undefined;
    const currentTabId = typeof tabId === "number" ? tabId : null;

    const report = await runSequence(steps, onFailure, async (step) => {
      const resolved = resolveTargetParam(
        step.target, activeSnapshotId, activeSnapshotHash, activeSnapshotTabId, currentTabId,
      );
      const actParams: Record<string, unknown> = { action: step.action };
      if (resolved.selector) actParams.selector = resolved.selector;
      if (resolved.index != null) {
        actParams.index = resolved.index;
        actParams.snapshotId = resolved.snapshotId;
        if (resolved.frameId && resolved.frameId !== 0) actParams.frameId = resolved.frameId;
      }
      if (step.value !== undefined) actParams.value = step.value;
      // click/hover 的自证只能靠副作用信号,不强开就永远是 unknown
      if (step.action === "click" || step.action === "hover") {
        actParams.options = { observeEffect: true };
      }
      const d = dispatchNewTool("vortex_act", actParams);
      if (!d) return { ok: false, error: "Error [INVALID_PARAMS]: unsupported action" };
      const resp = await sendRequest(d.action, d.params, PORT, tabId, DEFAULT_TIMEOUT);
      if (resp.error) return { ok: false, error: `[${resp.error.code}]: ${resp.error.message}` };
      return { ok: true, result: (resp.result ?? {}) as Record<string, unknown> };
    });

    return withEvents([{
      type: "text" as const,
      text: JSON.stringify(report, null, 2),
    }]);
  }
```

**不传 `fp`**：新建序列没有 `expect` 指纹，`verified` 全靠 Task 7.5 的自证。`runSequence` 里 `out.fp ?? {}` 已兜住。

import 补：`runSequence`、`type SequenceStepInput`、`type OnFailure`（来自 `./lib/sequence-run.js`）。`dispatchNewTool` 与 `resolveTargetParam` 在 `server.ts` 中已导入。

- [ ] **Step 2: 跑 MCP 全量单测**

```bash
pnpm --filter @vortex-browser/mcp test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿。

- [ ] **Step 3: 确认可编译**

```bash
pnpm -C packages/mcp build
```

Expected: 无输出即成功。

- [ ] **Step 4: 提交**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat: vortex_sequence 接线，每步复用 act 的 dispatch

动作名映射与各动作的 value 语义全走 dispatchNewTool，不另写一份：
scroll 的结构化展开、type→text、select JSON 还原都在那里，
自己再写必然漂移。click/hover 强开 observeEffect，否则自证永远 unknown。"
```

---

## Task 9: bench 覆盖序列的绿路径与红路径

**Files:**
- Create: `packages/vortex-bench/cases/sequence-substrate.case.ts`

**Interfaces:**
- Consumes: Task 8a/8b/8c 的 `vortex_sequence`；Task 6 的 fixture（复用，不新建）

- [ ] **Step 1: 写 case**

新建 `packages/vortex-bench/cases/sequence-substrate.case.ts`：

```ts
// 序列底座：绿路径全 verified；红路径（受控回滚）必须中断并把剩余步标 not_executed。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

interface SeqOut {
  summary: { total: number; verified: number; unverified: number; failed: number; notExecuted: number };
  steps: Array<{ index: number; state: string; drift?: { classes: string[] } | null }>;
}

const def: CaseDefinition = {
  name: "sequence-substrate",
  playgroundPath: "/synth/fingerprint-actions.html",
  tier: "medium",
  async run(ctx) {
    const obs = extractText(await ctx.call("vortex_observe", {}));
    const refOf = (label: string): string => {
      const m = obs.match(new RegExp(`(@[\\w:]+)[^\\n]*${label}`));
      if (!m) throw new Error(`observe 里找不到 ${label}：\n${obs.slice(0, 600)}`);
      return m[1];
    };

    // 绿路径：两步都能自证
    const ok = JSON.parse(extractText(await ctx.call("vortex_sequence", {
      steps: [
        { action: "fill", target: refOf("邮箱"), value: "a@b.com" },
        { action: "select", target: refOf("城市"), value: "sh" },
      ],
    }))) as SeqOut;
    ctx.assert(ok.summary.verified === 2, `绿路径应两步 verified，实际 ${JSON.stringify(ok.summary)}`);
    ctx.assert(ok.summary.notExecuted === 0, `绿路径不应有未执行步：${JSON.stringify(ok.summary)}`);

    // 红路径：第一步受控回滚 → stop 策略下第二步必须没跑
    const bad = JSON.parse(extractText(await ctx.call("vortex_sequence", {
      steps: [
        { action: "fill", target: refOf("受控字段"), value: "typed" },
        { action: "fill", target: refOf("邮箱"), value: "never@run.com" },
      ],
      onFailure: "stop",
    }))) as SeqOut;
    ctx.assert(bad.steps[1].state === "not_executed",
      `stop 策略下第二步应为 not_executed，实际 ${bad.steps[1].state}`);
    ctx.assert(bad.summary.notExecuted === 1,
      `未执行步应如实计数，实际 ${JSON.stringify(bad.summary)}`);

    // 判据 3（往返收益）：两个动作只花了一次 MCP 调用。
    // summary.total 是本次调用内执行的动作数，等价的单动作写法需要 2 次调用。
    ctx.assert(ok.summary.total === 2, `序列应在一次调用内完成两步，实际 ${ok.summary.total}`);
  },
};
export default def;
```

- [ ] **Step 2: 跑 case**

```bash
pnpm --filter @vortex-browser/bench bench run --pattern sequence-substrate
```

Expected: PASS

- [ ] **Step 3: 跑全量 bench**

```bash
pnpm --filter @vortex-browser/bench bench run --all
```

Expected: 99/99（97 + Task 6 的 1 + 本 case 1）

- [ ] **Step 4: 记录往返数，落实判据 3**

```bash
node -e 'const r=require("./packages/vortex-bench/reports/latest.json");
for(const c of r.cases) if(/sequence-substrate|fingerprint-actions/.test(c.case))
  console.log(c.case, "callCount=", c.callCount);'
```

把这两个数字写进 Step 5 的 commit message。判据 3 的成立依据是 case 内 `summary.total === 2` 而 `vortex_sequence` 只被调了一次——**若 `callCount` 明显高于预期（绿路径 1 次 observe + 2 次 sequence = 3），说明序列分支内部在偷偷多发请求，回头查 Task 8c 的 target 翻译是否重复调用。**

- [ ] **Step 5: 刷新 baseline**

```bash
cp packages/vortex-bench/reports/latest.json packages/vortex-bench/reports/baseline.json
```

- [ ] **Step 6: 提交**

```bash
git add packages/vortex-bench/cases/sequence-substrate.case.ts packages/vortex-bench/reports/baseline.json
git commit -m "test: 序列底座的绿路径与红路径 bench 覆盖

红路径用受控回滚 input 触发 drift，断言 stop 策略下剩余步骤
如实标 not_executed —— 静默跑完才是这个特性最危险的失败形态。"
```

---

## 实施前必做（来自思路文档第 7 段的待验证假设）

这两条在动 Task 1 之前先确认，结论写进对应 commit message：

1. ~~**同步回读的 value 在受控组件下是否已落定。**~~ **已实测，结论：安全，Task 1 按原设计做。**

   2026-08-13 在 ant.design 的真实 React 受控 input（`ant-select-input`，有 `onChange` + `value: string` prop）上复刻 fill 的写法（原生 setter + `input`/`change` 事件），逐时点读值：

   | 时点 | `el.value` |
   |---|---|
   | 原生 setter 后、派发事件前 | `"probe-A"` |
   | `input` 事件派发后 | `""` ← React 已同步回滚 |
   | `change` 事件派发后（**fill 的读取点**） | `""` |
   | 两帧后 / 300ms 后 | `""` |

   React 18 把 `input` 归为 discrete event 做**同步**重渲染，回滚在 `dispatchEvent` 返回前就完成了，因此 fill 现有读取时点拿到的已是最终值。**不需要延后一帧**（那会给每次 fill 增加一帧延迟）。

   **限制**：该 input 恰好 `readOnly: true`（antd Select 非搜索态的内层 input），是较弱的样本；且本结论只覆盖 React 18 的同步回滚路径。若某框架**异步**回滚（如 Vue `nextTick` 或 React `startTransition`），同步读到的会是回滚前的值。这不构成阻塞——同步读回的值本就是「DOM 在那一刻的事实」，符合诚实表征；但 Task 6 的 bench fixture 必须保留受控回滚用例作为回归锁。
2. ~~**快照 5 分钟 TTL / 20 条容量是否够序列用。**~~ **已实测，问法有误**，见 `docs/action-sequence-substrate-approach.md` §6.6。真正的约束不是时间而是「同时只有一个活快照」：中途任何一次 observe 会让已持有的全部 ref 立刻失效；只要不 observe，序列跑多久都行（实测 75 秒后旧 ref 仍可用）。结论已落进 Task 8a 前的决议①。

## 明确不做（YAGNI）

- 跨 session 落盘的 replay artifact（`vortex_replay` 工具）——留给下一轮独立 spec
- rollback / 事务语义——现有 `fill_form` 就是部分成功语义，序列沿用，不引入撤销
- 步间条件判断（第 N 步依赖第 N-1 步的返回值）——真出现需求再设计，现在做会把参数结构撑爆
- `micro-verify.ts` 死代码的清理——与本计划正交，单独提 issue
