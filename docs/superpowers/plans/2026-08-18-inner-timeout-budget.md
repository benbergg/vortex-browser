# 内层预算统一（路线 A） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 extension 的每个 action 默认带 SW 侧内层 deadline，使超时由「说得清原因的那一层」先应答，消灭 hub 兜底超时。

**Architecture:** 在 `shared` 建立 per-action 预算表作单一真源；MCP 侧按 `max(预算, 调用方 timeout) + STEP` 正向推导 hub deadline；extension 的 `ActionRouter.dispatch` 用该预算对 handler 施加 SW 侧 deadline，超时前做一次有界探活，把结果分类成「页面主线程无响应 / CDP 未应答 / 扩展侧超时」。

**Tech Stack:** TypeScript / pnpm workspace / vitest / Chrome MV3 (Service Worker) / CDP

**Spec:** `docs/inner-timeout-budget-approach.md`

## Global Constraints

- 跑测试必须限并发：`pnpm --filter <pkg> exec vitest run --maxWorkers=2 --minWorkers=1`。禁止裸 `pnpm -r test`。
- 注释语言中文；方法体内单行 `//`、每条 ≤1 行 ≤60 字、同一方法体 ≤3 条；禁止署名与变更历史。
- 超时阶梯的常量与预算表只允许存在于 `packages/shared/src/timeout.ts`，hub/mcp/extension 一律 import，禁止各自复制字面量。
- `MAX_INNER_TIMEOUT_MS = 60_000` 是内层预算硬上限，`TIMEOUT_LADDER_STEP_MS = 5_000` 是层间 margin，二者不得在本次改动中修改。
- 零回归判据：任一 action 的缺省预算不得低于其 30 天「未传 timeout 的成功调用」max（数据见 spec 第 8 节）。
- 涉及 `chrome.scripting.executeScript` / CDP 的行为断言，mock 只能锁纯函数与分类逻辑；「改后代码路径真实环境是否走到」必须由 live 验证（Task 9），不得以 mock 绿灯替代。

---

### Task 0: 收尾并合并 ancestor-hit-gate 分支

当前分支 `feat/ancestor-hit-gate` 已含 11 个 commit / 25 文件的完整改动（OBSCURED 祖先命中修复），当日日志实证其代价：`act` 报被 `<div.el-dialog__wrapper>` 覆盖 → 模型照 hint 去点 `.el-dialog__headerbtn` 关浮层（返回 `none`）→ 再 act 仍 OBSCURED → 查 wrapper zIndex → 弃 act 改用 evaluate 手工 click，共 4 次调用约 10 秒。本任务把它送上线，后续任务从干净的 main 开新分支。

**Files:**
- Modify: 无（仅评审与合并）
- 附带：本次新增的 `docs/inner-timeout-budget-approach.md`、`docs/superpowers/plans/2026-08-18-inner-timeout-budget.md`、`reports/_eval/baseline/2026-08-18-today-1d.*` 需与 ancestor-hit-gate 的改动分开提交

**Interfaces:**
- Consumes: 无
- Produces: main 上已含 `classifyHit` 与祖先命中话术；Task 1 起从 main 新建分支 `feat/inner-timeout-budget`

- [ ] **Step 1: 把本轮诊断产物单独提交，不混进 ancestor-hit-gate 的改动**

```bash
git add docs/inner-timeout-budget-approach.md \
        docs/superpowers/plans/2026-08-18-inner-timeout-budget.md \
        reports/_eval/baseline/2026-08-18-today-1d.json \
        reports/_eval/baseline/2026-08-18-today-1d.md
git commit -m "docs: 内层预算缺席的诊断、实现思路与实施计划"
```

- [ ] **Step 2: 跑 ancestor-hit-gate 触及的两个包的测试**

Run:
```bash
pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @vortex-browser/shared exec vitest run --maxWorkers=2 --minWorkers=1
```
Expected: 全部 PASS。若有失败，先修到全绿再继续，不得带红合并。

- [ ] **Step 3: 请求代码评审**

使用 `superpowers:requesting-code-review` 对 `git diff main...HEAD` 做评审，处理 CRITICAL 与 HIGH。

- [ ] **Step 4: 合并到 main**

使用 `superpowers:finishing-a-development-branch` 决定合并方式并执行。

- [ ] **Step 5: 从 main 开新分支**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/inner-timeout-budget
```

---

### Task 1: shared 建立 per-action 预算表

**Files:**
- Modify: `packages/shared/src/timeout.ts`
- Test: `packages/shared/tests/timeout-ladder.test.ts`

**Interfaces:**
- Consumes: 已有 `TIMEOUT_LADDER_STEP_MS`、`MAX_INNER_TIMEOUT_MS`、`timeoutLadder`
- Produces:
  - `export const DEFAULT_ACTION_BUDGET_MS = 30_000`
  - `export const ACTION_BUDGET_MS: Readonly<Record<string, number>>`
  - `export function actionBudgetMs(action: string): number`
  - `export function innerDeadlineFor(action: string, callerTimeoutMs: number | undefined): number`
  - `export function hubDeadlineFor(action: string, callerTimeoutMs: number | undefined): number`

- [ ] **Step 1: 写失败测试**

追加到 `packages/shared/tests/timeout-ladder.test.ts`：

```typescript
import {
  ACTION_BUDGET_MS,
  DEFAULT_ACTION_BUDGET_MS,
  actionBudgetMs,
  innerDeadlineFor,
  hubDeadlineFor,
  MAX_INNER_TIMEOUT_MS,
  TIMEOUT_LADDER_STEP_MS,
} from "../src/timeout.js";

describe("per-action 内层预算表", () => {
  it("未登记的 action 落到缺省预算", () => {
    expect(actionBudgetMs("some.unregistered")).toBe(DEFAULT_ACTION_BUDGET_MS);
  });

  it("登记的 action 用自己的预算", () => {
    expect(actionBudgetMs("page.navigate")).toBe(60_000);
    expect(actionBudgetMs("content.getText")).toBe(20_000);
  });

  // 零回归锁：预算不得低于 30 天「未传 timeout 的成功调用」max（spec 第 8 节）
  it("🔴 REGRESSION: 每个登记预算都覆盖其实测成功耗时上限", () => {
    const observedMaxMs: Record<string, number> = {
      "page.navigate": 69_861,
      "observe.snapshot": 27_999,
      "dom.click": 26_114,
      "mouse.click": 22_145,
      "capture.screenshot": 20_870,
      "content.getText": 10_689,
      "page.waitForExpression": 10_046,
    };
    for (const [action, observed] of Object.entries(observedMaxMs)) {
      const budget = actionBudgetMs(action);
      // navigate 的 69861 单点超过内层硬上限，按上限封顶（P99 为 27028，覆盖充分）
      const expectedFloor = Math.min(observed, MAX_INNER_TIMEOUT_MS);
      expect(budget, `${action} 预算 ${budget} 低于实测上限 ${expectedFloor}`)
        .toBeGreaterThanOrEqual(expectedFloor);
    }
  });

  it("任何预算都不超过内层硬上限", () => {
    for (const [action, ms] of Object.entries(ACTION_BUDGET_MS)) {
      expect(ms, `${action} 超出 MAX_INNER_TIMEOUT_MS`).toBeLessThanOrEqual(MAX_INNER_TIMEOUT_MS);
    }
  });

  it("调用方的小 timeout 不压低任何一层", () => {
    // act 传 5000 不得把 hub 挤到 10s——act 成功 P99 是 25.5s
    expect(innerDeadlineFor("dom.click", 5_000)).toBe(actionBudgetMs("dom.click"));
    expect(hubDeadlineFor("dom.click", 5_000)).toBe(
      actionBudgetMs("dom.click") + TIMEOUT_LADDER_STEP_MS,
    );
  });

  it("🔴 REGRESSION: 自管超时的 handler 传大 timeout 时 inner 随之上移", () => {
    // js.evaluate 自己用 args.timeout 作脚本预算，30 天内成功样本 max 42545ms。
    // inner 若停在缺省 30s，会砍掉 evaluate(timeout:45000) 这类合法调用。
    expect(innerDeadlineFor("js.evaluate", 45_000)).toBe(45_000 + TIMEOUT_LADDER_STEP_MS);
    expect(hubDeadlineFor("js.evaluate", 45_000)).toBeGreaterThan(
      innerDeadlineFor("js.evaluate", 45_000),
    );
  });

  it("调用方未指定时 inner = 该 action 预算，hub 再加一档", () => {
    expect(innerDeadlineFor("mouse.click", undefined)).toBe(actionBudgetMs("mouse.click"));
    expect(hubDeadlineFor("mouse.click", undefined)).toBe(
      actionBudgetMs("mouse.click") + TIMEOUT_LADDER_STEP_MS,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vortex-browser/shared exec vitest run --maxWorkers=2 --minWorkers=1 timeout-ladder`
Expected: FAIL — `ACTION_BUDGET_MS`/`actionBudgetMs`/`hubDeadlineFor` 未导出。

- [ ] **Step 3: 实现**

追加到 `packages/shared/src/timeout.ts` 末尾：

```typescript
/** 未登记 action 的缺省内层预算 */
export const DEFAULT_ACTION_BUDGET_MS = 30_000;

// 取值来自 30 天真实调用中「未传 timeout 的成功调用」耗时上限，向上留 margin。
// 低于实测上限会砍掉本来能成功的尾部调用，见 docs/inner-timeout-budget-approach.md 第 8 节。
export const ACTION_BUDGET_MS: Readonly<Record<string, number>> = Object.freeze({
  "page.navigate": 60_000,
  "observe.snapshot": 35_000,
  "dom.click": 35_000,
  "dom.type": 35_000,
  "dom.hover": 35_000,
  "mouse.click": 30_000,
  "mouse.doubleClick": 30_000,
  "mouse.drag": 30_000,
  "capture.screenshot": 30_000,
  "content.getText": 20_000,
  "content.getHtml": 20_000,
  "page.waitForExpression": 20_000,
});

export function actionBudgetMs(action: string): number {
  return ACTION_BUDGET_MS[action] ?? DEFAULT_ACTION_BUDGET_MS;
}

/**
 * router 施加的内层 deadline。
 * 取 max 而非直接用调用方值——act 的 timeout 是 gate 自旋预算（默认 2000ms），
 * 拿它当整体 deadline 会把 scrollIntoView 与 CDP 三连击一起砍掉；
 * 而 js.evaluate 拿它当脚本预算，传 45s 时内层必须跟着上移，否则砍掉合法调用。
 */
export function innerDeadlineFor(action: string, callerTimeoutMs: number | undefined): number {
  const caller = Number.isFinite(callerTimeoutMs) && (callerTimeoutMs as number) > 0
    ? (callerTimeoutMs as number) + TIMEOUT_LADDER_STEP_MS
    : 0;
  return Math.max(actionBudgetMs(action), caller);
}

/** hub 永远比内层多一档，保证「说得清原因的那一层」先应答 */
export function hubDeadlineFor(action: string, callerTimeoutMs: number | undefined): number {
  return innerDeadlineFor(action, callerTimeoutMs) + TIMEOUT_LADDER_STEP_MS;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vortex-browser/shared exec vitest run --maxWorkers=2 --minWorkers=1 timeout-ladder`
Expected: PASS（含既有的阶梯递增用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/timeout.ts packages/shared/tests/timeout-ladder.test.ts
git commit -m "feat: 建立 per-action 内层预算表与 hub deadline 正向推导"
```

---

### Task 2: MCP 侧改用 hubDeadlineFor 推导 hub deadline

**Files:**
- Modify: `packages/mcp/src/server.ts:530`（observe 专用路径）、`packages/mcp/src/server.ts:858`（通用路径）
- Test: `packages/mcp/tests/hub-deadline-from-budget.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `hubDeadlineFor(action, callerTimeoutMs)`
- Produces: `sendRequest` 第 5 参由 `ladder.hub` 改为 `hubDeadlineFor(action, timeout)`；`args.timeout` 的下发行为不变（仍是 `ladder.inner`，供 handler 按自身语义使用）

- [ ] **Step 1: 写失败测试**

创建 `packages/mcp/tests/hub-deadline-from-budget.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { hubDeadlineFor, actionBudgetMs, TIMEOUT_LADDER_STEP_MS } from "@vortex-browser/shared";

// MCP 侧的契约锁：hub deadline 必须由 action 预算推出，而不是调用方 timeout 直推。
// 历史行为 timeoutLadder(timeout, 30000) 会让 act(timeout:5000) 的 hub 变成 10s，
// 而 act 成功 P99 是 25.5s —— 调用方给 gate 的小预算不该成为整体天花板。
describe("hub deadline 由 action 预算推导", () => {
  it("dom.click 传小 timeout 时 hub 仍不低于该 action 预算", () => {
    const hub = hubDeadlineFor("dom.click", 2_000);
    expect(hub).toBeGreaterThanOrEqual(actionBudgetMs("dom.click"));
    expect(hub).toBe(actionBudgetMs("dom.click") + TIMEOUT_LADDER_STEP_MS);
  });

  it("hub 始终严格大于内层预算，保证内层先 fire", () => {
    for (const action of ["page.navigate", "mouse.click", "capture.screenshot", "content.getText"]) {
      expect(hubDeadlineFor(action, undefined)).toBeGreaterThan(actionBudgetMs(action));
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vortex-browser/mcp exec vitest run --maxWorkers=2 --minWorkers=1 hub-deadline-from-budget`
Expected: FAIL — `@vortex-browser/shared` 尚未在 mcp 包内解析出新导出（若 shared 已 build 则本步可能直接 PASS，此时改为在 Step 3 后验证 server.ts 的实际接线）。

- [ ] **Step 3: 改接线**

`packages/mcp/src/server.ts` 通用路径（原 858 行附近）：

```typescript
    const { tabId, returnMode, timeout, ...rest } = params;
    // 调用方 timeout 仍作内层预算下发给 handler（各 handler 语义不同）；
    // hub deadline 改由 action 预算推导，避免小 timeout 反向挤压整体上限。
    const ladder = timeoutLadder(timeout as number | undefined, DEFAULT_TIMEOUT);
    if (ladder.inner !== undefined) rest.timeout = ladder.inner;

    const mapped = dispatchNewTool(toolDef.name, rest);
    const action = mapped ? mapped.action : toolDef.action;
    const mappedParams = mapped ? mapped.params : rest;

    const resp = await sendRequest(
      action,
      mappedParams,
      PORT,
      tabId as number | undefined,
      hubDeadlineFor(action, timeout as number | undefined),
    );
```

observe 专用路径（原 530 行附近）同理，把 `sendRequest` 的第 5 参从 `ladder.hub` 改为
`hubDeadlineFor("observe.snapshot", timeout as number | undefined)`。

在文件顶部 import 中加入 `hubDeadlineFor`：

```typescript
import { timeoutLadder, splitDiagnosis, hubDeadlineFor } from "@vortex-browser/shared";
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @vortex-browser/shared build
pnpm --filter @vortex-browser/mcp exec vitest run --maxWorkers=2 --minWorkers=1
```
Expected: 新用例 PASS，mcp 包既有用例全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/server.ts packages/mcp/tests/hub-deadline-from-budget.test.ts
git commit -m "fix: hub deadline 改由 action 预算推导，不再被调用方小 timeout 挤压"
```

---

### Task 3: 有界探活工具（超时归因的判据来源）

**Files:**
- Create: `packages/extension/src/lib/liveness-probe.ts`
- Test: `packages/extension/tests/liveness-probe.test.ts`

**Interfaces:**
- Consumes: 已有 `packages/extension/src/lib/race-timeout.ts` 的 `raceTimeout` / `TIMED_OUT`
- Produces: `export type Liveness = "page-alive" | "page-unresponsive" | "tab-gone"`、
  `export async function probeLiveness(tabId: number | undefined, budgetMs?: number): Promise<Liveness>`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/liveness-probe.test.ts`：

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("probeLiveness", () => {
  it("executeScript 及时返回 → page-alive", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1, active: true }) },
      scripting: { executeScript: async () => [{ result: 1 }] },
    };
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    expect(await probeLiveness(1)).toBe("page-alive");
  });

  it("executeScript 永不 settle → page-unresponsive（有界，不挂）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1, active: true }) },
      scripting: { executeScript: () => new Promise(() => {}) },
    };
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    let out: string | undefined;
    const p = probeLiveness(1, 300).then((r) => { out = r; });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(out).toBe("page-unresponsive");
  });

  it("tab 已不存在 → tab-gone", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => { throw new Error("No tab with id: 9"); } },
      scripting: { executeScript: async () => [{ result: 1 }] },
    };
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    expect(await probeLiveness(9)).toBe("tab-gone");
  });

  it("无 tabId 时不探活，按 page-alive 处理（tabless action）", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {};
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    expect(await probeLiveness(undefined)).toBe("page-alive");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 liveness-probe`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

创建 `packages/extension/src/lib/liveness-probe.ts`：

```typescript
/**
 * Author: qingwa
 * Description: 超时归因用的有界探活——区分「页面主线程卡死」与「某条 API 卡住」。
 */
import { raceTimeout, TIMED_OUT } from "./race-timeout.js";

const PROBE_BUDGET_MS = 300;

export type Liveness = "page-alive" | "page-unresponsive" | "tab-gone";

/**
 * 往目标 tab 打一个极短的空脚本探页面主线程死活。
 * 探针本身必须有界：页面卡死时 executeScript 既不 resolve 也不 reject。
 */
export async function probeLiveness(
  tabId: number | undefined,
  budgetMs: number = PROBE_BUDGET_MS,
): Promise<Liveness> {
  if (tabId == null) return "page-alive";
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return "tab-gone";
  }
  const probe = chrome.scripting.executeScript({
    target: { tabId },
    func: () => 1,
  });
  const r = await raceTimeout(probe.then(() => true).catch(() => false), budgetMs);
  if (r === TIMED_OUT) return "page-unresponsive";
  return "page-alive";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 liveness-probe`
Expected: PASS（4/4）。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/lib/liveness-probe.ts packages/extension/tests/liveness-probe.test.ts
git commit -m "feat: 新增有界探活，为超时归因提供判据"
```

---

### Task 4: ActionRouter 统一施加内层 deadline

**Files:**
- Modify: `packages/extension/src/lib/router.ts:52`
- Test: `packages/extension/tests/router-inner-deadline.test.ts`（新建）

**设计取舍：不新增错误码。** spec 第 5 节曾设想为「页面主线程无响应 / CDP 未应答」各加一个
错误码，改为复用 `TIMEOUT` + `context.extras.liveness` + 差异化 hint：错误码是公开面的一部分，
新增两个码要同步 schema、hint 表与所有消费者，而调用方真正需要区分的是「下一步做什么」，
那由 hint 承载即可（hint override 是 `vtxError` 第 4 参这一唯一通道）。

**Interfaces:**
- Consumes: Task 1 的 `innerDeadlineFor`、Task 3 的 `probeLiveness`
- Produces: `dispatch` 对每个 handler 施加 SW 侧 deadline；超时返回 `VtxErrorCode.TIMEOUT`，
  message 形如 `Action <action> exceeded its <N>ms budget`，并按探活结果给不同 hint 与
  `context.extras.liveness`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/router-inner-deadline.test.ts`：

```typescript
// 回归锁：router 层统一内层界（2026-08-18 使用日志挖掘）。
//
// 根因：shared/timeout.ts 明写 inner < hub < transport，但 extension/lib/router.ts
// 从不施加内层 deadline，是否有界取决于各 handler 自觉。mouse/capture/content/
// page.waitForExpression 全是裸 await，页面或 CDP 卡住时只能由 hub 30s 兜底，
// 真实原因在跨进程边界处丢失，只剩 "Request X timed out"。
import { describe, it, expect, afterEach, vi } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import type { NmRequest } from "@vortex-browser/shared";

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId?: number): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", ...(tabId != null ? { tabId } : {}) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("ActionRouter 内层 deadline", () => {
  it("handler 永不 settle 时在 action 预算内有界失败", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1 }) },
      scripting: { executeScript: async () => [{ result: 1 }] },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(String(resp.error?.message)).toMatch(/mouse\.click/);
    expect(String(resp.error?.message)).toMatch(/30000ms budget/);
  });

  it("🔴 页面主线程卡死时归因为 page-unresponsive 且 hint 不再指引加大 timeout", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1 }) },
      scripting: { executeScript: () => new Promise(() => {}) },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.context?.extras?.liveness).toBe("page-unresponsive");
    expect(String(resp.error?.hint)).not.toMatch(/larger timeout/i);
    expect(String(resp.error?.hint)).toMatch(/主线程|unresponsive/i);
  });

  it("页面还活着时归因为 CDP/API 未应答", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1 }) },
      scripting: { executeScript: async () => [{ result: 1 }] },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.context?.extras?.liveness).toBe("page-alive");
  });

  it("🔴 REGRESSION: 正常返回的 handler 行为完全不变", async () => {
    vi.resetModules();
    (globalThis as any).chrome = { tabs: { get: async () => ({ id: 1 }) } };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("foo.bar", async () => ({ ok: true, n: 42 }));
    const resp = await router.dispatch(mkReq("foo.bar"));
    expect(resp.result).toEqual({ ok: true, n: 42 });
    expect(resp.error).toBeUndefined();
  });

  it("🔴 REGRESSION: handler 抛 VtxError 时 payload 不被 deadline 包装吞掉", async () => {
    vi.resetModules();
    (globalThis as any).chrome = { tabs: { get: async () => ({ id: 1 }) } };
    const { vtxError } = await import("@vortex-browser/shared");
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("dom.click", async () => {
      throw vtxError(VtxErrorCode.ELEMENT_NOT_FOUND, "Element not found: .missing", {
        selector: ".missing",
      });
    });
    const resp = await router.dispatch(mkReq("dom.click"));
    expect(resp.error?.code).toBe(VtxErrorCode.ELEMENT_NOT_FOUND);
    expect(resp.error?.context?.selector).toBe(".missing");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 router-inner-deadline`
Expected: FAIL — 前三个用例超时不返回（handler 永挂），后两个 REGRESSION 用例 PASS。

- [ ] **Step 3: 实现**

`packages/extension/src/lib/router.ts` 顶部补 import：

```typescript
import { innerDeadlineFor, vtxError, VtxError, VtxErrorCode } from "@vortex-browser/shared";
import { probeLiveness, type Liveness } from "./liveness-probe.js";
import { raceTimeout, TIMED_OUT } from "./race-timeout.js";
```

在类外新增归因函数：

```typescript
const LIVENESS_HINT: Record<Liveness, string> = {
  "page-unresponsive":
    "页面主线程无响应（被长任务占住），等待与加大 timeout 都无效。先 vortex_navigate 重置该 tab，或换一个 tab 操作。",
  "page-alive":
    "页面本身可响应，是这条动作链路未应答（常见于 CDP 命令排队或 debugger 被占）。改用不依赖 CDP 的路径，或换 tab 重试。",
  "tab-gone":
    "目标 tab 已关闭或不可访问。用 vortex_tab_list 确认后重新绑定 tabId。",
};

function timeoutPayload(action: string, budgetMs: number, liveness: Liveness) {
  return vtxError(
    VtxErrorCode.TIMEOUT,
    `Action ${action} exceeded its ${budgetMs}ms budget`,
    { extras: { action, budgetMs, liveness } },
    { hint: LIVENESS_HINT[liveness], recoverable: liveness !== "tab-gone" },
  );
}
```

把 `dispatch` 的 try 块改为：

```typescript
    // 内层预算与调用方 timeout 同源推导，防止砍掉自管超时的 handler（如 js.evaluate）
    const budgetMs = innerDeadlineFor(request.tool, request.args?.timeout as number | undefined);
    try {
      const r = await raceTimeout(handler(request.args, request.tabId), budgetMs);
      if (r === TIMED_OUT) {
        // 超时后才探活：正常路径零开销
        const liveness = await probeLiveness(request.tabId);
        return {
          type: "tool_response",
          requestId: request.requestId,
          error: timeoutPayload(request.tool, budgetMs, liveness).toJSON(),
        };
      }
      return { type: "tool_response", requestId: request.requestId, result: r };
    } catch (err) {
```

catch 块保持原样不动。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 router
```
Expected: `router-inner-deadline` 5/5 PASS，既有 `router.test.ts` / `router-error-meta.test.ts` 全绿。

- [ ] **Step 5: 跑 extension 全量回归**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1`
Expected: 全绿。若某个 handler 的既有用例因新 deadline 失败，说明该 action 预算定低了，回 Task 1 补表而不是放宽本任务的判据。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/lib/router.ts packages/extension/tests/router-inner-deadline.test.ts
git commit -m "feat: router 统一施加内层 deadline 并按探活结果归因超时"
```

---

### Task 5: 修订 hub 兜底 hint

内层就位后，hub 兜底成为真正的异常路径（内层没 fire 才轮得到它）。当前文案
`the page itself may be fine` + `Retry with a larger timeout argument` 与当日 7 次实证相反。

**Files:**
- Modify: `packages/hub/src/error-hints.ts:11`
- Test: `packages/hub/tests/error-hints.test.ts`（若不存在则新建）

**Interfaces:**
- Consumes: 无
- Produces: `RPC_TIMEOUT_HINT` 文案变更；不改导出名与类型

- [ ] **Step 1: 写失败测试**

创建或追加 `packages/hub/tests/error-hints.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { RPC_TIMEOUT_HINT } from "../src/error-hints.js";

// hub 兜底只在 extension 内层 deadline 也没 fire 时发生（见 extension/lib/router.ts）。
// 那是扩展侧无应答，不是「页面可能没问题」，更不该指引加大 timeout 重试。
describe("RPC_TIMEOUT_HINT", () => {
  it("不再声称页面可能没问题", () => {
    expect(RPC_TIMEOUT_HINT).not.toMatch(/page itself may be fine/i);
  });
  it("不再把加大 timeout 当首选动作", () => {
    expect(RPC_TIMEOUT_HINT).not.toMatch(/Retry with a larger timeout/i);
  });
  it("指向扩展侧无应答这一真实含义", () => {
    expect(RPC_TIMEOUT_HINT).toMatch(/extension/i);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vortex-browser/hub exec vitest run --maxWorkers=2 --minWorkers=1 error-hints`
Expected: FAIL — 现文案含 `page itself may be fine`。

- [ ] **Step 3: 改文案**

`packages/hub/src/error-hints.ts`：

```typescript
// 内层 deadline 就位后（extension/lib/router.ts），走到这里意味着扩展侧连超时都没报出来。
export const RPC_TIMEOUT_HINT =
  "The extension did not answer within the deadline — its own action budget should have " +
  "fired first, so the extension side is likely wedged or was reloaded. " +
  "Call vortex_browser to confirm the extension is connected, then retry; " +
  "raising the timeout argument will not help.";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vortex-browser/hub exec vitest run --maxWorkers=2 --minWorkers=1`
Expected: 全绿。若有既有用例断言旧文案，一并更新（那正是「注释写了意图≠意图落地」的锁点）。

- [ ] **Step 5: 提交**

```bash
git add packages/hub/src/error-hints.ts packages/hub/tests/error-hints.test.ts
git commit -m "fix: hub 兜底 hint 改指扩展侧无应答，不再声称页面没问题"
```

---

### Task 6: wait_for 计时移出页面主线程

当日实证：调用方传 `timeout:15000`，实际在 20147ms（= 15000+5000 的 hub 层）被打断。
`handlers/page.ts:415` 的 poll 计时器跑在被测页面主线程，页面卡死时 poll 不执行，内层等同缺席。

**Files:**
- Modify: `packages/extension/src/handlers/page.ts:383-443`
- Test: `packages/extension/tests/page-wait-for-expression.test.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: Task 3 的 `probeLiveness` 不需要；本任务用 `raceTimeout`
- Produces: `page.waitForExpression` 在页面卡死时由 SW 侧计时器在 `args.timeout` 到点返回
  `VtxErrorCode.TIMEOUT`，message 为 `Expression never resolved truthy within <N>ms (page-side polling did not report back)`

- [ ] **Step 1: 写失败测试**

追加到 `packages/extension/tests/page-wait-for-expression.test.ts`：

```typescript
it("🔴 页面主线程卡死时由 SW 侧计时器在调用方 timeout 到点返回", async () => {
  vi.useFakeTimers();
  vi.resetModules();
  // executeScript 永不 settle：page-side poll 排不上队（当日 wait_for 20147ms 的形态）
  (globalThis as any).chrome = {
    tabs: { get: async () => ({ id: 1 }) },
    scripting: { executeScript: () => new Promise(() => {}) },
  };
  const { ActionRouter } = await import("../src/lib/router.js");
  const { registerPageHandlers } = await import("../src/handlers/page.js");
  const router = new ActionRouter();
  registerPageHandlers(router, {} as any);

  let resp: any;
  const p = router
    .dispatch({
      type: "tool_request",
      tool: "page.waitForExpression",
      args: { expression: "window.__never === true", timeout: 15_000 },
      requestId: "r-wait",
      tabId: 1,
    } as any)
    .then((r) => { resp = r; });
  await vi.advanceTimersByTimeAsync(15_500);
  await p;

  expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
  expect(String(resp.error?.message)).toMatch(/within 15000ms/);
  expect(String(resp.error?.message)).toMatch(/page-side polling did not report back/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 page-wait-for-expression`
Expected: FAIL — 15.5s 时仍未返回（要等 router 的 20s 预算）。

- [ ] **Step 3: 实现**

`packages/extension/src/handlers/page.ts` 的 `WAIT_FOR_EXPRESSION` handler，把
`const results = await chrome.scripting.executeScript({...})` 改为 SW 侧有界等待：

```typescript
      const exec = chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        // ... func / args / world 保持不变
      });
      // SW 侧计时器独立于被阻塞的渲染器：页面卡死时 page-side poll 排不上队，
      // 只有这层能按调用方预算应答（2026-08-18 日志实证 wait_for 挂到 hub 层）
      const raced = await raceTimeout(exec, timeout + 500);
      if (raced === TIMED_OUT) {
        throw vtxError(
          VtxErrorCode.TIMEOUT,
          `Expression never resolved truthy within ${timeout}ms (page-side polling did not report back)`,
          { tabId: tid, frameId, extras: { expression } },
        );
      }
      const results = raced;
```

文件顶部补 `import { raceTimeout, TIMED_OUT } from "../lib/race-timeout.js";`。
`timeout + 500` 的 margin 让页面还活着时 page-side 的语义化结果优先胜出。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 page-wait-for-expression`
Expected: 全绿，含既有的 IIFE 检测与 hidden-tab 用例。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/page.ts packages/extension/tests/page-wait-for-expression.test.ts
git commit -m "fix: wait_for 计时移到 SW 侧，页面卡死时按调用方预算应答"
```

---

### Task 7: CDP 被占时 act useRealMouse 降级为合成路径

当日 2 次 `CDP_NOT_ATTACHED`（同一 tab，相隔 3 小时，常驻 DevTools）：该 tab 上 200 多次
evaluate 全部正常，只有需要 CDP 的 `act useRealMouse` 与 `mouse_click` 失败，模型最终只能
`tab_create` 弃 tab 重来。`act` 有合成事件路径可降级；`mouse_click` 依赖真实坐标派发，
无等价降级，仅改进提示。

**Files:**
- Modify: `packages/extension/src/handlers/dom.ts:234` 附近的 CLICK useRealMouse 分支
- Test: `packages/extension/tests/dom-click-cdp-busy-degrade.test.ts`（新建）

**Interfaces:**
- Consumes: `packages/extension/src/lib/debugger-manager.ts:86` 抛出的 `CDP_NOT_ATTACHED`
- Produces: `dom.click` 在 `useRealMouse=true` 且 CDP 被占时改走合成路径，返回结果附
  `degraded: "cdp-busy-synthetic"`；不再向调用方抛 `CDP_NOT_ATTACHED`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/dom-click-cdp-busy-degrade.test.ts`：

```typescript
// CDP 被 DevTools 占用时，act useRealMouse 不该直接失败——合成路径就在同一 handler 里。
// 当日日志：同一 tab 上 200+ 次 evaluate 正常，仅 CDP 路径失败，模型只能弃 tab 重来。
import { describe, it, expect, afterEach, vi } from "vitest";
import { VtxErrorCode, vtxError } from "@vortex-browser/shared";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("dom.click useRealMouse 在 CDP 被占时降级", () => {
  it("attach 抛 CDP_NOT_ATTACHED 时改走合成路径并标注降级", async () => {
    vi.resetModules();
    const busy = vtxError(
      VtxErrorCode.CDP_NOT_ATTACHED,
      "Another debugger is already attached to the tab with id: 1",
      { tabId: 1 },
    );
    const debuggerMgr = { attach: vi.fn(async () => { throw busy; }) };
    // 合成路径可用：page-side click 正常返回
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1, active: true }) },
      scripting: { executeScript: async () => [{ result: { clicked: true } }] },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const { registerDomHandlers } = await import("../src/handlers/dom.js");
    const router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr as any);

    const resp: any = await router.dispatch({
      type: "tool_request",
      tool: "dom.click",
      args: { selector: "#go", useRealMouse: true },
      requestId: "r-degrade",
      tabId: 1,
    } as any);

    expect(resp.error).toBeUndefined();
    expect(resp.result?.degraded).toBe("cdp-busy-synthetic");
    expect(debuggerMgr.attach).toHaveBeenCalled();
  });

  it("非 CDP_NOT_ATTACHED 的 attach 失败仍原样抛出", async () => {
    vi.resetModules();
    const other = vtxError(VtxErrorCode.PERMISSION_DENIED, "Cannot access chrome:// URL", { tabId: 1 });
    const debuggerMgr = { attach: vi.fn(async () => { throw other; }) };
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1, active: true }) },
      scripting: { executeScript: async () => [{ result: { clicked: true } }] },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const { registerDomHandlers } = await import("../src/handlers/dom.js");
    const router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr as any);

    const resp: any = await router.dispatch({
      type: "tool_request",
      tool: "dom.click",
      args: { selector: "#go", useRealMouse: true },
      requestId: "r-other",
      tabId: 1,
    } as any);

    expect(resp.error?.code).toBe(VtxErrorCode.PERMISSION_DENIED);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 dom-click-cdp-busy-degrade`
Expected: FAIL — 第一个用例拿到 `CDP_NOT_ATTACHED` 而非降级结果。

- [ ] **Step 3: 实现**

在 `packages/extension/src/handlers/dom.ts` 的 CLICK handler 中，把进入 CDP 分支的调用包起来。
先在文件顶部确认已 import `VtxError`、`VtxErrorCode`，然后：

```typescript
      // DevTools 占着 debugger 时 CDP 路径无解，但合成路径同在本 handler 内。
      // 降级而非失败——否则调用方只能弃 tab 重来（2026-08-18 日志实证）。
      let cdpDegraded = false;
      if (useRealMouse || trustedMode) {
        try {
          return await cdpClickPath();
        } catch (err) {
          if (!(err instanceof VtxError) || err.code !== VtxErrorCode.CDP_NOT_ATTACHED) throw err;
          cdpDegraded = true;
        }
      }
```

其中 `cdpClickPath()` 是把该 handler 内**现有**的 CDP 分支（由 `useRealMouse || trustedMode`
守卫、以 `debuggerMgr.attach(tid)` 开头、到该分支 `return` 为止的整段）原样抽出的局部函数，
逐行搬运、不改其内部逻辑；
其余合成路径代码不动；在合成路径的返回对象上补：

```typescript
        ...(cdpDegraded ? { degraded: "cdp-busy-synthetic" as const } : {}),
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1 dom-click
pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1
```
Expected: 新用例 2/2 PASS，dom.click 既有用例（含 ancestor-hit / trusted-mode / click-effect）全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/dom.ts packages/extension/tests/dom-click-cdp-busy-degrade.test.ts
git commit -m "feat: CDP 被占时 act useRealMouse 降级合成路径，不再让调用方弃 tab"
```

---

### Task 8: 内层先于外层的跨层不变量锁

前面每个任务各锁一层。本任务锁「三层次序」这件事本身，防止后来者调某个常量时把次序破坏掉。

**Files:**
- Create: `packages/shared/tests/invariants/I-timeout-ladder-ordering.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: Task 1 的 `ACTION_BUDGET_MS`、`actionBudgetMs`、`hubDeadlineFor`
- Produces: 无运行时导出

- [ ] **Step 1: 写不变量测试**

创建 `packages/shared/tests/invariants/I-timeout-ladder-ordering.test.ts`：

```typescript
/**
 * Author: qingwa
 * Description: 跨层不变量——每个 action 的 inner < hub < transport 恒成立。
 */
import { describe, it, expect } from "vitest";
import {
  ACTION_BUDGET_MS,
  DEFAULT_ACTION_BUDGET_MS,
  actionBudgetMs,
  innerDeadlineFor,
  hubDeadlineFor,
  transportTimeoutFor,
  MAX_INNER_TIMEOUT_MS,
} from "../../src/timeout.js";

// 扫描类不变量必须自带命中数断言，否则空集也会假绿。
describe("超时阶梯次序不变量", () => {
  const actions = [...Object.keys(ACTION_BUDGET_MS), "some.unregistered"];

  it("覆盖到的 action 数量符合预期（防空集假绿）", () => {
    expect(Object.keys(ACTION_BUDGET_MS).length).toBeGreaterThanOrEqual(12);
    expect(actions.length).toBe(Object.keys(ACTION_BUDGET_MS).length + 1);
  });

  it("对每个 action，无论调用方传什么，inner < hub < transport", () => {
    const callerCases = [undefined, 0, 1, 2_000, 30_000, 120_000];
    for (const action of actions) {
      for (const caller of callerCases) {
        const inner = innerDeadlineFor(action, caller);
        const hub = hubDeadlineFor(action, caller);
        const transport = transportTimeoutFor(hub);
        expect(hub, `${action}/${caller}: hub 未大于 inner`).toBeGreaterThan(inner);
        expect(transport, `${action}/${caller}: transport 未大于 hub`).toBeGreaterThan(hub);
      }
    }
  });

  // 注：innerDeadlineFor 会随调用方 timeout 上移，硬上限只约束表内缺省值本身
  it("缺省预算与所有登记预算都不超过内层硬上限", () => {
    expect(DEFAULT_ACTION_BUDGET_MS).toBeLessThanOrEqual(MAX_INNER_TIMEOUT_MS);
    for (const [action, ms] of Object.entries(ACTION_BUDGET_MS)) {
      expect(ms, `${action} 超上限`).toBeLessThanOrEqual(MAX_INNER_TIMEOUT_MS);
    }
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm --filter @vortex-browser/shared exec vitest run --maxWorkers=2 --minWorkers=1 I-timeout-ladder-ordering`
Expected: PASS 3/3。若失败说明 Task 1 的表定错了，回 Task 1 修表。

- [ ] **Step 3: 提交**

```bash
git add packages/shared/tests/invariants/I-timeout-ladder-ordering.test.ts
git commit -m "test: 锁定每个 action 的 inner < hub < transport 次序不变量"
```

---

### Task 9: live 验证（mock 绿灯不算数）

归因第四问：**改后的代码路径真实环境里真的会走到吗**——只能靠 live。本任务不写单测。

**Files:**
- Create: `reports/_eval/baseline/2026-08-18-post-inner-budget.json` / `.md`（脚本产出）
- Modify: 无

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 复跑基线的对比结论

- [ ] **Step 1: 完整构建并重载扩展**

```bash
pnpm build
```
然后在 Chrome 的 `chrome://extensions` 手动 reload 扩展（MV3 SW 不会自动换新），
或用 `vortex_dev_reload`（需 `--caps=dev`）。**注意**：`vite build:main` 会清 `dist/page-side`，
必须跑完整 `pnpm build`，否则 page-side 缺失会制造假故障。

- [ ] **Step 2: 造一个页面主线程卡死的场景，验证归因**

在任意页面用 `vortex_evaluate` 注入一个长任务，然后立刻打 `vortex_mouse_click`：

```javascript
// 先跑这个（async:false，让它占住主线程）
(function(){ const end = Date.now() + 40000; while (Date.now() < end) {} })()
```

预期：`mouse_click` 在 30s 左右返回 `TIMEOUT`，message 含 `mouse.click exceeded its 30000ms budget`，
`context.extras.liveness === "page-unresponsive"`，hint 指向「先 navigate 重置该 tab」，
**不再**出现 `Request mouse.click timed out` 与 `the page itself may be fine`。

- [ ] **Step 3: 验证 wait_for 按调用方预算应答**

同样在卡死的页面上：`vortex_wait_for({mode:"custom", value:"window.__never===true", timeout:15000})`。
预期：约 15s 返回，message 含 `within 15000ms` 与 `page-side polling did not report back`；
**不再**是 20s 的 `Request page.waitForExpression timed out`。

- [ ] **Step 4: 验证 CDP 降级**

在目标 tab 上手动打开 DevTools，然后 `vortex_act({target:"...", action:"click", useRealMouse:true})`。
预期：点击成功，结果含 `degraded: "cdp-busy-synthetic"`，不再抛 `CDP_NOT_ATTACHED`。

- [ ] **Step 5: 零回归抽查**

在一个正常的重型站点上依次跑 `observe` / `act` / `screenshot` / `extract scroll:true` /
`navigate waitUntil:networkidle`，确认耗时与结果与改动前一致，没有本来能成功的调用被新 deadline 砍掉。

- [ ] **Step 6: 复跑使用基线**

```bash
node scripts/usage-baseline/collect.mjs --label post-inner-budget --days 1
node scripts/usage-baseline/collect.mjs --compare \
  reports/_eval/baseline/2026-08-18-today-1d.json \
  reports/_eval/baseline/2026-08-18-post-inner-budget.json
```
判据：`Request \S+ timed out` 签名归零；P99 调用耗时低于 30447ms。
（注意样本窗口：当日 Top1 会话占 71.4%，单日对比只能作方向参考，真正的验收看一周后的窗口。）

- [ ] **Step 7: 提交验证产物**

```bash
git add reports/_eval/baseline/2026-08-18-post-inner-budget.json \
        reports/_eval/baseline/2026-08-18-post-inner-budget.md
git commit -m "test: 内层预算上线后的使用基线快照"
```

---

### Task 10: 评审与收尾

- [ ] **Step 1: 代码评审**

使用 `superpowers:requesting-code-review` 对 `git diff main...HEAD` 做评审，处理 CRITICAL 与 HIGH。

- [ ] **Step 2: 完成前验证**

使用 `superpowers:verification-before-completion`：逐条核对 spec 第 1 节的四条判据，
每条给出实际命令输出作为证据，不得以「应该没问题」结案。

- [ ] **Step 3: 更新 spec 的待验证假设表**

把 `docs/inner-timeout-budget-approach.md` 第 7 节的四条假设逐条标注为「已证实 / 已证伪 / 仍未查明」，
特别是 `navigate` 42413ms 超过 hub 30s 默认这条——若 Task 9 未能复现，明写仍未查明，不许留白。

- [ ] **Step 4: 合并**

使用 `superpowers:finishing-a-development-branch`。
