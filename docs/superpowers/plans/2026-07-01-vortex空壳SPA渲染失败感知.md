# 空壳 SPA / 渲染失败感知 affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** observe 在检测到「framework 在场但根容器近空、0 交互元素、文档 complete」时输出 frame 级 `blankShell` 信号 + 顶部 `# blank-shell:` meta,把静默空树转为可行动提示。

**Architecture:** 沿用 blindspot 族「真源纯分类器 + observe.ts page-side inline 副本 + parity 结构性单测」铁律(page-side 注入函数丢模块作用域必须内联)。`blankShell` 的类型管道与既有 `modal?` **完全同形**(单个可选对象,条件 spread),只在 `modal?` 出现的每处镜像加字段;唯一新逻辑=检测函数 + 渲染 summary。纯感知信号,零副作用、零 observe 入参、零 tools/list 预算影响。

**Tech Stack:** TypeScript,Chrome MV3 扩展(page-side MAIN-world 注入),vitest(jsdom),MCP observe-render。

## Global Constraints

- **page-side 自包含**:inline 副本**不引模块级 helper**(inline gotcha,见 memory `vortex_page_side_func_inline_gotcha`);真源函数仅供 jsdom 单测 + 作规范参照。
- **真源↔inline parity**:改真源 `detectBlankShell` 须同步 observe.ts inline 副本(标记 `[inline detectBlankShell]`);结构性单测校验防漂移。
- **判据五门(全满足才触发,spike 实测收紧)**:① framework 在场 ② 根容器 `#root/#app/#__next/[data-reactroot]` 存在 ③ 根容器 `innerHTML.trim().length < 64` ④ 该 frame 交互元素数 `=== 0`(非 `<3`)⑤ `document.readyState === 'complete'`。
- **软提示语义**:提示"可能仍在渲染**或**渲染失败",不断言 failed(加载中/失败两态都正确,消除 FP 危害)。
- **向后兼容**:无 `blankShell` 时零输出;不改任何现有渲染/字段。
- **框架检测串**(真源与 inline 必须一致):globals `React/Vue/__NEXT_DATA__ !== undefined`、umi `typeof g_history !== 'undefined' || g !== undefined`、script src 正则 `/(?:umi|react|vue|next|runtime|chunk|\.[a-f0-9]{8}\.js)/i`。

---

### Task 1: `detectBlankShell` 真源纯分类器 + 单测

**Files:**
- Modify: `packages/extension/src/page-side/blindspot-detect.ts`(文件末尾追加类型 + 函数)
- Test: `packages/extension/tests/blindspot-detect.test.ts`(追加 describe 块;若无此文件则新建)

**Interfaces:**
- Produces: `export type BlankShell = { root: string; rootLen: number; framework: string }`
- Produces: `export function detectBlankShell(doc: Document, win: any, interactiveCount: number): BlankShell | null`

- [ ] **Step 1: 写失败测试**

追加到 `packages/extension/tests/blindspot-detect.test.ts`(import 处补 `detectBlankShell`):

```typescript
import { detectBlankShell } from "../src/page-side/blindspot-detect.js";

describe("detectBlankShell", () => {
  // 用 jsdom document + mock window 构造五门边界
  function mk(html: string, opts: { ready?: DocumentReadyState; win?: any } = {}) {
    document.documentElement.innerHTML = `<head></head><body>${html}</body>`;
    if (opts.ready) Object.defineProperty(document, "readyState", { value: opts.ready, configurable: true });
    else Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    return opts.win ?? {};
  }

  it("失败空壳(framework+空root+0交互+complete) → 命中", () => {
    const win = mk(`<div id="root"></div>`, { win: { React: {} } });
    expect(detectBlankShell(document, win, 0)).toEqual({ root: "#root", rootLen: 0, framework: "react" });
  });

  it("root 有内容 → 不命中(已渲染)", () => {
    const win = mk(`<div id="root"><h1>Dashboard</h1><nav>....................................</nav></div>`, { win: { React: {} } });
    expect(detectBlankShell(document, win, 0)).toBeNull();
  });

  it("无 framework → 不命中(静态稀疏页护栏)", () => {
    const win = mk(`<div id="root"></div>`, { win: {} });
    expect(detectBlankShell(document, win, 0)).toBeNull();
  });

  it("交互元素≠0 → 不命中(小内容已渲染页护栏)", () => {
    const win = mk(`<div id="root"></div>`, { win: { React: {} } });
    expect(detectBlankShell(document, win, 2)).toBeNull();
  });

  it("readyState≠complete → 不命中(仍在加载)", () => {
    const win = mk(`<div id="root"></div>`, { ready: "loading", win: { React: {} } });
    expect(detectBlankShell(document, win, 0)).toBeNull();
  });

  it("无 SPA 挂载点 → 不命中(不敢称 SPA 外壳)", () => {
    const win = mk(`<main></main>`, { win: { React: {} } });
    expect(detectBlankShell(document, win, 0)).toBeNull();
  });

  it("framework 经 script chunk 检出(无 globals) → 命中 script-chunk", () => {
    const win = mk(`<div id="app"></div><script src="https://cdn/umi.89ab768f.js"></script>`, { win: {} });
    expect(detectBlankShell(document, win, 0)).toEqual({ root: "#app", rootLen: 0, framework: "script-chunk" });
  });

  it("umi globals 检出 g_history", () => {
    const win = mk(`<div id="root"></div>`, { win: { g_history: {} } });
    expect(detectBlankShell(document, win, 0)?.framework).toBe("umi");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && npx vitest run tests/blindspot-detect.test.ts`
Expected: FAIL — `detectBlankShell is not a function` / 导入报错。

- [ ] **Step 3: 实现真源函数**

追加到 `packages/extension/src/page-side/blindspot-detect.ts` 末尾:

```typescript
/** 空壳 SPA / 渲染失败 frame 级信号。@since blank-shell */
export type BlankShell = { root: string; rootLen: number; framework: string };

/**
 * 空壳 SPA / 渲染失败感知(P2 衍生:站点自身 JS/网络失败致 #root 空时 observe 静默空树,
 * 模型误读"无控件")。五门全满足才触发(见 spec FP 表):framework 在场 + 根容器存在且近空
 * + 0 交互 + document complete。软语义:加载中/真失败两态提示都正确。
 * observe.ts page-side scan 内联同一判定(标记 [inline detectBlankShell]),改一处须改两处;
 * observe-blindspot-scan.test.ts 结构性校验。win 传 window(单测传 mock)。
 */
export function detectBlankShell(doc: Document, win: any, interactiveCount: number): BlankShell | null {
  if (interactiveCount !== 0) return null;                       // ④ 有收集到元素 → 非空壳
  if (doc.readyState !== "complete") return null;                // ⑤ 仍在加载 DOM 阶段
  let framework = "";                                            // ① framework 在场
  if (win.React !== undefined) framework = "react";
  else if (win.Vue !== undefined) framework = "vue";
  else if (win.__NEXT_DATA__ !== undefined) framework = "next";
  else if (typeof win.g_history !== "undefined" || win.g !== undefined) framework = "umi";
  else {
    for (const s of Array.from(doc.scripts)) {
      if (/(?:umi|react|vue|next|runtime|chunk|\.[a-f0-9]{8}\.js)/i.test((s as HTMLScriptElement).src || "")) {
        framework = "script-chunk";
        break;
      }
    }
  }
  if (!framework) return null;
  for (const sel of ["#root", "#app", "#__next", "[data-reactroot]"]) {  // ② 挂载点 ③ 近空
    const el = doc.querySelector(sel);
    if (!el) continue;
    const len = el.innerHTML.trim().length;
    return len < 64 ? { root: sel, rootLen: len, framework } : null;      // 首个存在挂载点定状态
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && npx vitest run tests/blindspot-detect.test.ts`
Expected: PASS(新增 8 例全绿)。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/blindspot-detect.ts packages/extension/tests/blindspot-detect.test.ts
git commit -m "feat(observe): detectBlankShell 真源分类器(空壳 SPA 感知)"
```

---

### Task 2: observe.ts inline 副本 + framesOut 管道 + parity 单测

**Files:**
- Modify: `packages/extension/src/handlers/observe.ts`(scan return 前加 inline 计算 + 5 处 modal 镜像点加 blankShell)
- Test: `packages/extension/tests/observe-blindspot-scan.test.ts`(追加 parity 结构性断言)

**Interfaces:**
- Consumes: 无(inline 副本自包含,不 import 真源)
- Produces: scan page 对象新增可选字段 `blankShell?: { root: string; rootLen: number; framework: string }`;framesOut 每 frame 同字段。

- [ ] **Step 1: 加 inline 计算 + 挂到 scan 返回**

在 `packages/extension/src/handlers/observe.ts` 的 scan 返回对象(约 3682 行 `return {` )**之前**插入 inline 计算。`elements` 即该 frame 已收集交互元素数组:

```typescript
        // [inline detectBlankShell] 真源 packages/extension/src/page-side/blindspot-detect.ts
        // detectBlankShell,改一处须改两处。空壳 SPA/渲染失败感知:framework 在场 + 根容器近空
        // + 0 交互(elements.length===0) + document complete → frame 级 blankShell 信号。
        let __blankShell: { root: string; rootLen: number; framework: string } | undefined;
        if (elements.length === 0 && document.readyState === "complete") {
          let __fw = "";
          if ((window as any).React !== undefined) __fw = "react";
          else if ((window as any).Vue !== undefined) __fw = "vue";
          else if ((window as any).__NEXT_DATA__ !== undefined) __fw = "next";
          else if (typeof (window as any).g_history !== "undefined" || (window as any).g !== undefined) __fw = "umi";
          else {
            for (const __s of Array.from(document.scripts)) {
              if (/(?:umi|react|vue|next|runtime|chunk|\.[a-f0-9]{8}\.js)/i.test((__s as HTMLScriptElement).src || "")) { __fw = "script-chunk"; break; }
            }
          }
          if (__fw) {
            for (const __sel of ["#root", "#app", "#__next", "[data-reactroot]"]) {
              const __rt = document.querySelector(__sel);
              if (!__rt) continue;
              const __len = __rt.innerHTML.trim().length;
              if (__len < 64) __blankShell = { root: __sel, rootLen: __len, framework: __fw };
              break;
            }
          }
        }
```

然后在 return 对象里(3697 行 `...(__modalMeta ? { modal: __modalMeta } : {})` 之后)加:

```typescript
          ...(__blankShell ? { blankShell: __blankShell } : {}),
```

- [ ] **Step 2: scan page 类型接口加字段(observe.ts:239 附近,modal? 同处)**

在 observe.ts 约 239 行 `modal?: { name: string; role: string; suppressed: number };` **之后**加:

```typescript
  /** 空壳 SPA/渲染失败 frame 级信号。@since blank-shell */
  blankShell?: { root: string; rootLen: number; framework: string };
```

- [ ] **Step 3: framesOut 接口加字段(observe.ts:4004,modal? 同处)**

在约 4004 行 framesOut 接口的 `modal?: { name: string; role: string; suppressed: number };` **之后**加同一行:

```typescript
        /** 空壳 SPA/渲染失败 frame 级信号。@since blank-shell */
        blankShell?: { root: string; rootLen: number; framework: string };
```

- [ ] **Step 4: framesOut push 加条件 spread(observe.ts:4170,modal spread 同处)**

在约 4170 行 `...(s.page.modal ? { modal: s.page.modal } : {}),` **之后**加:

```typescript
          ...(s.page.blankShell ? { blankShell: s.page.blankShell } : {}),
```

- [ ] **Step 5: 写 parity 结构性断言**

追加到 `packages/extension/tests/observe-blindspot-scan.test.ts`(读取 observe.ts 源文验证 inline 副本含关键判据串):

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("blankShell inline↔真源 parity", () => {
  const observeSrc = readFileSync(
    fileURLToPath(new URL("../src/handlers/observe.ts", import.meta.url)),
    "utf8",
  );
  it("observe.ts 含 [inline detectBlankShell] 标记", () => {
    expect(observeSrc).toContain("[inline detectBlankShell]");
  });
  it("inline 副本含五门关键判据(与真源一致)", () => {
    expect(observeSrc).toContain('elements.length === 0 && document.readyState === "complete"'); // ④⑤
    expect(observeSrc).toMatch(/umi\|react\|vue\|next\|runtime\|chunk/); // ① framework 正则
    expect(observeSrc).toContain('"#root", "#app", "#__next", "[data-reactroot]"'); // ② 挂载点
    expect(observeSrc).toContain("__len < 64"); // ③ 近空阈值
  });
  it("framesOut 管道镜像 blankShell(与 modal 同形)", () => {
    expect(observeSrc).toContain("s.page.blankShell ? { blankShell: s.page.blankShell }");
  });
});
```

- [ ] **Step 6: 跑测试 + 构建确认无回归**

Run: `cd packages/extension && npx vitest run tests/observe-blindspot-scan.test.ts && pnpm build:main`
Expected: PASS + build 成功(inline 语法/类型正确编入 SW bundle)。

- [ ] **Step 7: 提交**

```bash
git add packages/extension/src/handlers/observe.ts packages/extension/tests/observe-blindspot-scan.test.ts
git commit -m "feat(observe): blankShell inline 副本 + framesOut 管道 + parity"
```

---

### Task 3: observe-render.ts 渲染 `# blank-shell:` meta + 单测

**Files:**
- Modify: `packages/mcp/src/lib/observe-render.ts`(CompactFrame 加字段 + blankShellSummary + 两处 render 调用)
- Test: `packages/mcp/src/lib/observe-render.test.ts`(追加渲染断言)

**Interfaces:**
- Consumes: `CompactFrame.blankShell?: { root: string; rootLen: number; framework: string }`
- Produces: `# blank-shell: ...` meta 行(命中时置于顶部,与 `# blindspots:`/`# modal:` 并列)

- [ ] **Step 1: 写失败测试**

追加到 `packages/mcp/src/lib/observe-render.test.ts`(用既有 render 入口 + 构造带 blankShell 的 frame;参照文件内既有 modal 渲染测试的调用形态):

```typescript
describe("blankShell 渲染", () => {
  it("blankShell frame → 输出 # blank-shell: 提示行 + framework/root", () => {
    const data = {
      snapshotId: "s1", url: "https://x/app", elements: [],
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/app", offset: { x: 0, y: 0 },
        elementCount: 0, truncated: false, scanned: true,
        blankShell: { root: "#root", rootLen: 0, framework: "umi" } }],
    } as any;
    const out = renderObserve(data); // ← 与文件内既有测试用的 render 函数名一致
    expect(out).toContain("# blank-shell:");
    expect(out).toContain("umi");
    expect(out).toContain("#root");
  });
  it("无 blankShell → 不输出该行(向后兼容)", () => {
    const data = { snapshotId: "s2", url: "https://x", elements: [], frames: [] } as any;
    expect(renderObserve(data)).not.toContain("# blank-shell:");
  });
});
```

> 注:`renderObserve` 用文件内既有测试实际调用的导出函数名替换(可能是 `renderCompact`/`renderTree` 或统一入口——打开 observe-render.test.ts 顶部 import 确认后对齐)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/mcp && npx vitest run src/lib/observe-render.test.ts`
Expected: FAIL — 输出不含 `# blank-shell:`。

- [ ] **Step 3: CompactFrame 加字段**

在 `packages/mcp/src/lib/observe-render.ts` 约 100 行 `modal?: { name: string; role: string; suppressed: number };` **之后**加:

```typescript
  /** 空壳 SPA/渲染失败 frame 级信号。@since blank-shell */
  blankShell?: { root: string; rootLen: number; framework: string };
```

- [ ] **Step 4: 加 blankShellSummary 函数**

在 `modalSummary`(约 398 行)**之后**加:

```typescript
/** 空壳 SPA/渲染失败 meta 行:首个带 blankShell 的 frame → # blank-shell:。软语义(加载/失败两态)。 */
function blankShellSummary(frames?: CompactFrame[]): string | null {
  for (const f of frames ?? []) {
    if (f.blankShell) {
      const b = f.blankShell;
      return `# blank-shell: ${b.framework} 应用的 ${b.root} 近空(${b.rootLen} chars)且 0 交互元素、文档已 complete — 页面可能仍在渲染或渲染失败。建议 vortex_wait_for(idle=net) 后重试,或 vortex_debug_read(console/network) 查错(如 ERR_NETWORK / React hydration)。`;
    }
  }
  return null;
}
```

- [ ] **Step 5: 两处 render 调用(compact + tree,modalLine 同处)**

在 observe-render.ts 两处 `const modalLine = modalSummary(data.frames); if (modalLine) lines.push(modalLine);`(约 434-435 与 547-548)**各自之后**加:

```typescript
  const blankLine = blankShellSummary(data.frames);
  if (blankLine) lines.push(blankLine);
```

- [ ] **Step 6: 跑测试确认通过 + MCP 全测无回归**

Run: `cd packages/mcp && npx vitest run`
Expected: PASS(新增 2 例 + 既有全绿;I15 tools/list 不受影响,无入参改动)。

- [ ] **Step 7: 提交**

```bash
git add packages/mcp/src/lib/observe-render.ts packages/mcp/src/lib/observe-render.test.ts
git commit -m "feat(observe): 渲染 # blank-shell meta 提示行"
```

---

### Task 4: 全测 + 真站 live spike + 收尾提交

**Files:** 无代码改动(验证 + 记忆更新)

- [ ] **Step 1: 扩展 + MCP 全测**

Run: `cd packages/extension && pnpm test && cd ../mcp && pnpm test`
Expected: 两包全绿(扩展含 blindspot-detect + parity 新例;MCP 含 render 新例)。

- [ ] **Step 2: 重建扩展 + 重载**

Run: `cd packages/extension && pnpm build:main`,然后经 MCP `vortex_dev_reload` 重载(或重试 `vortex_observe` 重连)。
Expected: build 成功,扩展 stamp 更新。

- [ ] **Step 3: 真站 live spike(承重墙)**

用 MCP 工具依次验证(observe 后**立刻**读,避免 SW 休眠清快照):
- **失败 CSR**:`vortex_navigate https://g2.antv.antgroup.com/examples/general/interval#column-basic` → `vortex_observe` → 顶部应出 `# blank-shell: umi 应用的 #root 近空...`。
- **SSR 已渲染**(对照,不应报):`vortex_navigate https://g2.antv.antgroup.com/` → `vortex_observe` → **无** `# blank-shell:`(root 有内容 41KB)。
- **静态稀疏**(对照,不应报):`vortex_navigate https://example.com/` → `vortex_observe` → **无** `# blank-shell:`(无 framework)。
Expected: 失败页命中、两对照页均不误报。若失败页未命中,回读 `vortex_evaluate` 核对 elements.length/readyState/root 状态排障。

- [ ] **Step 4: 更新记忆**

编辑 `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/memory/vortex_hardvisual_eval_phase2_chart.md`:P2 衍生 blank-shell affordance 已 ship,记录判据五门 + spike 数据 + commit hash。

- [ ] **Step 5: 最终确认提交(如有记忆/文档外的收尾)**

Run: `git status --short && git log --oneline -5`
Expected: 工作树干净,Task 1-3 三个 feat commit 在列。

---

## Self-Review

**1. Spec coverage:** spec 五门判据 → Task 1 真源 + Task 2 inline(判据完整镜像);信号形状(frame 级 blankShell + `# blank-shell` meta)→ Task 2 管道 + Task 3 渲染;软提示语义 → Task 3 summary 文案("可能仍在渲染或渲染失败");FP 分析 → Task 1 单测覆盖 S2/S3/S4c 护栏(root 有内容/无 framework/interactive≠0);承重墙 live → Task 4 真站 spike。Non-goals(console 增强/自定义 mount)明确不实现。全覆盖。

**2. Placeholder scan:** 无 TBD/TODO;唯一"待对齐"是 Task 3 的 `renderObserve` 函数名(已显式标注:打开 observe-render.test.ts import 对齐既有 render 导出名),非占位符而是防止臆造 API 的核对指令。

**3. Type consistency:** `BlankShell = { root: string; rootLen: number; framework: string }` 全 5 处(真源类型/observe.ts:239/observe.ts:4004/framesOut push/observe-render CompactFrame)字段名一致;inline 副本变量 `__blankShell` 同结构;parity 单测断言判据串与真源逐字对齐。
