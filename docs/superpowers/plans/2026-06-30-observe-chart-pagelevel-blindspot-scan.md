# observe chart 页级盲区扫描 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对未被收集为交互元素的图表 canvas(echarts/zrender,含 srcdoc 子 frame)做页级扫描,产出 frame 级 `# blindspots:` 条目,指引 agent 用 `vortex_evaluate getOption()` 读数据而非截图估值。

**Architecture:** 镜像既有虚拟列表 dedicated pass(observe.ts `pageBlindspots`,逐 frame 注入运行,故 srcdoc 子 frame 自动覆盖)。新增纯函数 `detectChartCanvas`(charts-only,仅 echarts `data-zr-dom-id`),在该 pass 内内联调用扫所有未收集 canvas,产 frame 级 `{kind:"canvas",...}` 条目;frame 级 blindspot 类型扩 union;`blindspotSummary` 渲染 canvas 变体。

**Tech Stack:** TypeScript,vitest(ext + mcp),Chrome MV3 page-side `executeScript` MAIN world。

## Global Constraints

- **page-side inline gotcha**:`detectChartCanvas` 的判定在 observe.ts `pageBlindspots` pass 内**内联**(MAIN world 注入丢模块作用域,不得引模块级 helper);真源 `blindspot-detect.ts` 改一处须同步内联副本,标记 `[inline detectChartCanvas]`,`observe-blindspot-scan.test.ts` 校验。
- **frame 级 blindspot 类型 union 两处同步**:`FramePageResult.blindspots`(observe.ts:233)+ `CompactFrame.blindspots`(observe-render.ts:94),加 canvas 变体 `{ kind:"canvas"; name:string; chartLib:string; readback:"chart" }`;observe.ts:3498 的 `pageBlindspots` 局部类型同步。
- **charts-only**:仅标 echarts/zrender(`data-zr-dom-id` 非空)的 canvas;纯 raster/装饰/非 echarts 图表不标。
- **dedup**:页级扫描跳过已被 per-element 收集的 canvas(`collectedEls` 在 observe.ts:3498 作用域,是 DOM Element 数组,用 `collectedEls.indexOf(canvas) >= 0` 判定)。
- **尺寸门**:canvas `rect.width*rect.height >= 200*150`(同 CANVAS_MIN_AREA,排装饰 sparkline)。
- 注释中文;禁止 `Co-Authored-By`/`Created by`;Conventional Commits(`git-commit` skill)。
- 测试命令:`pnpm --filter @vortex-browser/extension test <pattern>` / `pnpm --filter @vortex-browser/mcp test <pattern>`(底层 `vitest run`)。

---

### Task 1: 纯函数 detectChartCanvas

**Files:**
- Modify: `packages/extension/src/page-side/blindspot-detect.ts`(在 `detectDivVirtualScroller` 后追加,文件末约 :145)
- Test: `packages/extension/tests/blindspot-detect.test.ts`

**Interfaces:**
- Produces: `detectChartCanvas(el: HTMLElement): { chartLib: string } | null` — `el` 是 `<canvas>` 且有 `data-zr-dom-id` 属性 → `{ chartLib: "echarts" }`;否则 `null`。

- [ ] **Step 1: 写失败测试**

在 `packages/extension/tests/blindspot-detect.test.ts` 顶部 import 处补 `detectChartCanvas`(与既有 `detectBlindspot` 等同处 import),并追加:

```typescript
describe("detectChartCanvas", () => {
  it("zrender canvas(有 data-zr-dom-id)→ {chartLib:echarts}", () => {
    const c = document.createElement("canvas");
    c.setAttribute("data-zr-dom-id", "zr_0");
    expect(detectChartCanvas(c)).toEqual({ chartLib: "echarts" });
  });
  it("无 data-zr-dom-id 的 canvas → null", () => {
    expect(detectChartCanvas(document.createElement("canvas"))).toBeNull();
  });
  it("非 canvas 元素(即便有 data-zr-dom-id)→ null", () => {
    const d = document.createElement("div");
    d.setAttribute("data-zr-dom-id", "zr_0");
    expect(detectChartCanvas(d)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension test blindspot-detect`
Expected: FAIL（`detectChartCanvas is not a function` / 未导出）

- [ ] **Step 3: 实现纯函数**

在 `blindspot-detect.ts` 文件末（`detectDivVirtualScroller` 之后）追加：

```typescript
/**
 * 图表 canvas 页级识别(charts-only 页级盲区扫描)。echarts/zrender 给其 canvas 打
 * data-zr-dom-id 属性(2026-06-30 真站 spike 验证)。非 canvas / 无该属性 → null。
 * observe.ts pageBlindspots pass 内联同一判定(标记 [inline detectChartCanvas]),
 * 改一处须改两处;observe-blindspot-scan.test.ts 校验。
 */
export function detectChartCanvas(el: HTMLElement): { chartLib: string } | null {
  if (el.tagName.toLowerCase() !== "canvas") return null;
  if (el.getAttribute("data-zr-dom-id") === null) return null;
  return { chartLib: "echarts" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension test blindspot-detect`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/blindspot-detect.ts packages/extension/tests/blindspot-detect.test.ts
git commit -m "feat(observe): 加 detectChartCanvas 纯函数(echarts/zrender 页级识别)"
```

---

### Task 2: MCP 渲染侧 —— frame 级 canvas 盲区类型 + blindspotSummary 渲染

**Files:**
- Modify: `packages/mcp/src/lib/observe-render.ts:94`（CompactFrame.blindspots 类型）、`:345-352`（blindspotSummary frame 循环）
- Test: `packages/mcp/tests/observe-render-blindspot.test.ts`

**Interfaces:**
- Consumes: frame 级 canvas 盲区条目形 `{ kind:"canvas"; name:string; chartLib:string; readback:"chart" }`
- Produces: `blindspotSummary` 对 frame 级 canvas 条目输出 `${name} chart(${chartLib}) → read via vortex_evaluate getOption()${frame 标注}`；既有 virtual 条目输出不变。

- [ ] **Step 1: 写失败测试**

在 `packages/mcp/tests/observe-render-blindspot.test.ts` 追加（frames 携带 canvas 变体盲区）：

```typescript
it("frame 级 chart canvas 盲区 → summary 指向 vortex_evaluate", () => {
  const out = renderObserveCompact(
    { snapshotId: "s", url: "u", elements: [],
      frames: [{ frameId: 12, url: "about:srcdoc", scanned: true, elementCount: 0, offset: { x: 0, y: 0 },
        blindspots: [{ kind: "canvas", name: "图表", chartLib: "echarts", readback: "chart" }] }] } as any,
    null);
  expect(out).toContain("图表 chart(echarts) → read via vortex_evaluate getOption()");
  expect(out).toContain("(frame 12)");
});

it("frame 级 virtual 盲区渲染不受 canvas 分支影响(回归)", () => {
  const out = renderObserveCompact(
    { snapshotId: "s", url: "u", elements: [],
      frames: [{ frameId: 0, url: "u", scanned: true, elementCount: 0, offset: { x: 0, y: 0 },
        blindspots: [{ kind: "virtual", total: 200, rendered: 9, name: "list" }] }] } as any,
    null);
  expect(out).toContain("list virtual(200/9)");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: FAIL（canvas 条目当前被当 virtual 渲染成 `图表 virtual(undefined/undefined)`，不含 chart 文案）

- [ ] **Step 3: 实现类型 + 渲染**

`observe-render.ts:94` CompactFrame.blindspots 类型改为 union：

```typescript
  blindspots?: Array<
    | { kind: "virtual"; total: number; rendered: number; name: string; confidence?: "low" }
    | { kind: "canvas"; name: string; chartLib: string; readback: "chart" }
  >;
```

`observe-render.ts` `blindspotSummary` 的 frame 循环（原 `:345-352`）改为按 kind 分派：

```typescript
  for (const f of frames ?? []) {
    for (const b of f.blindspots ?? []) {
      const fr = f.frameId !== 0 ? ` (frame ${f.frameId})` : "";
      if (b.kind === "canvas") {
        parts.push(`${b.name} chart(${b.chartLib}) → read via vortex_evaluate getOption()${fr}`);
      } else {
        // confidence:low(A2-fb scrollHeight 估算)用 ~ 前缀标记 total 为近似值。
        const tot = b.confidence === "low" ? `~${b.total}` : `${b.total}`;
        parts.push(`${b.name} virtual(${tot}/${b.rendered})${fr}`);
      }
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/mcp test observe-render-blindspot`
Expected: PASS（两个新测试 + 既有 blindspot 测试全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/lib/observe-render.ts packages/mcp/tests/observe-render-blindspot.test.ts
git commit -m "feat(observe): blindspotSummary 渲染 frame 级 chart canvas 盲区"
```

---

### Task 3: 扩展侧 —— 页级 chart canvas 扫描 + frame 类型 + parity

**Files:**
- Modify: `packages/extension/src/handlers/observe.ts:233`（FramePageResult.blindspots 类型）、`:3498`（pageBlindspots 局部类型 + 新增 canvas 扫描段）
- Test: `packages/extension/tests/observe-blindspot-scan.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `detectChartCanvas` 判定逻辑(内联复刻:`tagName==="canvas"` 且 `data-zr-dom-id` 非空 → echarts)
- Produces: observe.ts `pageBlindspots` 在每 frame 产出 `{ kind:"canvas"; name; chartLib:"echarts"; readback:"chart" }` 条目;`FramePageResult.blindspots` 类型含 canvas 变体。

- [ ] **Step 1: 看 parity 测试基线**

Run: `pnpm --filter @vortex-browser/extension test observe-blindspot-scan`
Expected: 当前 PASS。阅读该测试,确认它如何对内联副本做结构性 `toContain` + 行为断言(P0 已建此模式)。

- [ ] **Step 2: 写失败测试（结构性 + 行为）**

在 `observe-blindspot-scan.test.ts` 追加：① 结构性断言 observe.ts scan 源文本含 `[inline detectChartCanvas]` 标记与 `data-zr-dom-id`；② 行为断言:构造一个含 `<canvas data-zr-dom-id>`(400×300)且**未被收集**的 DOM,跑页级扫描逻辑应产出一条 `{kind:"canvas", chartLib:"echarts", readback:"chart"}`。参照文件内既有 virtual 页级扫描测试的构造/调用方式对齐（同一 `src` 源文本读取 helper + 同一 page-level scan 调用入口）。若该测试文件以"读 observe.ts 源文本断言内联标记"为主、不直接执行扫描，则至少补两条结构性断言：

```typescript
it("[inline detectChartCanvas] 标记存在 + zrender 属性判定内联", () => {
  expect(src).toContain("[inline detectChartCanvas]");
  expect(src).toContain("data-zr-dom-id");
});
it("页级 canvas 扫描有尺寸门 + dedup(collectedEls)", () => {
  expect(src).toContain("200 * 150");
  expect(src).toContain("collectedEls.indexOf");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension test observe-blindspot-scan`
Expected: FAIL（标记 / 判定尚未加入 observe.ts）

- [ ] **Step 4: 实现类型 + 页级扫描**

`observe.ts:233` FramePageResult.blindspots 类型改为 union：

```typescript
  blindspots?: Array<
    | { kind: "virtual"; total: number; rendered: number; name: string; confidence?: "low" }
    | { kind: "canvas"; name: string; chartLib: string; readback: "chart" }
  >;
```

`observe.ts:3498` `pageBlindspots` 局部类型同步为同一 union（把 `Array<{ kind: "virtual"; total: number; rendered: number; name: string; confidence?: "low" }>` 改成上面的 union）。

在 `pageBlindspots` 块**末尾**（`detectDivVirtualScroller` 内联段之后、块的 `}` 之前，约 :3603）追加 canvas 扫描段：

```javascript
          // [inline detectChartCanvas] 图表 canvas 页级扫描:图表 canvas 常不被收集为交互
          // 元素(ECharts 在 srcdoc 子 frame / 主 frame 非交互 canvas),独立扫一遍产 frame
          // 级条目。真源 blindspot-detect.ts detectChartCanvas,改一处须改两处。charts-only:
          // 仅 echarts/zrender(canvas 带 data-zr-dom-id)。
          for (const __cv of querySelectorAllDeep("canvas", document)) {
            const __cr = (__cv as HTMLElement).getBoundingClientRect();
            if (__cr.width * __cr.height < 200 * 150) continue;          // 尺寸门(排装饰 sparkline)
            if (collectedEls.indexOf(__cv as Element) >= 0) continue;     // dedup:已 per-element 收集不双报
            if ((__cv as HTMLElement).getAttribute("data-zr-dom-id") === null) continue; // 仅 echarts/zrender
            const __cnm =
              (__cv as HTMLElement).getAttribute("aria-label") ||
              (__cv as HTMLElement).getAttribute("title") ||
              "chart";
            pageBlindspots.push({ kind: "canvas", name: String(__cnm).slice(0, 40), chartLib: "echarts", readback: "chart" });
          }
```

（注:`collectedEls` 在该作用域是已收集 DOM Element 数组,Task 调用方 observe.ts:3490 已遍历过它;`querySelectorAllDeep` 同 pass 上文已用。若 `collectedEls.indexOf` 因元素类型不匹配编译报错,用 `(collectedEls as Element[]).indexOf(__cv as Element)` 或等价成员判定。）

- [ ] **Step 5: 跑测试确认通过 + 全 ext 盲区测试**

Run: `pnpm --filter @vortex-browser/extension test blindspot`
Expected: PASS（parity 结构性断言绿 + detect 单测绿 + 既有虚拟列表扫描不回归）

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/observe.ts packages/extension/tests/observe-blindspot-scan.test.ts
git commit -m "feat(observe): 页级 chart canvas 扫描产 frame 级盲区(含 srcdoc 子 frame)"
```

---

### Task 4: 真浏览器 spike 验证（承重，jsdom 测不到 srcdoc + 真 zrender）

无代码产出，ship 前闸门。jsdom 无真 srcdoc 跨 frame、无真 zrender canvas，必须真 Chrome 验证。

**Files:** 无

- [ ] **Step 1: 构建并确认新 build 生效**

Run: `pnpm --filter @vortex-browser/extension build`，然后 `vortex_dev_reload`(caps=dev)或确认 `vortex_observe` 已反映新构建（先 `vortex_tab_list` 唤醒 SW；若 dev_reload 报 fromStamp==targetStamp 且等于新 build-stamp.txt，说明已 live）。

- [ ] **Step 2: ECharts srcdoc → 顶部出 chart 条目**

`vortex_navigate https://echarts.apache.org/examples/en/editor.html?c=bar-stack` → `vortex_observe frames=all-permitted` → 断言顶部 `# blindspots:` 含 `chart(echarts) → read via vortex_evaluate getOption()` 且带 `(frame N)` 标注（图表 canvas 在 about:srcdoc 子 frame）。

- [ ] **Step 3: 纯 raster fixture → 不出 chart 条目**

写临时 fixture `packages/vortex-bench/playground/public/raster-chart-probe.html`（含一个无 data-zr-dom-id 的 400×300 `<canvas>`），`vortex_navigate http://localhost:5173/raster-chart-probe.html` → `vortex_observe` → 断言**无** chart 盲区条目（charts-only 不误报）。验证后删除该 fixture。

- [ ] **Step 4: dedup 检查（已收集 chart canvas 不双报）**

若 Step 2 的 ECharts 图表 canvas 恰被收集为 per-element（罕见，多数非交互），确认它**不同时**出现 per-element `[blindspot=canvas chart=echarts ...]` 与页级 `# blindspots:` 两处。若无法构造已收集的 chart canvas，记录"未触发 dedup 路径，靠单测 Task 3 行为断言覆盖"。

- [ ] **Step 5: 记录结论并提交（含订正）**

实测结果记入 commit message 或 `reports/`。若 Step 2 暴露 `frames=all-permitted` 未扫到 srcdoc chart frame / zrender 属性名变化，回 Task 1/3 订正后再提交。

```bash
git commit --allow-empty -m "test(observe): chart 页级扫描真浏览器 spike(echarts srcdoc 出条目/raster 不误报)"
```

---

### Task 5: 回归扫尾 —— 全量测试 + 残余断言

**Files:** 视失败而定（ext + mcp + vortex-bench 全量）

- [ ] **Step 1: 三包全量**

Run: `pnpm --filter @vortex-browser/mcp test` 然后 `pnpm --filter @vortex-browser/extension test` 然后 `pnpm --filter @vortex-browser/vortex-bench test`
Expected: 全绿。任何因 frame 级 blindspot 类型 union 变化(新增 canvas 变体)而失败的类型/断言，逐个修复（如 bench observe 解析器若解析 `# blindspots:` 行，确认 chart 文案不破坏解析）。

- [ ] **Step 2: grep 残余**

Run: `grep -rn 'virtual(' packages/vortex-bench --include='*.ts'` 确认 bench 对 `# blindspots:` 的解析/断言未被新 chart 行式破坏。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "test(observe): chart 页级盲区扫描回归扫尾"
```

---

## 超出本计划范围（defer）

- Chart.js / AntV G2 / Plotly 等非 echarts 图表库识别（需全局 registry / SVG，脆）。
- 纯 raster / 非图表非交互 canvas 的页级盲区（用户选 charts-only 排除）。
- 图表数据自动提取（Layer B 库感知提取器）。

## Self-Review

- **Spec coverage**：U1(Task 1)、U2 页级扫描(Task 3)、U3 类型 union(Task 2 mcp + Task 3 ext)、U4 渲染(Task 2)、U5 dedup(Task 3)；测试(各 task + Task 4 spike + Task 5 回归)。全覆盖。
- **Placeholder scan**：无 TBD；每步含真代码与命令。Task 3 Step 2 给了"若测试以源文本断言为主"的具体兜底断言，非占位。
- **Type consistency**：canvas 变体 `{ kind:"canvas"; name:string; chartLib:string; readback:"chart" }` 在 Task 2(observe-render.ts 类型+渲染)、Task 3(observe.ts 类型+push)一致；`detectChartCanvas` 返回 `{chartLib:string}|null` 在 Task 1 定义、Task 3 内联复刻判定一致；frame 循环 `b.kind==="canvas"` 判别与 push 的 kind 字段一致。
