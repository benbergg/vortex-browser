# observe Canvas Readback 指路提示 (P0 Layer A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** observe 检测到 canvas 盲区时,不只说"这是盲区",而是精确告诉 agent 该走哪条替代文本通道(图表实例 / component 状态 / 截图),消灭"看到 `[blindspot=canvas]` 就反射式截图"的无效退化。

**Architecture:** 在既有 `Blindspot` 结构上加两个可选字段 `readback`(指路通道)与 `chartLib`(图表库名)。检测侧 `detectBlindspot` 的 canvas 分支按廉价高精度信号分类:zrender/echarts canvas(`data-zr-dom-id`)→ chart;canvas 或祖先挂 React fiber / Vue 实例 → component;否则 → screenshot。渲染侧 `blindspotTag`(行内)与 `blindspotSummary`(顶部 `# blindspots:` 汇总)把分类渲染成可读指路。blindspot 全程以整体对象 spread 透传,新字段加进 3 处类型声明即自动流通。

**Tech Stack:** TypeScript,vitest(ext + mcp 两包),Chrome MV3 扩展 page-side `chrome.scripting.executeScript` MAIN world。

## Global Constraints

- **page-side inline gotcha**:`detectBlindspot` 在 `observe.ts:3292` 有内联副本(标记 `[inline detectBlindspot]`),改真源(`blindspot-detect.ts`)必须同步改内联副本;`tests/observe-blindspot-scan.test.ts` 校验两者行为对齐。内联 func 内**不得引用模块级 helper**(注入丢作用域),所有逻辑必须自包含在分支体内。
- **blindspot 类型声明 3 处必须同步**:`blindspot-detect.ts:8`(`Blindspot`)、`observe.ts:214`(`ScannedElement.blindspot` 内联)+ `observe.ts:3294`(inline func 内 `__vtxBlind` 内联类型)、`observe-render.ts:78`(`CompactElement.blindspot` 内联)。
- **向后兼容**:现有断言 `toContain("[blindspot=canvas]")` / `toEqual({ kind: "canvas" })` 会因新字段失效,须在对应 task 内更新。
- 注释中文;禁止 `Co-Authored-By` / `Created by` 署名;提交走 Conventional Commits(`git-commit` skill)。
- 测试命令:`pnpm --filter @vortex-browser/extension test <pattern>` / `pnpm --filter @vortex-browser/mcp test <pattern>`(底层 `vitest run`,positional 作文件名过滤)。

---

### Task 1: 渲染侧 —— blindspotTag + blindspotSummary 渲染 readback/chart 指路

纯函数、jsdom 可完整单测,先落地输出格式(即使检测侧未接,渲染层也能正确处理带 readback/chartLib 的 blindspot 对象)。

**Files:**
- Modify: `packages/mcp/src/lib/observe-render.ts:78`(CompactElement.blindspot 类型)、`:310-323`(blindspotTag)、`:342`(blindspotSummary canvas 行)
- Test: `packages/mcp/tests/observe-render-blindspot.test.ts`

**Interfaces:**
- Produces:
  - `CompactElement["blindspot"]` 扩展为 `{ kind: "virtual"|"canvas"|"shadow"; total?: number; rendered?: number; confidence?: "low"; readback?: "component"|"screenshot"|"chart"; chartLib?: string }`
  - `blindspotTag(b)` canvas 输出:chart → ` [blindspot=canvas chart=<lib> readback=evaluate:getOption]`;component → ` [blindspot=canvas readback=query:component]`;其余(含旧 `readback` 缺省)→ ` [blindspot=canvas readback=screenshot]`
  - `blindspotSummary` canvas 行追加指路尾巴(见 Step 3)

- [ ] **Step 1: 写失败测试**

在 `packages/mcp/tests/observe-render-blindspot.test.ts` 追加:

```typescript
import { renderObserveCompact } from "../src/lib/observe-render.js";

it("canvas chart 渲染 chart + readback=evaluate", () => {
  const out = renderObserveCompact(
    { snapshotId: "s", url: "u", elements: [
      { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0,
        blindspot: { kind: "canvas", readback: "chart", chartLib: "echarts" } },
    ] } as any, null);
  expect(out).toContain("[blindspot=canvas chart=echarts readback=evaluate:getOption]");
  expect(out).toContain("chart(echarts)"); // 顶部 summary 指路
});

it("canvas component 渲染 readback=query:component", () => {
  const out = renderObserveCompact(
    { snapshotId: "s", url: "u", elements: [
      { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0,
        blindspot: { kind: "canvas", readback: "component" } },
    ] } as any, null);
  expect(out).toContain("[blindspot=canvas readback=query:component]");
  expect(out).toContain("vortex_query mode=component");
});

it("canvas screenshot(纯光栅 + 旧无 readback)渲染 readback=screenshot", () => {
  for (const bs of [{ kind: "canvas", readback: "screenshot" }, { kind: "canvas" }]) {
    const out = renderObserveCompact(
      { snapshotId: "s", url: "u", elements: [
        { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0, blindspot: bs },
      ] } as any, null);
    expect(out).toContain("[blindspot=canvas readback=screenshot]");
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: FAIL（输出仍是旧 `[blindspot=canvas]`,不含新串）

- [ ] **Step 3: 实现渲染**

`observe-render.ts:78` 类型改为:

```typescript
  blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low"; readback?: "component" | "screenshot" | "chart"; chartLib?: string };
```

`observe-render.ts` `blindspotTag` 的 canvas 分支(原 `:321` 单行)替换为:

```typescript
  if (b.kind === "canvas") {
    if (b.readback === "chart") return ` [blindspot=canvas chart=${b.chartLib ?? "?"} readback=evaluate:getOption]`;
    if (b.readback === "component") return " [blindspot=canvas readback=query:component]";
    return " [blindspot=canvas readback=screenshot]"; // screenshot / 旧无 readback 缺省
  }
```

`blindspotSummary` 的 canvas 行(原 `:342` `parts.push(\`${e.role} ${ref} canvas-editor\`)`)替换为:

```typescript
    else if (b.kind === "canvas") {
      if (b.readback === "chart") parts.push(`${e.role} ${ref} chart(${b.chartLib ?? "?"}) → read via vortex_evaluate getOption()`);
      else if (b.readback === "component") parts.push(`${e.role} ${ref} canvas → readable via vortex_query mode=component`);
      else parts.push(`${e.role} ${ref} canvas → visual only, use vortex_screenshot`);
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: PASS（含上方 3 个新断言;旧 `[blindspot=canvas]` 精确断言若存在会失败 → 同步把它改成 `[blindspot=canvas readback=screenshot]`,该 fixture `blindspot:{kind:"canvas"}` 无 readback 即 screenshot 缺省)

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/lib/observe-render.ts packages/mcp/tests/observe-render-blindspot.test.ts
git commit -m "feat(observe): canvas 盲区渲染 readback 指路(chart/component/screenshot)"
```

---

### Task 2: 检测侧 —— detectBlindspot canvas 分支分类 readback

**Files:**
- Modify: `packages/extension/src/page-side/blindspot-detect.ts:8-13`(Blindspot 类型)、`:28-31`(canvas 分支)
- Test: `packages/extension/tests/blindspot-detect.test.ts`

**Interfaces:**
- Consumes: Task 1 的 readback 取值约定(`"component"|"screenshot"|"chart"`)
- Produces: `detectBlindspot(el, n)` canvas 命中时返回带 `readback` (+ chart 时 `chartLib`) 的 Blindspot:
  - canvas 带 `data-zr-dom-id` 属性 → `{ kind:"canvas", readback:"chart", chartLib:"echarts" }`
  - 否则 canvas 或 ≤6 层祖先挂 React fiber(`__reactFiber$*`/`__reactInternalInstance$*`)或 Vue(`__vue__`/`__vue_app__`)→ `{ kind:"canvas", readback:"component" }`
  - 否则 → `{ kind:"canvas", readback:"screenshot" }`

- [ ] **Step 1: 写失败测试**

在 `packages/extension/tests/blindspot-detect.test.ts` 追加（jsdom 可直接挂 expando 属性模拟 fiber/zrender）:

```typescript
function bigCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.getBoundingClientRect = () => ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return c;
}

it("zrender/echarts canvas → readback=chart", () => {
  const c = bigCanvas();
  c.setAttribute("data-zr-dom-id", "zr_0");
  expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "chart", chartLib: "echarts" });
});

it("React fiber 祖先 canvas → readback=component", () => {
  const wrap = document.createElement("div");
  (wrap as any)["__reactFiber$abc123"] = {};
  const c = bigCanvas();
  wrap.appendChild(c);
  expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "component" });
});

it("Vue 实例 canvas 自身 → readback=component", () => {
  const c = bigCanvas();
  (c as any).__vue__ = {};
  expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "component" });
});

it("纯光栅 canvas(无框架/无图表)→ readback=screenshot", () => {
  expect(detectBlindspot(bigCanvas(), 0)).toEqual({ kind: "canvas", readback: "screenshot" });
});
```

并把既有 `:55` 断言 `toEqual({ kind: "canvas" })` 改为 `toEqual({ kind: "canvas", readback: "screenshot" })`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension test blindspot-detect`
Expected: FAIL（现返回 `{ kind: "canvas" }` 无 readback/chartLib）

- [ ] **Step 3: 实现检测**

`blindspot-detect.ts:8-13` 类型扩展:

```typescript
export type Blindspot = {
  kind: "virtual" | "canvas" | "shadow";
  total?: number;
  rendered?: number;
  confidence?: "low";
  readback?: "component" | "screenshot" | "chart";
  chartLib?: string;
};
```

`blindspot-detect.ts:28-31` canvas 分支替换为（**全自包含,无外部 helper**,以便内联副本逐字复刻）:

```typescript
  if (tag === "canvas") {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < CANVAS_MIN_AREA) return null;
    // 图表库识别(廉价高精度):zrender(echarts)给 canvas 打 data-zr-dom-id 属性。
    if (el.getAttribute("data-zr-dom-id") !== null) {
      return { kind: "canvas", readback: "chart", chartLib: "echarts" };
    }
    // 框架驱动画布:canvas 或 ≤6 层祖先挂 React fiber / Vue 实例 → 状态可经
    // vortex_query mode=component 读回(Excalidraw 实证)。
    let node: HTMLElement | null = el;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      if ((node as any).__vue__ || (node as any).__vue_app__) return { kind: "canvas", readback: "component" };
      for (const k of Object.keys(node)) {
        if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) {
          return { kind: "canvas", readback: "component" };
        }
      }
    }
    return { kind: "canvas", readback: "screenshot" };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension test blindspot-detect`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/blindspot-detect.ts packages/extension/tests/blindspot-detect.test.ts
git commit -m "feat(observe): detectBlindspot canvas 分支按 zrender/框架信号分类 readback"
```

---

### Task 3: 内联副本同步 + ScannedElement 类型 + parity 测试

**Files:**
- Modify: `packages/extension/src/handlers/observe.ts:214`(ScannedElement.blindspot)、`:3294`(`__vtxBlind` 内联类型)、`:3297-3298`(inline canvas 分支)
- Test: `packages/extension/tests/observe-blindspot-scan.test.ts`

**Interfaces:**
- Consumes: Task 2 的 canvas 分支逻辑（须逐字复刻到内联副本,行为对齐)
- Produces: 内联 `__vtxBlind` 与 `detectBlindspot` 对 canvas 返回相同结构(含 readback/chartLib)

- [ ] **Step 1: 先看 parity 测试期望**

Run: `pnpm --filter @vortex-browser/extension test observe-blindspot-scan`
Expected: 当前 PASS（基线）。阅读该测试确认它如何比对内联副本与纯函数(若它对 canvas 构造 fixture 调两边比 `toEqual`,Task 2 改后此测试会 FAIL,即 Step 2)。

- [ ] **Step 2: 跑 parity 测试确认失败**

Run: `pnpm --filter @vortex-browser/extension test observe-blindspot-scan`
Expected: FAIL（纯函数已返回 readback,内联副本仍返回 `{ kind:"canvas" }` → 不对齐）。若该测试未覆盖 canvas readback,在其中补一条:对带 `data-zr-dom-id` 的 canvas、React fiber 祖先 canvas、纯 canvas 分别断言内联副本输出 == `detectBlindspot` 输出。

- [ ] **Step 3: 同步内联副本 + 类型**

`observe.ts:214` ScannedElement.blindspot 类型追加字段:

```typescript
  blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low"; readback?: "component" | "screenshot" | "chart"; chartLib?: string };
```

`observe.ts:3294` `__vtxBlind` 内联类型同样追加 `readback?` + `chartLib?`(逐字同上类型体)。

`observe.ts:3297-3298` inline canvas 分支替换为（与 Task 2 canvas 分支逐字等价,变量名用内联的 `htmlEl`/`rect`):

```typescript
            if (__t === "canvas") {
              if (rect.width * rect.height >= 200 * 150) {
                if (htmlEl.getAttribute("data-zr-dom-id") !== null) {
                  __vtxBlind = { kind: "canvas", readback: "chart", chartLib: "echarts" };
                } else {
                  let __n: HTMLElement | null = htmlEl;
                  for (let __i = 0; __n && __i < 6; __i++, __n = __n.parentElement) {
                    if ((__n as any).__vue__ || (__n as any).__vue_app__) { __vtxBlind = { kind: "canvas", readback: "component" }; break; }
                    let __hit = false;
                    for (const __k of Object.keys(__n)) {
                      if (__k.indexOf("__reactFiber$") === 0 || __k.indexOf("__reactInternalInstance$") === 0) { __hit = true; break; }
                    }
                    if (__hit) { __vtxBlind = { kind: "canvas", readback: "component" }; break; }
                  }
                  if (!__vtxBlind) __vtxBlind = { kind: "canvas", readback: "screenshot" };
                }
              }
            }
```

- [ ] **Step 4: 跑 parity + 全 ext 盲区测试确认通过**

Run: `pnpm --filter @vortex-browser/extension test blindspot`
Expected: PASS（parity 对齐 + Task 2 测试仍绿）

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/observe.ts packages/extension/tests/observe-blindspot-scan.test.ts
git commit -m "feat(observe): 内联 detectBlindspot 副本同步 canvas readback 分类 + parity"
```

---

### Task 4: 真浏览器 spike 验证(承重,jsdom 测不到)

page-side 对真实 React fiber key / zrender `data-zr-dom-id` 的假设必须在真 Chrome 验证(jsdom 无真框架,内联注入丢作用域只有活浏览器暴露)。本 task 无代码产出,是 ship 前闸门。

**Files:** 无（验证 + 记录)

- [ ] **Step 1: 构建并重载扩展**

Run: `pnpm --filter @vortex-browser/extension build`,然后用 `vortex_dev_reload`(caps=dev)或手动 🔄 重载,轮询 buildStamp 确认新构建生效。

- [ ] **Step 2: Excalidraw → 期望 readback=component**

`vortex_navigate https://excalidraw.com` → `vortex_observe` → 断言 canvas 行含 `[blindspot=canvas readback=query:component]`,顶部 `# blindspots:` 含 `readable via vortex_query mode=component`。

- [ ] **Step 3: ECharts → 期望 chart=echarts**

`vortex_navigate https://echarts.apache.org/examples/en/editor.html?c=bar-stack`。注意图表在 srcdoc 子 frame,需 `vortex_observe frames=all-permitted` 或对 chart frame 单扫;断言该 canvas 行含 `chart=echarts readback=evaluate:getOption`。**若实测发现 chart canvas 未被收集为元素(F3 现象:0 interactive),记录为已知局限**:per-element 检测只对已收集 canvas 生效,chart-in-iframe / 未收集 canvas 的页级扫描留作后续(见"超出本计划范围")。同时实测确认真实 zrender canvas 确有 `data-zr-dom-id` 属性(用 `vortex_evaluate` 读 `document.querySelector('canvas')?.getAttributeNames()` 核对;若属性名不同,回 Task 2/3 订正)。

- [ ] **Step 4: 纯光栅 canvas → 期望 readback=screenshot**

找一个非框架的原生 `<canvas>` demo(如 MDN canvas tutorial 示例页),断言 canvas 行含 `readback=screenshot`。

- [ ] **Step 5: 记录 spike 结论并提交(若有订正)**

把三站实测结果(component / chart / screenshot 是否如期)记入 commit message 或 `reports/`。如 Step 3 暴露属性名/收集范围问题,在此修正 Task 2/3 后再 commit。

```bash
git commit --allow-empty -m "test(observe): canvas readback 真浏览器 spike 验证(excalidraw/echarts/raster)"
```

---

### Task 5: 回归扫尾 —— 全量测试 + 残余断言订正

**Files:** 视失败而定(ext + mcp 全量)

- [ ] **Step 1: 跑两包全量测试**

Run: `pnpm --filter @vortex-browser/extension test` 然后 `pnpm --filter @vortex-browser/mcp test`
Expected: 全绿。任何因 `[blindspot=canvas]` 字面变化而失败的断言(bench fixtures / 其他 observe 测试),逐个改为新格式 `[blindspot=canvas readback=...]`。

- [ ] **Step 2: grep 残余硬编码断言**

Run: `grep -rn '\[blindspot=canvas\]' packages --include='*.ts'`
Expected: 仅注释/文档命中;任何测试里的精确串断言改为 `[blindspot=canvas readback=` 前缀匹配或完整新串。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "test(observe): canvas readback 渲染变更回归断言订正"
```

---

## 超出本计划范围(defer,记入 backlog)

- **chart-in-iframe / 未收集 canvas 的页级扫描**:per-element 检测只覆盖已被 observe 收集的 canvas;ECharts 在 srcdoc 子 frame 且常未被收集(F3)。需类似虚拟列表的 dedicated page-side pass 独立扫描图表 canvas → 走 frame 级 `blindspots` 通道。属 Layer A 后续。
- **Chart.js / AntV G2 识别**:本计划仅 echarts(zrender `data-zr-dom-id`,中文生态最高频)。其余库信号待 spike 数据后增量加。
- **Layer B 库感知数据提取器**(getOption / React state 直抽快捷工具)、**Layer C**(语义化截断 / 计数语义 / extract markdown / evaluate 契约可读性):见设计文档 `Knowledge-Library/07-Tech/20260630-vortex截图退化-归因与解决方案.md`。

## Self-Review

- **Spec coverage**:设计 Layer A 三项 —— canvas readback 精细化(Task 1-4 ✓)、图表库识别(echarts via Task 2-4 ✓,其余库 defer)、页级 perception hints(blindspotSummary 指路尾巴 Task 1 ✓,canvas-in-iframe 页级扫描 defer 并记录)。
- **Placeholder scan**:无 TBD;每步含真代码与确切命令。
- **Type consistency**:`readback: "component"|"screenshot"|"chart"` + `chartLib?: string` 在 3 处类型声明(blindspot-detect.ts / observe.ts ×2 / observe-render.ts)与渲染分支用法一致;canvas readback 值域贯穿检测→透传→渲染一致。
