# observe 盲区降级信号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** observe 遇虚拟列表/canvas/closed-shadow/截断时,在输出中发出行内标注 + 顶部 meta 摘要的盲区降级信号,让 agent 不再把局部当全局。

**Architecture:** 检测放 page-side scan(observe.ts MAIN world func,能访问 live DOM 的 aria 属性/后代计数/shadowRoot);信号字段经 ScannedElement→compact 映射透传到 MCP;渲染层(observe-render.ts)出行内 tag + 汇总顶部 meta 行。先做 Node 可单测的渲染层(TDD 干净),再做 page-side 检测(单测 + 强制活浏览器 spike)。

**Tech Stack:** TypeScript, vitest, vortex page-side MAIN-world executeScript, vortex MCP。

设计文档:`docs/superpowers/specs/2026-06-17-observe-blindspot-signal-design.md`
证据:`reports/_dogfood/spike-perception-blindspot-2026-06-17.md`

---

## 数据契约（贯穿全程，先对齐）

`blindspot` 字段加到 ScannedElement(observe.ts:86) 与 CompactElement(observe-render.ts:3):
```ts
blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low" };
```
`candidateCount` 加到 CompactFrame(observe-render.ts:64)。

渲染形态:
- 行内:`[virtual: <total>/<rendered>]` ｜ `[blindspot=canvas]` ｜ `[blindspot=shadow?]`(shadow 低置信带 `?`)
- 顶部 meta(Viewport 行后):`# blindspots: <role>@<ref> <kind>(...); ...`
- 截断 meta:`# truncated: returned <M> of ~<N> candidates`(per truncated frame)

---

## Task 1: 渲染层 — CompactElement.blindspot 行内 tag（renderObserveTree）

**Files:**
- Modify: `packages/mcp/src/lib/observe-render.ts:3-62`(加字段), `:390-392`(tree 行渲染)
- Test: `packages/mcp/tests/observe-render-blindspot.test.ts`(新建)

- [ ] **Step 1: 写失败测试**
```ts
import { describe, it, expect } from "vitest";
import { renderObserveTree } from "../src/lib/observe-render.js";

function obs(elements: any[]) {
  return { snapshotId: "s1", url: "http://x", elements };
}

describe("blindspot inline tag (tree)", () => {
  it("virtual list 渲染 [virtual: total/rendered]", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "div", role: "grid", name: "G", frameId: 0, blindspot: { kind: "virtual", total: 1000, rendered: 32 } },
    ]), null);
    expect(out).toContain("[virtual: 1000/32]");
  });
  it("canvas 渲染 [blindspot=canvas]", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0, blindspot: { kind: "canvas" } },
    ]), null);
    expect(out).toContain("[blindspot=canvas]");
  });
  it("closed shadow 低置信渲染 [blindspot=shadow?]", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "x-widget", role: "generic", name: "W", frameId: 0, blindspot: { kind: "shadow", confidence: "low" } },
    ]), null);
    expect(out).toContain("[blindspot=shadow?]");
  });
  it("无 blindspot 元素不打任何盲区 tag（负例）", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "button", role: "button", name: "OK", frameId: 0 },
    ]), null);
    expect(out).not.toContain("blindspot");
    expect(out).not.toContain("[virtual");
  });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: FAIL（`[virtual: ...]` 等未渲染）

- [ ] **Step 3: 实现**
在 `observe-render.ts` CompactElement 接口(:3-62)末尾加:
```ts
  /** 盲区降级信号:虚拟列表/canvas/closed-shadow。@since blindspot */
  blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low" };
```
加一个纯函数(放在 `stateFlags` 附近):
```ts
function blindspotTag(b?: CompactElement["blindspot"]): string {
  if (!b) return "";
  if (b.kind === "virtual") {
    const t = b.total != null && b.rendered != null ? `${b.total}/${b.rendered}` : (b.total != null ? `${b.total}/?` : "?");
    return ` [virtual: ${t}]`;
  }
  if (b.kind === "canvas") return " [blindspot=canvas]";
  return b.confidence === "low" ? " [blindspot=shadow?]" : " [blindspot=shadow]";
}
```
在 `renderObserveTree` 的行 push(:390-392)把 `${blindspotTag(e.blindspot)}` 接到 `offscreenSeg` 之后、`bboxSeg` 之前:
```ts
    lines.push(
      `${indent}${newPrefix}- ${e.role}${name}${ref}${stateFlags(e.state)}${weak}${cursor}${listener}${valueSeg}${comp}${err}${ctrl}${desc}${offscreenSeg}${blindspotTag(e.blindspot)}${bboxSeg}${hasChildren ? ":" : ""}`,
    );
```

- [ ] **Step 4: 运行确认通过**
Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add packages/mcp/src/lib/observe-render.ts packages/mcp/tests/observe-render-blindspot.test.ts
git commit -m "feat(observe): 渲染层盲区行内 tag(tree)"
```

---

## Task 2: 渲染层 — 顶部 meta 摘要 + compact 模式对齐

**Files:**
- Modify: `packages/mcp/src/lib/observe-render.ts` renderObserveTree(:233-241 区域插 meta)、renderObserveCompact(:233-241)
- Test: `packages/mcp/tests/observe-render-blindspot.test.ts`(追加)

- [ ] **Step 1: 追加失败测试**
```ts
describe("blindspot 顶部 meta 摘要", () => {
  it("汇总各盲区到 # blindspots 行", () => {
    const out = renderObserveTree(obs([
      { index: 29, tag: "div", role: "grid", name: "G", frameId: 0, blindspot: { kind: "virtual", total: 1000, rendered: 32 } },
      { index: 56, tag: "canvas", role: "img", name: "C", frameId: 0, blindspot: { kind: "canvas" } },
    ]), null);
    expect(out).toMatch(/# blindspots:.*grid.*virtual.*1000\/32/);
    expect(out).toMatch(/# blindspots:.*canvas/);
  });
  it("无盲区不出 # blindspots 行（负例）", () => {
    const out = renderObserveTree(obs([{ index: 0, tag: "button", role: "button", name: "OK", frameId: 0 }]), null);
    expect(out).not.toContain("# blindspots");
  });
  it("compact 模式同样渲染行内 tag", () => {
    const { renderObserveCompact } = require("../src/lib/observe-render.js");
    const out = renderObserveCompact(obs([
      { index: 0, tag: "div", role: "grid", name: "G", frameId: 0, blindspot: { kind: "virtual", total: 1000, rendered: 32 } },
    ]), null);
    expect(out).toContain("[virtual: 1000/32]");
  });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: FAIL

- [ ] **Step 3: 实现**
加汇总纯函数:
```ts
function blindspotSummary(elements: CompactElement[], snapshotHash: string | null): string | null {
  const parts: string[] = [];
  for (const e of elements) {
    const b = e.blindspot;
    if (!b) continue;
    const ref = refOf(e, snapshotHash);
    if (b.kind === "virtual") parts.push(`${e.role}@${ref} virtual(${b.total ?? "?"}/${b.rendered ?? "?"})`);
    else if (b.kind === "canvas") parts.push(`${e.role}@${ref} canvas-editor`);
    else parts.push(`${e.role}@${ref} shadow${b.confidence === "low" ? "?" : ""}`);
  }
  return parts.length ? `# blindspots: ${parts.join("; ")}` : null;
}
```
在 renderObserveTree 与 renderObserveCompact 的 `lines.push("")`(空行,分别 :203 / :300)**之前**插入:
```ts
  const bsLine = blindspotSummary(data.elements, snapshotHash);
  if (bsLine) lines.push(bsLine);
```
并在 renderObserveCompact 的元素行(:233-235)把 `${blindspotTag(el.blindspot)}` 接到 `offscreenSeg` 后:
```ts
    lines.push(
      `${newPrefix}${refOf(el, snapshotHash)} [${el.role}]${name}${stateFlags(el.state)}${valueSeg}${offscreenSeg}${blindspotTag(el.blindspot)}${bboxSeg}`,
    );
```

- [ ] **Step 4: 运行确认通过**
Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add packages/mcp/src/lib/observe-render.ts packages/mcp/tests/observe-render-blindspot.test.ts
git commit -m "feat(observe): 盲区顶部 meta 摘要 + compact 模式对齐"
```

---

## Task 3: 渲染层 — A4 截断量化 meta（candidateCount）

**Files:**
- Modify: `packages/mcp/src/lib/observe-render.ts:64-72`(CompactFrame 加 candidateCount), scanNotes 区(:246-253 与 :404-411)
- Modify: `packages/extension/src/handlers/observe.ts:2510 区域`(frame summary 透传 candidateCount)
- Test: `packages/mcp/tests/observe-render-blindspot.test.ts`(追加)

- [ ] **Step 1: 追加失败测试**
```ts
describe("A4 截断量化", () => {
  it("truncated frame 出 # truncated: returned M of ~N", () => {
    const data = { snapshotId: "s", url: "http://x", elements: [],
      frames: [{ frameId: 0, parentFrameId: -1, url: "http://x", offset: {x:0,y:0}, elementCount: 80, truncated: true, scanned: true, candidateCount: 247 }] };
    const out = renderObserveTree(data as any, null);
    expect(out).toMatch(/# truncated: returned 80 of ~247/);
  });
  it("未截断不出 truncated 行（负例）", () => {
    const data = { snapshotId: "s", url: "http://x", elements: [],
      frames: [{ frameId: 0, parentFrameId: -1, url: "http://x", offset: {x:0,y:0}, elementCount: 12, truncated: false, scanned: true, candidateCount: 12 }] };
    expect(renderObserveTree(data as any, null)).not.toContain("# truncated");
  });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: FAIL

- [ ] **Step 3: 实现**
CompactFrame(:64-72) 加:
```ts
  candidateCount?: number;
```
在 renderObserveTree 与 renderObserveCompact 的 scanNotes 循环(:247 / :405,`for (const f of data.frames ?? [])` 内)加分支:
```ts
    if (f.truncated && f.candidateCount != null && f.candidateCount > f.elementCount) {
      scanNotes.push(`# truncated: returned ${f.elementCount} of ~${f.candidateCount} candidates${f.frameId !== 0 ? ` (frame ${f.frameId})` : ""}`);
    }
```
extension 侧 `observe.ts:2510 区`的 frame summary 对象(已有 `truncated: s.page.truncated`)补:
```ts
          candidateCount: s.page.candidateCount,
```

- [ ] **Step 4: 运行确认通过**
Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add packages/mcp/src/lib/observe-render.ts packages/extension/src/handlers/observe.ts packages/mcp/tests/observe-render-blindspot.test.ts
git commit -m "feat(observe): A4 截断量化 meta(candidateCount 透传)"
```

---

## Task 4: page-side 检测纯函数 + 单测（detectBlindspot）

**Files:**
- Create: `packages/extension/src/page-side/blindspot-detect.ts`(纯函数,供 inline 复制 + 单测,遵循 page-side inline gotcha:函数自包含不引模块级 helper)
- Test: `packages/extension/tests/blindspot-detect.test.ts`(新建,用 jsdom 构造 DOM)

> 注:page-side MAIN-world func 内联陷阱(见 memory `vortex_page_side_func_inline_gotcha`)——检测逻辑写成**自包含纯函数**,单测用 `new Function` 剥离作用域复刻注入,Task 5 把同一函数体内联进 scan func。

- [ ] **Step 1: 写失败测试**
```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { detectBlindspot } from "../src/page-side/blindspot-detect.js";

describe("detectBlindspot", () => {
  it("aria-rowcount 远大于渲染行 → virtual", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="1000">${"<div role='row'></div>".repeat(32)}</div>`;
    const grid = document.querySelector('[role=grid]')!;
    const b = detectBlindspot(grid as HTMLElement, 32);
    expect(b).toEqual({ kind: "virtual", total: 1000, rendered: 32 });
  });
  it("短列表 rowcount≈渲染 → 不报（负例）", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="5">${"<div role='row'></div>".repeat(5)}</div>`;
    expect(detectBlindspot(document.querySelector('[role=grid]') as HTMLElement, 5)).toBeNull();
  });
  it("大尺寸 canvas → canvas", () => {
    document.body.innerHTML = `<canvas width="800" height="600"></canvas>`;
    const c = document.querySelector("canvas")! as HTMLCanvasElement;
    Object.defineProperty(c, "getBoundingClientRect", { value: () => ({ width: 800, height: 600 }) });
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas" });
  });
  it("装饰性小 canvas(sparkline) → 不报（负例）", () => {
    document.body.innerHTML = `<canvas width="40" height="16"></canvas>`;
    const c = document.querySelector("canvas")! as HTMLCanvasElement;
    Object.defineProperty(c, "getBoundingClientRect", { value: () => ({ width: 40, height: 16 }) });
    expect(detectBlindspot(c, 0)).toBeNull();
  });
  it("自定义元素无可观察后代 → shadow 低置信", () => {
    document.body.innerHTML = `<x-widget></x-widget>`;
    const w = document.querySelector("x-widget")! as HTMLElement;
    Object.defineProperty(w, "getBoundingClientRect", { value: () => ({ width: 200, height: 80 }) });
    expect(detectBlindspot(w, 0)).toEqual({ kind: "shadow", confidence: "low" });
  });
  it("普通 div → 不报（负例）", () => {
    document.body.innerHTML = `<div>hi</div>`;
    expect(detectBlindspot(document.querySelector("div") as HTMLElement, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `pnpm --filter @vortex-browser/extension test blindspot-detect`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**
```ts
// packages/extension/src/page-side/blindspot-detect.ts
// 自包含纯函数:不引模块级 helper(page-side inline gotcha)。Task 5 内联同一函数体。
export type Blindspot = { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low" };

const VIRTUAL_ROLES = new Set(["grid", "treegrid", "table", "listbox", "tree"]);
const CANVAS_MIN_AREA = 200 * 150; // 排除装饰性 sparkline

export function detectBlindspot(el: HTMLElement, renderedDescendants: number): Blindspot | null {
  const tag = el.tagName.toLowerCase();
  // A1 canvas
  if (tag === "canvas") {
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= CANVAS_MIN_AREA) return { kind: "canvas" };
    return null;
  }
  const role = (el.getAttribute("role") || "").toLowerCase();
  // A2 virtual list
  if (VIRTUAL_ROLES.has(role)) {
    const rc = parseInt(el.getAttribute("aria-rowcount") || "", 10);
    const ss = parseInt(el.getAttribute("aria-setsize") || "", 10);
    const declared = !isNaN(rc) && rc > 0 ? rc : (!isNaN(ss) && ss > 0 ? ss : NaN);
    // 显著大于渲染(留缓冲,避免短列表/分页误报):declared > rendered 且 declared 至少多 2 倍或 +20
    if (!isNaN(declared) && declared > renderedDescendants && declared >= Math.max(renderedDescendants * 2, renderedDescendants + 20)) {
      return { kind: "virtual", total: declared, rendered: renderedDescendants };
    }
    return null;
  }
  // A3 closed-shadow best-effort:自定义元素(含连字符) + 有 layout box + 零可观察后代
  if (tag.includes("-") && renderedDescendants === 0) {
    const r = el.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 24) return { kind: "shadow", confidence: "low" };
  }
  return null;
}
```

- [ ] **Step 4: 运行确认通过**
Run: `pnpm --filter @vortex-browser/extension test blindspot-detect`
Expected: PASS（6 例全过,含 3 负例）

- [ ] **Step 5: 提交**
```bash
git add packages/extension/src/page-side/blindspot-detect.ts packages/extension/tests/blindspot-detect.test.ts
git commit -m "feat(observe): page-side 盲区检测纯函数 detectBlindspot + 单测"
```

---

## Task 5: 把检测内联进 scan func + ScannedElement 透传

**Files:**
- Modify: `packages/extension/src/handlers/observe.ts:86-140`(ScannedElement 加 blindspot)、scan MAIN func 内(per-element 输出构造处 ~2006-2040,内联 detectBlindspot 函数体并调用)、compact 映射处(~2420-2480 透传 blindspot)
- Test: `packages/extension/tests/observe-blindspot-scan.test.ts`(新建,复刻注入式单测)

- [ ] **Step 1: 写失败测试（复刻注入,验证内联副本与纯函数一致）**
```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { detectBlindspot } from "../src/page-side/blindspot-detect.js";
import { readFileSync } from "node:fs";

describe("scan func 内联 detectBlindspot 与纯函数一致", () => {
  it("observe.ts 内联副本存在且行为对齐", () => {
    const src = readFileSync(new URL("../src/handlers/observe.ts", import.meta.url), "utf8");
    // 内联标记注释,确保 Task 5 真的内联了(防漏)
    expect(src).toContain("// [inline detectBlindspot]");
    // 行为对齐:grid aria-rowcount=1000/rendered=10 → virtual
    document.body.innerHTML = `<div role="grid" aria-rowcount="1000">${"<div role='row'></div>".repeat(10)}</div>`;
    expect(detectBlindspot(document.querySelector('[role=grid]') as HTMLElement, 10))
      .toEqual({ kind: "virtual", total: 1000, rendered: 10 });
  });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `pnpm --filter @vortex-browser/extension test observe-blindspot-scan`
Expected: FAIL（无 `[inline detectBlindspot]` 标记）

- [ ] **Step 3: 实现**
(a) ScannedElement(:86) 加字段:
```ts
  /** 盲区降级信号。@since blindspot */
  blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low" };
```
(b) 在 scan 的 MAIN-world func 顶部内联检测函数(带标记注释,常量与 blindspot-detect.ts 保持同步):
```ts
        // [inline detectBlindspot] — 真源 packages/extension/src/page-side/blindspot-detect.ts,改一处须改两处
        const __vtxDetectBlindspot = (el, renderedDescendants) => {
          const tag = el.tagName.toLowerCase();
          if (tag === "canvas") { const r = el.getBoundingClientRect(); return r.width * r.height >= 200*150 ? { kind: "canvas" } : null; }
          const role = (el.getAttribute("role") || "").toLowerCase();
          const VR = ["grid","treegrid","table","listbox","tree"];
          if (VR.indexOf(role) >= 0) {
            const rc = parseInt(el.getAttribute("aria-rowcount") || "", 10);
            const ss = parseInt(el.getAttribute("aria-setsize") || "", 10);
            const declared = (!isNaN(rc) && rc > 0) ? rc : ((!isNaN(ss) && ss > 0) ? ss : NaN);
            if (!isNaN(declared) && declared > renderedDescendants && declared >= Math.max(renderedDescendants*2, renderedDescendants+20))
              return { kind: "virtual", total: declared, rendered: renderedDescendants };
            return null;
          }
          if (tag.indexOf("-") >= 0 && renderedDescendants === 0) {
            const r = el.getBoundingClientRect();
            if (r.width >= 40 && r.height >= 24) return { kind: "shadow", confidence: "low" };
          }
          return null;
        };
```
(c) 在 per-element 输出对象构造处(~2006-2040,与 reactMarker/listenerInteractive 同区)计算并附加。`renderedDescendants` = 该元素在已收集 candidates 中的后代计数(用 `el.querySelectorAll('*')` 中被 collect 的近似:对 virtual 容器用 `el.querySelectorAll('[role=row],[role=option]').length` 渲染行数更准):
```ts
            const __vtxRendered = (htmlEl.matches('[role=grid],[role=treegrid],[role=table]')
              ? htmlEl.querySelectorAll('[role=row]').length
              : htmlEl.matches('[role=listbox],[role=tree]')
              ? htmlEl.querySelectorAll('[role=option],[role=treeitem]').length
              : htmlEl.childElementCount);
            const __vtxBlind = __vtxDetectBlindspot(htmlEl, __vtxRendered);
```
并在输出对象 spread 里加:
```ts
            ...(__vtxBlind ? { blindspot: __vtxBlind } : {}),
```
(d) compact 映射处(~2430-2477,与 reactClickable 透传同区,两处 compact/tree 分支)加:
```ts
              ...(e.blindspot ? { blindspot: e.blindspot } : {}),
```

- [ ] **Step 4: 运行确认通过**
Run: `pnpm --filter @vortex-browser/extension test observe-blindspot-scan`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add packages/extension/src/handlers/observe.ts packages/extension/tests/observe-blindspot-scan.test.ts
git commit -m "feat(observe): 内联盲区检测进 scan + ScannedElement 透传"
```

---

## Task 6: 全量单测 + lint + 构建

- [ ] **Step 1: 全量单测**
Run: `pnpm -r test`
Expected: 全绿（含既有 observe 测试无回归）

- [ ] **Step 2: throw 纪律 + 构建**
Run: `pnpm build`
Expected: Done（page-side bundle 含 blindspot-detect 不报错）

- [ ] **Step 3: 若有失败,systematic-debugging 修复后重跑**

---

## Task 7: 活浏览器 spike 验证（强制,承重墙 load-bearing）

> page-side scan 改动不靠单测假绿(护栏)。需用户确认 Chrome+扩展在跑,扩展已 reload 加载新 build。

- [ ] **Step 1: 重跑 A2 ag-grid**
`vortex_tab_create https://www.ag-grid.com/example/` → `vortex_observe(scope=full,filter=all)`
Expected: grid 容器行出 `[virtual: 1000/<rendered>]`,顶部 `# blindspots:` 含该 grid。

- [ ] **Step 2: 重跑 A1 Excalidraw**
开 excalidraw.com → press 'r' + mouse_drag 画矩形 → observe
Expected: Canvas 元素行出 `[blindspot=canvas]`,顶部 meta 含 canvas-editor。

- [ ] **Step 3: 重跑 A3 closed-shadow**
example.com 注入 closed-shadow 自定义元素 → observe
Expected: host 行出 `[blindspot=shadow?]`(best-effort)。

- [ ] **Step 4: 普通页负例复核**
开一个普通页(如 ant.design 某组件页) → observe
Expected: **无多余 blindspot/virtual 标记**(误报复核)。

- [ ] **Step 5: 记录 spike 结果**
更新 `reports/_dogfood/spike-perception-blindspot-2026-06-17.md` 追加「修复后验证」段。

---

## Task 8: bench 回归 case + baseline + scoreboard

**Files:**
- Create: `packages/vortex-bench/cases/observe-blindspot-virtual.case.ts` 等(参照既有 case 形态)
- Modify: `reports/_dogfood/scoreboard.md`, `reports/_dogfood/backlog.md`(A 族标完成)

- [ ] **Step 1: 加 bench case**
参照 `packages/vortex-bench/cases/observe-srcdoc-same-origin.case.ts` 形态,加 fixture(含 aria-rowcount 虚拟 grid / canvas / 截断)断言信号出现。

- [ ] **Step 2: 跑 bench**
Run: bench 命令(参照 package.json / 既有 runner)
Expected: 全绿,新 case 通过;必要时刷 baseline。

- [ ] **Step 3: 更新 scoreboard/backlog**
backlog A1/A2/A3/A4 标 ✅ done(file:line + commit);scoreboard 验收线「真站优雅降级」推进。

- [ ] **Step 4: 提交**
```bash
git add packages/vortex-bench reports/_dogfood
git commit -m "test(observe): 盲区信号 bench 回归 case + baseline + 记账"
```

---

## Self-Review 备注
- 覆盖:A1(canvas Task4/5/7)、A2(virtual Task4/5/7)、A3(shadow Task4/5/7)、A4(截断 Task3/7)、行内+meta 形态(Task1/2)、负例不误报(Task1/2/4/7)、活浏览器(Task7)、bench(Task8)。A5 iframe 不在本轮(留 backlog)。
- 类型一致:`blindspot` 字段在 ScannedElement(observe.ts) 与 CompactElement(observe-render.ts) 同形;`detectBlindspot` 纯函数与 scan 内联副本同步(Task5 标记注释 + 单测对齐防漂移)。
- 阈值(canvas 面积 200x150、virtual 缓冲 2x/+20、shadow 40x24)为初值,Task7 活浏览器复核误报后可微调。
