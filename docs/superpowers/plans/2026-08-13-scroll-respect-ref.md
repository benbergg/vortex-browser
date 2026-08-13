# scroll 尊重 @ref Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `vortex_act action=scroll` 传 `target=@ref` + `position` 时真的滚那个元素，并保证效果指纹里的 `targetIdentity` 与 `scrollAfter` 永远出自同一个元素。

**Architecture:** 三层各改一处。`dispatch` 在「有 position 且调用方没自己指定 container」时保留 `selector`/`index`（今天无条件删掉，导致滚的是 window）；`dom.scroll` 新增返回 `scrolledSelf` 标记实际滚的是不是目标元素本身；`extractSignals` 在 `scrolledSelf !== true` 时不发 scroll 指纹。第三层是关键——它堵死「滚了祖先却挂目标身份」这条误归属残余路径。

**Tech Stack:** TypeScript / vitest 2.1.9 / jsdom / vortex-bench

**背景与路线取舍见** `docs/scroll-respect-ref-approach.md`（路线 A 已由用户选定；其「在 dispatch 里把 selector 填进 container」的原始机制在计划阶段被证伪，见该文 §7 与本文 Global Constraints 第 6 条）。

## Global Constraints

- **跑测试必须限并发**：`--maxWorkers=2 --minWorkers=1`；禁止在仓库根跑 `pnpm -r test`。
- **TDD 顺序不可颠倒**：先写测试 → **真跑出 RED** → 再改实现 → 跑出 GREEN。不许先写实现再补测试。
- **提交规范**：Conventional Commits，中文描述，动词开头、结尾无句号；禁止 `Co-Authored-By` 等任何署名。
- **注释规范**：中文；方法体内单行 `//`，每条 ≤1 行 ≤60 字；只写「为什么」不写「做什么」。
- **只碰该 Task 的 Files 段列出的文件**，要动别的先停下来问。
- **不要改 `dom.scroll` 现有的 `findScrollableAncestor` 上溯语义**：`packages/cli/src/commands/dom.ts:38-41` 的 `dom scroll --selector X --position bottom` 是唯一真正走到那条分支的活路径，改它会造成 CLI 回归。本计划靠 `scrolledSelf` 让指纹层自己判断，而不是改滚动行为。
- **I15 字节预算**：`packages/mcp/tests/invariants/I15.tools-list-budget.test.ts` 是唯一真源，当前 cap 10300 B。加能力调 cap，不压既有字符；调整必须在该文件内登记实测值与理由。
- **改完扩展要重建并确认加载**：`pnpm -C packages/extension build` 后调 `vortex_dev_reload` 确认 buildStamp 变化，否则实测的是旧代码（本轮已因此误判过一次）。

---

## File Structure

| 文件 | 职责 | 本计划的改动 |
|---|---|---|
| `packages/extension/src/handlers/dom.ts` | `dom.scroll` handler（注入页面的滚动逻辑） | `doScroll` 返回值增加 `scrolledSelf` |
| `packages/extension/tests/dom-scroll-scrolled-self.test.ts` | 新建 | 经 `router.dispatch` 真跑注入函数，锁 `scrolledSelf` 三种取值 |
| `packages/mcp/src/tools/dispatch.ts` | `vortex_act` → v0.5 action 参数映射 | scroll 分流：有 position 且无 container 时保留 `selector`/`index` |
| `packages/mcp/tests/tool-dispatch.test.ts` | 既有 dispatch 映射单测 | 新增保留断言；既有 strip 断言按新语义迁移 |
| `packages/mcp/src/lib/fingerprint-apply.ts` | 指纹归一化与信号提取 | `extractSignals` 的 scroll 分支加 `scrolledSelf` 闸 |
| `packages/mcp/tests/act-fingerprint-actions.test.ts` | 既有 `extractSignals` 单测 | 新增闸门断言 |
| `packages/mcp/src/tools/schemas-public.ts` | 公开工具 schema | `vortex_act` 描述补 scroll 下 target 的含义 |
| `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts` | 字节预算唯一真源 | 登记实测值 |

---

## Task 1: `dom.scroll` 报出实际滚的是不是目标本身

**Files:**
- Modify: `packages/extension/src/handlers/dom.ts:1415-1474`
- Test: `packages/extension/tests/dom-scroll-scrolled-self.test.ts`（新建）

**Interfaces:**
- Produces: `dom.scroll` 的 position / x-y 路径返回值新增字段 `scrolledSelf: boolean`。`true` 表示实际滚动的元素就是 `selector` 指向的那个；`false` 表示滚的是 window、显式 `container`、或上溯到的祖先。`scrollIntoView` 路径（仅 selector 无 position）不返回该字段，其返回形状 `{success, moved, inView}` 保持不变。

**jsdom 三个坑，不按这个写测试必然假绿：**

1. **jsdom 不展开 `overflow` 简写**——`style="overflow:auto"` 下 `getComputedStyle(el).overflowY` 实测返回 `"visible"`，`findScrollableAncestor` 会返回 null、静默走 window 分支，测试以错误的理由变绿。fixture **必须写长写法 `overflow-y:auto`**。
2. **jsdom 没有 `Element.prototype.scrollTo`**（实测 `typeof el.scrollTo === "undefined"`，调用抛 `el.scrollTo is not a function`），必须手动挂。
3. **jsdom 的 `scrollHeight`/`clientHeight` 恒为 0**，`findScrollableAncestor` 的 `scrollHeight > clientHeight` 判否，必须用 `Object.defineProperty` 显式定义。

- [ ] **Step 1: 写失败测试**

新建 `packages/extension/tests/dom-scroll-scrolled-self.test.ts`：

```ts
/**
 * Author: qingwa
 * Description: dom.scroll 必须如实报出「滚的是不是目标元素本身」。指纹层靠这个
 *   标记决定发不发 scroll 指纹——滚了祖先却挂目标身份就是张冠李戴。
 *   走 router.dispatch 真跑生产代码，不复刻注入函数体。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/native.js", () => ({
  // dom.ts:6 是 `import { pageQuery as nativePageQuery }`，mock 必须导出 pageQuery
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
  return { type: "tool_request", tool: DomActions.SCROLL, args, requestId: "r-scroll" } as NmRequest;
}

/** 给元素装上 jsdom 缺失的滚动能力：scrollTo + 可写 scrollTop/Left + 尺寸。 */
function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: 0, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 0, configurable: true });
  let top = 0, left = 0;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v) => { top = v; }, configurable: true });
  Object.defineProperty(el, "scrollLeft", { get: () => left, set: (v) => { left = v; }, configurable: true });
  (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = (o) => {
    // 夹到最大可滚距离，模拟真实浏览器对 999999 的钳制
    if (o.top !== undefined) top = Math.min(o.top, scrollHeight - clientHeight);
    if (o.left !== undefined) left = o.left;
  };
}

describe("dom.scroll 的 scrolledSelf 标记", () => {
  let router: ActionRouter;
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    // overflow-y 必须写长写法：jsdom 不展开 overflow 简写（实测 overflowY 得到 visible）
    dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div id="box" style="height:80px;overflow-y:auto">
           <div id="item">项</div>
         </div>
         <div id="plain">不可滚</div>
       </body></html>`,
      { pretendToBeVisual: true },
    );
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "Element", "Event"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }
    makeScrollable(dom.window.document.getElementById("box") as HTMLElement, 1200, 80);
    dom.window.scrollTo = () => {};

    router = new ActionRouter();
    registerDomHandlers(router, { attach: vi.fn(), sendCommand: vi.fn() } as never);
  });

  it("目标自身可滚 → scrolledSelf:true，且滚的是它自己", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#box", position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, scrolledSelf: true, scrollTop: 1120 });
  });

  it("目标不可滚、上溯到祖先 → scrolledSelf:false（身份与位置已不同源）", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#item", position: "bottom" }));
    expect(resp.error).toBeUndefined();
    // 滚的是 #box 不是 #item，标记必须为 false
    expect((resp.result as { scrolledSelf: boolean }).scrolledSelf).toBe(false);
  });

  it("无 selector 的页面级滚动 → scrolledSelf:false", async () => {
    const resp = await router.dispatch(mkReq({ position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { scrolledSelf: boolean }).scrolledSelf).toBe(false);
  });

  it("显式 container → scrolledSelf:false（container 路径本就没有 @ref 身份）", async () => {
    const resp = await router.dispatch(mkReq({ container: "#box", position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { scrolledSelf: boolean }).scrolledSelf).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension exec vitest run tests/dom-scroll-scrolled-self.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，前两条报 `scrolledSelf` 为 `undefined`（字段还不存在）。

**若第一条报的是 `scrollTop: 0` 而不是 `scrolledSelf undefined`**，说明 jsdom 的 overflow/尺寸桩没生效、走到了 window 分支——停下来汇报，不要改断言迁就。

- [ ] **Step 3: 实现**

`packages/extension/src/handlers/dom.ts`，把 `:1415-1421` 的「确定滚动容器」块替换为：

```ts
            // 确定滚动容器
            let scrollTarget: Element | Window = window;
            // 指纹层靠它判断身份与位置是否同源,滚了祖先就不能挂目标的身份
            let scrolledSelf = false;
            if (cont) {
              const containerEl = document.querySelector(cont);
              if (!containerEl) return { error: `Container not found: ${cont}` };
              scrollTarget = containerEl;
            }
```

把 `:1426-1433` 的分支替换为：

```ts
            if (sel && pos && !cont) {
              const el = document.querySelector(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              const ancestor = findScrollableAncestor(el);
              if (ancestor) {
                scrollTarget = ancestor;
                scrolledSelf = ancestor === el;
              }
              // fall through to position branch（scrollTarget 已切换）
            } else if (sel) {
```

把 `:1455` 的 `doScroll` 签名与返回值替换为：

```ts
            const doScroll = (opts: ScrollToOptions): { success: true; moved: boolean; scrollTop: number; scrollLeft: number; scrolledSelf: boolean } => {
              const before = readPos(scrollTarget);
              const scrollOpts: ScrollToOptions = { ...opts, behavior: "auto" };
              if (scrollTarget instanceof Window) {
                scrollTarget.scrollTo(scrollOpts);
              } else {
                (scrollTarget as Element).scrollTo(scrollOpts);
              }
              const after = readPos(scrollTarget);
              return {
                success: true,
                // 回读:位置无变化(已在目标边界 / 容器不可滚 / 容器解析错)时 moved:false,
                // agent 据此判断是否真滚动而非盲信 success(#18)。
                moved:
                  Math.abs(after.top - before.top) > 1 ||
                  Math.abs(after.left - before.left) > 1,
                scrollTop: after.top,
                scrollLeft: after.left,
                scrolledSelf,
              };
            };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/extension exec vitest run tests/dom-scroll-scrolled-self.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（4 个用例）

- [ ] **Step 5: 跑扩展全量单测**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿。已确认仓内没有对 scroll 结果做 `toEqual` 完整形状断言的测试，新增字段不应打破任何既有用例；若真有失败，停下汇报。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/dom.ts packages/extension/tests/dom-scroll-scrolled-self.test.ts
git commit -m "feat: dom.scroll 报出实际滚的是不是目标元素本身

指纹要拿 targetIdentity 和 scrollAfter 配对,而 findScrollableAncestor
会上溯到祖先。不把这件事说出来,指纹就会张冠李戴。"
```

---

## Task 2: dispatch 不再把 @ref 目标一律剥掉

**Files:**
- Modify: `packages/mcp/src/tools/dispatch.ts:166-175`
- Test: `packages/mcp/tests/tool-dispatch.test.ts`（既有文件，新增用例）

**Interfaces:**
- Consumes: 无
- Produces: `dispatchNewTool("vortex_act", {action:"scroll", ...})` 的下发参数规则——`value` 含 `position` 且**不含** `container` 时保留 `selector`/`index`/`snapshotId`，仅删 `target`；其余情况（含 `container`、或 `x`/`y`）维持现状全删。

**为什么不是「把 selector 填进 container」**：路线 A 的原始机制在计划阶段被证伪。`server.ts:718-732` 显示 `@ref` 只翻译出 `index` + `snapshotId`，**没有 selector**（真正的 CSS selector 存在扩展侧快照里，见 `packages/extension/src/lib/resolve-target.ts:61`）。dispatch 手上没有 selector 可填，解析只能发生在扩展侧。故改为「保留目标，让 `dom.scroll` 自己解析」。

- [ ] **Step 1: 写失败测试**

在 `packages/mcp/tests/tool-dispatch.test.ts` 中，紧接既有的 `vortex_act(scroll, target=...) 不传 value 时也通` 用例之后，追加：

```ts
  // 2026-08-13: target=@ref + position 原先被无条件 strip → 实际滚 window，
  // 而 server.ts 仍按删除前的 params.index 建 targetIdentity → 指纹张冠李戴。
  it("vortex_act(scroll, index + position 无 container) 保留 index/snapshotId", () => {
    const { action, params } = dispatchNewTool("vortex_act", {
      index: 7,
      snapshotId: "snap_x",
      action: "scroll",
      value: { position: "bottom" },
    })!;
    expect(action).toBe("dom.scroll");
    expect(params.position).toBe("bottom");
    expect(params.index).toBe(7);
    expect(params.snapshotId).toBe("snap_x");
    // target 仍必须删除：它是未翻译的原始形态，底层不认
    expect(params).not.toHaveProperty("target");
  });

  it("vortex_act(scroll, selector + position 无 container) 保留 selector", () => {
    const { params } = dispatchNewTool("vortex_act", {
      selector: "#list",
      action: "scroll",
      value: { position: "bottom" },
    })!;
    expect(params.selector).toBe("#list");
    expect(params.position).toBe("bottom");
  });

  it("显式 container 时仍全 strip：调用方指名的容器优先于目标", () => {
    const { params } = dispatchNewTool("vortex_act", {
      selector: "#list",
      index: 7,
      snapshotId: "snap_x",
      action: "scroll",
      value: { container: ".other", position: "bottom" },
    })!;
    expect(params.container).toBe(".other");
    expect(params).not.toHaveProperty("selector");
    expect(params).not.toHaveProperty("index");
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/tool-dispatch.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，前两条报 `params.index` / `params.selector` 为 `undefined`（当前被无条件删除）。第三条应当已经通过。

- [ ] **Step 3: 实现**

`packages/mcp/src/tools/dispatch.ts`，把 `:167-175` 替换为：

```ts
        // server.ts 已把 params.target 翻译成 selector(raw CSS)或 index(@ref);
        // target 本身是未翻译形态,底层不认,任何情况都删。
        const v = scrollValue as Record<string, unknown>;
        if ("container" in v || "position" in v || "x" in v || "y" in v) {
          delete next.target;
          // 有 position 且调用方没指名 container 时保留目标,让 dom.scroll 拿它当
          // 滚动容器;否则滚的是 window,而指纹仍按目标建身份 → 张冠李戴。
          const keepTarget = "position" in v && !("container" in v);
          if (!keepTarget) {
            delete next.selector;
            delete next.index;
          }
        }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/tool-dispatch.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS。

**注意既有用例 `vortex_act(scroll, value={container, position}) 把 value spread + strip selector`（`:170`）必须仍然通过**——它传了显式 container，走的是全 strip 分支。若它反而红了，说明 `keepTarget` 判据写反，停下汇报，**不要改那条既有断言**。

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/tools/dispatch.ts packages/mcp/tests/tool-dispatch.test.ts
git commit -m "fix: scroll 传 position 时不再剥掉 @ref 目标

原先无条件 strip 导致实际滚 window,而 server.ts 按删除前的
params.index 建 targetIdentity,指纹把 window 的位置挂在具名元素上。
调用方显式指名 container 时仍全 strip,container 优先。"
```

---

## Task 3: 指纹只在身份与位置同源时才发

**Files:**
- Modify: `packages/mcp/src/lib/fingerprint-apply.ts`（`extractSignals` 的 scroll 分支）
- Test: `packages/mcp/tests/act-fingerprint-actions.test.ts`（既有文件，新增用例）

**Interfaces:**
- Consumes: Task 1 的 `scrolledSelf` 字段
- Produces: `extractSignals("scroll", result)` 在 `result.scrolledSelf !== true` 时返回 `undefined`

**这一步是路线取舍的兑现**：思路文档里否掉路线 B 的理由是「`findScrollableAncestor` 上溯到祖先时误归属会换个形式回来」。Task 1 让上溯变得可见，这一步据此闸掉——两者合起来才等于选定的路线 A 语义。

- [ ] **Step 1: 写失败测试**

在 `packages/mcp/tests/act-fingerprint-actions.test.ts` 的 `describe` 内追加：

```ts
  it("scroll 滚的是祖先而非目标本身 → 不发信号，绝不张冠李戴", () => {
    expect(extractSignals("scroll", {
      success: true, moved: true, scrollTop: 1120, scrollLeft: 0, scrolledSelf: false,
    })).toBeUndefined();
  });

  it("scroll 滚的就是目标本身 → 正常取位置", () => {
    expect(extractSignals("scroll", {
      success: true, moved: true, scrollTop: 1120, scrollLeft: 0, scrolledSelf: true,
    })).toEqual({ kind: "scroll", scrollAfter: { top: 1120, left: 0 } });
  });
```

同时把既有的 `scroll：取位置（dom.ts:1447 的形状）` 用例的入参补上 `scrolledSelf: true`——该用例写于 `scrolledSelf` 存在之前，不补会因新闸门而红：

```ts
  it("scroll：取位置（dom.ts:1447 的形状）", () => {
    expect(extractSignals("scroll", {
      success: true, moved: true, scrollTop: 1200, scrollLeft: 0, scrolledSelf: true,
    })).toEqual({ kind: "scroll", scrollAfter: { top: 1200, left: 0 } });
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/act-fingerprint-actions.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL，第一条报「期望 undefined，实际拿到 `{kind:"scroll",...}`」。

- [ ] **Step 3: 实现**

`packages/mcp/src/lib/fingerprint-apply.ts`，把 `extractSignals` 里的 scroll 分支替换为：

```ts
  if (action === "scroll") {
    const top = result.scrollTop, left = result.scrollLeft;
    if (typeof top !== "number" || typeof left !== "number") return undefined;
    // 滚的不是目标本身(上溯到祖先/滚了 window)时位置与身份不同源,宁可不发
    if (result.scrolledSelf !== true) return undefined;
    return { kind: "scroll", scrollAfter: { top, left } };
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/act-fingerprint-actions.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS（9 个用例：既有 7 条 + 新增 2 条）

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/lib/fingerprint-apply.ts packages/mcp/tests/act-fingerprint-actions.test.ts
git commit -m "fix: scroll 指纹仅在滚的是目标本身时才发

上溯到祖先时 targetIdentity 指元素、scrollAfter 是祖先的位置,
两者不同源。宁可不发指纹,也不发一个对不上的。"
```

---

## Task 4: 工具描述说清 scroll 下 target 的含义

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:56`（`vortex_act` 的 description）
- Modify: `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`（cap 说明区登记）

**Interfaces:**
- Consumes: Task 2 的新参数语义
- Produces: 无代码接口，仅工具面文案

**为什么必须改**：当前描述只有 `scroll:value={container?,position}`，完全没提 target 在 scroll 下的作用。行为改了描述不改，模型不会知道可以用 @ref 指定滚动容器——能力等于不存在（Task 5 评审时已因同类问题返工过一次）。

- [ ] **Step 1: 改描述**

把 `packages/mcp/src/tools/schemas-public.ts:56` 的

```ts
      "Write to a UI element. scroll:value={container?,position}. " +
```

改为

```ts
      "Write to a UI element. scroll:value={container?,position}; target=@ref scrolls that element itself. " +
```

- [ ] **Step 2: 跑 I15 看实测字节**

```bash
pnpm --filter @vortex-browser/mcp exec vitest run tests/invariants/I15.tools-list-budget.test.ts --maxWorkers=2 --minWorkers=1
```

若通过，记下测试打印/断言里的实测字节数即可，无需调 cap，直接做 Step 3 的登记。
若因超过 10300 而失败，按「加能力调 cap 不压既有字符」惯例把 cap 调到实测值向上取整、留少量余量，并在 Step 3 一并写明。

- [ ] **Step 3: 在 I15 登记**

在 `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts` 顶部 cap 说明区末尾（`// 沿用"加能力调 cap 不压字符"惯例。` 那一段之后）追加，把 `<实测值>` 换成 Step 2 的真实数字：

```
// vortex_act scroll target 语义: payload 实测 <实测值>B。scroll 传 target=@ref 时
// 改为滚该元素自身(原先被 strip 掉、实际滚 window,指纹还挂着该元素的身份)。
// 行为变了描述必须跟上,否则模型不知道能用 @ref 指容器,能力等于不存在。
```

- [ ] **Step 4: 跑 MCP 全量单测**

```bash
pnpm --filter @vortex-browser/mcp test -- --maxWorkers=2 --minWorkers=1
```

Expected: 全绿，含 I15。

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/tools/schemas-public.ts packages/mcp/tests/invariants/I15.tools-list-budget.test.ts
git commit -m "docs: act 描述补 scroll 下 target 的含义

行为改了描述没跟上,模型就不知道可以用 @ref 指定滚动容器,
新能力等于不存在。字节实测已在 I15 登记。"
```

---

## Task 5: 实机验证并跑全量 bench 对照

**Files:**
- Modify: `packages/vortex-bench/cases/fingerprint-actions.case.ts`（Task 6 产出的 case，scroll 断言加强）
- Modify: `packages/vortex-bench/playground/public/synth/fingerprint-actions.html`（滚动容器换成有真实角色的元素）

**Interfaces:**
- Consumes: Task 1-4 的全部产出

**前置**：本 Task 依赖 action-sequence-substrate 计划的 Task 6 已落地这两个文件。若它们尚不存在，停下汇报，不要自行新建。

**fixture 为什么要换标签**：实测四变体对照（`<div aria-label>` / `<section aria-label>` / `<ul aria-label>` / `role=listbox`），**只有裸 `<div>` 拿不到 @ref**——它在 a11y 里是 `generic` 角色。其余三种 observe 都会发 @ref。改动最小的修法是把 `<div id="list">` 换成 `<section id="list">`。

- [ ] **Step 1: 重建扩展并确认加载**

```bash
pnpm -C packages/extension build
```

然后调用 `vortex_dev_reload` 工具，确认返回的 `toStamp` 与 `dist/build-stamp.txt` 一致。**这一步不能省**：本轮已经发生过一次「主仓 dist 是六天前的旧构建，实测结果全是旧代码行为」的误判。

- [ ] **Step 2: 改 fixture**

把 `packages/vortex-bench/playground/public/synth/fingerprint-actions.html` 里的

```html
  <div id="list" style="height:120px;overflow:auto" aria-label="列表">
    <div style="height:2000px">长内容</div>
  </div>
```

改为

```html
  <section id="list" style="height:120px;overflow:auto" aria-label="列表">
    <div style="height:2000px">长内容</div>
  </section>
```

- [ ] **Step 3: 加强 case 的 scroll 断言**

把 `packages/vortex-bench/cases/fingerprint-actions.case.ts` 末尾的 scroll 段替换为：

```ts
    // scroll：record 出位置。断言必须是「滚到底部的真实位置」而非「有个数字」——
    // 之前的写法在实际滚了 window 的情况下同样能过（top:0 也是 number）
    const scr = await act({
      action: "scroll", target: refOf("列表"), value: { position: "bottom" }, options: rec,
    });
    ctx.assert(scr.fingerprint?.scrollAfter != null,
      `scroll 指纹缺失（滚的可能不是目标本身）：${JSON.stringify(scr)}`);
    ctx.assert((scr.fingerprint?.scrollAfter?.top ?? 0) > 1000,
      `scroll 应滚到容器底部（约 1880），实际 ${scr.fingerprint?.scrollAfter?.top}`);
```

- [ ] **Step 4: 起 playground 并跑该 case**

```bash
# 终端 A（若尚未常驻）
pnpm --filter @vortex-browser/bench playground
# 终端 B
pnpm --filter @vortex-browser/bench bench run --pattern fingerprint-actions
```

Expected: PASS。

**两种失败要照实汇报、不要绕过**：拿到 `fingerprintSkipped` 说明 Task 2 的保留没生效；拿到 `top: 0` 说明滚的仍是 window。都停下汇报，不许把阈值调低来凑绿。

- [ ] **Step 5: 跑全量 bench 对照**

```bash
pnpm --filter @vortex-browser/bench bench run --all
```

Expected: 98/98。**重点看 `f-scroll-to-bottom` 与 `jd-review-rm-03-scroll-load` 两条**——它们是仓内仅有的既有 scroll 用例，均不传 target，本次改动不应触及它们。任一变红即为回归，停下汇报。

- [ ] **Step 6: 提交**

```bash
git add packages/vortex-bench/cases/fingerprint-actions.case.ts packages/vortex-bench/playground/public/synth/fingerprint-actions.html
git commit -m "test: scroll 指纹断言改为校验真实滚动位置

原断言只要求 scrollAfter.top 是数字,实际滚了 window(top:0)照样通过。
fixture 的裸 div 在 a11y 里是 generic 角色拿不到 @ref,换成 section。"
```
