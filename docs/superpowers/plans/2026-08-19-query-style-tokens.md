# 页面样式调研能力（路线 A + D）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `vortex_query` 能接 `@ref`、一次给全设计相关的计算样式、拿不到背景时说「未判定」而不是「不合格」，并新增 `mode=tokens` 抽出站点的设计变量面。

**Architecture:** 全部改动落在页面侧探针 + 两条既有寻址链的复用。`@ref` 走 MCP 层「抬 pattern 成 target」复用 server.ts 既有翻译链（`liftWaitForRefToTarget` 的同款做法），扩展侧用已被 6 个 handler 验证过的 `resolveTarget` 反查。样式属性面按 typography / box / paint / motion 四组扩充，用既有 `attr` 参数选组。tokens 是一个新的自包含页面侧探针，不需要元素寻址。

**Tech Stack:** TypeScript、Chrome MV3 `chrome.scripting.executeScript`（MAIN world）、vitest + jsdom、pnpm workspace。

**Spec:** `docs/style-investigation-approach.md`（选定路线：A 地板 + D 设计 token 面，§4）

## Global Constraints

- 分支：`feat/query-style-tokens`，从 `main`（`259a7ed`）切出。不在 main 上直接改。
- 跑测试**必须**限并发：`pnpm vitest run --maxWorkers=2 --minWorkers=1 <file>`。**禁止**裸跑 `pnpm -r test`（会卡死机器），全仓测试只在最后一个任务跑一次。
- 页面侧注入函数（`*ProbeFunc`）**必须自包含**：`executeScript` 的 `func` 注入会丢模块作用域，引用任何模块级标识符都会在真实浏览器里抛 `X is not defined`，而 jsdom 单测因为作用域还在会假绿。每个新增/修改的探针都要配一条 `new Function` 复刻注入的自包含测试。
- 每条新增测试都要做**变异验证**：把被测行为改坏，确认测试转红；不转红的测试要重写而不是保留。
- 注释规范：中文；方法体内一律单行 `//`，每条 ≤1 行 ≤60 字；同一方法体内 ≤3 条；禁止分步骤流水账、禁止复述代码、禁止把需求背景/评审过程写进注释。TS 文件不写 `Author:`。
- **禁止**对既有文件跑 `prettier --write`（会整篇重排产生几百行噪声）。只手改要改的行。
- commit 遵循 Conventional Commits，中文描述、动词开头、结尾无句号；**禁止** `Co-Authored-By` / `Signed-off-by` 署名。
- `tools/list` 有字节预算不变量（`packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`）：当前 payload 实测 **11037 B**，上限 11100；`vortex_query` description 当前 **222 char**，上限 230。两者余量都极小，加能力时按仓库既有惯例「加能力调 cap 不压字符」上调，并在测试里补一段说明为什么调。
- 向后兼容：`styleProbeFunc` 既有的 8 个扁平字段（`index/tag/color/background/bgFromAncestor/fontWeight/fontSize/contrastRatio`）保持原名原位，新字段只做增量。唯一允许的破坏性变更是 `wcagAA`/`wcagAAA` 的类型从 `boolean` 变为 `boolean | "unknown"` —— 这正是本次要修的诚实性缺陷。

---

## File Structure

| 文件 | 责任 | 任务 |
|------|------|------|
| `packages/mcp/src/lib/query-ref.ts` | **新建**。把 `vortex_query` 选择器类 mode 的 `@ref` 形式 `pattern` 抬成 `target`，复用 server.ts 既有翻译链 | 1 |
| `packages/mcp/src/server.ts` | 在既有 `liftWaitForRefToTarget` 调用旁挂上新 helper | 1 |
| `packages/extension/src/handlers/query.ts` | 承重文件。handler 入口接 `resolveTarget`；`styleProbeFunc` 对比度语义修正与属性面扩充；新增 `tokensProbeFunc` 与 `tokens` 分支 | 1,2,3,4 |
| `packages/mcp/src/tools/schemas-public.ts` | `mode` 枚举加 `tokens`；description 与 `attr` 说明 | 5 |
| `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts` | 上调两处 cap 并写明理由 | 5 |
| `packages/extension/tests/query-style.test.ts` | 既有，扩充 | 2,3 |
| `packages/extension/tests/query-tokens.test.ts` | **新建** | 4 |
| `packages/extension/tests/query-ref-target.test.ts` | **新建** | 1 |
| `packages/mcp/tests/query-ref-lift.test.ts` | **新建** | 1 |
| `docs/style-investigation-approach.md` | 补 §7 实测结论 | 6 |

---

### Task 1: `vortex_query` 接受 `@ref`

**Files:**
- Create: `packages/mcp/src/lib/query-ref.ts`
- Create: `packages/mcp/tests/query-ref-lift.test.ts`
- Create: `packages/extension/tests/query-ref-target.test.ts`
- Modify: `packages/mcp/src/server.ts:21`（import）、`:772`（调用点）
- Modify: `packages/extension/src/handlers/query.ts:1468-1495`（handler 入口取 pattern / tid / frameId）

**背景（实测）：** `resolve-target.ts:17` 的 `resolveTarget` 被 dom / mouse / capture / file / page / content 六个 handler 引用，`query.ts` 引用数为 **0**。实测 `vortex_query({mode:"style", pattern:"@ref1"})` 报 `Invalid CSS selector`。这与 `wait-for-ref.ts` 头注释记录的 N0063 缺陷是同一类：某个工具的元素参数没走翻译链，破坏「全程 @ref」的心智模型。

**Interfaces:**
- Consumes: `resolveTargetOptional(args)` from `packages/extension/src/lib/resolve-target.ts:80`，返回 `{ selector, boundTabId?, boundFrameId?, descriptor? } | undefined`。
- Produces: `liftQueryRefToTarget(toolName: string, params: Record<string, unknown>): void`，供 `server.ts` 在 target 翻译**之前**调用。

- [ ] **Step 1: 写 MCP 层失败测试**

创建 `packages/mcp/tests/query-ref-lift.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { liftQueryRefToTarget } from "../src/lib/query-ref.js";

describe("liftQueryRefToTarget", () => {
  it.each(["style", "geometry", "css", "component"])(
    "mode=%s 且 pattern 以 @ 开头 → 抬成 target 并删掉 pattern",
    (mode) => {
      const params: Record<string, unknown> = { mode, pattern: "@a1b2:e7" };
      liftQueryRefToTarget("vortex_query", params);
      expect(params.target).toBe("@a1b2:e7");
      expect("pattern" in params).toBe(false);
    },
  );

  it.each(["text", "sheet", "flow", "chart", "schema", "tokens"])(
    "mode=%s 不是选择器类 → pattern 原样保留",
    (mode) => {
      const params: Record<string, unknown> = { mode, pattern: "@a1b2:e7" };
      liftQueryRefToTarget("vortex_query", params);
      expect(params.pattern).toBe("@a1b2:e7");
      expect("target" in params).toBe(false);
    },
  );

  it("CSS 选择器形态不动（不以 @ 开头）", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "h1" };
    liftQueryRefToTarget("vortex_query", params);
    expect(params.pattern).toBe("h1");
    expect("target" in params).toBe(false);
  });

  it("已显式带 target 时不抢 pattern", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "@a1b2:e7", target: "#explicit" };
    liftQueryRefToTarget("vortex_query", params);
    expect(params.target).toBe("#explicit");
    expect(params.pattern).toBe("@a1b2:e7");
  });

  it("别的工具不受影响", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "@a1b2:e7" };
    liftQueryRefToTarget("vortex_observe", params);
    expect(params.pattern).toBe("@a1b2:e7");
    expect("target" in params).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/mcp/tests/query-ref-lift.test.ts`
Expected: FAIL，`Cannot find module '../src/lib/query-ref.js'`

- [ ] **Step 3: 实现 helper**

创建 `packages/mcp/src/lib/query-ref.ts`：

```ts
/**
 * vortex_query 的 pattern 在选择器类 mode 下就是元素定位符，却是唯一没接进
 * server.ts target→{index,snapshotId,frameId} 翻译链的入口（wait-for-ref.ts
 * 头注释里的 N0063 是同一类缺陷）。本 helper 在 target 翻译之前把 @ref 形态
 * 的 pattern 抬成 target，复用同一条翻译 + STALE/tab 校验。
 */
const QUERY_SELECTOR_MODES = new Set(["css", "component", "geometry", "style"]);

export function liftQueryRefToTarget(
  toolName: string,
  params: Record<string, unknown>,
): void {
  if (toolName !== "vortex_query") return;
  if (!QUERY_SELECTOR_MODES.has(params.mode as string)) return;
  // 已显式带 target 时不抢:避免悄悄吞掉调用方的定位意图
  if (params.target != null) return;
  const pattern = params.pattern;
  if (typeof pattern !== "string" || !pattern.startsWith("@")) return;
  params.target = pattern;
  delete params.pattern;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/mcp/tests/query-ref-lift.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: 挂到 server.ts**

在 `packages/mcp/src/server.ts:21` 的 import 下方加：

```ts
import { liftQueryRefToTarget } from "./lib/query-ref.js";
```

在 `:772` 的 `liftWaitForRefToTarget(toolDef.name, params);` 紧下一行加：

```ts
  liftQueryRefToTarget(toolDef.name, params);
```

- [ ] **Step 6: 写扩展侧失败测试**

创建 `packages/extension/tests/query-ref-target.test.ts`。参考同目录 `query-handler.test.ts` 里 `registerQueryHandlers` 的 mock 方式（`chrome.scripting.executeScript` / `chrome.tabs.query` 的 stub 形状照抄）。核心断言：

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerQueryHandlers } from "../src/handlers/query.js";
import { putSnapshot } from "../src/lib/snapshot-store.js";

describe("query 经 index+snapshotId 定位（@ref 翻译后的形态）", () => {
  let executeScript: ReturnType<typeof vi.fn>;
  let router: ActionRouter;

  beforeEach(() => {
    executeScript = vi.fn().mockResolvedValue([
      { result: { elements: [{ index: 0, tag: "h1" }], total: 1, showing: 1 } },
    ]);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: { executeScript },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    router = new ActionRouter();
    registerQueryHandlers(router);
  });

  it("不传 pattern、只传 index+snapshotId → 用快照里的 selector 当 pattern", async () => {
    // putSnapshot 的实参形状照 lib/snapshot-store.ts 的导出签名填
    const snapshotId = putSnapshot({
      tabId: 42,
      frameId: 0,
      elements: [{ index: 3, selector: ".css-m7knwo", role: "link", name: "Start for free" }],
    } as never);

    const resp = await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "style", index: 3, snapshotId },
      requestId: "r1",
      tabId: 42,
    } as never);

    expect(resp.error).toBeUndefined();
    // 页面侧探针收到的第一个实参就是反查出来的 selector
    expect(executeScript.mock.calls[0][0].args[0]).toBe(".css-m7knwo");
  });

  it("跨 frame 快照 → executeScript 打的是快照绑定的 frame", async () => {
    const snapshotId = putSnapshot({
      tabId: 42,
      frameId: 7,
      elements: [{ index: 1, selector: ".in-iframe", role: "button", name: "Buy" }],
    } as never);

    await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "style", index: 1, snapshotId },
      requestId: "r1b",
      tabId: 42,
    } as never);

    // buildExecuteTarget 把 frameId 放进 target.frameIds;打错 frame 这里就转红
    expect(executeScript.mock.calls[0][0].target.frameIds).toEqual([7]);
  });

  it("既不传 pattern 也不传 index → 仍报 pattern 必填", async () => {
    const resp = await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "style" },
      requestId: "r2",
      tabId: 42,
    } as never);
    expect(String(resp.error?.message)).toMatch(/pattern is required/);
  });
});
```

> 实现者注意：`putSnapshot` 的真实导出名与参数形状以 `packages/extension/src/lib/snapshot-store.ts` 为准，按实际签名调整这两行，不要改断言语义。

- [ ] **Step 7: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-ref-target.test.ts`
Expected: FAIL，第一个用例报 `pattern is required and must be a non-empty string`

- [ ] **Step 8: 扩展侧接 resolveTarget**

在 `packages/extension/src/handlers/query.ts` 顶部 import 区加：

```ts
import { resolveTargetOptional } from "../lib/resolve-target.js";
```

把 `registerQueryHandlers` 里的入口段（现为 `:1468` 起的 `const pattern = args.pattern as string | undefined;` 到 `:1495` 的 `if (frameId != null) await ensureFrameAttached(tid, frameId);`）改成：

```ts
      const mode = args.mode as string | undefined;

      // query 是唯一没接 @ref 的元素类 handler;选择器类 mode 复用 resolveTarget 反查
      const SELECTOR_MODES = new Set(["css", "component", "geometry", "style"]);
      const resolved =
        args.pattern == null && mode != null && SELECTOR_MODES.has(mode)
          ? resolveTargetOptional(args)
          : undefined;
      const pattern = (args.pattern as string | undefined) ?? resolved?.selector;

      // 参数校验（mode 白名单分支保持原样，只把 pattern 校验挪到 resolved 之后）
      ...原 mode 校验不变...
      if (!pattern || typeof pattern !== "string" || !pattern.trim()) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          "vortex_query: pattern is required and must be a non-empty string",
        );
      }

      // 快照绑定的 tab/frame 优先于调用方传的,跨 frame ref 才不会打错 frame
      const tid = await getActiveTabId(
        resolved?.boundTabId ?? (args.tabId as number | undefined) ?? tabId,
      );
      const frameId = resolved?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
```

- [ ] **Step 9: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-ref-target.test.ts packages/extension/tests/query-handler.test.ts`
Expected: PASS，且 `query-handler.test.ts` 既有用例不回归

- [ ] **Step 10: 变异验证**

先 `cp packages/mcp/src/lib/query-ref.ts /tmp/qr.bak`，把 `params.target = pattern;` 改成 `params.target = "h1";`，跑 Step 4 的命令，确认转红，再 `cp /tmp/qr.bak packages/mcp/src/lib/query-ref.ts` 还原。
同样把 Step 8 里的 `?? resolved?.selector` 删掉，跑 Step 9 的命令确认转红，再手工改回。

> **不要**用 `git checkout -- <file>` 还原变异：同一文件里未提交的真修改会一起丢。

- [ ] **Step 11: Commit**

```bash
git add packages/mcp/src/lib/query-ref.ts packages/mcp/src/server.ts \
        packages/extension/src/handlers/query.ts \
        packages/mcp/tests/query-ref-lift.test.ts \
        packages/extension/tests/query-ref-target.test.ts
git commit -m "feat: vortex_query 选择器类 mode 接受 @ref"
```

---

### Task 2: 对比度不说假话（背景上溯到根 + 渐变判定 + WCAG 三态）

**Files:**
- Modify: `packages/extension/src/handlers/query.ts:750-860`（`styleProbeFunc`）
- Modify: `packages/extension/tests/query-style.test.ts`

**背景（实测）：** gamma.app 的 `h1` 其 painted 背景在**第 10 层祖先**（`body`），而 `:824` 的上溯循环写死 `j < 8`（同文件 `geometry` 探针 `:669` 写的却是 `j < 12`——同一种上溯两个魔数）。结果 `contrastRatio` 为 `null`，而 `:850` 的 `wcagAA: contrastRatio != null && contrastRatio >= 4.5` 把 `null` 折叠成 `false`，于是工具对一个实际对比度 15:1（AAA 通过）的标题输出「AA 不合格」。这是把「不知道」说成「不合格」。

**Interfaces:**
- Produces: `styleProbeFunc` 每个元素新增 `contrastStatus: "ok" | "no-painted-background" | "background-image"`；`wcagAA` / `wcagAAA` 类型变为 `boolean | "unknown"`。Task 3 在同一个元素对象上追加分组字段。

- [ ] **Step 1: 写失败测试**

在 `packages/extension/tests/query-style.test.ts` 的 `describe` 内追加：

```ts
  it("painted 背景在第 10 层祖先 → 仍能上溯到（不再写死 8 层）", () => {
    let cur = document.body;
    for (let i = 0; i < 10; i++) {
      const d = document.createElement("div");
      cur.appendChild(d);
      cur = d;
    }
    // 最外层套白底,内层全透明
    (document.body.firstElementChild as HTMLElement).style.backgroundColor = "rgb(255, 255, 255)";
    const el = document.createElement("h1");
    el.className = "deep";
    el.style.color = "rgb(0, 0, 0)";
    cur.appendChild(el);

    const r = styleProbeFunc(".deep", 10, []) as any;
    expect(r.elements[0].background).toBe("rgb(255, 255, 255)");
    expect(r.elements[0].bgFromAncestor).toBe(true);
    expect(r.elements[0].contrastStatus).toBe("ok");
    expect(r.elements[0].contrastRatio).toBeCloseTo(21, 0);
  });

  it("完全找不到 painted 背景 → wcag 三项为 unknown,不谎报 false", () => {
    const el = document.createElement("div");
    el.className = "nobg";
    el.style.color = "rgb(0, 0, 0)";
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    document.body.appendChild(el);

    const r = styleProbeFunc(".nobg", 10, []) as any;
    expect(r.elements[0].contrastRatio).toBeNull();
    expect(r.elements[0].contrastStatus).toBe("no-painted-background");
    expect(r.elements[0].wcagAA).toBe("unknown");
    expect(r.elements[0].wcagAAA).toBe("unknown");
  });

  it("背景是渐变 → 对比度不可判定,不拿 backgroundColor 硬算", () => {
    const wrap = document.createElement("div");
    wrap.style.backgroundColor = "rgb(255, 255, 255)";
    wrap.style.backgroundImage = "linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))";
    const el = document.createElement("span");
    el.className = "grad";
    el.style.color = "rgb(0, 0, 0)";
    wrap.appendChild(el);
    document.body.appendChild(wrap);

    const r = styleProbeFunc(".grad", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("background-image");
    expect(r.elements[0].contrastRatio).toBeNull();
    expect(r.elements[0].wcagAA).toBe("unknown");
  });

  it("近祖先渐变 + 远祖先纯白 → 背景取渐变那层,不能穿过去拿远处的白", () => {
    const far = document.createElement("div");
    far.style.backgroundColor = "rgb(255, 255, 255)";
    const near = document.createElement("div");
    near.style.backgroundImage = "linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))";
    const el = document.createElement("span");
    el.className = "layered";
    el.style.color = "rgb(0, 0, 0)";
    near.appendChild(el);
    far.appendChild(near);
    document.body.appendChild(far);

    const r = styleProbeFunc(".layered", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("background-image");
    expect(r.elements[0].contrastRatio).toBeNull();
    // 关键:返回的 background 不得是被渐变盖住的那层白
    expect(r.elements[0].background).not.toBe("rgb(255, 255, 255)");
  });

  it("元素自身带图 → 不上溯,状态与背景来源自洽", () => {
    const wrap = document.createElement("div");
    wrap.style.backgroundColor = "rgb(255, 255, 255)";
    const el = document.createElement("div");
    el.className = "selfimg";
    el.style.backgroundImage = "linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))";
    el.style.color = "rgb(0, 0, 0)";
    wrap.appendChild(el);
    document.body.appendChild(wrap);

    const r = styleProbeFunc(".selfimg", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("background-image");
    expect(r.elements[0].bgFromAncestor).toBe(false);
    expect(r.elements[0].wcagAA).toBe("unknown");
  });

  it("真低对比仍然判 false（不能因为改三态就一律 unknown）", () => {
    const el = document.createElement("div");
    el.className = "low";
    el.style.color = "rgb(200, 200, 200)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.appendChild(el);
    const r = styleProbeFunc(".low", 10, []) as any;
    expect(r.elements[0].wcagAA).toBe(false);
    expect(r.elements[0].contrastStatus).toBe("ok");
  });
```

同时把该文件既有 4 个用例的调用从 `styleProbeFunc(".t", 10)` 改成 `styleProbeFunc(".t", 10, [])`（第三参在 Task 3 才有实际作用，这里先占位为空数组 = 不返回任何分组）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-style.test.ts`
Expected: FAIL —— 第 10 层用例报 `background` 为 `rgba(0, 0, 0, 0)`；三态用例报 `wcagAA` 为 `false` 而非 `"unknown"`

- [ ] **Step 3: 改探针**

`packages/extension/src/handlers/query.ts`，`styleProbeFunc` 签名加第三参并改对比度段。签名与返回类型：

```ts
export const styleProbeFunc = (
  selector: string,
  maxResults: number,
  groups: string[],
):
  | {
      elements: Array<{
        index: number;
        tag: string;
        color: string;
        background: string;
        backgroundImage: string;
        bgFromAncestor: boolean;
        fontWeight: string;
        fontSize: string;
        contrastRatio: number | null;
        contrastStatus: "ok" | "no-painted-background" | "background-image";
        wcagAA: boolean | "unknown";
        wcagAAA: boolean | "unknown";
        typography?: Record<string, string>;
        box?: Record<string, string>;
        paint?: Record<string, string>;
        motion?: Record<string, string>;
      }>;
      total: number;
      showing: number;
    }
  | { error: string } => {
```

把原 `:820-855` 的背景上溯 + 对比度 + wcag 段整体替换为：

```ts
      let background = cs.backgroundColor;
      let backgroundImage = cs.backgroundImage;
      let bgFromAncestor = false;
      let contrastStatus: "ok" | "no-painted-background" | "background-image" =
        backgroundImage !== "none" ? "background-image" : "ok";

      // 自身已经绘制(有图)就不上溯:再往上的层被它盖住,不是实际背景
      if (contrastStatus === "ok" && isTransparent(background)) {
        // 不设层数上限:gamma.app 的 painted 背景在第 10 层,任何魔数都会漏
        for (let a: HTMLElement | null = el.parentElement; a; a = a.parentElement) {
          const acs = getComputedStyle(a);
          // 第一层产生绘制的祖先就是背景层,图和色都在这一层取,取完即停
          if (acs.backgroundImage !== "none") {
            backgroundImage = acs.backgroundImage;
            background = acs.backgroundColor;
            bgFromAncestor = true;
            contrastStatus = "background-image";
            break;
          }
          if (!isTransparent(acs.backgroundColor)) {
            background = acs.backgroundColor;
            bgFromAncestor = true;
            break;
          }
        }
      }

      let contrastRatio: number | null = null;
      if (contrastStatus === "ok") {
        const fg = parse(color);
        const bg = parse(background);
        if (fg && bg && !isTransparent(background)) {
          const L1 = lum(fg) + 0.05;
          const L2 = lum(bg) + 0.05;
          contrastRatio = Math.round((Math.max(L1, L2) / Math.min(L1, L2)) * 100) / 100;
        } else {
          // 背景没找到就是没找到,不能折叠成"不合格"
          contrastStatus = "no-painted-background";
        }
      }
      const verdict = (min: number): boolean | "unknown" =>
        contrastRatio == null ? "unknown" : contrastRatio >= min;
```

`elements.push` 里对应改为：

```ts
        backgroundImage,
        contrastStatus,
        wcagAA: verdict(4.5),
        wcagAAA: verdict(7),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-style.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 变异验证**

`cp packages/extension/src/handlers/query.ts /tmp/q.bak`，依次做两个变异，每次跑 Step 4 命令确认转红，然后 `cp /tmp/q.bak packages/extension/src/handlers/query.ts` 还原：
1. 把上溯循环加回 `, j = 0` / `j < 8` 上限 → 第 10 层用例应转红
2. 把 `verdict` 改回 `contrastRatio != null && contrastRatio >= min` → 三态用例应转红
3. 把遇到祖先背景图时的 `break` 删掉（让循环继续上溯到远处纯色）→ 层叠语义用例应转红

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-style.test.ts
git commit -m "fix: 样式探针背景上溯到根,拿不到背景时 WCAG 判定输出 unknown"
```

---

### Task 3: 样式属性面按四组扩充

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（`styleProbeFunc` 分组段 + `:1686` style 分支）
- Modify: `packages/extension/tests/query-style.test.ts`

**背景（实测）：** `styleProbeFunc` 的 docstring 自陈是回答「配色/对比度对不对」，属性面按 a11y 审计裁的。gamma.app 的 `h1` 真值 `font-family: ESBuild, sans-serif` / `letter-spacing: -1.2px` / `line-height: 60px`，主 CTA 的 `border-radius: 24px` / `padding: 0px 32px` / `transition`，一项都拿不到。

**Interfaces:**
- Consumes: Task 2 定下的 `styleProbeFunc(selector, maxResults, groups)` 第三参。
- Consumes: `normalizeCssAttrParam(attr)` from `packages/extension/src/handlers/query.ts:1459`，返回 `string[] | null`。
- Produces: 元素对象上的 `typography` / `box` / `paint` / `motion` 四个可选 `Record<string, string>`。

- [ ] **Step 1: 写失败测试**

在 `packages/extension/tests/query-style.test.ts` 追加：

```ts
  it("groups 含 typography → 给 fontFamily/lineHeight/letterSpacing", () => {
    const el = document.createElement("h1");
    el.className = "g1";
    el.style.fontFamily = "ESBuild, sans-serif";
    el.style.lineHeight = "60px";
    el.style.letterSpacing = "-1.2px";
    document.body.appendChild(el);
    const r = styleProbeFunc(".g1", 10, ["typography"]) as any;
    expect(r.elements[0].typography.fontFamily).toBe("ESBuild, sans-serif");
    expect(r.elements[0].typography.lineHeight).toBe("60px");
    expect(r.elements[0].typography.letterSpacing).toBe("-1.2px");
    // 没点名的组不返回,省字节
    expect(r.elements[0].box).toBeUndefined();
    expect(r.elements[0].motion).toBeUndefined();
  });

  it("groups 含 box → 给 borderRadius/padding", () => {
    const el = document.createElement("a");
    el.className = "g2";
    el.style.borderRadius = "24px";
    el.style.padding = "0px 32px";
    document.body.appendChild(el);
    const r = styleProbeFunc(".g2", 10, ["box"]) as any;
    expect(r.elements[0].box.borderRadius).toBe("24px");
    expect(r.elements[0].box.padding).toBe("0px 32px");
  });

  it("groups 含 motion → 给 transition", () => {
    const el = document.createElement("div");
    el.className = "g3";
    el.style.transition = "background-color 0.2s ease-out";
    document.body.appendChild(el);
    const r = styleProbeFunc(".g3", 10, ["motion"]) as any;
    expect(r.elements[0].motion.transition).toContain("background-color");
  });

  it("四组全开 → 四个字段都在", () => {
    const el = document.createElement("div");
    el.className = "g4";
    document.body.appendChild(el);
    const r = styleProbeFunc(".g4", 10, ["typography", "box", "paint", "motion"]) as any;
    for (const g of ["typography", "box", "paint", "motion"]) {
      expect(r.elements[0][g], `缺分组 ${g}`).toBeTypeOf("object");
    }
  });

  it("注入自包含:剥离模块作用域后仍可运行", () => {
    // executeScript 注入会丢模块作用域,引用模块级标识符在真实浏览器里必炸
    const detached = new Function("return " + styleProbeFunc.toString())();
    const el = document.createElement("div");
    el.className = "iso";
    document.body.appendChild(el);
    expect(() => detached(".iso", 1, ["typography", "box", "paint", "motion"])).not.toThrow();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-style.test.ts`
Expected: FAIL，`Cannot read properties of undefined (reading 'fontFamily')`

- [ ] **Step 3: 实现分组**

在 `styleProbeFunc` 的 `elements.push({...})` 之前插入（注意：全部内联，不得引用模块级常量）：

```ts
      const want = (g: string): boolean => groups.indexOf(g) !== -1;
      const pick = (props: string[]): Record<string, string> => {
        const o: Record<string, string> = {};
        for (const p of props) o[p] = cs.getPropertyValue(p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()));
        return o;
      };
      const typography = want("typography")
        ? pick(["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "textTransform"])
        : undefined;
      const box = want("box")
        ? pick(["display", "padding", "margin", "borderRadius", "borderWidth", "borderStyle", "borderColor", "width", "height"])
        : undefined;
      const paint = want("paint")
        ? pick(["backgroundColor", "backgroundImage", "boxShadow", "opacity", "outline", "filter"])
        : undefined;
      const motion = want("motion")
        ? pick(["transition", "transform", "animation"])
        : undefined;
```

`elements.push` 末尾追加：

```ts
        ...(typography ? { typography } : {}),
        ...(box ? { box } : {}),
        ...(paint ? { paint } : {}),
        ...(motion ? { motion } : {}),
```

- [ ] **Step 4: 接 `attr` 参数**

`packages/extension/src/handlers/query.ts:1686` 的 style 分支，在 `const maxResults = ...` 下方加：

```ts
        // attr 选组,不传给全四组;组名非法直接报错,别静默返回空对象
        const ALL_GROUPS = ["typography", "box", "paint", "motion"];
        const requested = normalizeCssAttrParam(args.attr as string | undefined);
        const groups = requested ?? ALL_GROUPS;
        const bad = groups.filter((g) => ALL_GROUPS.indexOf(g) === -1);
        if (bad.length > 0) {
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            `vortex_query mode=style: attr must be one or more of ${ALL_GROUPS.join("|")}; got ${bad.join(",")}`,
          );
        }
```

并把 `args: [pattern, maxResults]` 改为 `args: [pattern, maxResults, groups]`。

- [ ] **Step 4b: 写 handler 接线测试（必做，不是可选）**

纯函数测试证明不了接线。在 `packages/extension/tests/query-ref-target.test.ts` 追加：

```ts
  it("attr 选组真的传到了页面侧探针的第三个实参", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "style", pattern: "h1", attr: "typography" },
      requestId: "r4",
      tabId: 42,
    } as never);
    expect(executeScript.mock.calls[0][0].args[2]).toEqual(["typography"]);
  });

  it("不传 attr → 四组全开", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "style", pattern: "h1" },
      requestId: "r5",
      tabId: 42,
    } as never);
    expect(executeScript.mock.calls[0][0].args[2]).toEqual(["typography", "box", "paint", "motion"]);
  });

  it("非法组名 → 报错而不是静默返回空分组", async () => {
    const resp = await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "style", pattern: "h1", attr: "colours" },
      requestId: "r6",
      tabId: 42,
    } as never);
    expect(String(resp.error?.message)).toMatch(/attr must be one or more of/);
  });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-style.test.ts packages/extension/tests/query-handler.test.ts`
Expected: PASS（13 个用例 + query-handler 无回归）

- [ ] **Step 6: 变异验证**

`cp packages/extension/src/handlers/query.ts /tmp/q.bak`。依次做三个变异，每次跑 Step 5 命令确认转红，之后 `cp /tmp/q.bak` 还原：
1. 把 `pick` 里的驼峰转短横线 `.replace(...)` 删掉（`getPropertyValue("fontFamily")` 在真浏览器返回空串）→ 分组用例应转红
2. 把 `args: [pattern, maxResults, groups]` 改回两参 → **Step 4b 的接线用例**应转红
3. 把 `const groups = requested ?? ALL_GROUPS;` 改成 `const groups = ALL_GROUPS;`（忽略 `attr`）→ Step 4b 的接线用例应转红

第 2、3 条是这轮的重点：纯函数测试对这两个变异全绿，正是本仓库上一轮反复栽的「公式对、调用点错」。

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-style.test.ts
git commit -m "feat: 样式探针按 typography/box/paint/motion 四组扩充属性面"
```

---

### Task 4: 新增 `mode=tokens` 设计变量面

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（新增 `tokensProbeFunc` + mode 白名单 + `tokens` 分支）
- Create: `packages/extension/tests/query-tokens.test.ts`

**背景（实测）：** gamma.app 的 `:root` 上有 **675** 个 `--chakra-*` 自定义属性（`--chakra-colors-deepspace-900=#00387a`、`--chakra-fontSizes-3xl=1.875rem`、`--chakra-transition-easing-ease-out=cubic-bezier(0,0,0.2,1)`），这是站点完整的设计系统，vortex 零暴露。

**分类原则：** **优先看值，其次才看名字**。框架命名各不相同（`--chakra-colors-*` / `--color-*` / `--brand-primary`），值的形态是跨框架稳定的。只有值本身看不出类型时（`var()` 别名、裸数字）才回落到名字启发式。

**Interfaces:**
- Produces: `tokensProbeFunc(pattern: string, maxPerGroup: number)`，返回
  `{ roots: string[]; total: number; showing: number; groups: Record<string, Array<{ name: string; value: string; alias?: string }>> }`
  或 `{ error: string }`。分组键取值范围：`color` / `gradient` / `fontFamily` / `fontSize` / `spacing` / `radius` / `shadow` / `motion` / `other`。

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/query-tokens.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { tokensProbeFunc } from "../src/handlers/query.js";

// jsdom 的 getComputedStyle 不枚举自定义属性,按真实 Chrome 的行为造替身:
// 可迭代出属性名 + getPropertyValue 取值。
function stubComputedStyle(entries: Array<[string, string]>) {
  const names = entries.map(([n]) => n);
  const map = new Map(entries);
  const fake = {
    length: names.length,
    getPropertyValue: (p: string) => map.get(p) ?? "",
    [Symbol.iterator]: function* () { yield* names; },
  };
  vi.spyOn(window, "getComputedStyle").mockReturnValue(fake as never);
}

afterEach(() => vi.restoreAllMocks());

describe("tokensProbeFunc", () => {
  it("按值形态分类:十六进制/rgb/oklch → color", () => {
    stubComputedStyle([
      ["--chakra-colors-deepspace-900", "#00387a"],
      ["--brand", "rgb(5, 64, 173)"],
      ["--accent", "oklch(0.7 0.1 200)"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.color.map((t: any) => t.name).sort()).toEqual(
      ["--accent", "--brand", "--chakra-colors-deepspace-900"],
    );
    expect(r.groups.color.find((t: any) => t.name === "--chakra-colors-deepspace-900").value)
      .toBe("#00387a");
  });

  it("长度值按名字细分:fontSize / radius / spacing", () => {
    stubComputedStyle([
      ["--chakra-fontSizes-3xl", "1.875rem"],
      ["--radius-lg", "24px"],
      ["--space-4", "1rem"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.fontSize[0].name).toBe("--chakra-fontSizes-3xl");
    expect(r.groups.radius[0].name).toBe("--radius-lg");
    expect(r.groups.spacing[0].name).toBe("--space-4");
  });

  it("cubic-bezier / 时长 → motion", () => {
    stubComputedStyle([
      ["--chakra-transition-easing-ease-out", "cubic-bezier(0, 0, 0.2, 1)"],
      ["--dur-fast", "200ms"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.motion.map((t: any) => t.name).sort())
      .toEqual(["--chakra-transition-easing-ease-out", "--dur-fast"]);
  });

  it("分类边界:阴影/渐变/纯色/别名各归各位", () => {
    stubComputedStyle([
      ["--shadow-sm", "0 1px 2px rgba(0, 0, 0, 0.1)"],
      ["--shadow-hex", "0 1px 2px #000000"],
      ["--gradient-hero", "linear-gradient(90deg, #000000, #ffffff)"],
      ["--shadow-color", "rgba(0, 0, 0, 0.1)"],
      ["--shadow-alias", "var(--shadow-sm)"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    const at = (n: string) =>
      Object.entries(r.groups).find(([, v]: any) => v.some((t: any) => t.name === n))?.[0];
    expect(at("--shadow-sm")).toBe("shadow");
    expect(at("--shadow-hex")).toBe("shadow");
    expect(at("--gradient-hero")).toBe("gradient");
    // 只有颜色没有长度 = 它就是个颜色 token,按值判为 color 是刻意决定不是意外
    expect(at("--shadow-color")).toBe("color");
    // var() 别名值看不出类型,按名字回落
    expect(at("--shadow-alias")).toBe("shadow");
  });

  it("字体栈 → fontFamily", () => {
    stubComputedStyle([["--font-body", "PPMori, sans-serif"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.fontFamily[0].value).toBe("PPMori, sans-serif");
  });

  it("var() 别名:记录 alias 并按名字归类", () => {
    stubComputedStyle([["--btn-bg-color", "var(--brand-500)"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.color[0].alias).toBe("--brand-500");
  });

  it("pattern 按名字子串过滤(大小写不敏感)", () => {
    stubComputedStyle([
      ["--chakra-colors-a", "#111111"],
      ["--other-color", "#222222"],
    ]);
    const r = tokensProbeFunc("CHAKRA", 50) as any;
    expect(r.total).toBe(1);
    expect(r.groups.color[0].name).toBe("--chakra-colors-a");
  });

  it("maxPerGroup 逐组截断,total 仍是过滤后全量", () => {
    stubComputedStyle([
      ["--c1", "#111111"], ["--c2", "#222222"], ["--c3", "#333333"],
    ]);
    const r = tokensProbeFunc("*", 2) as any;
    expect(r.total).toBe(3);
    expect(r.showing).toBe(2);
    expect(r.groups.color.length).toBe(2);
  });

  it("roots 如实报告扫了哪些根（召回边界要说出来,不能装作全站）", () => {
    stubComputedStyle([["--c1", "#111111"]]);
    const r = tokensProbeFunc("*", 50) as any;
    // 只扫 :root 与 body;挂在中间主题容器上的变量不在覆盖面内,由 roots 告诉调用方
    expect(r.roots).toEqual([":root", "body"]);
  });

  it("一个 token 都没有 → total=0 且 groups 为空对象", () => {
    stubComputedStyle([]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.total).toBe(0);
    expect(r.groups).toEqual({});
  });

  it("注入自包含:剥离模块作用域后仍可运行", () => {
    stubComputedStyle([["--c1", "#111111"]]);
    const detached = new Function("return " + tokensProbeFunc.toString())();
    expect(() => detached("*", 10)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-tokens.test.ts`
Expected: FAIL，`tokensProbeFunc is not a function`

- [ ] **Step 3: 实现探针**

在 `packages/extension/src/handlers/query.ts` 的 `styleProbeFunc` 之后加（全部内联，不引用任何模块级标识符）：

```ts
/**
 * page-side 设计 token 探测函数体。mode=tokens 注入 MAIN world。
 * 回答「这个站的设计系统长什么样」——调色板、字阶、间距阶、圆角、阴影、动效。
 * 分类优先看值形态（跨框架稳定），值看不出类型时才回落到名字启发式。
 * 参数 args: [pattern, maxPerGroup]；pattern="*" 取全量，否则按名字子串过滤（不区分大小写）。
 * pattern 在 schema 层对所有 mode 都是必填，tokens 取全量的写法就是 "*"（与 mode=schema 同约定）。
 * ⚠ 自包含:注入丢模块作用域,一切辅助函数必须内联。
 */
export const tokensProbeFunc = (
  pattern: string,
  maxPerGroup: number,
):
  | {
      roots: string[];
      total: number;
      showing: number;
      groups: Record<string, Array<{ name: string; value: string; alias?: string }>>;
    }
  | { error: string } => {
  try {
    const byName = (n: string): string => {
      if (/font-?famil|typeface/.test(n)) return "fontFamily";
      if (/font-?size|text-?size|leading|line-?height/.test(n)) return "fontSize";
      if (/radius|rounded/.test(n)) return "radius";
      if (/shadow/.test(n)) return "shadow";
      if (/duration|delay|easing|transition|animation/.test(n)) return "motion";
      if (/colou?r|(^|-)bg(-|$)|background|(^|-)fg(-|$)|foreground/.test(n)) return "color";
      if (/space|spacing|gap|size|inset|margin|padding/.test(n)) return "spacing";
      return "other";
    };
    const classify = (name: string, value: string): string => {
      const n = name.toLowerCase();
      const v = value.trim();
      if (/^var\(/.test(v)) return byName(n);
      if (/gradient\(/i.test(v)) return "gradient";
      if (/^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i.test(v)) return "color";
      if (/cubic-bezier\(|steps\(|^-?\d+(\.\d+)?m?s$/i.test(v)) return "motion";
      if (/\d(px|rem|em)\b[\s\S]*(rgba?\(|#[0-9a-f]{3,8})/i.test(v)) return "shadow";
      if (/^-?\d+(\.\d+)?(px|rem|em|%|vh|vw)$/.test(v)) {
        const g = byName(n);
        return g === "color" || g === "other" ? "spacing" : g;
      }
      if (/,/.test(v) && /(sans-serif|serif|monospace|system-ui|cursive|fantasy)/i.test(v)) {
        return "fontFamily";
      }
      return byName(n);
    };

    const roots: string[] = [];
    const seen = new Map<string, string>();
    const hosts: Array<[string, Element | null]> = [
      [":root", document.documentElement],
      ["body", document.body],
    ];
    for (const [label, host] of hosts) {
      if (!host) continue;
      const cs = getComputedStyle(host as Element);
      let hit = false;
      for (const prop of Array.from(cs as unknown as Iterable<string>)) {
        if (typeof prop !== "string" || prop.slice(0, 2) !== "--") continue;
        hit = true;
        // body 上的主题覆盖优先于 :root,后写胜出
        seen.set(prop, cs.getPropertyValue(prop).trim());
      }
      if (hit) roots.push(label);
    }

    const all = pattern === "*"
      ? Array.from(seen)
      : Array.from(seen).filter(([n]) => n.toLowerCase().indexOf(pattern.toLowerCase()) !== -1);

    const groups: Record<string, Array<{ name: string; value: string; alias?: string }>> = {};
    let showing = 0;
    for (const [name, value] of all.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const g = classify(name, value);
      if (!groups[g]) groups[g] = [];
      if (groups[g].length >= maxPerGroup) continue;
      const m = value.trim().match(/^var\(\s*(--[^,)\s]+)/);
      groups[g].push(m ? { name, value, alias: m[1] } : { name, value });
      showing++;
    }
    return { roots, total: all.length, showing, groups };
  } catch (e) {
    return { error: "tokens probe error: " + (e instanceof Error ? e.message : String(e)) };
  }
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-tokens.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 接进 handler**

在 `packages/extension/src/handlers/query.ts` 的 mode 白名单校验（`:1474` 起）里加 `mode !== "tokens"`，并把错误消息补上 `'tokens'`。

在 `:1686` 的 `} else if (mode === "style") {` **之前**插入分支：

```ts
      } else if (mode === "tokens") {
        // tokens 模式:抽站点 CSS 自定义属性,给调色板/字阶/间距阶。
        const maxPerGroup = Math.min((args.maxResults as number | undefined) ?? 40, 200);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: tokensProbeFunc,
          args: [pattern, maxPerGroup],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { roots: string[]; total: number; showing: number; groups: Record<string, unknown[]> }
          | { error: string }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage tokens: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage tokens error: ${res.error}`);
        }
        return withDiagnosis(
          res,
          res.total === 0
            ? "no CSS custom properties matched on :root/body; the site may compile design tokens away at build time (SCSS/Less variables leave no runtime trace) — use mode=style on a representative element instead"
            : null,
        );
```

- [ ] **Step 6: 加 handler 级测试**

在 `packages/extension/tests/query-ref-target.test.ts` 追加：

```ts
  it("mode=tokens 注入的是 tokensProbeFunc,实参是 [pattern, maxPerGroup]", async () => {
    const { tokensProbeFunc } = await import("../src/handlers/query.js");
    executeScript.mockResolvedValue([{ result: { roots: [":root"], total: 0, showing: 0, groups: {} } }]);
    await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "tokens", pattern: "colors", maxResults: 12 },
      requestId: "r7",
      tabId: 42,
    } as never);
    const call = executeScript.mock.calls[0][0];
    // 注错探针 / 把 maxResults 当别的用 / pattern 传丢,这三种都在这里转红
    expect(call.func).toBe(tokensProbeFunc);
    expect(call.args).toEqual(["colors", 12]);
  });

  it("mode=tokens 不传 maxResults → 每组默认 40", async () => {
    executeScript.mockResolvedValue([{ result: { roots: [":root"], total: 0, showing: 0, groups: {} } }]);
    await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "tokens", pattern: "*" },
      requestId: "r8",
      tabId: 42,
    } as never);
    expect(executeScript.mock.calls[0][0].args[1]).toBe(40);
  });

  it("mode=tokens 零命中 → 带自陈说明为什么空", async () => {
    executeScript.mockResolvedValue([{ result: { roots: [], total: 0, showing: 0, groups: {} } }]);
    const resp = await router.dispatch({
      type: "tool_request",
      tool: "query.queryPage",
      args: { mode: "tokens", pattern: "*" },
      requestId: "r3",
      tabId: 42,
    } as never);
    expect(resp.error).toBeUndefined();
    expect(JSON.stringify(resp.result)).toMatch(/compile design tokens away at build time/);
  });
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/extension/tests/query-tokens.test.ts packages/extension/tests/query-ref-target.test.ts`
Expected: PASS

- [ ] **Step 8: 变异验证**

`cp packages/extension/src/handlers/query.ts /tmp/q.bak`。变异 1：把 `classify` 里的 `if (/^(#|rgba?\(...)/i.test(v)) return "color";` 删掉 → 颜色用例应转红。变异 2：把 `if (groups[g].length >= maxPerGroup) continue;` 删掉 → 截断用例应转红。变异 3：把零命中自陈的三元改成恒 `null` → Step 6 的零命中用例应转红。变异 4：把 `func: tokensProbeFunc` 改成 `func: styleProbeFunc` → Step 6 的注入接线用例应转红。变异 5：把 `args: [pattern, maxPerGroup]` 改成 `args: [pattern]` → 同一条用例应转红。每次跑 Step 7 命令，之后 `cp /tmp/q.bak` 还原。

- [ ] **Step 9: Commit**

```bash
git add packages/extension/src/handlers/query.ts \
        packages/extension/tests/query-tokens.test.ts \
        packages/extension/tests/query-ref-target.test.ts
git commit -m "feat: vortex_query 新增 mode=tokens 抽站点设计变量面"
```

---

### Task 5: 公开 schema 与字节预算

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:477-495`
- Modify: `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts:159`（payload cap）、`:235`（description cap）

**背景（实测）：** `vortex_query` description 当前 222 char / 上限 230；`tools/list` payload 当前 11037 B / 上限 11100。两处余量都不够放新 mode，必须按仓库既有惯例「加能力调 cap 不压字符」上调并写明理由。

**Interfaces:**
- Consumes: Task 3 的 `attr` 分组语义、Task 4 的 `tokens` mode 与 `pattern="*"` 约定、Task 1 的 `@ref` 支持。

- [ ] **Step 1: 改 schema**

`packages/mcp/src/tools/schemas-public.ts`：

`description` 末尾追加 `; tokens=CSS 变量→调色板/字阶(pattern=* 取全量,只扫 :root/body)`：

```ts
    description: "Zero-LLM probe: text=grep; css=find elems; component=Vue/React state; geometry=bbox/clip/occlude; style=color/bg+WCAG+排版/盒/绘制/动效(attr 选组); sheet=Lake Sheet→md/csv/json; flow=流程图→mermaid; chart=echarts→数据(series/axis/legend,attr=summary|json); tokens=CSS 变量→调色板/字阶(pattern=*,只扫 :root/body).",
```

`mode` 枚举加 `tokens`：

```ts
          enum: ["text", "css", "component", "geometry", "style", "sheet", "flow", "chart", "schema", "tokens"],
```

`mode` 的 description 末尾追加：

```ts
            "; style/geometry/css/component 的 pattern 也接受 vortex_observe 的 @ref"
```

`attr` 的 description 改为：

```ts
        attr: { type: "string", description: "css: 属性名, 多个用 , 或 | 分隔(如 'class|title'); style: 分组 typography|box|paint|motion(默认全开); chart/sheet/flow: 输出格式" },
```

- [ ] **Step 2: 量新字节数**

```bash
cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/mcp build && node -e '
import("./packages/mcp/dist/src/tools/schemas-public.js").then(m=>{
  const defs=m.getPublicToolDefs();
  const payload=JSON.stringify(defs.map(d=>({name:d.name,description:d.description,inputSchema:d.schema})));
  const q=defs.find(d=>d.name==="vortex_query");
  console.log("payload bytes:",payload.length," query description chars:",q.description.length);
});'
```

记下这两个数，下一步据实填 cap。

- [ ] **Step 3: 上调两处 cap**

`packages/mcp/tests/invariants/I15.tools-list-budget.test.ts:159` 上方追加注释并改数字（把 `<实测值>` 换成 Step 2 量到的数，cap 取实测值向上取整到百位再 +100）：

```ts
    // mode=tokens + @ref: 11100 → <新cap>。vortex_query mode 枚举新增 tokens(站点 CSS
    // 变量→调色板/字阶),description 同步追加,attr 补 style 分组说明,mode 说明补 @ref。
    // payload 实测 <实测值>B。沿用"加能力调 cap 不压字符"惯例。
    expect(toolsListPayload.length).toBeLessThanOrEqual(<新cap>);
```

`:235` 的 description cap 同样处理：

```ts
    // 230 → <新cap>: 仍只有 vortex_query 超(<实测值>),是新增 tokens mode 一段真能力说明
    // 累加的结果。整体放宽会给别的工具留出白涨空间,所以拆成两条:query 单独放宽,
    // 其余仍锁在放宽前的最大值 174(vortex_act)。
    const q = defs.find((d) => d.name === "vortex_query")!;
    expect(q.description.length).toBeLessThanOrEqual(<新cap>);
    for (const d of defs.filter((d) => d.name !== "vortex_query")) {
      expect(d.description.length).toBeLessThanOrEqual(174);
    }
```

- [ ] **Step 4: 跑不变量测试**

Run: `cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1 packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`
Expected: PASS

- [ ] **Step 5: 变异验证**

三个变异，每个都要确认**转红**（证明 cap 在管事而不是摆设），之后改回：
1. payload cap 改回 11100
2. `vortex_query` 的 cap 改回 230
3. 把 `vortex_act` 的 description 手工加长 20 字符 → 应被 174 那条锁住转红（证明放宽 query 没有给别人开口子）

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/schemas-public.ts packages/mcp/tests/invariants/I15.tools-list-budget.test.ts
git commit -m "feat: 公开 query mode=tokens 与 style 分组参数,上调 tools/list 预算"
```

---

### Task 6: 真站验收与文档回填

**Files:**
- Modify: `docs/style-investigation-approach.md`（§7 待验证假设 → 实测结论）

**前置：** 需要真实浏览器。用 vortex 自己验（binding 当前是 Microsoft Edge；操作前先 `vortex_browser()` 确认，用完不要切走）。扩展改动要生效必须完整构建并重载扩展。

- [ ] **Step 1: 全仓构建 + 全量测试**

```bash
cd /Users/lg/workspace/vortex && pnpm build
```
Expected: exit 0。（`vite build:main` 会清 `dist/page-side`，必须走完整 `pnpm build`，不能只构建单包。）

```bash
cd /Users/lg/workspace/vortex && pnpm vitest run --maxWorkers=2 --minWorkers=1
```
Expected: 全绿。基线（合并 `259a7ed` 后实测）：shared 337 / cli 31 / hub 248 / mcp 735 / extension 2274。新增用例数应等于本计划新增的断言数，不得有既有用例转红。

- [ ] **Step 2: 重载扩展**

用 `vortex_dev_reload`（需 `--caps=dev`）触发 `chrome.runtime.reload` 并轮询 buildStamp，确认跑的是新 dist 而不是旧构建。

- [ ] **Step 3: 真站验收——@ref 打通（判据 1）**

在 gamma.app 上：`vortex_observe` 取到主 CTA「Start for free」的 `@ref`，直接 `vortex_query({mode:"style", pattern:"<那个 @ref>"})`。
Expected: 不报 `Invalid CSS selector`，返回该元素的样式；全程没有手写 CSS 选择器。

- [ ] **Step 4: 真站验收——属性面（判据 2）**

`vortex_query({mode:"style", pattern:"h1"})`。
Expected: `typography.fontFamily` 为 `ESBuild, sans-serif`、`typography.letterSpacing` 为 `-1.2px`、`typography.lineHeight` 为 `60px`。
对主 CTA：`box.borderRadius` 为 `24px`、`box.padding` 为 `0px 32px`、`typography.fontFamily` 含 `PPMori`、`paint.backgroundColor` 为 `rgb(5, 64, 173)`。

- [ ] **Step 5: 真站验收——不说假话（判据 3）**

同一条 `mode=style pattern=h1` 的返回里：
Expected: `background` 为 `rgb(255, 255, 255)`（上溯到第 10 层的 body，中间 9 层实测均为 `rgba(0,0,0,0)` 且无 background-image）、`bgFromAncestor` 为 `true`、`contrastStatus` 为 `"ok"`、`wcagAAA` 为 `true`。**不得**出现 `wcagAA: false`。

- [ ] **Step 6: 真站验收——tokens（路线 D）**

`vortex_query({mode:"tokens", pattern:"*"})`。
Expected: `roots` 为 `[":root","body"]`（如实报告覆盖面）；`groups.color` 里能找到 `--chakra-colors-deepspace-900` = `#00387a`；`groups.fontSize` 里有 `--chakra-fontSizes-3xl` = `1.875rem`；`groups.motion` 里有 `--chakra-transition-easing-ease-out`。
`total` 记录实测值（本轮勘察为 675）作为参考，**不作为正确性门槛**——那是 gamma.app 一个站的结构，换站就不成立。
再验过滤：`pattern:"colors"` 的 `total` 应显著小于全量且各项名字都含 `colors`。

- [ ] **Step 6b: 真站验收——祖先上溯的实际代价**

背景上溯改成无上限后，最坏成本是 O(元素数 × DOM 深度)。在 gamma.app 上跑
`vortex_query({mode:"style", pattern:"div", maxResults:50})` 并记录墙钟耗时。
Expected: 记下真实数字。若 > 1000ms，把深度上限/祖先样式缓存作为独立一条改动提出来，
**不要**在本轮临时塞一个新魔数——那正是本次要修掉的③。若 ≤ 1000ms，把实测值写进
§7 并明确「不设上限是经实测的决定，不是没想过」。

- [ ] **Step 7: 真站验收——evaluate 归零（判据 4）**

复盘 Step 3-6：整个流程未调用 `vortex_evaluate`。若任何一步不得不回落到 evaluate，把缺口写进 §7 而不是悄悄绕过。

- [ ] **Step 8: 回填文档**

`docs/style-investigation-approach.md` 的 §7：把三条【推】按实测结果改成【已实证】或【已证伪】并附具体数字；把 Step 7 发现的任何缺口作为新的【待验证】条目写进去。

- [ ] **Step 9: Commit**

```bash
git add docs/style-investigation-approach.md
git commit -m "docs: 回填样式调研能力的真站实测结论"
```

---

## Self-Review

**1. Spec 覆盖**（对照 `docs/style-investigation-approach.md` §0.5 的五条失效机制与 §1 的四条判据）

| 失效机制 | 任务 | 判据 |
|---------|------|------|
| ① 寻址断链（query 不接 @ref） | Task 1 | 判据 1 → Task 6 Step 3 |
| ② 属性面对错了问题 | Task 3 | 判据 2 → Task 6 Step 4 |
| ③ 背景上溯 8 层不够 + 不看 background-image | Task 2 | 判据 3 → Task 6 Step 5 |
| ④ null 当 false 断言 | Task 2 | 判据 3 → Task 6 Step 5 |
| ⑤ 设计 token 整层缺席 | Task 4 | 路线 D → Task 6 Step 6 |
| 公开面（schema/预算） | Task 5 | — |
| 判据 4（evaluate 归零） | — | Task 6 Step 7 |

无缺口。放弃的 B / C 两条路线不在本计划范围内，符合 §4 的选定。

**2. 占位符扫描**：Task 5 Step 3 里的 `<实测值>` / `<新cap>` 是**必须现场测量**的数字，Step 2 给了测量命令；这不是 TBD，是「量了再填」的显式指令。其余各步均含可直接执行的代码或命令。

**3. 外部评审（Luna / GPT-5.6，2026-08-19）**：报告见 `reports/_review/luna-plan-review-20260819.md`，16 条发现已逐条裁决。

采纳并已改：背景上溯遇到祖先背景图仍继续上溯导致 `background` 与 `contrastStatus` 自相矛盾（真设计缺陷，Task 2 改为「第一层产生绘制的祖先即背景层，取完即停」并补两条层叠用例）；Task 3 的 `attr→groups→args[2]` 接线测试由条件性改为必做 Step 4b；Task 4 补 `func`/`args` 接线断言与 gradient 分类分支、分类边界用例、`roots` 覆盖面用例；`liftQueryRefToTarget` 增加「已有 target 不抢」守卫；Task 1 补跨 frame 快照打对 frame 的断言；Task 5 description cap 拆成 query 单放宽、其余锁 174；Task 6 增加祖先上溯耗时实测并把 `total ≥ 600` 从门槛降为参考值。

不采纳并说明理由：`new Function` 自包含测试被指「证明不了真实 MAIN world」——它证明不了 Chrome API 差异，但它精确捕捉的是模块作用域引用，也就是本仓库真实栽过的失效模式；且自定义属性能否枚举已在 gamma.app 实测确认（`Array.from(getComputedStyle(root))` 返回 675 条），不是假设，真站验收本就在 Task 6。jsdom 第 10 层用例被指「不能证明 Chrome 行为」——它的职责是锁「循环无上限」这个边界，Chrome 行为归 Task 6 Step 5，分工本就如此。

**4. 类型一致性**：`styleProbeFunc(selector, maxResults, groups)` 的三参签名在 Task 2 定下、Task 3 使用，测试调用一致（Task 2 用 `[]`，Task 3 用具体组名）。`contrastStatus` 的三个字面量在 Task 2 的类型声明、实现、测试三处一致。`tokensProbeFunc(pattern, maxPerGroup)` 在 Task 4 定义与 handler 调用一致。分组键在 Task 4 的实现（`byName`/`classify` 的返回）与测试断言一致：`color` / `gradient` / `fontFamily` / `fontSize` / `spacing` / `radius` / `shadow` / `motion` / `other`（`gradient` 只由 `classify` 的值分支产出，`byName` 不返回它——名字里带 gradient 的 `var()` 别名会落到 `other`，这是刻意的：别名的真实类型只有解析后才知道）。
