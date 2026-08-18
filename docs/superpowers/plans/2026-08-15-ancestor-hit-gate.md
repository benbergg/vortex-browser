# 命中祖先不再无条件放行（P0-1a）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** act click 在目标被祖先裁剪 / `pointer-events:none` / 祖先层覆盖时报 `OBSCURED` 并点名该祖先，不再返回 `success:true` 而实际零点击。

**Architecture:** 把三处逐字拷贝的命中归属判据收敛成一个无全局依赖的纯函数 `classifyHit(el, hit)`，由 page-side 模块 `hit-ownership.ts` 导出；`actionability.ts` 直接 import，`dom.ts`/`cdp.ts` 两处注入函数经既有的 `window.__vortexDomResolve` 命名空间调用。判据只收紧一处：`hit.contains(el)` 且 hit **非交互元素**时判 OBSCURED（kind=`ancestor`）；交互祖先维持放行。

**Tech Stack:** TypeScript / Chrome MV3 / vitest + jsdom / CDP

**Spec:** `reports/_eval/next-iteration-2026-08/APPROACH-ancestor-hit-gate-2026-08-15.md`（路线 B，用户 2026-08-15 选定）
诊断依据：`reports/_eval/next-iteration-2026-08/EVAL-xiaoe-6-issues-2026-08-15.md` §1a

## Global Constraints

- 跑 vitest 一律带 `--maxWorkers=2 --minWorkers=1`，禁止默认满核（会卡死机器）。
- page-side 注入函数（`dom.ts` / `cdp.ts` 内 `executeScript({func})`）**丢模块作用域**，不能 `import`；只能经 `window.__vortexDomResolve` 取。单测必须用 `new Function` 剥离作用域复刻注入，否则假绿。
- `dom-resolve.ts` 的 version 守卫是 `?.version === 1`；新增导出必须同步 bump，否则页面上残留的旧对象会让新方法 `undefined`。**`actionability.ts:37` 有同款守卫 `__vortexActionability?.version === 1`，改判据后同样必须 bump**——否则残留旧 IIFE 让整个 Task 2 在真浏览器上不生效（单测因每次 `vi.resetModules()` 重新执行而照样绿，是典型假绿）。
- **判定不可用时 fail closed**：`__vortexDomResolve.classifyHit` 取不到（模块未注入 / 页面在两次 `executeScript` 之间导航）时，返回 `NOT_ATTACHED`，**不得静默放行**——静默放行就是把 P0 根因原样留在降级路径上。注意**它不会自动恢复**：派发发生在 `healAwareGate`/`waitActionable` 之后，此时注入函数返回的 `errorCode` 经 `mapPageError`（`native.ts:65`，签名 `: never`）直接抛出，不再回到 gate 自旋。这是可接受的：`classifyHit` 缺失只可能是导航竞态（调用方已 `await loadPageSideModule`），而导航后本就该重新 observe，`NOT_ATTACHED` 的既有 hint 正是这个指引。
- **transient 豁免只适用于 overlay**：`isTransient`（`dom.ts:57`）的三条判据里有「transform 含 matrix」，而 swiper 轨道正是 `transform: translateX()`。祖先命中不会因为祖先在做动画而变得可点，豁免必须按 `kind` 分流。
- 纯函数不得引用全局 `document`（用 `el.ownerDocument`），保证单测无需搭 jsdom 全局。
- 判据只收紧「非交互祖先」一种；交互祖先（`button` 包 `pointer-events:none` 的 `span` 等）维持现状放行——收紧它需要另一批实证。
- 提交信息用 Conventional Commits，禁止任何署名尾注。

---

### Task 1: 纯函数 `classifyHit` 单一真源

**Files:**
- Create: `packages/extension/src/page-side/hit-ownership.ts`
- Test: `packages/extension/tests/hit-ownership.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type HitOwnership = { ok: true } | { ok: false; blocker: string; kind: "overlay" | "ancestor" }`
  - `classifyHit(el: Element, hit: Element | null): HitOwnership`
  - `describeElement(el: Element): string`
  - `isClickTargetAncestor(el: Element, hit: Element): boolean` — 严格白名单，决定祖先命中是否放行
  - `isWidgetContainer(el: Element): boolean` — 宽松判据（任意 role / tabindex / 原生交互标签），**逐字保留原 `isInteractiveEl`**，只服务于装饰层 carve-out
  - `composedParent(node: Element): Element | null` / `composedContains(ancestor, node): boolean` — 穿 shadow host 的上溯，`classifyHit` 与两个 carve-out 共用

> **为什么拆两个**：原 `isInteractiveEl` 用 `!!getAttribute("role")`，任意 role 都算交互。用它决定祖先放行会漏掉核心场景——swiper 轨道常带 `role="group"`、`role="presentation"` 明确非交互、`tabindex="-1"` 只是 programmatic focus。但装饰层 carve-out（el-select）依赖的正是这个宽松判据，收窄它会引入回归。故一严一宽，各司其职。

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/hit-ownership.test.ts`：

```typescript
/**
 * Author: qingwa
 * Description: 命中归属判定的单一真源。2026-08-15 spike 实测:realMouse 路径下
 *   pointer-events:none / 祖先 ::after 覆盖 / 祖先 overflow:hidden 裁剪
 *   三种「命中祖先」场景全部 success:true 而页面零 click。
 */
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { classifyHit, describeElement, isWidgetContainer, isClickTargetAncestor } from "../src/page-side/hit-ownership.js";

const mk = (html: string) => new JSDOM(`<body>${html}</body>`).window.document;

describe("classifyHit", () => {
  it("hit 就是目标 → ok", () => {
    const d = mk(`<button id="b">x</button>`);
    const el = d.getElementById("b")!;
    expect(classifyHit(el, el)).toEqual({ ok: true });
  });

  it("hit 是目标的后代（点在自己的子节点上）→ ok", () => {
    const d = mk(`<button id="b"><span id="s">x</span></button>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("s")!)).toEqual({ ok: true });
  });

  it("hit 是非交互祖先（裁剪 / pointer-events:none）→ ancestor，点名该祖先", () => {
    const d = mk(`<div id="wrap" class="row deep"><button id="b">x</button></div>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("wrap")!)).toEqual({
      ok: false,
      blocker: "div#wrap.row.deep",
      kind: "ancestor",
    });
  });

  it("hit 是交互祖先 → 维持放行（button 包 pointer-events:none 的 span）", () => {
    const d = mk(`<button id="b"><span id="s">x</span></button>`);
    expect(classifyHit(d.getElementById("s")!, d.getElementById("b")!)).toEqual({ ok: true });
  });

  it("hit 是 label 祖先且关联目标 → 放行（点 label 会激活控件）", () => {
    const d = mk(`<label id="l"><input id="i" type="radio">选项</label>`);
    expect(classifyHit(d.getElementById("i")!, d.getElementById("l")!)).toEqual({ ok: true });
  });

  it("swiper 轨道 role=group 祖先 → 仍判 ancestor（不因有 role 就放行）", () => {
    const d = mk(`<div id="track" role="group" class="swiper-wrapper"><button id="b">题3</button></div>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("track")!)).toEqual({
      ok: false, blocker: "div#track.swiper-wrapper", kind: "ancestor",
    });
  });

  it("role=presentation 祖先 → 仍判 ancestor", () => {
    const d = mk(`<div id="p" role="presentation"><button id="b">x</button></div>`);
    expect((classifyHit(d.getElementById("b")!, d.getElementById("p")!) as any).kind).toBe("ancestor");
  });

  it("tabindex=-1 祖先 → 仍判 ancestor（programmatic focus 不等于可点）", () => {
    const d = mk(`<div id="t" tabindex="-1"><button id="b">x</button></div>`);
    expect((classifyHit(d.getElementById("b")!, d.getElementById("t")!) as any).kind).toBe("ancestor");
  });

  it("role=link 祖先 → 放行（白名单内的交互 role）", () => {
    const d = mk(`<div id="lk" role="link"><span id="s">x</span></div>`);
    expect(classifyHit(d.getElementById("s")!, d.getElementById("lk")!)).toEqual({ ok: true });
  });

  it("shadow 内目标 + light DOM 祖先命中 → ancestor（contains 不穿 shadow，须用 composed 上溯）", () => {
    const d = mk(`<div id="host" class="wrap"></div>`);
    const host = d.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button id="inner">x</button>`;
    const inner = sr.getElementById("inner")!;
    expect(classifyHit(inner, host)).toEqual({ ok: false, blocker: "div#host.wrap", kind: "ancestor" });
  });

  it("hit 是无关兄弟覆盖层 → overlay", () => {
    const d = mk(`<button id="b">x</button><div id="ov">mask</div>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("ov")!)).toEqual({
      ok: false,
      blocker: "div#ov",
      kind: "overlay",
    });
  });

  it("hit=null → 保留 elementFromPoint=null 签名（auto-wait 对该串单独分流）", () => {
    const d = mk(`<button id="b">x</button>`);
    expect(classifyHit(d.getElementById("b")!, null)).toEqual({
      ok: false,
      blocker: "elementFromPoint=null",
      kind: "overlay",
    });
  });

  it("同 widget 装饰层：hit 非交互且与目标同处一个交互容器 → ok（el-select carve-out）", () => {
    const d = mk(`<div id="w" role="combobox"><input id="i"><span id="disp">占位</span></div>`);
    expect(classifyHit(d.getElementById("i")!, d.getElementById("disp")!)).toEqual({ ok: true });
  });

  it("backdrop carve-out：目标在 el-select-dropdown 内、hit 是 backdrop → ok", () => {
    const d = mk(`<div class="el-select-dropdown"><li id="opt">选项</li></div><div id="mask" class="modal-backdrop"></div>`);
    expect(classifyHit(d.getElementById("opt")!, d.getElementById("mask")!)).toEqual({ ok: true });
  });

  it("describeElement 取前两个 class", () => {
    const d = mk(`<div id="x" class="a b c">y</div>`);
    expect(describeElement(d.getElementById("x")!)).toBe("div#x.a.b");
  });

  it("isWidgetContainer 保持宽松（装饰层 carve-out 依赖它）", () => {
    const d = mk(`<div id="g" role="group"></div><div id="t" tabindex="-1"></div><div id="p"></div>`);
    expect(isWidgetContainer(d.getElementById("g")!)).toBe(true);
    expect(isWidgetContainer(d.getElementById("t")!)).toBe(true);
    expect(isWidgetContainer(d.getElementById("p")!)).toBe(false);
  });

  it("isClickTargetAncestor 严格白名单：group/presentation/tabindex=-1 都不算", () => {
    const d = mk(`<div id="g" role="group"><i id="x"></i></div><div id="btn" role="button"></div><a id="na"></a><a id="ha" href="#"></a>`);
    const x = d.getElementById("x")!;
    expect(isClickTargetAncestor(x, d.getElementById("g")!)).toBe(false);
    expect(isClickTargetAncestor(x, d.getElementById("btn")!)).toBe(true);
    expect(isClickTargetAncestor(x, d.getElementById("na")!)).toBe(false); // 无 href 的 <a> 不可点
    expect(isClickTargetAncestor(x, d.getElementById("ha")!)).toBe(true);
  });

  it("label 祖先但关联的是别的控件 → 不放行", () => {
    const d = mk(`<label id="l" for="other"><input id="i" type="radio"></label><input id="other">`);
    expect(isClickTargetAncestor(d.getElementById("i")!, d.getElementById("l")!)).toBe(false);
  });

  it("label 祖先无任何关联控件 → 不放行（点 label 不会激活任意后代 div）", () => {
    const d = mk(`<label id="l"><div id="t">纯文本</div></label>`);
    expect(isClickTargetAncestor(d.getElementById("t")!, d.getElementById("l")!)).toBe(false);
    expect((classifyHit(d.getElementById("t")!, d.getElementById("l")!) as any).kind).toBe("ancestor");
  });

  it("summary / area[href] 祖先 → 放行；role=gridcell 容器 → 不放行", () => {
    const d = mk(`<details><summary id="s"><i id="x"></i></summary></details><div id="gc" role="gridcell"><i id="y"></i></div>`);
    expect(isClickTargetAncestor(d.getElementById("x")!, d.getElementById("s")!)).toBe(true);
    expect(isClickTargetAncestor(d.getElementById("y")!, d.getElementById("gc")!)).toBe(false);
  });

  it("装饰层 carve-out 穿 shadow：shadow 内 widget 容器 contains 命中层 → ok", () => {
    const d = mk(`<div id="host"></div>`);
    const sr = d.getElementById("host")!.attachShadow({ mode: "open" });
    sr.innerHTML = `<div id="w" role="combobox"><input id="i"><span id="disp">占位</span></div>`;
    expect(classifyHit(sr.getElementById("i")!, sr.getElementById("disp")!)).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/hit-ownership.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/page-side/hit-ownership.js"`

- [ ] **Step 3: 实现纯函数**

创建 `packages/extension/src/page-side/hit-ownership.ts`：

```typescript
// 命中归属判定的单一真源。此前 actionability 门 / dom.ts 合成路径 / cdp.ts realMouse
// 路径各存一份逐字拷贝的 contains 判据,「命中祖先无条件放行」这一路三处同时漏。
// 不引用全局 document:祖先遍历一律走 el.ownerDocument。

export type HitOwnership =
  | { ok: true }
  | { ok: false; blocker: string; kind: "overlay" | "ancestor" };

export function describeElement(el: Element): string {
  const cls =
    typeof el.className === "string" && el.className
      ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".")
      : "";
  return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
}

// 宽松判据:任意 role / tabindex / 原生交互标签。**逐字保留自原 isInteractiveEl**,
// 只服务于装饰层 carve-out(el-select),不参与祖先放行——那里用严格白名单。
export function isWidgetContainer(el: Element): boolean {
  const t = el.tagName.toLowerCase();
  return (
    !!el.getAttribute("role") ||
    el.getAttribute("tabindex") != null ||
    t === "button" ||
    t === "a" ||
    t === "input" ||
    t === "select" ||
    t === "textarea"
  );
}

// 严格白名单:哪些祖先「被点到」等价于目标被点到。
// 宽松版(任意 role)会放行 role="group" 的 swiper 轨道、role="presentation" 的纯装饰容器、
// tabindex="-1" 的 programmatic-focus 容器——正是本次要拦的那一类。
// 不含 gridcell / row / region / group:它们是**容器**语义,可点性来自内部控件而非自身,
// 放行会把「点在单元格空白处」当成点中了里面的按钮。有实测反例再加。
const CLICKABLE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "option", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton",
  "treeitem",
]);

export function isClickTargetAncestor(el: Element, hit: Element): boolean {
  const t = hit.tagName.toLowerCase();
  // label:点它把激活转发给**关联控件**。目标不是那个控件时不算到达
  // ——<label><div id=target></label> 点 label 不会激活 div(codex 二轮 P2-1)。
  if (t === "label") return (hit as HTMLLabelElement).control === el;
  if (t === "button" || t === "select" || t === "textarea" || t === "input" || t === "summary") return true;
  if (t === "a" || t === "area") return hit.hasAttribute("href");
  const role = (hit.getAttribute("role") ?? "").toLowerCase();
  if (role) return CLICKABLE_ROLES.has(role); // presentation / none / group / region → false
  const ti = hit.getAttribute("tabindex");
  return ti != null && Number(ti) >= 0; // tabindex="-1" 不算可点
}

// contains 不穿 shadow:shadow 内的目标对其 light-DOM host 祖先 contains 恒 false。
// 命中归属要按 composed 树算,否则 shadow 组件全部落到 overlay 分支、话术指错方向。
// 沿 composed 树取上一级:元素走 parentElement,shadow 根跨到 host。
export function composedParent(node: Element): Element | null {
  const p = node.parentNode as Node | null;
  if (p && (p as Element).nodeType === 1) return p as Element;
  if (p && (p as Node).nodeType === 11) return ((p as any).host as Element | undefined) ?? null; // ShadowRoot
  return null;
}

export function composedContains(ancestor: Element, node: Element): boolean {
  let cur: Element | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = composedParent(cur);
  }
  return false;
}

// 复合输入控件(el-select 等)把可见显示层作为兄弟节点叠在透明真控件之上,点击经显示层
// 冒泡仍到达同一 widget。hit 非交互且与目标同处一个交互容器 → 装饰层,不算遮挡。
// 祖先遍历与包含判断都走 composed 树:否则 shadow 内的 widget 装饰层在这里失效,
// 而 classifyHit 的祖先分支却穿了 shadow,三条路径判定不一致(codex 二轮 P2-3)。
function isSameWidgetDecoration(el: Element, hit: Element): boolean {
  if (isWidgetContainer(hit)) return false;
  const root = el.ownerDocument.documentElement;
  let w: Element | null = composedParent(el);
  while (w && w !== root) {
    if (isWidgetContainer(w)) return composedContains(w, hit);
    w = composedParent(w);
  }
  return false;
}

// overlay 打开时其 backdrop 视觉覆盖页面,hit-test 命中 backdrop,但目标在更高 z 的
// overlay 容器内、完全可点。
function isBackdropCarveOut(el: Element, hit: Element): boolean {
  const hitTag = hit.tagName.toLowerCase();
  const hitCls = typeof hit.className === "string" ? hit.className.toLowerCase() : "";
  const isBackdrop =
    hitTag === "md-backdrop" ||
    hitCls.includes("cdk-overlay-backdrop") ||
    hitCls.includes("modal-backdrop") ||
    hitCls.includes("ant-modal-mask") ||
    hitCls.includes("backdrop");
  if (!isBackdrop) return false;
  const root = el.ownerDocument.documentElement;
  let cur: Element | null = el;
  // 同样走 composed 上溯:shadow 内的 md-dialog / el-select-dropdown 否则找不到。
  while (cur && cur !== root) {
    const t = cur.tagName.toLowerCase();
    const c = typeof cur.className === "string" ? cur.className.toLowerCase() : "";
    if (
      t === "md-select-menu" ||
      t === "md-dialog" ||
      t === "md-menu-content" ||
      c.includes("md-open-menu-container") ||
      c.includes("md-select-menu-container") ||
      c.includes("cdk-overlay-pane") ||
      c.includes("cdk-overlay-container") ||
      c.includes("ngdialog-content") ||
      c.includes("modal-content") ||
      c.includes("ant-modal-content") ||
      c.includes("el-dialog") ||
      c.includes("el-select-dropdown")
    ) {
      return true;
    }
    cur = composedParent(cur);
  }
  return false;
}

export function classifyHit(el: Element, hit: Element | null): HitOwnership {
  // 中心点没命中任何元素(被裁到视口外等)。保留原字符串:auto-wait 对它有专门话术分流。
  if (!hit) return { ok: false, blocker: "elementFromPoint=null", kind: "overlay" };
  if (hit === el || el.contains(hit)) return { ok: true };
  if (isSameWidgetDecoration(el, hit)) return { ok: true };
  if (isBackdropCarveOut(el, hit)) return { ok: true };
  if (composedContains(hit, el)) {
    // 白名单内的可点祖先维持放行:点击落在它身上语义等价
    // (button 内 pointer-events:none 的 span、label 包关联控件)。
    if (isClickTargetAncestor(el, hit)) return { ok: true };
    // 其余祖先 = 裁剪 / pointer-events:none / 祖先层覆盖,坐标派发到不了目标。
    return { ok: false, blocker: describeElement(hit), kind: "ancestor" };
  }
  return { ok: false, blocker: describeElement(hit), kind: "overlay" };
}
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/hit-ownership.test.ts
```

Expected: PASS（24 个用例）

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/hit-ownership.ts packages/extension/tests/hit-ownership.test.ts
git commit -m "feat: 抽出命中归属判定纯函数 classifyHit"
```

---

### Task 2: actionability 门接线

**Files:**
- Modify: `packages/extension/src/page-side/actionability.ts:12`（import）、`:28-34`（`ActionabilityResult.extras` 类型）、`:37`（version 守卫 bump）、`:136-224`（`receivesEvents` 整体替换）、`:382`（`extras` 带上 kind）
- Test: `packages/extension/tests/actionability-ancestor-hit.test.ts`

**Interfaces:**
- Consumes: `classifyHit` from Task 1
- Produces: `probe()` 在祖先命中时返回 `{ ok: false, reason: "OBSCURED", extras: { blocker, hitKind: "ancestor", modalBlocked } }`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/actionability-ancestor-hit.test.ts`：

```typescript
/**
 * Author: qingwa
 * Description: 门在「中心点命中目标的非交互祖先」时必须判 OBSCURED。
 *   2026-08-15 spike:三种祖先命中场景在 realMouse 下全部 success:true 而页面零 click。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function probeWith(html: string, targetId: string, hitId: string | null) {
  vi.resetModules();
  const dom = setupActionabilityEnv({ html });
  const doc = dom.window.document;
  const target = doc.getElementById(targetId)!;
  // 非 0×0 rect,否则 isVisible 先拦 NOT_VISIBLE 而测不到 receivesEvents。
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    (el as any).getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
  }
  const hit = hitId ? doc.getElementById(hitId) : null;
  Object.defineProperty(doc, "elementFromPoint", { value: () => hit, configurable: true });
  await import("../src/page-side/actionability.js");
  const probe = (globalThis.window as any).__vortexActionability.probe;
  return probe("#" + targetId, false);
}

describe("actionability 祖先命中", () => {
  it("非交互祖先命中 → OBSCURED 且点名祖先", async () => {
    const r = await probeWith(`<div id="wrap" class="row"><button id="b">x</button></div>`, "b", "wrap");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("OBSCURED");
    expect(r.extras.blocker).toBe("div#wrap.row");
    expect(r.extras.hitKind).toBe("ancestor");
  });

  it("交互祖先命中 → 维持放行（回归保护）", async () => {
    const r = await probeWith(`<button id="b"><span id="s">x</span></button>`, "s", "b");
    expect(r.ok).toBe(true);
  });

  it("命中自己 → 放行（回归保护）", async () => {
    const r = await probeWith(`<button id="b">x</button>`, "b", "b");
    expect(r.ok).toBe(true);
  });

  it("兄弟覆盖层 → OBSCURED 且 kind=overlay（回归保护）", async () => {
    const r = await probeWith(`<button id="b">x</button><div id="ov">m</div>`, "b", "ov");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("OBSCURED");
    expect(r.extras.blocker).toBe("div#ov");
    expect(r.extras.hitKind).toBe("overlay");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/actionability-ancestor-hit.test.ts
```

Expected: FAIL — 第 1 例 `r.ok` 是 `true`（当前 `hit.contains(el)` 放行），且 `extras.hitKind` 为 `undefined`

- [ ] **Step 3: 接线**

`packages/extension/src/page-side/actionability.ts` 第 12 行 import 追加：

```typescript
import { classifyHit } from "./hit-ownership.js";
```

`:33` 的 `extras` 类型补两个字段（`modalBlocked` 现有代码已在传但类型里没有，一并补上）：

```typescript
      extras?: { blocker?: string; tagName?: string; hasReadOnly?: boolean; inert?: boolean; ariaValueWidget?: string; hitKind?: "overlay" | "ancestor"; modalBlocked?: boolean };
```

`:37` 的 version 守卫 bump 到 2（**不 bump 则真浏览器上残留的旧 IIFE 让本 Task 完全不生效，而单测因 `vi.resetModules()` 照样绿**）：

```typescript
  if ((window as any).__vortexActionability?.version === 2) return;
```

同时把该 IIFE 内导出对象上的 `version: 1` 改成 `version: 2`。

把 `:136-224` 的整个 `receivesEvents` 函数体替换为（保留函数签名，调用点不动）：

```typescript
  function receivesEvents(
    el: Element,
    cx: number,
    cy: number,
  ): { ok: boolean; blocker?: string; kind?: "overlay" | "ancestor" } {
    // 判据收敛到 hit-ownership.classifyHit(单一真源,dom.ts / cdp.ts 同款)。
    const own = classifyHit(el, deepElementFromPoint(cx, cy));
    return own.ok ? { ok: true } : { ok: false, blocker: own.blocker, kind: own.kind };
  }
```

`:382` 的 OBSCURED 返回补上 kind（`re` 是 `receivesEvents` 的结果）：

```typescript
        return { ok: false, reason: "OBSCURED", extras: { blocker: re.blocker, hitKind: re.kind, modalBlocked } };
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/actionability-ancestor-hit.test.ts
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
```

Expected: 新测试 4/4 PASS；全量套件无新增失败（尤其 `actionability-*.test.ts`、`auto-wait-*.test.ts`）。若 `auto-wait-modal-hint.test.ts` 因 `extras` 多了 `hitKind` 而失败，改断言用 `expect.objectContaining`，不要回退实现。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/actionability.ts packages/extension/tests/actionability-ancestor-hit.test.ts
git commit -m "fix: 门在命中非交互祖先时判 OBSCURED，不再无条件放行"
```

---

### Task 3: 经 `dom-resolve` 暴露给注入路径

**Files:**
- Modify: `packages/extension/src/page-side/dom-resolve.ts:5-10`（import）、`:13-14`（version 守卫 bump）、末尾新增 `classifyHit` 成员
- Test: `packages/extension/tests/dom-resolve-classify-hit.test.ts`

**Interfaces:**
- Consumes: `classifyHit` from Task 1
- Produces: `window.__vortexDomResolve.version === 2`、`window.__vortexDomResolve.classifyHit(el, hit): HitOwnership`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/dom-resolve-classify-hit.test.ts`：

```typescript
/**
 * Author: qingwa
 * Description: dom-resolve 暴露 classifyHit 给 dom.ts / cdp.ts 的注入函数。
 *   version 必须同步 bump——页面上残留的 v1 对象会让新方法 undefined。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";

afterEach(() => vi.resetModules());

async function loadInto(html: string, preset?: { version: number }) {
  vi.resetModules();
  const dom = new JSDOM(`<body>${html}</body>`);
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  if (preset) (dom.window as any).__vortexDomResolve = preset;
  await import("../src/page-side/dom-resolve.js");
  return dom.window.document;
}

describe("dom-resolve.classifyHit", () => {
  it("暴露 classifyHit 且 version 为 2", async () => {
    await loadInto(`<div id="w"><button id="b">x</button></div>`);
    const ns = (globalThis as any).window.__vortexDomResolve;
    expect(ns.version).toBe(2);
    expect(typeof ns.classifyHit).toBe("function");
  });

  it("非交互祖先 → ancestor", async () => {
    const doc = await loadInto(`<div id="w" class="row"><button id="b">x</button></div>`);
    const ns = (globalThis as any).window.__vortexDomResolve;
    expect(ns.classifyHit(doc.getElementById("b"), doc.getElementById("w"))).toEqual({
      ok: false, blocker: "div#w.row", kind: "ancestor",
    });
  });

  it("残留的 v1 对象会被替换（version 守卫不得把新方法挡在外面）", async () => {
    await loadInto(`<button id="b">x</button>`, { version: 1 });
    const ns = (globalThis as any).window.__vortexDomResolve;
    expect(ns.version).toBe(2);
    expect(typeof ns.classifyHit).toBe("function");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/dom-resolve-classify-hit.test.ts
```

Expected: FAIL — `expect(ns.version).toBe(2)` 收到 `1`；`ns.classifyHit` 是 `undefined`

- [ ] **Step 3: 实现**

`packages/extension/src/page-side/dom-resolve.ts`：import 段追加

```typescript
import { classifyHit } from "./hit-ownership.js";
```

版本守卫改为（v1 残留必须被替换）：

```typescript
  if ((window as any).__vortexDomResolve?.version === 2) return;
  (window as any).__vortexDomResolve = {
    version: 2,
```

在 `isEnabled` 成员之后追加：

```typescript
    // 命中归属判定,与门 actionability.receivesEvents 共用 hit-ownership.classifyHit。
    // 注入函数丢模块作用域,只能经这里拿(#1a,2026-08-15)。
    classifyHit: (el: Element, hit: Element | null) => classifyHit(el, hit),
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/dom-resolve-classify-hit.test.ts
```

Expected: PASS（3/3）

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/dom-resolve.ts packages/extension/tests/dom-resolve-classify-hit.test.ts
git commit -m "feat: dom-resolve 暴露 classifyHit 并 bump version 到 2"
```

---

### Task 4: CDP realMouse 路径接线

**Files:**
- Modify: `packages/extension/src/adapter/cdp.ts:171-205`（删掉内联 `isInteractiveEl` / `sameWidgetDecoration` / contains 判据，改调 `resolve.classifyHit`）
- Test: `packages/extension/tests/cdp-click-ancestor-hit.test.ts`

**Interfaces:**
- Consumes: `window.__vortexDomResolve.classifyHit` from Task 3
- Produces: `cdpClickElement` 在祖先命中时返回 `{ errorCode: "ELEMENT_OCCLUDED", error: "Element <sel> is covered by <desc>", extras: { blocker, hitKind } }`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/cdp-click-ancestor-hit.test.ts`。注入函数丢模块作用域，故用 `new Function` 剥离作用域复刻注入（直接调 import 来的函数会假绿）：

```typescript
/**
 * Author: qingwa
 * Description: cdp.ts realMouse 路径的遮挡检查改用 __vortexDomResolve.classifyHit。
 *   注入函数经 executeScript 序列化 toString 后丢模块作用域,故用 new Function
 *   剥离作用域复刻注入环境——直接调 import 的函数测不出 "X is not defined"。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cdpClickElement } from "../src/adapter/cdp.js";
import { classifyHit } from "../src/page-side/hit-ownership.js";

// 照 tests/click-synthetic-inline-scope.test.ts 的范式:捕获**真实**注入 func,
// 用 new Function 剥离模块闭包后真执行。手写一段等价代码测不出裸引用模块级
// helper 的 ReferenceError,也测不到真实的 topEl 获取与返回路径。
let dom: JSDOM;
let lastResult: unknown;

function installChrome(withResolve: boolean) {
  const win = dom.window as any;
  win.__vortexDomResolve = withResolve
    ? { deepElementFromPoint: (x: number, y: number) => win.document.elementFromPoint(x, y),
        queryAllDeep: (s: string) => Array.from(win.document.querySelectorAll(s)),
        isEnabled: () => true,
        classifyHit: (a: Element, b: Element | null) => classifyHit(a, b) }
    : undefined;
  (globalThis as any).chrome = {
    scripting: {
      executeScript: async ({ func, args }: { func: Function; args: unknown[] }) => {
        // 关键:String(func) 后重新求值 —— 模块作用域在此彻底丢失。
        const stripped = new Function("return (" + String(func) + ")")();
        lastResult = await stripped(...args);
        return [{ result: lastResult }];
      },
    },
    debugger: { sendCommand: async () => ({}) },
  };
}

beforeEach(() => {
  dom = new JSDOM(`<body><div id="w" class="row"><button id="b">x</button></div></body>`, { pretendToBeVisual: true });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  const btn = dom.window.document.getElementById("b")!;
  const wrap = dom.window.document.getElementById("w")!;
  (btn as any).getBoundingClientRect = () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, left: 10, right: 30, bottom: 30 });
  Object.defineProperty(dom.window.document, "elementFromPoint", { value: () => wrap, configurable: true });
  vi.restoreAllMocks();
});

// cdpClickElement 实际调用 debuggerMgr.attach + debuggerMgr.sendCommand（cdp.ts:59-64），
// 缺 sendCommand 时 force=true 用例会崩在 "not a function" 而非测到判定逻辑。
const mkMgr = () => ({ attach: vi.fn(async () => {}), sendCommand: vi.fn(async () => ({})) }) as any;

describe("cdp realMouse 祖先命中", () => {
  // page-side 结果带 error 时 cdpClickElement 走 mapPageError（native.ts:65，`: never`）
  // 直接抛异常，所以断言必须用 rejects —— 直接 await 再查 lastResult 测不到抛错路径。
  it("剥离模块作用域后真执行：非交互祖先 → 抛 ELEMENT_OCCLUDED 且点名祖先", async () => {
    installChrome(true);
    await expect(cdpClickElement(mkMgr(), 1, undefined, "#b", {})).rejects.toMatchObject({
      code: "ELEMENT_OCCLUDED",
    });
    expect(lastResult).toMatchObject({ extras: { blocker: "div#w.row", hitKind: "ancestor" } });
  });

  it("classifyHit 不可用（模块未注入 / 刚导航）→ fail closed 抛 NOT_ATTACHED", async () => {
    installChrome(false);
    await expect(cdpClickElement(mkMgr(), 1, undefined, "#b", {})).rejects.toMatchObject({
      code: "NOT_ATTACHED",
    });
    expect(JSON.stringify(lastResult)).toContain("page likely navigated");
  });

  it("force=true → 跳过判定照常派发（回归保护）", async () => {
    installChrome(true);
    const mgr = mkMgr();
    await cdpClickElement(mgr, 1, undefined, "#b", { force: true });
    expect((lastResult as any).errorCode).toBeUndefined();
    expect((lastResult as any).result).toMatchObject({ tag: "button" });
    expect(mgr.sendCommand).toHaveBeenCalled(); // 真派发过，不是提前 return
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/cdp-click-ancestor-hit.test.ts
```

Expected: FAIL — 第 1 例：源码里还有 `!topEl.contains(el)`、没有 `classifyHit`

- [ ] **Step 3: 接线**

`packages/extension/src/adapter/cdp.ts`：删除 `:171-194` 的内联 `isInteractiveEl` 与 `sameWidgetDecoration` 计算，把 `:195-216` 的 `if (!force) { ... }` 整块替换为：

```typescript
        // 命中归属判定收敛到 __vortexDomResolve.classifyHit(与门同一真源)。
        if (!force) {
          // fail closed:判定不可用(模块未注入 / 两次 executeScript 之间页面导航)时
          // 报 NOT_ATTACHED。**不会自动恢复**——派发在 gate 之后,这里的 errorCode 经
          // mapPageError 直接抛出,不回到 auto-wait 自旋(codex 二轮 P1-1)。但这是正确
          // 语义:导航后本就该重新 observe。静默放行才是把 P0 根因留在降级路径上。
          if (!resolve?.classifyHit) {
            return {
              errorCode: "NOT_ATTACHED",
              error: `Hit-ownership check unavailable for ${sel} (page-side module missing — page likely navigated); retry re-injects it`,
            };
          }
          const own = resolve.classifyHit(el, topEl) as { ok: boolean; blocker?: string; kind?: string };
          if (!own.ok) {
            return {
              errorCode: "ELEMENT_OCCLUDED",
              error: `Element ${sel} is covered by <${own.blocker}>`,
              extras: { blocker: own.blocker, hitKind: own.kind },
            };
          }
        }
        return {
          result: {
            x: cxInner,
            y: cyInner,
            tag: el.tagName.toLowerCase(),
            text: el.innerText?.slice(0, 200),
          },
        };
```

- [ ] **Step 4: 跑测试确认通过 + 全量**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/cdp-click-ancestor-hit.test.ts
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
```

Expected: 新测试 2/2 PASS；全量无新增失败

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/adapter/cdp.ts packages/extension/tests/cdp-click-ancestor-hit.test.ts
git commit -m "fix: cdp realMouse 路径改用 classifyHit 判命中归属"
```

---

### Task 5: 合成 click 路径接线

**Files:**
- Modify: `packages/extension/src/handlers/dom.ts:405-432`（同款 contains 判据 → `classifyHit`；`isTransientOverlay` 豁免按 `kind` 分流）
- Modify: 同文件 CLICK 的 `executeScript` 调用——**把 `force` 加进 `args` 与注入 `func` 的参数列表**。合成路径此前压根收不到 `force`（`0f9db90` 的 CHANGELOG 把它记为「未归因的不一致」），不传就没法与 CDP 的 `if (!force)` 对齐。
- Test: `packages/extension/tests/dom-click-ancestor-hit.test.ts`

**Interfaces:**
- Consumes: `window.__vortexDomResolve.classifyHit` from Task 3
- Produces: 合成路径同样返回 `{ errorCode: "ELEMENT_OCCLUDED", extras: { blocker, hitKind } }`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/dom-click-ancestor-hit.test.ts`：

```typescript
/**
 * Author: qingwa
 * Description: 合成 click 路径(element.click())的遮挡检查与 CDP 路径、门三者同判据。
 *   合成 click 本身绕过 hit-test(2026-08-15 spike 实测:三种祖先命中场景在合成路径下
 *   全部"点中"),所以这道检查是合成路径唯一的真实性保障。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { classifyHit } from "../src/page-side/hit-ownership.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/auto-wait.js", () => ({ waitActionable: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

let dom: JSDOM;
let lastResult: any;
let router: ActionRouter;

// 捕获真实注入 func 并 new Function 剥离模块闭包后执行（同
// tests/click-synthetic-inline-scope.test.ts）。source-grep 测不出注入期问题。
function setup(ancestorHtml: string) {
  dom = new JSDOM(`<body>${ancestorHtml}</body>`, { pretendToBeVisual: true });
  const win = dom.window as any;
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  const btn = win.document.getElementById("b")!;
  const wrap = win.document.getElementById("w")!;
  btn.getBoundingClientRect = () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, left: 10, right: 30, bottom: 30 });
  Object.defineProperty(win.document, "elementFromPoint", { value: () => wrap, configurable: true });
  win.__vortexDomResolve = {
    queryAllDeep: (s: string) => Array.from(win.document.querySelectorAll(s)),
    deepElementFromPoint: () => wrap,
    isEnabled: () => true,
    classifyHit: (a: Element, b: Element | null) => classifyHit(a, b),
  };
  (globalThis as any).chrome = {
    scripting: {
      executeScript: async ({ func, args }: { func: Function; args: unknown[] }) => {
        const stripped = new Function("return (" + String(func) + ")")();
        lastResult = await stripped(...args);
        return [{ result: lastResult }];
      },
    },
  };
  router = new ActionRouter();
  registerDomHandlers(router, undefined as any);
}

const click = (args: Record<string, unknown>) =>
  router.dispatch({ type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" } as NmRequest);

beforeEach(() => vi.clearAllMocks());

describe("合成 click 祖先命中", () => {
  it("非交互祖先 → ELEMENT_OCCLUDED（注入期真执行）", async () => {
    setup(`<div id="w" class="row"><button id="b">x</button></div>`);
    await click({ selector: "#b" });
    expect(lastResult).toMatchObject({ errorCode: "ELEMENT_OCCLUDED", extras: { hitKind: "ancestor" } });
  });

  it("祖先带 transform（swiper 轨道）仍被拦——transient 豁免不适用于祖先命中", async () => {
    setup(`<div id="w" style="transform: translateX(-400px)"><button id="b">题3</button></div>`);
    // jsdom 不算 computed transform，直接让 isTransient 的判据命中 aria-hidden 等价物：
    dom.window.document.getElementById("w")!.setAttribute("aria-hidden", "true");
    await click({ selector: "#b" });
    expect(lastResult).toMatchObject({ errorCode: "ELEMENT_OCCLUDED", extras: { hitKind: "ancestor" } });
  });

  it("transient 兄弟浮层仍豁免（回归保护，kind=overlay 才吃豁免）", async () => {
    setup(`<div id="w" aria-hidden="true">mask</div><button id="b">x</button>`);
    const win = dom.window as any;
    const mask = win.document.getElementById("w")!;
    win.__vortexDomResolve.deepElementFromPoint = () => mask;
    Object.defineProperty(win.document, "elementFromPoint", { value: () => mask, configurable: true });
    await click({ selector: "#b" });
    expect(lastResult?.errorCode).toBeUndefined();
  });

  it("force=true → 跳过判定（与 CDP 路径对齐）", async () => {
    setup(`<div id="w" class="row"><button id="b">x</button></div>`);
    await click({ selector: "#b", force: true });
    expect(lastResult?.errorCode).toBeUndefined();
  });

  it("classifyHit 不可用 → fail closed 报 NOT_ATTACHED", async () => {
    setup(`<div id="w" class="row"><button id="b">x</button></div>`);
    delete (dom.window as any).__vortexDomResolve.classifyHit;
    await click({ selector: "#b" });
    expect(lastResult).toMatchObject({ errorCode: "NOT_ATTACHED" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/dom-click-ancestor-hit.test.ts
```

Expected: FAIL — 5 例里前两例失败（当前祖先命中放行，`lastResult` 没有 `errorCode`）；`force` 那例也失败（注入函数还没有 `force` 参数）

- [ ] **Step 3: 接线**

先把 `force` 送进注入函数（`args` 末尾追加 `args.force === true`，`func` 参数列表相应追加 `force: boolean`），再把判定条件替换为（`sameWidgetDecoration` 已并入 `classifyHit`，此处不再单独计算）：

```typescript
            const isTransientOverlay = isTransientInline(topEl);
            const __resolve = (window as any).__vortexDomResolve;
            if (!force) {
              // fail closed,同 cdp.ts:判定不可用时报可重试的 NOT_ATTACHED。
              if (!__resolve?.classifyHit) {
                return {
                  errorCode: "NOT_ATTACHED",
                  error: `Hit-ownership check unavailable for ${sel} (page-side module missing — page likely navigated); retry re-injects it`,
                };
              }
              const __own = __resolve.classifyHit(el, topEl) as { ok: boolean; blocker?: string; kind?: string };
              // transient 豁免**只对 overlay 成立**:它的语义是「兄弟浮层在做动画,点击会
              // 冒泡到目标」。祖先命中不会因为祖先在做动画而变得可点——而 isTransient 的
              // 判据里恰好有「transform 含 matrix」,swiper 轨道正是 translateX,不分流的话
              // 本次修复在合成路径上对原始 bug 场景完全失效(codex 审核 P1-2)。
              const exempt = __own.kind === "overlay" && isTransientOverlay;
              if (!__own.ok && !exempt) {
                return {
                  errorCode: "ELEMENT_OCCLUDED",
                  error: `Element ${sel} is covered by <${__own.blocker}>`,
                  extras: { blocker: __own.blocker, hitKind: __own.kind },
                };
              }
            }
```

- [ ] **Step 4: 跑测试确认通过 + 全量**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/dom-click-ancestor-hit.test.ts
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
```

Expected: 新测试 2/2 PASS；全量无新增失败

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/dom.ts packages/extension/tests/dom-click-ancestor-hit.test.ts
git commit -m "fix: 合成 click 路径改用 classifyHit，与门和 CDP 路径同判据"
```

---

### Task 6: 祖先命中的错误话术

**Files:**
- Modify: `packages/extension/src/action/auto-wait.ts:126-175`（`hitKind === "ancestor"` 分支）
- Modify: `packages/shared/src/errors.hints.ts:164`（OBSCURED hint 补祖先分支指引）
- Test: `packages/extension/tests/auto-wait-ancestor-message.test.ts`

**Interfaces:**
- Consumes: `extras.hitKind` from Task 2
- Produces: 超时消息 `Element's center hit-tests to its own ancestor <desc> ...`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/auto-wait-ancestor-message.test.ts`：

```typescript
/**
 * Author: qingwa
 * Description: 祖先命中的话术必须与「被浮层盖住」区分——修法完全不同:
 *   浮层要关掉,祖先裁剪要滚动容器/换目标,让调用方去找浮层是死路。
 */
import { describe, it, expect } from "vitest";
import { buildActionabilityTimeoutMessage } from "../src/action/auto-wait.js";

describe("祖先命中话术", () => {
  it("hitKind=ancestor → 点名祖先并给裁剪/pointer-events 处方", () => {
    const msg = buildActionabilityTimeoutMessage({
      timeout: 2000, lastReason: "OBSCURED",
      lastExtras: { blocker: "div#track-wrap", hitKind: "ancestor", modalBlocked: false },
    });
    expect(msg).toContain("div#track-wrap");
    expect(msg).toContain("ancestor");
    expect(msg).not.toContain("dismiss");
  });

  it("hitKind=overlay → 保持既有「被谁盖住」话术（回归保护）", () => {
    const msg = buildActionabilityTimeoutMessage({
      timeout: 2000, lastReason: "OBSCURED",
      lastExtras: { blocker: "div#mask", hitKind: "overlay", modalBlocked: false },
    });
    expect(msg).toContain("covered by <div#mask>");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/auto-wait-ancestor-message.test.ts
```

Expected: FAIL — `buildActionabilityTimeoutMessage` 未导出（当前消息构造内联在 `waitActionable` 里）

- [ ] **Step 3: 抽出消息构造并加分支**

`packages/extension/src/action/auto-wait.ts`：把 `:126-175` 的消息构造抽成导出函数（`waitActionable` 改为调用它），并在 `blocker` 分支之前插入祖先分支：

```typescript
export function buildActionabilityTimeoutMessage(a: {
  timeout: number;
  lastReason?: string;
  lastExtras?: { blocker?: string; hitKind?: string; modalBlocked?: boolean };
}): string {
  const { timeout, lastReason, lastExtras } = a;
  const modalBlocked = lastReason === "OBSCURED" && lastExtras?.modalBlocked === true;
  const blocker = lastReason === "OBSCURED" && !modalBlocked ? lastExtras?.blocker : undefined;
  const noHit = blocker === "elementFromPoint=null";
  if (modalBlocked) {
    return `Actionability timeout after ${timeout}ms; last reason: OBSCURED ` +
      `(element is covered by an open modal <dialog> in the top layer; the rest of the page is ` +
      `inert while it is open — dismiss the dialog first, e.g. press Escape or click its close button, then retry)`;
  }
  if (noHit) {
    return `Hit-testing the element's center reached no element at all after ${timeout}ms ` +
      `(clipped by an ancestor, or positioned outside the viewport)`;
  }
  // 祖先命中:目标在 DOM 里、CSS 上也"可见",但中心点 hit-test 落到自己的祖先——
  // 被祖先 overflow:hidden 裁掉、pointer-events:none、或祖先自身层压在上面。
  // 与浮层遮挡的修法完全不同,不能让调用方去关一个不存在的浮层。
  if (blocker && lastExtras?.hitKind === "ancestor") {
    return `Element's center hit-tests to its own ancestor <${blocker}> after ${timeout}ms ` +
      `(clipped by that ancestor, pointer-events:none, or the ancestor paints over it) — ` +
      `a real click at those coordinates would not reach the target; ` +
      `scroll that container to bring the element into its visible area, or target the element that actually receives the click`;
  }
  if (blocker) {
    return `Element is covered by <${blocker}> after ${timeout}ms of retrying; ` +
      `hit-testing its center reaches that element, not the target`;
  }
  return `Actionability timeout after ${timeout}ms; last reason: ${lastReason ?? "unknown"}`;
}
```

`packages/shared/src/errors.hints.ts:164` 的 OBSCURED hint 末尾追加一句：

```
If the message says the hit-test reached the element's own ancestor, waiting will never help — the element is clipped or non-interactive at those coordinates.
```

- [ ] **Step 4: 跑测试确认通过 + 全量**

```bash
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1 tests/auto-wait-ancestor-message.test.ts
pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
pnpm --filter @vortex-browser/shared test -- --maxWorkers=2 --minWorkers=1
```

Expected: 新测试 2/2 PASS；`auto-wait-modal-hint.test.ts` 等既有话术测试全绿

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/action/auto-wait.ts packages/shared/src/errors.hints.ts packages/extension/tests/auto-wait-ancestor-message.test.ts
git commit -m "fix: 祖先命中给独立话术，不再指引去关不存在的浮层"
```

---

### Task 7: live 验证 + bench + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- 复用：`/private/tmp/claude-501/-Users-lg-workspace-vortex/91c5ffb4-b44a-4495-898b-8e4e5cd12200/scratchpad/spike-ancestor-hit.html`

**Interfaces:**
- Consumes: Task 1-6 全部改动
- Produces: 无代码产物

- [ ] **Step 1: 完整构建并重载扩展**

```bash
pnpm build
```

然后 `vortex_dev_reload`（需 `--caps=dev`）或手动在扩展页 reload。**必须整包 `pnpm build`**：`vite build:main` 会清掉 `dist/page-side`，只跑单包构建会留下陈旧 page-side（历史坑）。

- [ ] **Step 2: live 复跑三个必拦场景**

打开 `spike-ancestor-hit.html`，逐个跑：

```
vortex_act { target: "#penbox",  action: "click", useRealMouse: true }
vortex_act { target: "#covered", action: "click", useRealMouse: true }
vortex_act { target: "#clipped", action: "click", useRealMouse: true }
```

Expected: 三次都抛 `ELEMENT_OCCLUDED` / `OBSCURED`，消息点名 `div.row` / `div#cp.cover-parent` / `div.row`，**不再是 `success: true`**。
再跑 `vortex_evaluate` 读 `window.__hits`，应为 `[]`（本来就到不了，现在是明确报错而非静默）。

- [ ] **Step 3: live 复跑三个必放行场景（回归）**

```
vortex_act { target: "#realradio", action: "click", useRealMouse: true }   → success，__hits 含 realradio.click
vortex_act { target: "#vis",       action: "click", useRealMouse: true }   → success，__hits 含 vis.click
vortex_act { target: "#lab1",      action: "click", useRealMouse: true }   → success
```

再对合成路径重跑一遍同样 6 个目标（不传 `useRealMouse`），两条路径判定必须一致。

补三个只能 live 验的场景（单测环境覆盖不到，codex 审核 P2-3 / P2-4）：

1. **iframe 内目标**：把 spike 页用 `<iframe>` 套一层，`vortex_act` 带 `frameId` 点 `#clipped`。判定必须发生在目标 frame——若报的 blocker 是主文档的元素，说明 `__vortexDomResolve` 取到了错 frame 的 window。
2. **open shadow 内目标**：`evaluate` 在页面上 `attachShadow` 塞一个被 host 裁剪的按钮，act 它 → 应报 `ancestor` 并点名 host（验证 `composedContains` 真的穿了 shadow；`Element.contains` 在这里恒 false）。
3. **导航后立即 act**：`vortex_navigate` 到 spike 页后**不做任何 observe** 直接 act `#clipped`。`webNavigation.onCommitted` 清 loader 缓存 → 本次调用的 `loadPageSideModule` 重新注入 → 正常路径应直接报 `ELEMENT_OCCLUDED / ancestor`。若报 `NOT_ATTACHED: Hit-ownership check unavailable`，说明撞上了导航竞态、fail-closed 生效（可接受，**但不会自动恢复**，需再调一次确认第二次成功）。**唯一不可接受的结果是静默 `success:true`**——那说明 Task 4/5 的接线有漏。

- [ ] **Step 4: bench 全跑**

```bash
pnpm --filter @vortex-browser/vortex-bench bench
```

Expected: 与改动前同样的通过数。**live bench 期间不要并行跑 vitest**（CPU 争用会造成假失败）。若有用例因这次收紧而失败，先判断它依赖的是不是旧的宽松行为——是则改用例并在 CHANGELOG 里点名，不是则回到 Task 1 重新审判据。

- [ ] **Step 5: 写 CHANGELOG 并提交**

在 `CHANGELOG.md` 的 Unreleased 段追加：

```markdown
- **`act` 点击被祖先裁剪 / `pointer-events:none` / 祖先层覆盖的元素时返回 `success:true` 而页面零 click**（新增 `packages/extension/src/page-side/hit-ownership.ts`；`actionability.ts:136`、`cdp.ts:195`、`dom.ts:411` 三处收敛到它）。三条路径各存一份逐字拷贝的 `hit === el || el.contains(hit) || hit.contains(el)` 判据，第三个条件把「中心点命中的是目标自己的祖先」也无条件放行——而这恰恰是目标被裁剪/不接收指针的典型信号。**2026-08-15 spike 实测**：realMouse 下 `pointer-events:none`、祖先 `::after` 覆盖、祖先 `overflow:hidden` 裁剪三种场景全部 `success:true`，页面监听器一个 click 都没收到；合成路径下则「点得到」（`element.click()` 绕过 hit-test），即真实用户点不到的东西工具点得到。收紧为：非交互祖先命中 → `OBSCURED` 并点名该祖先；**交互祖先维持放行**（`button` 内 `pointer-events:none` 的 `span`，点击落在它身上语义等价）。话术与浮层遮挡分开——祖先裁剪等多久都没用。
  - 顺带修正 `0f9db90` 的一条结论：那次「`act` click 不属于静默假成功」的核实只覆盖了兄弟遮挡（门确实有效），祖先命中这一路从三道门的同一个缺口穿过。
  - **祖先放行走严格白名单**：交互 role 白名单 + 原生交互标签 + `<label>`（须与目标关联）。宽松版（任意 `role` / `tabindex` 都算交互）会放行 `role="group"` 的 swiper 轨道、`role="presentation"` 的装饰容器、`tabindex="-1"` 的 programmatic-focus 容器——正是要拦的那一类。装饰层 carve-out 仍用原来的宽松判据，两者拆成 `isClickTargetAncestor` / `isWidgetContainer`，互不影响。
  - **transient 豁免按 `kind` 分流**：`isTransient` 的判据含「transform 含 matrix」，而 swiper 轨道正是 `translateX`——不分流的话合成路径对原始 bug 场景完全豁免掉。豁免只对兄弟浮层（`kind="overlay"`）成立。
  - **命中归属按 composed 树算**：`Element.contains` 不穿 shadow，shadow 内目标对其 light-DOM host 恒 false，会全部落进 overlay 分支、话术指错方向。新增 `composedContains` 沿 `parentNode ?? host` 上溯。
  - **判定不可用时 fail closed**：`__vortexDomResolve.classifyHit` 取不到（页面在两次 `executeScript` 之间导航）时报可重试的 `NOT_ATTACHED`，由自旋重新注入模块恢复——静默放行等于把根因原样留在降级路径上。
  - **顺带修掉合成路径不认 `force`**（`0f9db90` 记为待查的那条）：`force` 此前根本没进注入函数的入参列表，于是 `force:true` 跳过 gate 后仍会被合成路径内的遮挡检查拦住，与 CDP 路径行为不一致。现在两条路径都在 `if (!force)` 内做判定。
```

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录祖先命中放行的修复"
```

---

## Self-Review

**1. Spec 覆盖**：思路文档 §5 改动地图的 6 个文件全部有对应 Task（`hit-ownership.ts`→T1、`actionability.ts`→T2、`dom-resolve.ts`→T3、`cdp.ts`→T4、`dom.ts`→T5、`errors.hints.ts`+`auto-wait.ts`→T6）；§7 两条待验证（共享方式的降级可达性、bench 依赖）分别由 T4 Step 3 的 `resolve?.classifyHit` 降级分支与 T7 Step 4 覆盖。

**2. 占位符**：无 TBD / “类似 Task N” / 无代码的测试步骤。

**3. 类型一致性**：`HitOwnership` 的 `kind` 在 T1 定义为 `"overlay" | "ancestor"`，T2 存进 `extras.hitKind`（并同步扩展 `ActionabilityResult.extras` 类型），T4/T5 同名透传，T6 读同名字段——四处一致。`classifyHit(el, hit)` 参数顺序四处一致；`isClickTargetAncestor(el, hit)` 与 `isWidgetContainer(el)` 参数数量不同，T1 测试已分别覆盖。

## 审核修订记录（codex `gpt-5.6-luna`，2026-08-15）

8 条意见，核实后 7 条采纳、1 条降级：

| 意见 | 核实结论 | 处置 |
|---|---|---|
| P1 `isInteractiveElement` 过宽、漏 `<label>` | **成立**。`!!getAttribute("role")` 会放行 `role="group"` 的 swiper 轨道 | T1 拆成严格白名单 + 宽松容器判据 |
| P1 合成路径 transient 豁免绕过修复 | **成立且致命**。`isTransient` 含「transform 含 matrix」，swiper 轨道必中 | T5 豁免按 `kind` 分流 |
| P1 T4/T5 注入测试假绿 | **成立**。原测试是 source-grep + 手写等价代码 | 两处改用 `new Function("return ("+String(func)+")")()` 捕获真实注入函数执行 |
| P1 CDP `resolve` 缺失时 fail open | **成立**（暴露面比意见描述小：调用方已强制 `await loadPageSideModule`，窗口仅限「加载后、执行前导航」） | T4/T5 改 fail closed → 可重试 `NOT_ATTACHED` |
| P2 `ActionabilityResult` 类型未同步 | **成立**，且现有 `modalBlocked` 本来就没在类型里 | T2 一并补 |
| P2 `force` 三路径不统一 | **成立**，正是 `0f9db90` 记为待查的那条 | T5 把 `force` 送进注入函数 |
| P2 frameId/shadow 无行为测试 | **成立** | T1 加 shadow 单测；T7 加 iframe / shadow / 导航三个 live 场景 |
| P2 loader 缓存让 version 守卫不执行 | **部分成立**：`page-side-loader.ts:132` 已有 `webNavigation.onCommitted` 清缓存，机制在，缺的是测试 | 不新增单测，由 T7 live 场景 3 覆盖 |

**审核未提、自查发现**：`actionability.ts:37` 自己也有 `version === 1` 守卫，改判据后不 bump 则真浏览器上残留旧 IIFE 让 T2 完全不生效，而单测因 `vi.resetModules()` 照样全绿——已写进 Global Constraints 与 T2。

### 第二轮复审（同日）

前两条致命项判定为已堵死（`exempt` 分流方向正确、`composedContains` 无死循环）。新提 6 条，全部采纳：

| 意见 | 核实结论 | 处置 |
|---|---|---|
| P1 `NOT_ATTACHED` 不会触发自旋，"自旋恢复"描述失实 | **成立**。派发在 gate 之后，`mapPageError`（`native.ts:65`，`: never`）直接抛出，不回 gate | 改描述而非机制：明确它不自动恢复，且这是正确语义（导航后本就该重新 observe）；T7 场景 3 的期望同步改写 |
| P1 T4 测试跑不通 | **成立两处**：`mapPageError` 抛错须用 `rejects`；`mgr` 缺 `sendCommand`（`cdp.ts:59-64` 实际调 `attach` + `sendCommand`），`force` 用例会崩在 "not a function" | 断言改 `rejects.toMatchObject({ code })`，mock 补齐两个方法并断言真派发过 |
| P2 `label.control == null` 无条件放行 | **成立**。`<label><div id=target></label>` 会被放行，但点 label 不激活 div | 改为 `control === el`，补无关联 label 的用例 |
| P2 白名单漏 `summary` / `area[href]` / `treeitem` | **成立** | 三者加入；`gridcell`/`row`/`region` 明确不加并写明理由（容器语义，可点性来自内部控件） |
| P2 两个 carve-out 仍用 `parentElement`/`contains`，不走 composed | **成立**。祖先分支穿了 shadow 而 carve-out 没穿，同一 shadow 场景三条路径判定会不一致 | 抽 `composedParent`，两个 carve-out 一并改；补 shadow 内装饰层用例 |
| P2 T7 验证前提写错 | 同第 1 条 | 一并改写 |
