# Query 维度可组合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `vortex_query` 一次命中元素集合后按需返回几何 + 文本 + 属性 + 样式的组合结果，并把 css/geometry/style 三份内联 `queryAllDeep` 副本收敛为一份统一探针。

**Architecture:** 新建单一 `elementsProbeFunc` 承担「一次遍历 + 按维度采集原始值」，只产原始数据不做整形；新建纯函数模块 `element-shaping.ts` 把原始结果整形回 css/geometry/style 三种既有返回形状。老三个 mode 在 handler 层翻译成维度请求转发到统一探针，再经整形层还原契约，对外行为零变化。`component` 不并入（见 Global Constraints）。

**Tech Stack:** TypeScript、Chrome MV3 `chrome.scripting.executeScript({func})`、Vitest、jsdom

**Spec:** `docs/visual-issue-selfreport-approach.md`（路线 E，§4「E 的实现形态」为本计划的直接依据）

## Global Constraints

- **`component` mode 不并入统一探针。** `componentInspectFunc` 单体 12596 字节、最重且最少用，采的是组件实例状态与响应式剥离，与 DOM 表征不同层。合三个 payload 恒定 21475 字节；合四个变 34071 字节。债因此为 4 份 → 2 份（统一探针 1 份 + component 保留 1 份），不是 → 1 份。
- **探针必须自包含。** `chrome.scripting.executeScript({func})` 序列化函数、丢模块作用域，探针内不得 import 或引用任何外部标识符（`query.ts:578` 已有此警告）。`element-shaping.ts` 是 host 侧模块，不注入，可自由 import。
- **`SHADOW_WALK_MAX_DEPTH` 固定为 8**，与现有四处一致，不得引入新的 shadow 覆盖差异。
- **`maxResults` 只控制元素数，不因维度重解释。** 组合模式默认 20、上限 50。老 mode 保留各自现值：css 20/100、geometry 10/50、style 10/50。
- **维度不可用必须自陈**，不得字段消失：顶层 `dimensions.<name>.available=false` + `reason`。
- **css 的 `scanned` 自陈不得丢失**（`{ elements, shadowRoots, iframes }`，喂给 `diagnoseEmptyQueryCss`）。
- **测试命令**：`vitest` 是各包的本地依赖，**仓库根目录没有**，在根跑 `pnpm vitest` 会报
  `Command "vitest" not found`。一律用 `pnpm --filter <包名> exec vitest run --maxWorkers=2 --minWorkers=1 <相对包目录的路径>`，
  包名见 `packages/*/package.json`（extension 是 `@vortex-browser/extension`）。
  必须带 `--maxWorkers=2 --minWorkers=1`，禁止默认满核，禁止 `pnpm -r test`（会卡死机器）。
- **注释规范**：中文；方法体内单行 `//`，每条 ≤1 行 ≤60 字，同一方法体内 ≤3 条；禁止分步骤流水账；TS 文件不写 `@author`。
- **提交**：Conventional Commits，中文描述，动词开头，结尾无句号，禁止任何署名行。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `packages/extension/src/handlers/query.ts` | 现有。新增 `elementsProbeFunc`；删除 `cssQueryFunc`/`geometryProbeFunc`/`styleProbeFunc` 三个探针；三个 mode 分支改为转发 + 整形 |
| `packages/extension/src/lib/element-shaping.ts` | **新建**。纯函数整形层：`shapeCssResult` / `shapeGeometryResult` / `shapeStyleResult`。不注入，可 import，可真单测 |
| `packages/extension/src/lib/element-dimensions.ts` | **新建**。维度名常量与校验：`ALL_DIMENSIONS`、`normalizeDimensions`、`dimensionsForMode`。host 与探针共享的**数据**（非函数），探针只接收其结果 |
| `packages/extension/tests/query-contract-shape.test.ts` | **新建**。锁四种老返回形状的契约测试（Task 1 前置） |
| `packages/extension/tests/element-shaping.test.ts` | **新建**。整形层纯函数单测 |
| `packages/extension/tests/query-elements-mode.test.ts` | **新建**。组合模式端到端（handler 层，mock executeScript） |
| `packages/mcp/src/tools/schemas-public.ts` | 现有。`mode` enum 加 `elements`；新增 `dimensions` 字段；描述补可发现面 |
| `packages/mcp/tests/vortex-query.test.ts` | 现有。补 `elements` mode 与 `dimensions` 字段的 schema 断言 |

---

## Task 1: 锁住四种老返回形状的契约测试

先补测试再改实现。现有测试字段值覆盖密但形状覆盖稀：`query-geometry.test.ts` 17 个 expect 仅 1 处整体形状断言且 **0 处断言 `showing`**；`query-handler.test.ts:105` **mock 掉了 `executeScript`**，css 测试断言的只是 handler 透传，探针根本没跑；该文件没有 geometry/style 的返回形状测试。直接改实现会让形状漂移无人察觉。

**Files:**
- Create: `packages/extension/tests/query-contract-shape.test.ts`

**Interfaces:**
- Consumes: `cssQueryFunc`、`geometryProbeFunc`、`styleProbeFunc`（均从 `../src/handlers/query.js` 导出，本任务不改动它们）
- Produces: 三条形状契约，后续任务的整形层必须让它们保持绿

- [x] **Step 1: 写契约测试**

```ts
// query-contract-shape.test.ts
// 锁住 css/geometry/style 三个探针的返回形状。整形层重构后这些必须仍绿。
// 与既有测试的分工:既有测试断言字段"值"是否算对,这里断言返回体"形状"不漂移
// —— 键集合、showing 语义、scanned 自陈,三者既有测试都没覆盖。

import { describe, it, expect, beforeEach } from "vitest";
import { cssQueryFunc, geometryProbeFunc, styleProbeFunc } from "../src/handlers/query.js";

function seed(html: string): void {
  document.body.innerHTML = html;
}

describe("css 探针返回形状", () => {
  beforeEach(() => seed(`<ul><li class="item" href="/a">A</li><li class="item">B</li></ul>`));

  it("顶层键集合恒为 elements/total/showing/scanned", () => {
    const r = cssQueryFunc(".item", null, 10, true) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["elements", "scanned", "showing", "total"]);
  });

  it("showing 等于实际返回的元素数,不是命中总数", () => {
    const r = cssQueryFunc(".item", null, 1, true) as { total: number; showing: number; elements: unknown[] };
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });

  it("scanned 三个计数键齐全,零命中时也在", () => {
    const r = cssQueryFunc(".nope", null, 10, true) as { total: number; scanned: Record<string, number> };
    expect(r.total).toBe(0);
    expect(Object.keys(r.scanned).sort()).toEqual(["elements", "iframes", "shadowRoots"]);
    expect(r.scanned.elements).toBeGreaterThan(0);
  });

  it("元素键集合:不要属性不要文本时只有 index/tag/children_count", () => {
    const r = cssQueryFunc(".item", null, 10, false) as { elements: Array<Record<string, unknown>> };
    expect(Object.keys(r.elements[0]).sort()).toEqual(["children_count", "index", "tag"]);
  });
});

describe("geometry 探针返回形状", () => {
  beforeEach(() => seed(`<div id="a">A</div><div id="b">B</div>`));

  it("顶层键集合恒为 viewport/elements/total/showing(+pair 当命中≥2)", () => {
    const r = geometryProbeFunc("div", 10) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["elements", "pair", "showing", "total", "viewport"]);
  });

  it("命中 1 个时无 pair 键,而不是 pair:undefined", () => {
    const r = geometryProbeFunc("#a", 10) as Record<string, unknown>;
    // 先证明探针没崩:只断言"某键不存在"时,探针抛错返回 {error} 也会让断言通过 ——
    // 实测把 pair 门槛从 >=2 改成 >=1,rects[1] 为 undefined 致探针 catch,这条照样绿。
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.elements)).toBe(true);
    expect("pair" in r).toBe(false);
  });

  it("元素键集合固定,occludedBy 未命中时不出现", () => {
    const r = geometryProbeFunc("#a", 10) as { elements: Array<Record<string, unknown>> };
    expect(Object.keys(r.elements[0]).sort()).toEqual(
      ["bbox", "clippedByAncestor", "inViewport", "index", "occluded", "tag", "textClipped"],
    );
  });

  it("showing 受 maxResults 截断而 total 不受", () => {
    const r = geometryProbeFunc("div", 1) as { total: number; showing: number; elements: unknown[] };
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });
});

describe("style 探针返回形状", () => {
  beforeEach(() => seed(`<p class="t">hello</p>`));

  it("顶层含 elements/total/showing,选组决定元素上的组键", () => {
    const r = styleProbeFunc(".t", 10, ["typography"]) as {
      elements: Array<Record<string, unknown>>; total: number; showing: number;
    };
    expect(r.total).toBe(1);
    expect(r.showing).toBe(1);
    expect(r.elements[0]).toHaveProperty("typography");
    expect(r.elements[0]).not.toHaveProperty("box");
  });

  it("未选 font 组时不产生 declaredFont/fp 字段", () => {
    const r = styleProbeFunc(".t", 10, ["box"]) as { elements: Array<Record<string, unknown>> };
    expect("declaredFont" in r.elements[0]).toBe(false);
    expect("fp" in r.elements[0]).toBe(false);
  });

  it("选 font 组时 declaredFont 与 fp 同时出现,fp 是路径形状", () => {
    const r = styleProbeFunc(".t", 10, ["font"]) as { elements: Array<{ declaredFont?: string; fp?: string }> };
    expect(typeof r.elements[0].declaredFont).toBe("string");
    expect(r.elements[0].fp).toMatch(/^[A-Z]+:\d/);
  });
});
```

- [x] **Step 2: 跑测试确认全绿**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts`

Expected: PASS。这些断言描述的是**现状**，此刻必须全绿；若有红说明我对现状的理解有误，停下来核对而不是改测试迁就。

- [x] **Step 3: 变异验证——证明这些测试真的会转红**

依次做四处改动，每次只改一处、跑测试、确认转红、再改回：

| 改动位置 | 怎么改 | 必须转红的用例 |
|---|---|---|
| `query.ts` cssQueryFunc 返回语句 | `showing: limit` → `showing: total` | css「showing 等于实际返回的元素数」 |
| `query.ts` cssQueryFunc 返回语句 | 删掉 `scanned` | css「顶层键集合」+「scanned 三个计数键齐全」 |
| `query.ts` geometryProbeFunc pair 分支 | `if (rects.length >= 2)` → `if (rects.length >= 1)` | geometry 三条：「命中 1 个时无 pair 键」+「元素键集合固定」+「showing 受 maxResults 截断」 |
| `query.ts` styleProbeFunc font 分支 | 让 `fp` 恒为 `undefined` | style「选 font 组时 declaredFont 与 fp 同时出现」 |

任一处改坏后测试**没有**转红，说明该条断言是摆设，必须补强后重做变异。

- [x] **Step 4: 确认改回后仍全绿**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts`

Expected: PASS，且 `git diff packages/extension/src/` 为空（四处变异都已还原）。

- [x] **Step 5: 提交**

```bash
git add packages/extension/tests/query-contract-shape.test.ts
git commit -m "test: 补 css/geometry/style 探针返回形状契约测试

现有测试断言字段值,不覆盖键集合、showing 语义与 scanned 自陈;
handler 层 css 测试 mock 掉 executeScript,探针未真正执行。
四处变异验证确认新断言会转红。"
```

---

## Task 2: 维度常量与整形层纯函数

整形层是本次重构的承重墙：探针只产原始数据，三种老返回形状全部由它还原。它不注入页面，因此可以是普通模块、可以真单测——这正是 v3.1.0 「探针只读原始值、判据抽成模块级纯函数」的处方。

**Files:**
- Create: `packages/extension/src/lib/element-dimensions.ts`
- Create: `packages/extension/src/lib/element-shaping.ts`
- Create: `packages/extension/tests/element-shaping.test.ts`

**Interfaces:**
- Consumes: 无（本任务不依赖前序代码产物）
- Produces:
  - `ALL_DIMENSIONS: readonly string[]`
  - `normalizeDimensions(input: string | string[] | undefined): string[] | null`
  - `dimensionsForMode(mode: "css" | "geometry" | "style", styleGroups: string[] | null): string[]`
  - `type RawElement = Record<string, unknown> & { index: number; tag: string }`
  - `type RawProbeResult = { elements: RawElement[]; total: number; showing: number; viewport?: { w: number; h: number }; pair?: Record<string, boolean>; scanned?: { elements: number; shadowRoots: number; iframes: number }; fontFaces?: Array<Record<string, string>>; fontFacesPartial?: boolean; fontFacesPartialReasons?: string[] }`
  - `shapeCssResult(raw: RawProbeResult, opts: { attributes: string[] | null; includeText: boolean }): { elements: Array<Record<string, unknown>>; total: number; showing: number; scanned?: { elements: number; shadowRoots: number; iframes: number } }`
  - `shapeGeometryResult(raw: RawProbeResult): { viewport: { w: number; h: number }; elements: Array<Record<string, unknown>>; pair?: Record<string, boolean>; total: number; showing: number }`
  - `shapeStyleResult(raw: RawProbeResult, groups: string[]): { elements: Array<Record<string, unknown>>; total: number; showing: number; fontFaces?: Array<Record<string, string>>; fontFacesPartial?: boolean; fontFacesPartialReasons?: string[] }`

- [x] **Step 1: 写失败的测试**

```ts
// element-shaping.test.ts
// 整形层是纯函数,喂构造好的原始结果、断言还原出的形状 —— 不依赖 jsdom 布局
// (jsdom getBoundingClientRect 恒 0,靠它算布局必然假绿)。

import { describe, it, expect } from "vitest";
import { normalizeDimensions, dimensionsForMode, ALL_DIMENSIONS } from "../src/lib/element-dimensions.js";
import { shapeCssResult, shapeGeometryResult, shapeStyleResult } from "../src/lib/element-shaping.js";

const RAW = {
  elements: [
    {
      index: 0, tag: "li",
      text: "A", children_count: 0, attrs: { href: "/a" },
      bbox: [0, 0, 10, 10], inViewport: true, occluded: false,
      textClipped: false, clippedByAncestor: false,
      typography: { fontSize: "16px" }, box: { display: "block" },
      declaredFont: "Inter", fp: "LI:0",
    },
    {
      index: 1, tag: "li",
      text: "B", children_count: 0, attrs: {},
      bbox: [0, 20, 10, 10], inViewport: true, occluded: true, occludedBy: "div#mask",
      textClipped: false, clippedByAncestor: false,
      typography: { fontSize: "16px" }, box: { display: "block" },
      declaredFont: "Inter", fp: "LI:1",
    },
  ],
  total: 2, showing: 2,
  viewport: { w: 800, h: 600 },
  pair: { overlap: false, aAboveB: true },
  scanned: { elements: 12, shadowRoots: 0, iframes: 0 },
};

describe("normalizeDimensions", () => {
  it("接受逗号与竖线分隔,去空白", () => {
    expect(normalizeDimensions("geometry|text, box")).toEqual(["geometry", "text", "box"]);
  });

  it("未传返回 null,让调用方决定默认值", () => {
    expect(normalizeDimensions(undefined)).toBeNull();
  });

  it("全是空白时返回 null,而不是空数组", () => {
    expect(normalizeDimensions(" , | ")).toBeNull();
  });
});

describe("dimensionsForMode", () => {
  it("css 翻译成 text+attrs", () => {
    expect(dimensionsForMode("css", null).sort()).toEqual(["attrs", "text"]);
  });

  it("geometry 翻译成 geometry 单维", () => {
    expect(dimensionsForMode("geometry", null)).toEqual(["geometry"]);
  });

  it("style 原样透传所选样式组", () => {
    // 老 style 契约里那 10 个扁平字段与 groups 无关、恒返回;漏掉 contrast 就是静默行为变更
    expect(dimensionsForMode("style", ["box", "font"]).sort())
      .toEqual(["box", "contrast", "font"]);
  });

  it("每个 style 组名都在 ALL_DIMENSIONS 里,否则组合模式无法请求它", () => {
    for (const g of ["typography", "box", "paint", "motion", "pseudo", "font"]) {
      expect(ALL_DIMENSIONS).toContain(g);
    }
  });
});

describe("shapeCssResult", () => {
  it("只留 css 契约字段,几何与样式字段被剥掉", () => {
    const r = shapeCssResult(RAW, { attributes: ["href"], includeText: true });
    expect(Object.keys(r.elements[0]).sort()).toEqual(["attrs", "children_count", "index", "tag", "text"]);
    expect(Object.keys(r).sort()).toEqual(["elements", "scanned", "showing", "total"]);
  });

  it("includeText=false 时不带 text 键", () => {
    const r = shapeCssResult(RAW, { attributes: null, includeText: false });
    expect("text" in r.elements[0]).toBe(false);
  });

  it("attributes=null 时不带 attrs 键", () => {
    const r = shapeCssResult(RAW, { attributes: null, includeText: true });
    expect("attrs" in r.elements[0]).toBe(false);
  });

  it("attrs 为空对象时仍保留该键,不省略", () => {
    const r = shapeCssResult(RAW, { attributes: ["href"], includeText: true });
    expect(r.elements[1].attrs).toEqual({});
  });

  it("scanned 原样透传,零命中诊断依赖它", () => {
    expect(shapeCssResult(RAW, { attributes: null, includeText: true }).scanned)
      .toEqual({ elements: 12, shadowRoots: 0, iframes: 0 });
  });
});

describe("shapeGeometryResult", () => {
  it("只留 geometry 契约字段", () => {
    const r = shapeGeometryResult(RAW);
    expect(Object.keys(r.elements[0]).sort()).toEqual(
      ["bbox", "clippedByAncestor", "inViewport", "index", "occluded", "tag", "textClipped"],
    );
  });

  it("occludedBy 有值才出现", () => {
    const r = shapeGeometryResult(RAW);
    expect("occludedBy" in r.elements[0]).toBe(false);
    expect(r.elements[1].occludedBy).toBe("div#mask");
  });

  it("pair 缺席时不产生该键", () => {
    const r = shapeGeometryResult({ ...RAW, pair: undefined });
    expect("pair" in r).toBe(false);
  });

  it("顶层键集合与老契约一致", () => {
    expect(Object.keys(shapeGeometryResult(RAW)).sort())
      .toEqual(["elements", "pair", "showing", "total", "viewport"]);
  });
});

describe("shapeStyleResult", () => {
  it("只留所选组,未选的组被剥掉", () => {
    const r = shapeStyleResult(RAW, ["typography"]);
    expect(r.elements[0]).toHaveProperty("typography");
    expect(r.elements[0]).not.toHaveProperty("box");
    expect(r.elements[0]).not.toHaveProperty("bbox");
  });

  it("未选 font 时剥掉 declaredFont 与 fp", () => {
    const r = shapeStyleResult(RAW, ["box"]);
    expect("declaredFont" in r.elements[0]).toBe(false);
    expect("fp" in r.elements[0]).toBe(false);
  });

  it("选 font 时保留 declaredFont 与 fp 供 CDP 对齐", () => {
    const r = shapeStyleResult(RAW, ["font"]);
    expect(r.elements[0].declaredFont).toBe("Inter");
    expect(r.elements[0].fp).toBe("LI:0");
  });

  it("未选 pseudo 时剥掉 pseudoRaw,它是内部中间字段不该外泄", () => {
    const withPseudo = { ...RAW, elements: RAW.elements.map((e) => ({ ...e, pseudoRaw: { "::before": { content: '"x"' } } })) };
    expect("pseudoRaw" in shapeStyleResult(withPseudo, ["box"]).elements[0]).toBe(false);
    expect("pseudoRaw" in shapeStyleResult(withPseudo, ["pseudo"]).elements[0]).toBe(true);
  });

  it("整形不改变元素数量与顺序,fp 逐位对齐(CDP 按下标取字体,错位即静默取错)", () => {
    const shaped = shapeStyleResult(RAW, ["font"]);
    expect(shaped.elements).toHaveLength(RAW.elements.length);
    expect(shaped.elements.map((e) => e.fp)).toEqual(RAW.elements.map((e) => e.fp));
    expect(shaped.elements.map((e) => e.index)).toEqual([0, 1]);
  });

  // fixture 里每个元素都有 fp,所以 filter(e => e.fp) 型变异一个都滤不掉、测不出来。
  // 未请求 font 维度时探针本就不设 fp,这才是"整形不许丢元素"真正会被违反的场景。
  it("元素缺 fp 时也不能被丢掉,未请求 font 维度的探针输出就没有 fp", () => {
    const noFp = {
      ...RAW,
      elements: RAW.elements.map((e) => {
        const copy: Record<string, unknown> = { ...e };
        delete copy.fp;
        delete copy.declaredFont;
        return copy as typeof e;
      }),
    };
    const shaped = shapeStyleResult(noFp, ["box"]);
    expect(shaped.elements).toHaveLength(2);
    expect(shaped.elements.map((e) => e.index)).toEqual([0, 1]);
  });

  it("index 与 tag 恒保留,身份不能被剥掉", () => {
    for (const groups of [["box"], ["font"], ["typography", "paint"]]) {
      const r = shapeStyleResult(RAW, groups);
      expect(r.elements[0].index).toBe(0);
      expect(r.elements[0].tag).toBe("li");
    }
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/element-shaping.test.ts`

Expected: FAIL，报 `Failed to resolve import "../src/lib/element-dimensions.js"`

- [x] **Step 3: 写 element-dimensions.ts**

```ts
// 维度名单一真源。host 侧校验与探针采集共用同一份名字,避免两边各写一套漂移。
// 探针不 import 本模块(注入丢模块作用域),而是接收本模块算好的字符串数组。

/** 样式组名与 mode=style 的 attr 选组保持一致,组合模式据此可单独请求某一组。 */
const STYLE_GROUPS = ["typography", "box", "paint", "motion", "pseudo", "font"] as const;

// contrast 见 Task 5 抬头的订正:老 mode=style 无条件返回这批扁平字段
export const CONTRAST_KEYS: readonly string[] = [
  "color", "background", "backgroundImage", "bgFromAncestor", "fontWeight", "fontSize",
  "contrastRatio", "contrastStatus", "wcagAA", "wcagAAA",
];

export const ALL_DIMENSIONS: readonly string[] = [
  "geometry", "text", "attrs", "contrast", ...STYLE_GROUPS,
];

/** 逗号或竖线分隔;全空白视为未传,返回 null 让调用方套默认值而非退化成空集。 */
export function normalizeDimensions(input: string | string[] | undefined): string[] | null {
  if (input == null) return null;
  const raw = Array.isArray(input) ? input : input.split(/[,|]/);
  const out = raw.map((d) => d.trim()).filter(Boolean);
  return out.length > 0 ? out : null;
}

export function dimensionsForMode(
  mode: "css" | "geometry" | "style",
  styleGroups: string[] | null,
): string[] {
  if (mode === "css") return ["text", "attrs"];
  if (mode === "geometry") return ["geometry"];
  // contrast 恒开:老 style 契约里这批字段与 groups 无关,少给就是行为变更
  return ["contrast", ...(styleGroups ?? STYLE_GROUPS)];
}
```

- [x] **Step 4: 写 element-shaping.ts**

```ts
// 探针只产原始值,三种老返回形状全部由本模块还原。整形层不注入页面,
// 因此能被真断言覆盖 —— 探针内联逻辑做不到这点(jsdom 无布局,mock 出的是假绿)。

export type RawElement = Record<string, unknown> & { index: number; tag: string };

export type RawProbeResult = {
  elements: RawElement[];
  total: number;
  showing: number;
  viewport?: { w: number; h: number };
  pair?: Record<string, boolean>;
  scanned?: { elements: number; shadowRoots: number; iframes: number };
  fontFaces?: Array<Record<string, string>>;
  fontFacesPartial?: boolean;
  fontFacesPartialReasons?: string[];
};

const CSS_ELEMENT_KEYS = ["index", "tag", "children_count"] as const;
const GEOMETRY_ELEMENT_KEYS = [
  "index", "tag", "bbox", "inViewport", "occluded", "occludedBy", "textClipped", "clippedByAncestor",
] as const;

/** 只拷贝存在的键。写死 undefined 会让 `"k" in obj` 为真,老契约里那些键本该缺席。 */
function pick(src: RawElement, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

export function shapeCssResult(
  raw: RawProbeResult,
  opts: { attributes: string[] | null; includeText: boolean },
): {
  elements: Array<Record<string, unknown>>;
  total: number;
  showing: number;
  scanned?: { elements: number; shadowRoots: number; iframes: number };
} {
  const elements = raw.elements.map((e) => {
    const item = pick(e, CSS_ELEMENT_KEYS);
    if (opts.includeText && e.text !== undefined) item.text = e.text;
    // attrs 为空对象也要留键:调用方据此区分"没要属性"与"要了但都没有"
    if (opts.attributes != null && e.attrs !== undefined) item.attrs = e.attrs;
    return item;
  });
  return {
    elements,
    total: raw.total,
    showing: raw.showing,
    ...(raw.scanned ? { scanned: raw.scanned } : {}),
  };
}

export function shapeGeometryResult(raw: RawProbeResult): {
  viewport: { w: number; h: number };
  elements: Array<Record<string, unknown>>;
  pair?: Record<string, boolean>;
  total: number;
  showing: number;
} {
  return {
    viewport: raw.viewport ?? { w: 0, h: 0 },
    elements: raw.elements.map((e) => pick(e, GEOMETRY_ELEMENT_KEYS)),
    ...(raw.pair ? { pair: raw.pair } : {}),
    total: raw.total,
    showing: raw.showing,
  };
}

export function shapeStyleResult(
  raw: RawProbeResult,
  groups: string[],
): {
  elements: Array<Record<string, unknown>>;
  total: number;
  showing: number;
  fontFaces?: Array<Record<string, string>>;
  fontFacesPartial?: boolean;
  fontFacesPartialReasons?: string[];
} {
  // font 组才需要 declaredFont/fp(CDP 按下标对齐的凭据),pseudoRaw 只跟 pseudo 组走
  const extra = [
    ...(groups.indexOf("font") !== -1 ? ["declaredFont", "fp"] : []),
    ...(groups.indexOf("pseudo") !== -1 ? ["pseudoRaw"] : []),
  ];
  const keys = ["index", "tag", ...groups, ...extra];
  return {
    elements: raw.elements.map((e) => pick(e, keys)),
    total: raw.total,
    showing: raw.showing,
    ...(raw.fontFaces ? { fontFaces: raw.fontFaces } : {}),
    ...(raw.fontFacesPartial !== undefined ? { fontFacesPartial: raw.fontFacesPartial } : {}),
    ...(raw.fontFacesPartialReasons ? { fontFacesPartialReasons: raw.fontFacesPartialReasons } : {}),
  };
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/element-shaping.test.ts`

Expected: PASS（全部 20 条）

- [x] **Step 6: 变异验证整形层**

| 改动 | 必须转红的用例 |
|---|---|
| `pick` 里 `if (src[k] !== undefined)` 改成无条件 `out[k] = src[k]` | geometry「occludedBy 有值才出现」 |
| `shapeCssResult` 去掉 `opts.attributes != null` 条件 | css「attributes=null 时不带 attrs 键」 |
| `shapeStyleResult` 的 `extra` 恒含 `declaredFont`/`fp` | style「未选 font 时剥掉 declaredFont 与 fp」 |
| `shapeStyleResult` 的 `extra` 恒含 `pseudoRaw` | style「未选 pseudo 时剥掉 pseudoRaw」 |
| `shapeStyleResult` 改成 `raw.elements.filter(e => e.fp).map(...)` | style「元素缺 fp 时也不能被丢掉」——**不是**「整形不改变元素数量与顺序」，后者的 fixture 每个元素都有 fp，filter 一个都滤不掉，是死条件（实测发现） |

五处都必须转红；改回后重跑应全绿。

- [x] **Step 7: 提交**

```bash
git add packages/extension/src/lib/element-dimensions.ts \
        packages/extension/src/lib/element-shaping.ts \
        packages/extension/tests/element-shaping.test.ts
git commit -m "feat: 新增维度常量与整形层纯函数

探针只产原始值,css/geometry/style 三种返回形状由整形层还原。
整形层不注入页面故可真断言,三处变异验证确认测试有效。"
```

---

## Task 3: 统一探针骨架 + geometry 维度 + geometry mode 转发

先落地最简单的维度族，验证「统一探针 → 整形层 → 老契约」这条链路走得通，再往上叠 text/attrs 与样式组。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（新增 `elementsProbeFunc`；geometry mode 分支改为转发）
- Test: `packages/extension/tests/query-contract-shape.test.ts`（Task 1 已建，本任务只加断言）

**Interfaces:**
- Consumes: `shapeGeometryResult`、`dimensionsForMode`（Task 2 产出）
- Produces: `elementsProbeFunc(selector: string, maxResults: number, dims: string[], attributes: string[] | null, includeText: boolean): RawProbeResult | { error: string }`，导出自 `../src/handlers/query.js`

- [x] **Step 1: 写失败的测试**

追加到 `packages/extension/tests/query-contract-shape.test.ts` 末尾：

```ts
import { elementsProbeFunc } from "../src/handlers/query.js";

describe("统一探针 geometry 维度", () => {
  beforeEach(() => seed(`<div id="a">A</div><div id="b">B</div>`));

  it("只请求 geometry 时元素上没有文本与属性字段", () => {
    const r = elementsProbeFunc("div", 10, ["geometry"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0]).toHaveProperty("bbox");
    expect("text" in r.elements[0]).toBe(false);
    expect("attrs" in r.elements[0]).toBe(false);
  });

  it("不请求 geometry 时不产生 viewport 与 pair", () => {
    const r = elementsProbeFunc("div", 10, ["text"], null, true) as Record<string, unknown>;
    expect("viewport" in r).toBe(false);
    expect("pair" in r).toBe(false);
  });

  it("scanned 恒产出,与是否请求维度无关(零命中诊断依赖它)", () => {
    const r = elementsProbeFunc(".nope", 10, ["geometry"], null, false) as {
      total: number; scanned: Record<string, number>;
    };
    expect(r.total).toBe(0);
    expect(Object.keys(r.scanned).sort()).toEqual(["elements", "iframes", "shadowRoots"]);
    // 只查键集合是空集假绿:删掉探针里的累加,键还在、值变 0,断言照样通过。
    // 零命中诊断要的正是"搜了多少个都没匹配",没有这条数字断言就证明不了探针在数。
    expect(r.scanned.elements).toBeGreaterThan(0);
  });

  it("非法选择器返回 error 而不是抛出", () => {
    const r = elementsProbeFunc("div[[", 10, ["geometry"], null, false) as { error?: string };
    expect(r.error).toMatch(/Invalid CSS selector/);
  });

  it("经整形层还原后与老 geometry 探针形状一致", async () => {
    const { shapeGeometryResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc("div", 10, ["geometry"], null, false);
    const shaped = shapeGeometryResult(raw as never);
    const legacy = geometryProbeFunc("div", 10) as Record<string, unknown>;
    expect(Object.keys(shaped).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.keys((shaped.elements as Array<Record<string, unknown>>)[0]).sort())
      .toEqual(Object.keys((legacy.elements as Array<Record<string, unknown>>)[0]).sort());
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts`

Expected: FAIL，报 `elementsProbeFunc is not exported`

- [x] **Step 3: 在 query.ts 中新增统一探针**

插入到 `geometryProbeFunc` 定义之后（约 `query.ts:746` 后）。本步只实现骨架 + geometry 维度，`text`/`attrs`/样式组留待 Task 4、5 填入标注处：

```ts
/**
 * page-side 统一元素探针。一次命中元素集合,按 dims 采集各维度**原始值**。
 * 整形交给 host 侧 element-shaping.ts —— 探针内不做形状裁剪。
 * 参数 args: [selector, maxResults, dims, attributes, includeText]。
 * ⚠ 自包含:注入丢模块作用域,queryAllDeep 等必须内联。
 */
export const elementsProbeFunc = (
  selector: string,
  maxResults: number,
  dims: string[],
  attributes: string[] | null,
  includeText: boolean,
): {
  elements: Array<Record<string, unknown>>;
  total: number;
  showing: number;
  viewport?: { w: number; h: number };
  pair?: Record<string, boolean>;
  scanned: { elements: number; shadowRoots: number; iframes: number };
} | { error: string } => {
  try {
    const want = (d: string): boolean => dims.indexOf(d) !== -1;
    const SHADOW_WALK_MAX_DEPTH = 8;
    let scannedElements = 0;
    let shadowRootsSeen = 0;
    const queryAllDeep = (sel: string, root: Document | ShadowRoot, depth: number): Element[] => {
      const acc: Element[] = Array.from(root.querySelectorAll(sel));
      if (depth >= SHADOW_WALK_MAX_DEPTH) return acc;
      const all = root.querySelectorAll("*");
      scannedElements += all.length;
      for (const host of all) {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) {
          shadowRootsSeen++;
          acc.push(...queryAllDeep(sel, sr, depth + 1));
        }
      }
      return acc;
    };

    let matched: Element[];
    try {
      matched = queryAllDeep(selector, document, 0);
    } catch (e) {
      return { error: "Invalid CSS selector: " + (e instanceof Error ? e.message : String(e)) };
    }

    const scanned = {
      elements: scannedElements,
      shadowRoots: shadowRootsSeen,
      iframes: document.querySelectorAll("iframe,frame").length,
    };
    const total = matched.length;
    const limit = Math.min(total, maxResults);

    const wantGeo = want("geometry");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const R = (n: number): number => Math.round(n);
    const TOL = 2;
    const desc = (el: Element | null): string => {
      if (!el) return "?";
      let s = el.tagName ? el.tagName.toLowerCase() : "?";
      if ((el as HTMLElement).id) s += "#" + (el as HTMLElement).id;
      else if (typeof (el as HTMLElement).className === "string" && (el as HTMLElement).className.trim()) {
        s += "." + (el as HTMLElement).className.trim().split(/\s+/)[0];
      }
      return s;
    };

    // 只用到六个数值属性;不用 DOMRect 是因为 Task 7 的失败占位在 jsdom 下无法构造。
    // null 表示该元素几何采集失败 —— 与 elements 严格一一对应,不靠长度时机推断。
    type RectLike = { left: number; top: number; right: number; bottom: number; width: number; height: number };
    const rects: Array<RectLike | null> = [];
    const elements: Array<Record<string, unknown>> = [];
    for (let i = 0; i < limit; i++) {
      const el = matched[i] as HTMLElement;
      const item: Record<string, unknown> = { index: i, tag: el.tagName.toLowerCase() };

      if (wantGeo) {
        const r = el.getBoundingClientRect();
        rects.push(r);
        item.bbox = [R(r.left), R(r.top), R(r.width), R(r.height)];
        item.inViewport = r.left >= -TOL && r.top >= -TOL && r.right <= vw + TOL && r.bottom <= vh + TOL;

        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const topEl = typeof document.elementFromPoint === "function" ? document.elementFromPoint(cx, cy) : null;
        item.occluded = !!(topEl && topEl !== el && !el.contains(topEl));
        if (item.occluded) item.occludedBy = desc(topEl);

        item.textClipped = el.scrollWidth > el.clientWidth + TOL;

        let clipped = false;
        for (let a: HTMLElement | null = el.parentElement, j = 0; a && j < 12; j++, a = a.parentElement) {
          const ov = (() => {
            try {
              const cs = getComputedStyle(a);
              return cs.overflow + " " + cs.overflowX + " " + cs.overflowY;
            } catch {
              return "";
            }
          })();
          if (/hidden|auto|scroll|clip/.test(ov)) {
            const ar = a.getBoundingClientRect();
            if (r.right > ar.right + TOL || r.bottom > ar.bottom + TOL ||
                r.left < ar.left - TOL || r.top < ar.top - TOL) clipped = true;
            break; // 只看最近的裁剪祖先
          }
        }
        item.clippedByAncestor = clipped;
      }

      // [Task 4 在此插入 text / attrs 维度采集]
      // [Task 5 在此插入样式六组维度采集]

      elements.push(item);
    }

    const out: Record<string, unknown> = { elements, total, showing: limit, scanned };
    if (wantGeo) {
      out.viewport = { w: vw, h: vh };
      if (rects.length >= 2) {
        const a = rects[0];
        const b = rects[1];
        const near = (x: number, y: number): boolean => Math.abs(x - y) <= TOL;
        out.pair = {
          overlap: !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom),
          aAboveB: a.bottom <= b.top + TOL,
          aBelowB: a.top >= b.bottom - TOL,
          aLeftOfB: a.right <= b.left + TOL,
          aRightOfB: a.left >= b.right - TOL,
          sameLeft: near(a.left, b.left),
          sameTop: near(a.top, b.top),
          sameRight: near(a.right, b.right),
          sameBottom: near(a.bottom, b.bottom),
          sameHCenter: near(a.left + a.width / 2, b.left + b.width / 2),
          sameVCenter: near(a.top + a.height / 2, b.top + b.height / 2),
        };
      }
    }
    return out as never;
  } catch (e) {
    return { error: "elements probe error: " + (e instanceof Error ? e.message : String(e)) };
  }
};
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts`

Expected: PASS。老 geometry 探针尚未删除，其形状契约同时仍绿。

- [x] **Step 5: geometry mode 改为转发**

替换 `query.ts:1965` 起的 geometry 分支，注入函数与整形层各就各位：

```ts
      } else if (mode === "geometry") {
        // 转发到统一探针,再由整形层还原老契约(单一真源见 element-shaping.ts)
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 10, 50);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: elementsProbeFunc,
          args: [pattern, maxResults, dimensionsForMode("geometry", null), null, false],
          world: "MAIN",
        });

        const res = results[0]?.result as RawProbeResult | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage geometry: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage geometry error: ${res.error}`);
        }
        return shapeGeometryResult(res as RawProbeResult);
```

同时在 `query.ts` 顶部 import 区加入：

```ts
import { dimensionsForMode, normalizeDimensions, ALL_DIMENSIONS } from "../lib/element-dimensions.js";
import {
  shapeCssResult, shapeGeometryResult, shapeStyleResult, type RawProbeResult,
} from "../lib/element-shaping.js";
```

- [x] **Step 6: 跑 geometry 相关全部测试**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-geometry.test.ts tests/query-contract-shape.test.ts tests/query-handler.test.ts`

Expected: PASS

- [x] **Step 7: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-contract-shape.test.ts
git commit -m "refactor: geometry mode 转发到统一元素探针

新增 elementsProbeFunc 承担一次遍历+按维度采集原始值,
geometry 分支改为转发并经整形层还原,对外契约不变。"
```

---

## Task 4: text/attrs 维度 + css mode 转发

css 的 `scanned` 自陈是零命中诊断的唯一依据（`diagnoseEmptyQueryCss`），转发时最容易在 `withDiagnosis` 那一步丢掉——本任务的测试专门盯住它。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`
- Test: `packages/extension/tests/query-contract-shape.test.ts`、`packages/extension/tests/query-handler.test.ts`

**Interfaces:**
- Consumes: `elementsProbeFunc`（Task 3）、`shapeCssResult`、`dimensionsForMode`（Task 2）
- Produces: 无新增导出

- [x] **Step 1: 写失败的测试**

追加到 `packages/extension/tests/query-contract-shape.test.ts`：

```ts
describe("统一探针 text/attrs 维度", () => {
  beforeEach(() => seed(`<ul><li class="item" href="/a">A</li><li class="item">B</li></ul>`));

  it("请求 attrs 时按 attributes 白名单取值", () => {
    const r = elementsProbeFunc(".item", 10, ["attrs"], ["href"], false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs).toEqual({ href: "/a" });
    expect(r.elements[1].attrs).toEqual({});
  });

  it("超长属性值截断到 500 字符并加省略号", () => {
    document.querySelector(".item")!.setAttribute("data-x", "y".repeat(600));
    const r = elementsProbeFunc(".item", 10, ["attrs"], ["data-x"], false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs!["data-x"]).toHaveLength(503);
    expect(r.elements[0].attrs!["data-x"].endsWith("...")).toBe(true);
  });

  it("请求 text 时带 text 与 children_count", () => {
    const r = elementsProbeFunc(".item", 10, ["text"], null, true) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0].text).toBe("A");
    expect(r.elements[0].children_count).toBe(0);
  });

  it("includeText=false 时即使请求 text 维度也不产 text 字段", () => {
    const r = elementsProbeFunc(".item", 10, ["text"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect("text" in r.elements[0]).toBe(false);
    expect(r.elements[0].children_count).toBe(0);
  });

  // children_count 何时出现,老契约里没有明文规定,只能拿老探针实测建基线。
  // 不建基线就转发,等于把一个未定义行为固化成新契约。
  it.each([
    { attrs: null as string[] | null, includeText: true },
    { attrs: null as string[] | null, includeText: false },
    { attrs: ["href"], includeText: true },
    { attrs: ["href"], includeText: false },
    { attrs: [] as string[], includeText: true },
  ])("children_count 出现与否与老 css 探针一致 (attrs=$attrs, includeText=$includeText)", ({ attrs, includeText }) => {
    const legacy = cssQueryFunc(".item", attrs, 10, includeText) as { elements: Array<Record<string, unknown>> };
    const dims = ["text", "attrs"];
    const now = elementsProbeFunc(".item", 10, dims, attrs, includeText) as { elements: Array<Record<string, unknown>> };
    expect("children_count" in now.elements[0]).toBe("children_count" in legacy.elements[0]);
    expect(now.elements[0].children_count).toBe(legacy.elements[0].children_count);
  });

  it("经整形层还原后与老 css 探针形状一致", async () => {
    const { shapeCssResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc(".item", 10, ["text", "attrs"], ["href"], true);
    const shaped = shapeCssResult(raw as never, { attributes: ["href"], includeText: true });
    const legacy = cssQueryFunc(".item", ["href"], 10, true) as Record<string, unknown>;
    expect(Object.keys(shaped).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.keys((shaped.elements as Array<Record<string, unknown>>)[0]).sort())
      .toEqual(Object.keys((legacy.elements as Array<Record<string, unknown>>)[0]).sort());
  });
});
```

追加到 `packages/extension/tests/query-handler.test.ts`（补 Luna 指出的缺口：css 零命中的 `scanned` 自陈当前无任何覆盖）：

```ts
  it("css mode 零命中时把 scanned 事实带进诊断,而不是只回 total:0", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [], total: 0, showing: 0,
        scanned: { elements: 137, shadowRoots: 2, iframes: 1 },
      },
    }]);

    const res = await router.dispatch(mkReq("query.queryPage", { mode: "css", pattern: ".nope" }));

    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, unknown>;
    // scanned 不进返回体(老契约如此),但必须进诊断,否则调用方不知道搜了多大范围
    expect("scanned" in result).toBe(false);
    // 三个数值都必须进诊断。只匹配"出现某个数字"太宽 —— 诊断改成固定文案也能偶然过
    const diag = JSON.stringify(result);
    expect(diag).toContain("137");
    expect(diag).toContain("2");
    expect(diag).toContain("1");
    expect(diag).toMatch(/shadow/i);
    expect(diag).toMatch(/iframe/i);
  });

  it("css mode 命中时返回体带 showing,且等于元素数", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [{ index: 0, tag: "li", text: "A", children_count: 0 }],
        total: 5, showing: 1,
        scanned: { elements: 10, shadowRoots: 0, iframes: 0 },
      },
    }]);

    const res = await router.dispatch(mkReq("query.queryPage", { mode: "css", pattern: ".item", maxResults: 1 }));
    const result = res.result as { total: number; showing: number; elements: unknown[] };
    expect(result.total).toBe(5);
    expect(result.showing).toBe(1);
    expect(result.elements).toHaveLength(1);
  });
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts tests/query-handler.test.ts`

Expected: FAIL。contract-shape 的四条报 attrs/text 字段缺失；handler 的「零命中带 scanned」当前应已能过（老实现已支持），「showing」一条会暴露 css 分支是否真的透传 showing。

- [x] **Step 3: 在统一探针中填入 text/attrs 采集**

替换 Task 3 留下的 `// [Task 4 在此插入 text / attrs 维度采集]` 标注：

```ts
      if (want("text") || want("attrs")) {
        item.children_count = el.children.length;
      }
      if (want("text") && includeText) {
        const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        item.text = t.length > 300 ? t.slice(0, 300) + "..." : t;
      }
      if (want("attrs") && attributes != null) {
        const attrs: Record<string, string> = {};
        for (const attrName of attributes) {
          const val = el.getAttribute(attrName);
          if (val !== null) attrs[attrName] = val.length > 500 ? val.slice(0, 500) + "..." : val;
        }
        item.attrs = attrs;
      }
```

- [x] **Step 4: css mode 改为转发**

替换 `query.ts:1934` 起的 css 分支：

```ts
      } else if (mode === "css") {
        const attributes: string[] | null = normalizeCssAttrParam(args.attr as string | string[] | undefined);
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 20, 100);
        const includeText = (args.includeText as boolean | undefined) ?? true;

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: elementsProbeFunc,
          args: [pattern, maxResults, dimensionsForMode("css", null), attributes, includeText],
          world: "MAIN",
        });

        const res = results[0]?.result as RawProbeResult | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage css: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage css error: ${res.error}`);
        }
        const raw = res as RawProbeResult;
        // scanned 只喂诊断不进返回体,与老契约一致
        const { scanned, ...payload } = shapeCssResult(raw, { attributes, includeText });
        return withDiagnosis(
          payload,
          raw.total === 0 && scanned
            ? diagnoseEmptyQueryCss({ ...scanned, selector: pattern, frameScoped: frameId != null })
            : null,
        );
```

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts tests/query-handler.test.ts tests/query-css-attr-normalize.test.ts tests/query-empty-diagnosis.test.ts`

Expected: PASS

- [x] **Step 6: 变异验证 scanned 链路（两处，缺一不可）**

handler 测试用 mock 注入 payload，只能证明 handler 不丢 mock 数据，**不能证明探针真的在计数**。
两处变异分别盯住这两段：

| 改动位置 | 必须转红的用例 | 盯住的是 |
|---|---|---|
| Step 4 里 `raw.total === 0 && scanned` → `false` | handler「零命中时把 scanned 事实带进诊断」 | handler → 诊断这一段 |
| 统一探针里 `scannedElements += all.length` 整行删掉（**注意 `cssQueryFunc` 里有同名同形的一行，删错那处测不到；按行号定位到 `elementsProbeFunc` 内的那处**） | contract-shape「scanned 恒产出」 | 探针真的在计数 |

改回后重跑应全绿。

- [x] **Step 7: 提交**

```bash
git add packages/extension/src/handlers/query.ts \
        packages/extension/tests/query-contract-shape.test.ts \
        packages/extension/tests/query-handler.test.ts
git commit -m "refactor: css mode 转发到统一元素探针

补 text/attrs 维度采集;scanned 仍只喂零命中诊断不进返回体。
新增 handler 层零命中诊断测试,变异验证确认该链路被锁住。"
```

---

## Task 5: 样式六组维度采集（page-side）

> **执行中订正（Task 5 首轮阻断）**：原计划漏了一件事——老 `styleProbeFunc` 除六个组之外，
> **无条件**返回 10 个扁平字段（`color` / `background` / `backgroundImage` / `bgFromAncestor` /
> `fontWeight` / `fontSize` / `contrastRatio` / `contrastStatus` / `wcagAA` / `wcagAAA`，
> `query.ts:1342` 起的 push），与 `groups` 无关。Task 2 的 `shapeStyleResult` 只保留
> 「index/tag/所选组/font+pseudo 内部字段」，这 10 个必然被剥掉，Step 1 的形状契约测试
> **永远不可能通过**。修法是把它们提为第七个维度 `contrast`，并让
> `dimensionsForMode("style", …)` 恒带上它——老契约一字不变，`mode=elements` 里则可以
> 只要 `box` 而跳过上溯 painted background 的那趟祖先遍历。

本任务只做 page-side 采集：contrast 扁平块、六个组、伪元素原始值、`fp` 指纹、`fontFaces` 结果级聚合。
**host 侧的转发与 CDP 字体对齐拆到 Task 6**——那部分的风险（下标错位）与本任务的风险
（搬运漏内联标识符）性质完全不同，混在一个 Task 里出问题难以定位。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（只改 `elementsProbeFunc` 函数体）
- Test: `packages/extension/tests/query-contract-shape.test.ts`

**Interfaces:**
- Consumes: `elementsProbeFunc`（Task 3/4）
- Produces: `elementsProbeFunc` 支持九个维度名的完整采集

- [x] **Step 1: 写失败的测试**

追加到 `packages/extension/tests/query-contract-shape.test.ts`：

```ts
describe("统一探针样式维度", () => {
  beforeEach(() => seed(`<p class="t">hello</p>`));

  it("按组请求,未请求的组不出现", () => {
    const r = elementsProbeFunc(".t", 10, ["typography"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0]).toHaveProperty("typography");
    expect("box" in r.elements[0]).toBe(false);
    expect("paint" in r.elements[0]).toBe(false);
  });

  it("请求 font 组时产出 declaredFont 与 fp,fp 是路径形状供 CDP 对齐", () => {
    const r = elementsProbeFunc(".t", 10, ["font"], null, false) as {
      elements: Array<{ declaredFont?: string; fp?: string }>;
    };
    expect(typeof r.elements[0].declaredFont).toBe("string");
    expect(r.elements[0].fp).toMatch(/^[A-Z]+:\d/);
  });

  it("多个元素的 fp 互不相同,否则 CDP 对齐会误判为碰撞", () => {
    seed(`<p class="t">a</p><p class="t">b</p>`);
    const r = elementsProbeFunc(".t", 10, ["font"], null, false) as {
      elements: Array<{ fp?: string }>;
    };
    expect(r.elements[0].fp).not.toBe(r.elements[1].fp);
  });

  it("geometry 与样式组可同时请求,两者字段共存于同一元素", () => {
    const r = elementsProbeFunc(".t", 10, ["geometry", "box"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0]).toHaveProperty("bbox");
    expect(r.elements[0]).toHaveProperty("box");
    expect(r.elements[0].index).toBe(0);
  });

  it("经整形层还原后与老 style 探针形状一致", async () => {
    const { shapeStyleResult } = await import("../src/lib/element-shaping.js");
    const { dimensionsForMode } = await import("../src/lib/element-dimensions.js");
    const dims = dimensionsForMode("style", ["typography", "box"]);
    const raw = elementsProbeFunc(".t", 10, dims, null, false);
    const shaped = shapeStyleResult(raw as never, dims);
    const legacy = styleProbeFunc(".t", 10, ["typography", "box"]) as Record<string, unknown>;
    // 逐值而非只比键集合:pickProps 少做一次 camelCase→kebab 转换,键一个不缺、值全是空串
    expect((shaped.elements as Array<Record<string, unknown>>)[0])
      .toEqual((legacy.elements as Array<Record<string, unknown>>)[0]);
  });

  // 只比键集合挡不住"把 parseStrict 换成宽松 parse"这类改写:键一个不少,数字全错。
  // 对比度五态是真站上纠正过捏造数字的成果,必须逐值对齐老探针。
  it.each([
    ["ok", "color:#111;background:#fff"],
    ["no-painted-background", "color:#111"],
    ["translucent", "color:#111;background:#fff;opacity:.5"],
    ["unsupported-color", "color:oklch(.5 .1 200);background:#fff"],
    ["background-image", "color:#111;background:url(x.png)"],
  ])("contrast 维度逐值对齐老探针:%s", (_name, css) => {
    seed(`<p class="t" style="${css}">hello</p>`);
    const raw = elementsProbeFunc(".t", 10, ["contrast"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    const legacy = styleProbeFunc(".t", 10, []) as { elements: Array<Record<string, unknown>> };
    for (const k of ["contrastStatus", "contrastRatio", "wcagAA", "wcagAAA",
      "color", "background", "backgroundImage", "bgFromAncestor"]) {
      expect([k, raw.elements[0][k]]).toEqual([k, legacy.elements[0][k]]);
    }
  });

  it("未请求 contrast 时不做上溯,扁平对比度字段一个都不出现", () => {
    const r = elementsProbeFunc(".t", 10, ["box"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    for (const k of ["color", "background", "contrastRatio", "contrastStatus", "wcagAA"]) {
      expect(k in r.elements[0]).toBe(false);
    }
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts`

Expected: FAIL，样式组字段全部缺失

- [x] **Step 3: 把样式采集搬进统一探针**

替换 Task 3 留下的 `// [Task 5 在此插入样式六组维度采集]` 标注。**下列辅助逻辑从现有 `styleProbeFunc` 原样搬运，不要重写**（重写会引入与既有测试对不上的行为差异）：

| 从 `styleProbeFunc` 搬运 | 用途 |
|---|---|
| `pathOf`（元素树路径） | 生成 `fp`，CDP 对齐凭据 |
| `PSEUDO_PROPS` 常量与 `::before`/`::after` 采集循环 | `pseudo` 组的 `pseudoRaw` 原始值 |
| 对比度相关辅助（上溯 painted background 的那组函数） | `paint` 组 |
| `collectFontFaces` 及其 `GROUPING_TYPES`/`reasons` 集合 | 结果级 `fontFaces` / `fontFacesPartial` / `fontFacesPartialReasons` |

**「原样搬运」是字面意思。** 首轮执行时这里被"等价重写"了一遍，结果把 `parseStrict`
（只认完整 `rgb()/rgba()` 数值形态的严格解析）换成宽松的 `parse`，把 `opacityOf` 累计的
`translucent` 与 `background-image` 状态整个丢掉——五态退成三态，`oklch()` 颜色会被抓出
数字算成一个看着很正常的对比度。这正是 v3.0.0 修掉真站 46% 捏造数字的那类回归。
所以：`pathOf` / `collectFontFaces` / `parse` / `opacityOf` / `RGB_RE` / `parseStrict` /
`isTransparent` / `lum` / `pick` 全部从 `styleProbeFunc` 逐字复制到元素循环之前，
一个字符都不要改（`pick` 只加一个 `CSSStyleDeclaration` 入参，因为各组各取各的 `cs`）。

接线代码。注意两点：contrast 独立成块；六个组各自 `getComputedStyle(el)`，
不共用一个 `cs`——共用会让任一组的取样异常连坐其余组，Task 7 的维度级隔离就落不了地：

```ts
      if (want("contrast")) {
        // 整块从 styleProbeFunc 的元素循环体逐字搬来:上溯 painted background、
        // translucent 累计、五态优先级、verdict 的 null 语义,一处都不能简化
        const cs = getComputedStyle(el);
        /* … 逐字搬运 … */
        item.color = color;
        item.background = background;
        item.bgFromAncestor = bgFromAncestor;
        item.fontWeight = cs.fontWeight;
        item.fontSize = cs.fontSize;
        item.contrastRatio = contrastRatio;
        item.backgroundImage = backgroundImage;
        item.contrastStatus = contrastStatus;
        item.wcagAA = verdict(4.5);
        item.wcagAAA = verdict(7);
      }

      if (want("typography")) {
        item.typography = pickProps(getComputedStyle(el), ["fontFamily", "fontSize", "fontWeight",
          "lineHeight", "letterSpacing", "textAlign", "textTransform"]);
      }
      if (want("box")) {
        item.box = pickProps(getComputedStyle(el), ["display", "padding", "margin", "borderRadius",
          "borderWidth", "borderStyle", "borderColor", "width", "height", "flexDirection",
          "flexWrap", "justifyContent", "alignItems", "gap", "gridTemplateColumns",
          "gridTemplateRows"]);
      }
      if (want("paint")) {
        item.paint = pickProps(getComputedStyle(el),
          ["backgroundColor", "backgroundImage", "boxShadow", "opacity", "outline", "filter"]);
      }
      if (want("motion")) {
        item.motion = pickProps(getComputedStyle(el), ["transition", "transform", "animation"]);
      }
      if (want("pseudo")) {
        const PSEUDO_PROPS = ["content", "font-family", "color", "display", "visibility",
          "opacity", "background-image", "width", "height"];
        let pseudoRaw: Record<string, Record<string, string>> | undefined;
        for (const which of ["::before", "::after"]) {
          const pcs = getComputedStyle(el, which);
          const c = pcs.getPropertyValue("content");
          if (c === "none" || c === "normal") continue;
          const o: Record<string, string> = {};
          for (const prop of PSEUDO_PROPS) o[prop] = pcs.getPropertyValue(prop);
          // 键是 "before"/"after" 不带冒号,老探针如此,host 侧按此匹配
          (pseudoRaw ??= {})[which.slice(2)] = o;
        }
        if (pseudoRaw) item.pseudoRaw = pseudoRaw;
      }
      if (want("font")) {
        item.declaredFont = getComputedStyle(el).getPropertyValue("font-family");
        item.fp = pathOf(el);
      }
```

结果级 `fontFaces` 采集紧跟元素循环之后（与 `out` 组装同层）：

```ts
    if (want("font")) {
      const faces = collectFontFaces();
      out.fontFaces = faces.rules;
      out.fontFacesPartial = faces.partial;
      if (faces.partial) out.fontFacesPartialReasons = faces.partialReasons;
    }
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts`

Expected: PASS

- [x] **Step 5: 自包含验证——搬运有没有漏内联标识符**

搬运是本任务最大的风险：漏内联任一符号，jsdom 下直接调用不会报错（模块作用域还在），
**只有真实注入才崩**。必须用剥离作用域的方式验（`vortex_page_side_func_inline_gotcha` 的处方）：

```ts
  it("注入自包含:九维度全开剥离模块作用域后仍可运行", () => {
    const detached = new Function("return " + elementsProbeFunc.toString())();
    const st = document.createElement("style");
    st.textContent = '@font-face{font-family:"X";src:url(x.woff2)}';
    document.head.appendChild(st);
    const el = document.createElement("div");
    el.className = "iso-all";
    document.body.appendChild(el);
    let out: unknown;
    expect(() => {
      out = detached(".iso-all", 1,
        ["geometry", "text", "attrs", "contrast", "typography", "box", "paint", "motion",
          "pseudo", "font"],
        ["id"], true);
    }).not.toThrow();
    expect((out as { error?: string }).error).toBeUndefined();
    expect((out as { fontFaces?: unknown[] }).fontFaces).toBeDefined();
  });
```

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts -t "注入自包含"`

Expected: PASS。若报 `X is not defined`，回去补内联，**不要改测试**——这条测试的全部价值就在于此。

- [x] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-contract-shape.test.ts
git commit -m "feat: 统一探针补样式六组采集

搬入六组 computed 属性、伪元素原始值、fp 指纹与 fontFaces 聚合。
补剥离模块作用域的自包含验证,覆盖九维度全开。"
```

---

## Task 6: style mode 转发与 CDP 字体对齐（host-side）

`finalizeStyleResult` 按**数组下标**把 CDP 查到的平台字体贴回元素。整形层若改变元素数量
或顺序，字体会静默贴错——不报错、不缺字段，只是值是别人的。这是本次重构最隐蔽的失效模式。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（style 分支）
- Test: `packages/extension/tests/query-contract-shape.test.ts`

**Interfaces:**
- Consumes: `elementsProbeFunc`（Task 5 已完备）、`shapeStyleResult`（Task 2）、既有 `finalizeStyleResult`
- Produces: 无新增导出

- [x] **Step 1: 写下标不变量的测试**

```ts
describe("style 转发的下标不变量", () => {
  beforeEach(() => seed(`<p class="t">a</p><p class="t">b</p><p class="t">c</p>`));

  it("整形前后元素数量、顺序、fp 逐位一致", async () => {
    const { shapeStyleResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc(".t", 10, ["font"], null, false) as {
      elements: Array<{ fp?: string }>;
    };
    const shaped = shapeStyleResult(raw as never, ["font"]);
    expect(shaped.elements).toHaveLength(raw.elements.length);
    expect(shaped.elements.map((e) => e.fp)).toEqual(raw.elements.map((e) => e.fp));
  });

  it("maxResults 截断后,整形结果与探针看到的是同一批元素", async () => {
    const { shapeStyleResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc(".t", 2, ["font"], null, false) as {
      elements: Array<{ fp?: string }>; total: number; showing: number;
    };
    expect(raw.total).toBe(3);
    expect(raw.showing).toBe(2);
    const shaped = shapeStyleResult(raw as never, ["font"]);
    expect(shaped.elements).toHaveLength(2);
    expect(shaped.total).toBe(3);
  });
});
```

- [x] **Step 2: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts -t "下标不变量"`

Expected: PASS（Task 2 的整形层已满足）

- [x] **Step 3: 变异验证下标不变量真的被锁住**

做两次，各改一处再改回。**不要**用 `filter((e) => e.fp)`——本测试请求了 `font` 组，
每个元素都有 `fp`，这个条件一个都滤不掉，是死变异（Task 2 已经栽过一次）。

| 变异 | 把 `shapeStyleResult` 的 `raw.elements.map(...)` 改成 | 期望转红的用例 |
|---|---|---|
| 掉元素 | `raw.elements.slice(1).map(...)` | 数量、顺序、fp 逐位一致 / maxResults 截断 |
| 乱顺序 | `raw.elements.slice().reverse().map(...)` | 数量、顺序、fp 逐位一致 |

变异脚本必须带 `assert 命中数 == 1`：`raw.elements.map(` 在本文件里不止一处，
静默改错地方会让你误判测试是死的（Task 3、Task 4 各栽过一次）。
若没转红，说明测试没锁住，补强后重做变异。

- [x] **Step 4: style mode 改为转发**

> **执行中订正（Task 6 首轮）**：注入用 `dimensionsForMode("style", groups)`、整形却传 `groups`，
> 是这次重构最容易漏的一处缝——探针照样把对比度字段算出来返回，整形层一声不响全剥掉，
> `mode=style` 的返回少 10 个键而**不报任何错**，Step 1 的下标不变量测试也照样全绿。
> 所以先 `const dims = dimensionsForMode("style", groups)`，注入和整形共用这一个变量。
> 光靠"记得写对"不算数：`query-style-pseudo-font.test.ts` 里补了一条断言那批扁平字段
> 活着回到调用方的测试，把 `dims` 改回 `groups` 会转红。

替换 style 分支主体（**按内容定位，别按行号**——前几个 Task 已让行号大幅漂移）（`ALL_GROUPS` 校验与 `finalizeStyleResult` 调用保持不动）：

```ts
        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: elementsProbeFunc,
          args: [pattern, maxResults, dims, null, false],
          world: "MAIN",
        });

        const res = results[0]?.result as RawProbeResult | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage style: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage style error: ${res.error}`);
        }
        // 整形后再交 CDP:两侧必须看同一个已截断数组,否则 fp 下标错位
        return finalizeStyleResult(shapeStyleResult(res as RawProbeResult, dims) as never, {
          wantPseudo: groups.indexOf("pseudo") !== -1,
          wantFont: groups.indexOf("font") !== -1,
          debuggerMgr,
          tabId: tid,
          selector: pattern,
          maxResults,
        });
```

- [x] **Step 5: 跑 style 全部相关测试**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-style.test.ts tests/query-style-pseudo-font.test.ts tests/query-contract-shape.test.ts tests/platform-fonts.test.ts`

Expected: PASS

- [x] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-contract-shape.test.ts
git commit -m "refactor: style mode 转发到统一元素探针

搬入六组样式采集、伪元素原始值与 fp 指纹;整形后再交 CDP,
两侧共用同一个已截断数组避免下标错位。"
```

---

## Task 7: 维度级错误隔离

**这是转发方案引入的行为回归，不是既有技术债**（Luna 第五轮指出，我接受）。改之前三个 mode
各自独立，单个元素采集失败最多影响当前 mode；转发之后它们共用一个探针，而探针是整体
`try/catch`——任一元素的 `getComputedStyle`、伪元素读取或几何读取抛错，整个请求返回
`{ error }`，geometry/text/style 一起丢。必须在开放 `mode=elements` **之前**修掉，
否则会先上线一个已对外可调用、却不满足思路文档 §1 判据 3 的中间状态。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（`elementsProbeFunc` 元素循环）
- Test: `packages/extension/tests/query-contract-shape.test.ts`

**Interfaces:**
- Consumes: `elementsProbeFunc`（Task 5 已完备九维度）
- Produces: 元素级 `errors?: Record<string, string>` 字段（维度名 → 失败原因）

> **执行中订正（Task 7 首轮）**：三个整形函数必须放行 `errors`。首轮实现只在探针侧记了 `errors`，
> 整形层按固定键集合 pick 时把它剥掉了——`mode=style` 于是变成"返回成功、字段悄悄少几个"，
> 比重构前的整体报错还不诚实。健康页面上 `errors` 不存在，所以三个老形状契约照样一字不变。

- [x] **Step 1: 写失败的测试**

```ts
describe("维度级错误隔离", () => {
  beforeEach(() => seed(`<p class="t boom">a</p><p class="t">b</p>`));

  // 按元素精确注入失败,不能用"第 N 次调用抛错"计数:
  // geometry 的裁剪检查自带 try/catch 吞 getComputedStyle(query.ts:674-679),
  // 计数式 patch 会被它吃掉,测试看似在测 style 失败,实际什么都没测到。
  function failStyleOn(cls: string): () => void {
    const orig = window.getComputedStyle;
    (window as unknown as { getComputedStyle: unknown }).getComputedStyle = function (
      el: Element, pseudo?: string | null,
    ) {
      if ((el as HTMLElement).classList?.contains(cls)) throw new Error("style boom");
      return orig.call(window, el, pseudo ?? undefined);
    };
    return () => { (window as unknown as { getComputedStyle: unknown }).getComputedStyle = orig; };
  }

  it("box 维度失败不影响同一元素的 geometry", () => {
    // 注:这里只请求 geometry+box,不带 contrast —— contrast 也走 getComputedStyle,
    // 带上它只会多一条 errors,证明不了额外的东西。
    const restore = failStyleOn("boom");
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry", "box"], null, false) as {
        error?: string; elements: Array<Record<string, unknown>>;
      };
      expect(r.error).toBeUndefined();
      expect(r.elements).toHaveLength(2);
      expect(r.elements[0]).toHaveProperty("bbox");
      expect((r.elements[0].errors as Record<string, string>).box).toMatch(/style boom/);
      expect(r.elements[1]).toHaveProperty("box");
      expect("errors" in r.elements[1]).toBe(false);
    } finally {
      restore();
    }
  });

  // 样式组之间的隔离不能用 failStyleOn 验:它让该元素所有 getComputedStyle 都抛错,
  // box 与 motion 必然同时失败 —— 那既证明不了隔离生效、也证明不了失效。
  // 用只在带伪元素参数时抛错的注入,才能造出"一组失败、其余组正常"的局面。
  it("pseudo 组失败不连带丢 box 与 typography", () => {
    const orig = window.getComputedStyle;
    (window as unknown as { getComputedStyle: unknown }).getComputedStyle = function (
      el: Element, pseudo?: string | null,
    ) {
      if (pseudo) throw new Error("pseudo boom");
      return orig.call(window, el, undefined);
    };
    try {
      const r = elementsProbeFunc(".t", 1, ["typography", "box", "pseudo"], null, false) as {
        error?: string; elements: Array<Record<string, unknown>>;
      };
      expect(r.error).toBeUndefined();
      const e = r.elements[0];
      expect((e.errors as Record<string, string>).pseudo).toMatch(/pseudo boom/);
      expect("box" in (e.errors as Record<string, string>)).toBe(false);
      expect("typography" in (e.errors as Record<string, string>)).toBe(false);
      expect(e).toHaveProperty("box");
      expect(e).toHaveProperty("typography");
    } finally {
      (window as unknown as { getComputedStyle: unknown }).getComputedStyle = orig;
    }
  });

  // want() 判断本身错会让维度静默缺失:既没字段也没 errors 条目,现有断言都发现不了。
  // 这条把"请求了就必须有交代"变成硬判据。
  //
  // ⚠ jsdom 的 getComputedStyle(el,"::before") **不实现伪元素**,恒返回 content:"normal",
  // 探针据此判定"页面没有伪元素"而跳过 —— 既无 pseudoRaw 也无 errors。注入 <style> 改变不了
  // 这一点(实测),必须替掉 getComputedStyle 才造得出"有伪元素"的局面(见 stubPseudoContent)。
  // ⚠ pseudo 必须先造出真实伪元素。实现是"没有伪元素就不设 pseudoRaw"
  // (Task 5:`if (Object.keys(raw).length > 0)`),所以干净 DOM 上 pseudo 既无字段
  // 也无 errors —— 那是合法的"已采集但页面没有伪元素",不是缺失。
  // 不注入伪元素就跑这条,等于要求正常情况必有 pseudoRaw,判据本身是错的。
  it.each([
    ["geometry"], ["text"], ["attrs"], ["contrast"],
    ["typography"], ["box"], ["paint"], ["motion"], ["pseudo"], ["font"],
  ])("请求维度 %s 必须有交代:要么有字段,要么有 errors 条目", (dim) => {
    // contrast 产的是扁平字段,没有同名键;拿 color 当它的存在凭据
    const FIELD: Record<string, string> = {
      geometry: "bbox", text: "text", attrs: "attrs", font: "declaredFont", pseudo: "pseudoRaw",
      contrast: "color",
    };
    // 让 pseudo 有确定产出,否则"无伪元素"会被误判成"维度缺失"
    const st = document.createElement("style");
    st.textContent = '.t::before{content:"x"}';
    document.head.appendChild(st);
    const r = elementsProbeFunc(".t", 1, [dim], ["id"], true) as {
      elements: Array<Record<string, unknown>>;
    };
    const e = r.elements[0];
    const key = FIELD[dim] ?? dim;
    const accounted = key in e || Boolean((e.errors as Record<string, string> | undefined)?.[dim]);
    expect(accounted, `维度 ${dim} 既没产出 ${key} 也没记 errors.${dim}`).toBe(true);
    st.remove();
  });

  it("attrs 失败不连带丢 text", () => {
    const orig = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function (n: string) {
      if (this.classList?.contains("boom")) throw new Error("attr boom");
      return orig.call(this, n);
    };
    try {
      const r = elementsProbeFunc(".t", 2, ["text", "attrs"], ["id"], true) as {
        elements: Array<Record<string, unknown>>;
      };
      expect(r.elements[0].text).toBe("a");
      expect((r.elements[0].errors as Record<string, string>).attrs).toMatch(/attr boom/);
      expect("text" in (r.elements[0].errors as Record<string, string>)).toBe(false);
    } finally {
      Element.prototype.getAttribute = orig;
    }
  });

  it("一个元素 geometry 失败,其他元素仍返回", () => {
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains("boom")) throw new Error("rect boom");
      return orig.call(this);
    };
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry"], null, false) as {
        error?: string; elements: Array<Record<string, unknown>>;
      };
      expect(r.error).toBeUndefined();
      expect(r.elements).toHaveLength(2);
      expect(r.elements[1]).toHaveProperty("bbox");
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });

  it("首元素 geometry 失败时不产生 pair —— 占位 rect 不得被当成真坐标参与比较", () => {
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains("boom")) throw new Error("rect boom");
      return orig.call(this);
    };
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry"], null, false) as Record<string, unknown>;
      expect("pair" in r).toBe(false);
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });

  it("样式组失败不阻止 geometry 的 pair 生成", () => {
    const restore = failStyleOn("boom");
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry", "box"], null, false) as Record<string, unknown>;
      expect("pair" in r).toBe(true);
    } finally {
      restore();
    }
  });

  it("选择器非法仍是整请求错误,不降级成逐元素错误", () => {
    const r = elementsProbeFunc("div[[", 10, ["geometry"], null, false) as { error?: string };
    expect(r.error).toMatch(/Invalid CSS selector/);
  });

  it("全部正常时不产生 errors 字段", () => {
    const r = elementsProbeFunc(".t", 2, ["geometry"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect("errors" in r.elements[0]).toBe(false);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts -t "维度级错误隔离"`

Expected: FAIL。前两条会因整体 `try/catch` 返回 `{ error }` 而红。

- [x] **Step 3: 把元素循环内的采集按维度包起来**

**必须逐维度 guard，不能按「三大块」包**。按块包时 `attrs` 失败会连带丢 `text`、
`box` 失败会连带丢 `motion`——那不叫维度级隔离，只是把整体失败换了个粒度。
十个维度各自一个 guard：

```ts
      const errors: Record<string, string> = {};
      const guard = (dim: string, fn: () => void): void => {
        if (!want(dim)) return;
        try {
          fn();
        } catch (e) {
          errors[dim] = e instanceof Error ? e.message : String(e);
        }
      };

      guard("geometry", () => { /* 原 geometry 采集块整体移入,含 rects.push */ });
      guard("text", () => { /* 原 text 采集(含 children_count) */ });
      guard("attrs", () => { /* 原 attrs 采集 */ });
      // 样式六组各自独立:一组的 getComputedStyle 抛错不该带走其余五组。
      // ⚠ cs 必须在**每个 guard 内部**各自取。Task 5 原写法是循环外取一次六组共用,
      // 那一句若留在 guard 外,它抛错时不被任何 guard 捕获 —— 整个探针返回 {error},
      // 隔离形同虚设,而测试只会看到"整体失败",看不出是哪一步漏了保护。
      guard("contrast", () => { /* 上溯 painted background + 五态 + verdict 那一整块 */ });
      for (const g of ["typography", "box", "paint", "motion", "pseudo", "font"]) {
        guard(g, () => {
          const cs = getComputedStyle(el);   // 每组各取,别共享外层变量
          /* 该组的 pickProps / 伪元素读取 / declaredFont+fp */
        });
      }

      if (Object.keys(errors).length > 0) item.errors = errors;
```

**下标对齐**：`rects.push(r)` 在 geometry guard 内——该元素几何失败时 `rects` 与
`elements` 下标错开，`pair` 会比较错元素（静默失效）。几何失败时补占位。

**两点都不能含糊**：

其一，占位不能用 `new DOMRect(...)`——实测 jsdom 里 `typeof DOMRect !== "function"`，
这一行会让 Task 7 的全部测试以 `DOMRect is not defined` 崩掉（真实浏览器里有，
所以只在单测暴露）。

其二，不要靠 `rects.length < elements.length + 1` 这类长度时机推断补占位——那是隐式行为，
循环结构一改就错位。`rects` 与 `elements` 严格一一对应，几何失败即 `null`：

```ts
      let rect: RectLike | null = null;
      guard("geometry", () => {
        rect = el.getBoundingClientRect();
        /* 原 geometry 采集块其余部分,用 rect 而非重新取 */
      });
      rects.push(rect);   // 无条件 push,失败即 null
```

**`pair` 的前置条件按 rect 是否为 null 判断**。写成
`!elements[0].errors && !elements[1].errors` 是错的——text 或某个样式组失败会无理由地
禁掉两个元素都成功的几何比较；而绕道 `errors.geometry` 又是间接推断。直接看 rect：

```ts
      const a = rects[0];
      const b = rects[1];
      if (a && b) {
        const near = (x: number, y: number): boolean => Math.abs(x - y) <= TOL;
        out.pair = { /* 原 pair 计算 */ };
      }
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-contract-shape.test.ts`

Expected: PASS（含 Task 1-6 的全部既有断言）

- [x] **Step 5: 变异验证**

| 改动 | 必须转红的用例 |
|---|---|
| `guard` 的 catch 改成 `throw e` | 「box 维度失败不影响同一元素的 geometry」 |
| `if (Object.keys(errors).length > 0)` 改成无条件 `item.errors = errors` | 「全部正常时不产生 errors 字段」 |
| 六个样式组合并成一个 guard | 「pseudo 组失败不连带丢 box 与 typography」 |
| `guard` 的 `if (!want(dim)) return` 改成对某个维度恒不采集（模拟 want 判断错） | 「请求维度 %s 必须有交代」中该维度那一条 |
| 几何失败时不 push 占位 rect | 「中间元素 geometry 失败时 pair 不得跨过它拿后面的元素来比」 |
| `pair` 前的 `if (a && b)` 改成 `if (rects.length >= 2)`（不判 null） | 「一个元素 geometry 失败,其他元素仍返回」——`a` 为 null，`a.right` 抛错让整个探针返回 `{error}` |
| `rects.push(rect)` 挪进 `guard` 内部（失败时不 push，退回长度错位） | 「中间元素 geometry 失败时 pair 不得跨过它拿后面的元素来比」 |

> **执行中订正（Task 7 首轮）**：原表把后三条都指向「首元素 geometry 失败时不产生 pair」，
> **那条测试证明不了下标错位**。只有两个元素、第一个失败时，补不补占位 `rects` 都只剩一条，
> pair 两种实现下都不生成——看起来一样。错位要三个元素、失败的在中间才现形：
> `rects` 变成 `[第0个, 第2个]`，pair 拿第 0 和第 2 个比，还一声不响。已补一条三元素的测试，
> 补上之后两条变异才转红。

七条都必须转红。变异脚本一律带 `assert 命中数 == 1`——`query.ts` 里同形代码不止一处，
静默改错地方会让你误判测试是死的（Task 3、Task 4 各栽过一次）。
第三、五条专盯 Luna 复核指出的两个粒度错误——按块 guard 与 pair
条件过宽，两者都会让测试看起来在测隔离、实际测的是别的东西。

- [x] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-contract-shape.test.ts
git commit -m "fix: 统一探针按维度隔离采集错误

转发前三个 mode 各自独立,合并后整体 try/catch 会让单元素失败
拖垮所有维度。改为逐维度 guard,失败记入元素级 errors 字段;
几何失败时占位 rect 避免 pair 下标错位。"
```

---

## Task 8: 新增 mode=elements 对外入口

前三个 mode 已全部转发、错误隔离已就位。本任务开放组合模式这一对外能力。

**`font` 维度必须接 CDP，不能只给声明栈。** 初稿把它列为「已知缺口」，Luna 指出这不是缺口
而是 API 语义陷阱：`mode=style` 的 font 经 `finalizeStyleResult` 给出**实际渲染字体**，
若 `mode=elements` 的 font 只给 `declaredFont` 却同样标 `available:true`，
等于把「声明栈可用」伪装成「font 维度完整可用」，调用方无从分辨。故本任务复用
`finalizeStyleResult`，并让 `dimensions.font.available` 反映 CDP 的真实结果。

**删除老探针拆到 Task 9**——实查发现引用老探针的测试有 6 个文件、60+ 处调用。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（新增 `elements` 分派分支）
- Modify: `packages/mcp/src/tools/schemas-public.ts`
- Modify: `packages/mcp/tests/vortex-query.test.ts`
- Create: `packages/extension/tests/query-elements-mode.test.ts`

**Interfaces:**
- Consumes: `elementsProbeFunc`、`normalizeDimensions`、`ALL_DIMENSIONS`
- Produces: `vortex_query({ mode: "elements", pattern, dimensions, maxResults })` 对外能力

- [ ] **Step 1: 写失败的测试**

```ts
// query-elements-mode.test.ts
// 组合模式的 handler 层行为:维度校验、上限、维度自陈。
// 探针本身的采集行为由 query-contract-shape.test.ts 覆盖,此处不重复。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerQueryHandlers } from "../src/handlers/query.js";

const executeScript = vi.fn();
let router: ActionRouter;

function mkReq(action: string, params: Record<string, unknown>) {
  return { id: "1", action, params };
}

beforeEach(() => {
  executeScript.mockReset();
  globalThis.chrome = {
    scripting: { executeScript },
    tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: "https://x.test" }]) },
  } as never;
  router = new ActionRouter();
  registerQueryHandlers(router);
});

describe("mode=elements 维度校验", () => {
  it("非法维度名直接报错,不静默忽略", async () => {
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".x", dimensions: "geometry,nosuch",
    }));
    expect(res.error).toBeDefined();
    expect(String(res.error)).toMatch(/nosuch/);
  });

  it("不传 dimensions 时默认 geometry+text,不是全维度", async () => {
    executeScript.mockResolvedValueOnce([{ result: { elements: [], total: 0, showing: 0, scanned: { elements: 1, shadowRoots: 0, iframes: 0 } } }]);
    await router.dispatch(mkReq("query.queryPage", { mode: "elements", pattern: ".x" }));
    const dims = executeScript.mock.calls[0][0].args[2] as string[];
    expect(dims.sort()).toEqual(["geometry", "text"]);
  });

  it("maxResults 默认 20、上限 50,不因维度改变", async () => {
    executeScript.mockResolvedValue([{ result: { elements: [], total: 0, showing: 0, scanned: { elements: 1, shadowRoots: 0, iframes: 0 } } }]);
    await router.dispatch(mkReq("query.queryPage", { mode: "elements", pattern: ".x" }));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(20);

    executeScript.mockClear();
    await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".x", dimensions: "geometry|font|pseudo", maxResults: 999,
    }));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(50);
  });
});

describe("mode=elements 维度自陈", () => {
  it("请求了的维度标 available:true", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [{ index: 0, tag: "li", bbox: [0, 0, 1, 1], text: "A" }],
        total: 1, showing: 1, viewport: { w: 800, h: 600 },
        scanned: { elements: 3, shadowRoots: 0, iframes: 0 },
      },
    }]);
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".x", dimensions: "geometry,text",
    }));
    const r = res.result as { dimensions: Record<string, { available: boolean }> };
    expect(r.dimensions.geometry.available).toBe(true);
    expect(r.dimensions.text.available).toBe(true);
  });

  // 上一条只能证明"硬编码 true 的代码返回 true"。真正的契约在这条:
  // CDP 拿不到实际渲染字体时,必须说出来,不能让调用方以为拿到了。
  it("font 维度 CDP 不可用时 available:false 并带 reason", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [{ index: 0, tag: "li", declaredFont: "Inter, sans-serif", fp: "LI:0" }],
        total: 1, showing: 1,
        scanned: { elements: 3, shadowRoots: 0, iframes: 0 },
      },
    }]);
    // 不提供 debuggerMgr → finalizeStyleResult 走不可用分支
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".x", dimensions: "font",
    }));
    const r = res.result as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.font.available).toBe(false);
    expect(typeof r.dimensions.font.reason).toBe("string");
    expect(r.dimensions.font.reason!.length).toBeGreaterThan(0);
  });

  it("truncated 在被截断时为 true 并保留真实 total", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [{ index: 0, tag: "li" }],
        total: 90, showing: 1,
        scanned: { elements: 100, shadowRoots: 0, iframes: 0 },
      },
    }]);
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".x", maxResults: 1,
    }));
    const r = res.result as { total: number; showing: number; truncated: boolean };
    expect(r.total).toBe(90);
    expect(r.showing).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it("零命中时所有维度标 available:false,不能让空结果看起来像体检合格", async () => {
    executeScript.mockResolvedValueOnce([{
      result: { elements: [], total: 0, showing: 0, scanned: { elements: 9, shadowRoots: 0, iframes: 0 } },
    }]);
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".nope", dimensions: "geometry,text",
    }));
    const r = res.result as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.geometry.available).toBe(false);
    expect(r.dimensions.text.available).toBe(false);
    expect(r.dimensions.geometry.reason).toMatch(/no elements/i);
  });

  it("全部元素某维度失败时该维度标 available:false", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [
          { index: 0, tag: "li", errors: { box: "style boom" } },
          { index: 1, tag: "li", errors: { box: "style boom" } },
        ],
        total: 2, showing: 2, scanned: { elements: 9, shadowRoots: 0, iframes: 0 },
      },
    }]);
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".x", dimensions: "box",
    }));
    const r = res.result as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.box.available).toBe(false);
    expect(r.dimensions.box.reason).toMatch(/style boom/);
    // 截断场景下不得把"采样全失败"说成"整体不可用"
    expect(r.dimensions.box.reason).toMatch(/sampled/);
  });

  it("部分元素失败时维度仍可用,但 reason 说明失败比例", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [{ index: 0, tag: "li", errors: { box: "boom" } }, { index: 1, tag: "li", box: {} }],
        total: 2, showing: 2, scanned: { elements: 9, shadowRoots: 0, iframes: 0 },
      },
    }]);
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "elements", pattern: ".x", dimensions: "box",
    }));
    const r = res.result as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.box.available).toBe(true);
    expect(r.dimensions.box.reason).toMatch(/1\/2/);
  });

  // 上面两条走 mock,只验 handler 的 total>showing 计算。探针真的会截断吗?
  // 这条用真实 DOM 盯住探针本身 —— 探针若把 showing 写成 total,mock 测试发现不了。
  it("探针真实截断:命中 2 个、maxResults=1 时 total=2/showing=1", async () => {
    const { elementsProbeFunc } = await import("../src/handlers/query.js");
    document.body.innerHTML = `<i class="z"></i><i class="z"></i>`;
    const r = elementsProbeFunc(".z", 1, ["geometry"], null, false) as {
      total: number; showing: number; elements: unknown[];
    };
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });

  it("未截断时 truncated 为 false 而不是缺席", async () => {
    executeScript.mockResolvedValueOnce([{
      result: { elements: [{ index: 0, tag: "li" }], total: 1, showing: 1, scanned: { elements: 3, shadowRoots: 0, iframes: 0 } },
    }]);
    const res = await router.dispatch(mkReq("query.queryPage", { mode: "elements", pattern: ".x" }));
    expect((res.result as { truncated: boolean }).truncated).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-elements-mode.test.ts`

Expected: FAIL，`mode must be 'text', 'css', ...` —— `elements` 尚未被接受

- [ ] **Step 3: 新增 elements 分派分支**

在 `query.ts` 的 mode 校验白名单加入 `"elements"`（`query.ts:1879` 那个条件与 `1884` 的报错文案同步），并新增分支：

```ts
      } else if (mode === "elements") {
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 20, 50);
        // 默认给几何+文本:实测负载里这两样最常一起要,全维度会让返回体无谓变重
        const dims = normalizeDimensions(args.dimensions as string | string[] | undefined)
          ?? ["geometry", "text"];
        const bad = dims.filter((d) => ALL_DIMENSIONS.indexOf(d) === -1);
        if (bad.length > 0) {
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            `vortex_query mode=elements: dimensions must be one or more of ${ALL_DIMENSIONS.join("|")}; got ${bad.join(",")}`,
          );
        }
        const attributes: string[] | null = normalizeCssAttrParam(args.attr as string | string[] | undefined);
        const includeText = (args.includeText as boolean | undefined) ?? true;

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: elementsProbeFunc,
          args: [pattern, maxResults, dims, attributes, includeText],
          world: "MAIN",
        });

        const res = results[0]?.result as RawProbeResult | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage elements: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage elements error: ${res.error}`);
        }
        const raw = res as RawProbeResult;
        const wantFont = dims.indexOf("font") !== -1;
        const wantPseudo = dims.indexOf("pseudo") !== -1;

        // font 要的是实际渲染字体,只给声明栈会让调用方以为等价于 mode=style
        let body: Record<string, unknown> = { ...raw };
        if (wantFont || wantPseudo) {
          body = await finalizeStyleResult(raw as never, {
            wantPseudo, wantFont, debuggerMgr, tabId: tid, selector: pattern, maxResults,
          }) as never;
        }

        // 维度自陈:请求了但没拿到必须说出来,不能让字段静默消失。
        // 三条来源:零命中(压根没元素可采)、元素级 errors 汇总、font 的 CDP 状态。
        const els = (body.elements ?? []) as Array<{
          errors?: Record<string, string>; font?: { evidence?: string; reason?: string };
        }>;
        const dimensions: Record<string, { available: boolean; reason?: string }> = {};
        for (const d of dims) {
          if (raw.total === 0) {
            // 没有元素时任何维度都谈不上"可用",标 true 会被当成体检合格
            dimensions[d] = { available: false, reason: "no elements matched" };
            continue;
          }
          // 统计口径是**已返回的元素**,不是 raw.total。截断后说"整体不可用"是越界断言,
          // reason 必须点明这是采样结论(Luna 第七轮指出)。
          const failed = els.filter((e) => e.errors?.[d]);
          dimensions[d] = failed.length === els.length && els.length > 0
            ? { available: false, reason: `${failed[0].errors![d]} (all ${els.length} sampled elements failed; total matched ${raw.total})` }
            : { available: true, ...(failed.length > 0 ? { reason: `${failed.length}/${els.length} sampled elements failed` } : {}) };
        }
        if (wantFont && raw.total > 0) {
          // finalizeStyleResult 在 CDP 不可用时给每元素 evidence="unavailable" + reason
          const bad = els.find((e) => e.font?.evidence === "unavailable");
          if (bad) dimensions.font = { available: false, reason: bad.font?.reason ?? "platform fonts unavailable" };
        }

        const { scanned, ...rest } = body as RawProbeResult;
        return withDiagnosis(
          { ...rest, truncated: raw.total > raw.showing, dimensions },
          raw.total === 0 && scanned
            ? diagnoseEmptyQueryCss({ ...scanned, selector: pattern, frameScoped: frameId != null })
            : null,
        );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-elements-mode.test.ts`

Expected: PASS

- [ ] **Step 5: MCP schema 开放组合模式**

`packages/mcp/src/tools/schemas-public.ts`：
- `mode` enum（约 `:482`）加 `"elements"`
- 工具 description（约 `:477`）追加：`elements=一次命中按需返回多维度(dimensions 选 geometry|text|attrs|typography|box|paint|motion|pseudo|font)`
- properties 新增：

```ts
        dimensions: {
          type: "string",
          description: "mode=elements 专用:逗号或竖线分隔的维度名,默认 geometry,text",
        },
```

`packages/mcp/tests/vortex-query.test.ts` 追加：

```ts
  it("elements mode 在 enum 里,且 dimensions 字段已声明", () => {
    const def = getToolDef("vortex_query");
    const schema = def!.schema as {
      properties: { mode: { enum: string[] }; dimensions?: { type: string } };
    };
    expect(schema.properties.mode.enum).toContain("elements");
    expect(schema.properties.dimensions?.type).toBe("string");
  });
```

既有测试「每个 mode 都在 tools/list 文本里被提到」会自动覆盖 `elements` 的可发现性——若 description 忘了提，它会转红。

- [ ] **Step 6: 跑 extension 与 mcp 全量**

Run:
```bash
pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @vortex-browser/mcp exec vitest run --maxWorkers=2 --minWorkers=1
```

Expected: 全绿。此时老探针尚未删除，`queryAllDeep` 定义处为 5 份（4 老 + 1 统一）——
这是过渡态，Task 7 收敛到 2 份。

- [ ] **Step 7: 真实浏览器验证（jsdom 无布局，单测证明不了接线）**

在真实页面上跑一遍，确认组合模式的几何值不是 0（jsdom 下 `getBoundingClientRect` 恒 0，单测无法暴露接线错误）：

```
vortex_navigate → https://gamma.app
vortex_query { mode: "elements", pattern: "button", dimensions: "geometry,text,box", maxResults: 5 }
```

判据：`bbox` 四个数不全为 0；同一元素上 `text`、`box`、`bbox` 三者共存；`dimensions` 三项均 `available:true`。

- [ ] **Step 8: 提交**

```bash
git add packages/extension/src packages/extension/tests packages/mcp/src packages/mcp/tests
git commit -m "feat: query 新增 elements 组合模式

一次命中按 dimensions 返回几何/文本/属性/样式,带 truncated 与
维度级 available 自陈。老探针的删除见后续提交。"
```

---

## Task 9: 删除三个老探针并迁移其测试

删除成本被初稿严重低估。实查引用点：**6 个测试文件、60+ 处调用**，其中三处是
`styleProbeFunc.toString()` 配合 `new Function` 剥离模块作用域的自包含验证——
这类验证在探针合并后**只会更重要**（统一探针更大、内联标识符更多，漏一个就在真站崩，
而 mock 或直接调用都测不出来）。薄封装救不了：探针要被序列化注入，
封装体内引用 `elementsProbeFunc` 在注入后同样丢作用域。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（删三个 `export const` 探针）
- Modify: `packages/extension/tests/query-style.test.ts`（40+ 处，含 3 处 `.toString()`）
- Modify: `packages/extension/tests/deep-query-expr.test.ts`（8 处，含 `.toString()` 源码比对）
- Modify: `packages/extension/tests/query-geometry.test.ts`（8 处）
- Modify: `packages/extension/tests/query-css-form-value.test.ts`（6 处）
- Modify: `packages/extension/tests/query-shadow-pierce.test.ts`（3 处）
- Modify: `packages/extension/tests/query-empty-diagnosis.test.ts`（1 处）
- Modify: `packages/extension/tests/query-contract-shape.test.ts`（5 处「与老探针对照」改为硬编码期望）

**Interfaces:**
- Consumes: `elementsProbeFunc`（Task 3-5 已完备）
- Produces: 无新增导出；`queryAllDeep` 定义处收敛到 2 份

- [ ] **Step 1: 先迁自包含验证（最高风险，先做）**

`query-style.test.ts` 三处 `.toString()` 测试改为验证统一探针。注意第三处原本测的是
「`groups` 缺省不传」——`elementsProbeFunc` 五参全必填，缺省语义由 handler 层承担，
故该条改为「六组全开 + geometry + text/attrs 同时请求」，覆盖面比原来更大：

```ts
  it("注入自包含:全维度剥离模块作用域后仍可运行", () => {
    const detached = new Function("return " + elementsProbeFunc.toString())();
    const st = document.createElement("style");
    st.textContent = '@font-face{font-family:"X";src:url(x.woff2)}';
    document.head.appendChild(st);
    const el = document.createElement("div");
    el.className = "iso-all";
    document.body.appendChild(el);
    let out: unknown;
    expect(() => {
      out = detached(".iso-all", 1,
        ["geometry", "text", "attrs", "contrast", "typography", "box", "paint", "motion",
          "pseudo", "font"],
        ["id"], true);
    }).not.toThrow();
    expect((out as { error?: string }).error).toBeUndefined();
    expect((out as { fontFaces?: unknown[] }).fontFaces).toBeDefined();
  });

  it("注入自包含:只请求几何时也不引用外部标识符", () => {
    const detached = new Function("return " + elementsProbeFunc.toString())();
    const el = document.createElement("div");
    el.className = "iso-geo";
    document.body.appendChild(el);
    expect(() => detached(".iso-geo", 1, ["geometry"], null, false)).not.toThrow();
  });
```

- [ ] **Step 2: 跑自包含验证，确认统一探针真的自包含**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/query-style.test.ts -t "注入自包含"`

Expected: PASS。若报 `X is not defined`，说明 Task 3-5 搬运时漏内联了某个标识符——
**这正是这条测试存在的意义，此时回去补内联，不要改测试**。

- [ ] **Step 3: 机械替换其余五个文件的调用**

按下表逐文件替换，每替换一个文件跑一次该文件的测试：

| 文件 | 替换规则 |
|---|---|
| `query-style.test.ts` | `styleProbeFunc(sel, n, groups)` → `const d = dimensionsForMode("style", groups ?? null)` 后 `shapeStyleResult(elementsProbeFunc(sel, n, d, null, false) as never, d)`；**不要手写组名数组**，否则漏掉 contrast 就把老契约里那 10 个扁平字段测没了 |
| `deep-query-expr.test.ts` | `styleProbeFunc(".t", n, ["font"])` → `elementsProbeFunc(".t", n, ["font"], null, false)`；`styleProbeFunc.toString()` → `elementsProbeFunc.toString()`；describe 名里的 `styleProbeFunc` 一并改 |
| `query-geometry.test.ts` | `geometryProbeFunc(sel, n)` → `shapeGeometryResult(elementsProbeFunc(sel, n, ["geometry"], null, false) as never)` |
| `query-css-form-value.test.ts` | `cssQueryFunc(sel, attrs, n, inc)` → `shapeCssResult(elementsProbeFunc(sel, n, ["text","attrs"], attrs, inc) as never, { attributes: attrs, includeText: inc })` |
| `query-shadow-pierce.test.ts` | 同上 |
| `query-empty-diagnosis.test.ts` | 同上（该条断言 `scanned`，整形层已透传） |

- [ ] **Step 4: 改写契约测试里的五处对照**

`query-contract-shape.test.ts` 中「与老 X 探针形状一致」的五条，老探针已不存在，
改为硬编码期望键集合。示例（css，另两处同法）：

```ts
  it("css 整形结果键集合固定", async () => {
    const { shapeCssResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc(".item", 10, ["text", "attrs"], ["href"], true);
    const shaped = shapeCssResult(raw as never, { attributes: ["href"], includeText: true });
    expect(Object.keys(shaped).sort()).toEqual(["elements", "scanned", "showing", "total"]);
    expect(Object.keys(shaped.elements[0]).sort())
      .toEqual(["attrs", "children_count", "index", "tag", "text"]);
  });
```

顶部 import 去掉 `cssQueryFunc, geometryProbeFunc, styleProbeFunc`，只留 `elementsProbeFunc`。

- [ ] **Step 5: 删除三个老探针定义**

删除 `query.ts` 中 `export const cssQueryFunc`、`export const geometryProbeFunc`、
`export const styleProbeFunc` 三个完整定义。`deep-query-expr.ts:3/7/16` 与
`style-evidence.ts:7` 的注释里提到 `styleProbeFunc`，一并改为 `elementsProbeFunc`。

- [ ] **Step 6: 跑 extension 全量并核对副本数**

```bash
pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1
grep -c "const queryAllDeep" packages/extension/src/handlers/query.ts   # 期望 2
grep -rn "cssQueryFunc\|geometryProbeFunc\|styleProbeFunc" packages/extension/src packages/extension/tests   # 期望 0 行
```

Expected: 全绿；副本数 2（统一探针 1 + component 1）；无残留引用。

- [ ] **Step 7: 提交**

```bash
git add packages/extension/src packages/extension/tests
git commit -m "refactor: 删除 css/geometry/style 三个老探针

六个测试文件 60+ 处调用改走统一探针加整形层;三处剥离模块作用域的
自包含验证迁到 elementsProbeFunc 并扩到全维度。
queryAllDeep 内联副本从 4 份降到 2 份。"
```

---

## 自检记录

**1. Spec 覆盖**

| Spec §1 判据 | 落在哪个 Task |
|---|---|
| 1 元素身份跨维度对齐 | Task 5「geometry 与样式组可同时请求」；Task 6「整形前后 fp 逐位一致」+ 变异验证 |
| 2 `maxResults` 只管元素数、上限 20/50 | Task 8「maxResults 默认 20、上限 50,不因维度改变」+「探针真实截断」 |
| 2 维度不可用须自陈 | Task 8「font 维度 CDP 不可用时 available:false 并带 reason」 |
| 3 维度级错误隔离 | **Task 7 全部**（初稿列为缺口，Luna 指出这是转发引入的回归，已纳入） |
| 4 先补形状断言再改实现 | Task 1 全部 |
| 5 内联副本不增加 | Task 9 Step 6 `grep -c` + 无残留引用检查（4 份 → 2 份） |

**2. 九轮评审后修订的十五处**（初稿有、现已改）

| 初稿的问题 | 谁发现 | 处置 |
|---|---|---|
| `shapeStyleResult` 的 `extra` 无条件含 `pseudoRaw` | Luna | Task 2 已改为只在选 pseudo 时保留，并补测试与变异 |
| 组合 font 标 `available:true` 却只有声明栈 | Luna | Task 8 接 `finalizeStyleResult`，`available` 反映 CDP 真实结果 |
| 错误隔离被列为「已知缺口」 | Luna | 认定为转发引入的回归，新增 Task 7，排在开放对外 API 之前 |
| `scanned` 变异测试正则 `/137\|shadow\|iframe/i` 太宽 | Luna | Task 4 改为逐值 `toContain` + 双重变异（handler 段与探针计数段各一） |
| `children_count` 何时出现无契约定义 | Luna | Task 4 补五组参数的基线矩阵，以老探针实测为准 |
| 删老探针只说改 1 个测试文件 | 我与 Luna 各自独立查到 | 实为 6 文件 60+ 处，拆出 Task 9 并给逐文件替换规则表 |
| Task 7 按「三大块」guard，名为维度级实为块级：`attrs` 失败连带丢 `text`、`box` 失败连带丢 `motion` | Luna 复核 | 改为九个维度各自 guard，并补「box 挂了 motion 不该跟着挂」断言 |
| Task 7 测试断言 `errors.box`，实现只写 `errors.style`，两者对不上 | Luna 复核 | 统一为逐维度键 |
| Task 7 的样式失败测试**触发不了预期路径**：用「第 N 次调用抛错」计数，而 geometry 的裁剪检查自带 `try/catch` 吞 `getComputedStyle`（`query.ts:674-679`），第一次调用被它吃掉 | Luna 复核 | 改为按元素 class 精确注入失败。**这是又一例「mock 让危险路径变安全」——测试看起来在测隔离，实际什么都没测到** |
| Task 7 的 `pair` 前置条件 `!elements[0].errors && !elements[1].errors` 过宽：text 或样式组失败会禁掉两个元素几何都成功的比较 | Luna 复核 | 改为只看 `errors?.geometry`，并补「样式组失败不阻止 pair 生成」用例 |
| Task 7 承认要补占位 rect 的用例却没写 | Luna 复核 | Step 1 直接给出「首元素 geometry 失败时不产生 pair」 |
| Task 8 只有 font 做真实判定，其余维度即便元素级全失败仍标 `available:true`；且零命中时因找不到 unavailable 元素而误报可用 | Luna 复核 | 三条来源汇总：零命中、元素级 `errors` 全失败、font 的 CDP 状态；补三条测试 |

| Task 7 占位 rect 用 `new DOMRect(0,0,0,0)`，而 jsdom 无此构造函数 | 我实测（写探针测试跑 vitest 验证 `typeof DOMRect`） | 改用结构类型 `RectLike` 与对象字面量。**这行会让 Task 7 全部测试以 `DOMRect is not defined` 崩掉，且只在单测暴露**——真实浏览器有 DOMRect，光看代码或在浏览器里试都发现不了 |

| Task 7 的 box/motion 用例自相矛盾：注释写「motion 不该跟着挂」，断言却是 motion 也失败。`failStyleOn` 让该元素所有 `getComputedStyle` 抛错，两组必然同时失败——既证明不了隔离生效也证明不了失效 | Luna r7 | 删掉该用例；新增「pseudo 组失败不连带丢 box 与 typography」，注入改为**只在带伪元素参数时抛错**，才造得出「一组失败其余正常」的局面 |
| 占位 rect 靠 `rects.length < elements.length + 1` 的长度时机推断补入，是隐式行为，循环结构一改就错位 | Luna r7 | 改为 `rects: Array<RectLike \| null>` 与 elements 严格一一对应、无条件 push，失败即 null；pair 前置条件从间接的 `geoOk(errors.geometry)` 改为直接 `if (a && b)` |
| 九维度覆盖测试对 pseudo 判据不成立：实现是「没有伪元素就不设 pseudoRaw」，干净 DOM 上既无字段也无 errors，合法状态被判成缺失 | Luna r8 | 测试内注入 `.t::before{content:"x"}` 让 pseudo 有确定产出，用完 remove，并写明为何必须注入 |
| 样式六组共享循环外的 `const cs = getComputedStyle(el)`，该句若留在 guard 外则抛错不被任何 guard 捕获，整个探针返回 `{error}`，隔离形同虚设 | 我（改 Task 7 时自查） | Task 7 Step 3 写明 cs 必须在**每个 guard 内部**各自取 |

| 计划里 23 处测试命令写成 `pnpm vitest run ... packages/extension/tests/X`，在仓库根执行必然报 `Command "vitest" not found`（vitest 是子包依赖，根目录没有） | Luna **执行** Task 1 时撞上 | 全改为 `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 tests/X`。**九轮评审没查出来，因为没人真跑过那条命令** |
| 「命中 1 个时无 pair 键」是弱断言：只查 `"pair" in r === false`，探针崩掉返回 `{error}` 时同样通过 | 我验收 Luna 的变异报告时，发现它报的转红用例与计划期望对不上，复做变异后定位 | 补 `expect(r.error).toBeUndefined()` 与 elements 存在性断言。同一变异下转红用例从 2 条变 3 条 |

| Task 2 变异 5（`filter(e => e.fp).map`）是**死条件**：fixture 每个元素都有 fp，filter 一个都滤不掉，改坏了测试照样绿 | 我替 Luna 补做变异验证时实测发现 | 补用例「元素缺 fp 时也不能被丢掉」——未请求 font 维度时探针本就不设 fp，这才是该不变量真正会被违反的场景。补后该变异转红 |

| Task 3 的「scanned 恒产出」只断言键集合，没有 `scanned.elements > 0`；而 Task 4 变异表却期望它对「删掉计数」转红——**计划自相矛盾，那条断言从来不存在** | Luna 执行 Task 4 变异 2 时发现并自行诊断出根因 | 给该用例补 `expect(r.scanned.elements).toBeGreaterThan(0)`。补后变异如期转红。这正是「扫描类不变量必须自带命中数断言否则空集假绿」的又一次复发 |

**2b. 经复核确认无问题的两处**（我曾怀疑）：`wantFont || wantPseudo` 才调
`finalizeStyleResult` 的条件是对的（其余维度无需 finalize）；
`const { scanned, ...rest } = body as RawProbeResult` 不会丢字段——类型断言不影响
运行时解构，其余字段照常保留。

**3. 未采纳的评审意见**

- **Luna 建议再拆 Task 3（探针骨架/geometry 转发）与 Task 4（text-attrs 采集/css 转发）。** 不采纳：
  采集与转发在同一维度族内，中间态无独立价值，拆开后 review 收益小于碎片化成本。
  Luna 自己也判定 Task 3「偏大但仍可接受」。Task 5/6 的拆分则采纳了——那里两侧风险性质
  确实不同（搬运漏内联 vs CDP 下标错位）。
- **Luna 建议 `grep -c` 换成 AST/导出符号检查。** 不采纳：Task 9 Step 6 已配合
  「`grep -rn` 无残留引用为 0 行」两条一起判，足以覆盖；引入 AST 检查的维护成本
  与本次收益不匹配。

**4. 占位符扫描**：无 TBD/TODO/"类似 Task N"。Task 5 Step 3 的「从 `styleProbeFunc` 原样搬运」
列了确切四项来源；Task 7 Step 3 的三处 `guard` 注明「原采集块整体移入」并给出下标错位的处置；
Task 9 Step 3 给出逐文件替换规则表。

**5. 类型一致性**：`RawProbeResult` 在 Task 2 定义，Task 3-8 引用一致；
`elementsProbeFunc` 五参签名 `(selector, maxResults, dims, attributes, includeText)`
在 Task 3 定义，后续六处调用参数顺序一致；`shapeCssResult` 的 opts 键名
`attributes`/`includeText` 前后一致；Task 7 新增的元素级 `errors` 字段在 Task 8
的 `dimensions` 自陈中未被引用——两者是不同粒度（元素级 vs 请求级），刻意不耦合。

**5b. 评审放行**：Luna 第九轮给出 **GO**（演进：r7 NO-GO 三项 → r8 NO-GO 两项 → r9 GO）。
九轮记录归档于 `reports/_review/luna-visual-query-r1.md` ~ `r7to9-tmux.md`。

**6. 本次范围的真实边界**（明写，不假装覆盖）

- **跨 frame 元素关系拿不到。** 探针只对 `buildExecuteTarget` 指定的单个 frame 执行
  （`query.ts:1970`），同页 iframe 内元素与主文档元素之间的位置关系无从比较。
  工具描述须写明作用域，否则调用方会以为已全页扫描。
- **`pair` 仍只比较前两个元素。** 本次不扩为 N 元素两两——那属于思路文档路线 A 的
  「元素间关系」部分，咬住的是 26.7% 那半负载，与本计划的 73.3% 不是同一件事。
  组合模式返回 `pair` 时必须保持它「只比前两个」的语义，不得暗示全体关系。
- **`component` 不作为维度提供。** 见 Global Constraints 第 1 条（payload 取舍）。
