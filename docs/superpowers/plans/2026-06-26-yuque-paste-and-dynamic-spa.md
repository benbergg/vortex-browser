# 富文本粘贴（vortex_paste）+ 动态 SPA act 自愈增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 vortex 新增 `vortex_paste` 富文本粘贴原语（合成 ClipboardEvent 主路径），并增强动态 SPA 下 act 的 descriptor 自愈（候选集放宽 + 自旋期重定位 + 终态指引）。

**Architecture:** 缺口一新增 `dom.paste` handler——actionability gate（复用 healAwareGate）→ MAIN world 单次 executeScript 聚焦目标、构造 `DataTransfer`、派发合成 `ClipboardEvent('paste')`、回读 textContent 护栏 → NO_EFFECT 不假成功；公开 `vortex_paste` 工具经 dispatch 路由到 `dom.paste`。缺口二在既有 heal 链路上三处增量：B1 改 `heal.ts` 候选集（窄集零命中→宽集兜底，复用既有歧义护栏）；B2 给 `auto-wait.ts` 加自旋期 descriptor 重定位回调，由 `healAwareGate` 注入；B3 在终态错误补动态 SPA hint。

**Tech Stack:** TypeScript（pnpm workspace）、Chrome MV3 扩展 + CDP（chrome.debugger / chrome.scripting）、MCP（@modelcontextprotocol）、vitest + jsdom。

## Global Constraints

- **注释语言**：中文（API/异常/标识符保留英文）；TS 不加 `@author`；禁止 `Co-Authored-By` / `Created by` 等署名。
- **提交规范**：每个 commit 步骤必须用 `froggo-skills:git-commit` skill 生成符合 Conventional Commits 的信息（type 英文小写、description 中文动词开头、结尾无句号）。
- **I15 tools/list 预算**（`packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`）：当前 cap 7800 B、公开工具数 20、description ≤180 char、顶层 property 不带 description（除既有豁免）。新增工具须同步调升 cap（沿用历次「加能力 +100 微调 cap 不压缩字符」惯例）、更新数量断言与 names 列表。
- **公共 schema 风格**（`schemas-public.ts` 头部规则）：description 命令式、尽量 ≤60 char、properties 无 description、无 `default`（handler 内兜底）。
- **承重墙纪律**：`heal.ts` / `auto-wait.ts` 属自愈/门控承重墙，改动后除单测外须按 §Task 12 做活浏览器 spike 验证（对齐既往「承重墙改动须活浏览器 spike」教训）。
- **测试范式**：handler 结构用「读源码字符串 + 正则契约断言」（参 `tests/dom-type-contenteditable.test.ts`）；纯页面函数/匹配器用 `new Function` 剥离闭包 + jsdom（参 `tests/heal-inline-alignment.test.ts`）；handler 运行时行为用 `vi.mock` 模块替身 + `ActionRouter.dispatch` + `vi.stubGlobal("chrome", …)`（参 `tests/dom-action-default-timeout.test.ts`）。
- **不实现项（YAGNI）**：方案 T（OS 剪贴板 + CDP commands 可信粘贴）、`vortex_clipboard_set/get`、`editingCommandsForKey` 的 paste/copy/cut/undo、自动 re-observe。

---

## 文件结构

| 文件 | 责任 | 本计划动作 |
|---|---|---|
| `packages/shared/src/actions.ts` | action 枚举单一真源 | 加 `DomActions.PASTE = "dom.paste"` |
| `packages/extension/src/handlers/dom.ts` | DOM 动作 handler | 加 `dom.paste` handler；`healAwareGate` 注入 B2 重定位回调 |
| `packages/extension/src/action/heal.ts` | descriptor 自愈编排 | B1 候选集窄→宽兜底 |
| `packages/extension/src/action/auto-wait.ts` | actionability 自旋门 | B2 自旋期重定位回调 + B3 终态 hint 文案 |
| `packages/shared/src/errors.hints.ts` | 错误码默认 hint | B3 动态 SPA 指引（如需补 STALE_REF/TIMEOUT hint）|
| `packages/mcp/src/tools/schemas-public.ts` | 公开工具注册 | 加 `vortex_paste` ToolDef |
| `packages/mcp/src/tools/dispatch.ts` | 公开工具 → 内部 action | 加 `vortex_paste` case → `dom.paste` |
| `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts` | tools/list 预算不变量 | 更新 cap/数量/names |
| `docs/2026-06-25-yuque-paste-and-dynamic-spa-rootcause.md` | 原根因文档 | 订正缺口二误诊 |

---

# Phase 1 — 缺口一：vortex_paste

## Task 1: shared 加 `DomActions.PASTE`

**Files:**
- Modify: `packages/shared/src/actions.ts`（`DomActions` 对象，§ line 31-49）
- Test: `packages/extension/tests/dom-paste.test.ts`（本 task 仅建文件 + 第一条断言）

**Interfaces:**
- Produces: `DomActions.PASTE === "dom.paste"`（供 Task 2 handler 注册、Task 3 dispatch 路由消费）

- [ ] **Step 1: 写失败测试**

新建 `packages/extension/tests/dom-paste.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { DomActions } from "@vortex-browser/shared";

describe("dom.paste action 枚举", () => {
  it("DomActions.PASTE 注册为 dom.paste", () => {
    expect(DomActions.PASTE).toBe("dom.paste");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/dom-paste.test.ts`
Expected: FAIL（`DomActions.PASTE` 为 undefined）

- [ ] **Step 3: 加枚举值**

在 `packages/shared/src/actions.ts` 的 `DomActions` 内、`COMMIT` 行之后追加：

```typescript
  /** 富文本粘贴:合成 ClipboardEvent('paste')+构造 DataTransfer,触发编辑器自管的 paste→Markdown 转换。@since 当前版本 */
  PASTE: "dom.paste",
```

- [ ] **Step 4: 跑测试确认通过 + 全包构建**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/dom-paste.test.ts`
Expected: PASS
Run: `pnpm --filter @vortex-browser/shared build`
Expected: 构建成功（其他包依赖 shared dist）

- [ ] **Step 5: 提交**（用 git-commit skill）

```
feat: 新增 dom.paste action 枚举
```

---

## Task 2: extension 实现 `dom.paste` handler

**Files:**
- Modify: `packages/extension/src/handlers/dom.ts`（`registerDomHandlers` 内，紧随 `[DomActions.TYPE]` handler 之后新增 `[DomActions.PASTE]`）
- Test: `packages/extension/tests/dom-paste.test.ts`（扩展）

**Interfaces:**
- Consumes: `resolveTarget`（`lib/resolve-target.ts`，返回 `{selector, boundTabId?, boundFrameId?, descriptor?}`）、`healAwareGate`（`dom.ts` 内，签名见 §line 97）、`loadPageSideModule`、`getActiveTabId` / `ensureFrameAttached`、`mapPageError`
- Produces: 注册 `dom.paste` handler；返回 `{ success: true, pasted: <text.length>, path: "synthetic-clipboard", healed? }` 或抛 `NO_EFFECT` / `NOT_CONTENTEDITABLE` 语义错误

**handler 设计要点（实现时遵循）：**
- 解析 args：`text`（必填，text/plain 载荷）、`html`（可选 text/html）、`target`/`selector`/`index`、`force`/`timeout`/`tabId`/`frameId`。
- gate：`healAwareGate(tid, frameId, selector, { timeout, needsEditable: true }, force, descriptor)`，自愈后重绑 selector。
- 单次 `chrome.scripting.executeScript({ target: buildExecuteTarget(tid, frameId), world: "MAIN", func, args })`（MAIN world 才能让 `DataTransfer`/`ClipboardEvent` 是页面 realm 对象，且能被页面监听器读到 clipboardData）：func 内用 `window.__vortexDomResolve.queryAllDeep(sel)` 解析元素 → 校验 `isContentEditable`（非 contenteditable 返回 `NOT_CONTENTEDITABLE` 让 handler 提示改用 vortex_fill）→ `el.focus()` → 捕获 `before = el.textContent` → 构造 `DataTransfer` + `setData('text/plain', text)`（html 非空再 `setData('text/html', html)`）→ 派发 `new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })` → 读 `after = el.textContent` → 返回 `{ ok, before, after, changed: after !== before }`。
- 回读护栏（族 A）：`changed === false`（且 `text !== ""`）→ `mapPageError` 抛 `NO_EFFECT`，message 提示「编辑器可能校验 isTrusted 拒收合成 paste；可改用 vortex_fill 或后续 trusted 升级」。

- [ ] **Step 1: 写失败测试（源码契约 + 运行时 NO_EFFECT/路由）**

向 `packages/extension/tests/dom-paste.test.ts` 追加（顶部补 import）：

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { vi, beforeEach } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");

describe("dom.paste handler 源码契约", () => {
  it("注册 DomActions.PASTE handler", () => {
    expect(DOM_SRC).toMatch(/\[DomActions\.PASTE\]:\s*async/);
  });
  it("经 healAwareGate 走 actionability 自愈门", () => {
    const block = DOM_SRC.match(/\[DomActions\.PASTE\][\s\S]*?healAwareGate\(/);
    expect(block).not.toBeNull();
  });
  it("MAIN world 注入 + 构造 DataTransfer + 合成 ClipboardEvent('paste')", () => {
    const block = DOM_SRC.match(/\[DomActions\.PASTE\][\s\S]*?world:\s*"MAIN"[\s\S]*?new DataTransfer\(\)[\s\S]*?new ClipboardEvent\("paste"/);
    expect(block).not.toBeNull();
  });
  it("setData text/plain(+可选 text/html)", () => {
    expect(DOM_SRC).toMatch(/setData\("text\/plain"/);
    expect(DOM_SRC).toMatch(/setData\("text\/html"/);
  });
  it("回读护栏:内容未变 → NO_EFFECT", () => {
    const guard = DOM_SRC.match(/\[DomActions\.PASTE\][\s\S]*?changed[\s\S]*?NO_EFFECT/);
    expect(guard).not.toBeNull();
  });
  it("非 contentEditable → 提示改用 vortex_fill", () => {
    expect(DOM_SRC).toMatch(/NOT_CONTENTEDITABLE|vortex_fill/);
  });
  it("result 带 path 标识", () => {
    expect(DOM_SRC).toMatch(/path:\s*"synthetic-clipboard"/);
  });
});

// 运行时行为：mock chrome.scripting 返回受控结果，验证 NO_EFFECT 与成功映射。
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockResolvedValue({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 } }),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "dom.paste", args, requestId: "r-1" } as NmRequest;
}

describe("dom.paste handler 运行时", () => {
  let router: ActionRouter;
  const exec = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]) },
      scripting: { executeScript: exec },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue(undefined) } as any;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("内容变更 → success(path=synthetic-clipboard)", async () => {
    exec.mockResolvedValue([{ result: { ok: true, isContentEditable: true, before: "", after: "# t", changed: true } }]);
    const res = await router.dispatch(mkReq({ selector: "#ed", text: "# t" }));
    expect(res.result).toMatchObject({ success: true, path: "synthetic-clipboard" });
  });

  it("内容未变 → NO_EFFECT(不假成功)", async () => {
    exec.mockResolvedValue([{ result: { ok: true, isContentEditable: true, before: "# t", after: "# t", changed: false } }]);
    const res = await router.dispatch(mkReq({ selector: "#ed", text: "x" }));
    expect(res.error?.code).toBe(VtxErrorCode.NO_EFFECT);
  });

  it("非 contentEditable → 错误提示改用 fill", async () => {
    exec.mockResolvedValue([{ result: { ok: true, isContentEditable: false } }]);
    const res = await router.dispatch(mkReq({ selector: "#inp", text: "x" }));
    expect(res.error).toBeDefined();
    expect(JSON.stringify(res.error)).toMatch(/fill/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/dom-paste.test.ts`
Expected: FAIL（handler 未注册 / 源码契约缺失）

- [ ] **Step 3: 实现 handler**

在 `packages/extension/src/handlers/dom.ts` 的 `[DomActions.TYPE]` handler 之后插入（确认 `VtxErrorCode` 含 `NO_EFFECT`；若无 `NOT_CONTENTEDITABLE` 码，复用 `INVALID_TARGET` 并在 message 给出 fill 指引）：

```typescript
    [DomActions.PASTE]: async (args, tabId) => {
      const __t = resolveTarget(args);
      let selector = __t.selector;
      const text = args.text as string;
      const html = args.html as string | undefined;
      if (text == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: text");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // gate + descriptor 自愈(needsEditable:true,contenteditable 也算可编辑)。
      const __heal = await healAwareGate(
        tid, frameId, selector,
        { timeout: args.timeout as number | undefined, needsEditable: true },
        args.force as boolean | undefined,
        __t.descriptor,
      );
      selector = __heal.selector;

      await loadPageSideModule(tid, frameId, "dom-resolve");
      // MAIN world 单次注入:解析→聚焦→构造 DataTransfer→派发合成 paste→回读。
      // MAIN world 必需:DataTransfer/ClipboardEvent 须是页面 realm 对象,
      // 否则页面监听器读 e.clipboardData 跨 realm 取不到数据。
      const out = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        world: "MAIN",
        func: (sel: string, txt: string, htmlPayload: string | null) => {
          const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
          if (els.length === 0) return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
          const el = els[0] as HTMLElement;
          if (!el.isContentEditable) {
            return {
              ok: true, isContentEditable: false,
              error: `Element ${sel} is not contentEditable; vortex_paste is for rich-text editors — use vortex_fill for inputs/textareas`,
            };
          }
          el.focus();
          const before = el.textContent ?? "";
          const dt = new DataTransfer();
          dt.setData("text/plain", txt);
          if (htmlPayload != null) dt.setData("text/html", htmlPayload);
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
          const after = el.textContent ?? "";
          return { ok: true, isContentEditable: true, before, after, changed: after !== before };
        },
        args: [selector, text, html ?? null],
      });
      const r = out?.[0]?.result as {
        ok?: true; isContentEditable?: boolean; before?: string; after?: string;
        changed?: boolean; errorCode?: string; error?: string;
      } | undefined;
      if (r?.errorCode) mapPageError(r, selector);
      // 非 contentEditable:提示改用 fill(不假成功)。
      if (r && r.isContentEditable === false) {
        throw vtxError(VtxErrorCode.INVALID_TARGET, r.error ?? `Element ${selector} is not contentEditable; use vortex_fill`);
      }
      // 族 A 回读护栏:非空文本派发后内容未变 → 编辑器拒收(很可能校验 isTrusted)。
      if (text !== "" && r?.changed === false) {
        throw vtxError(
          VtxErrorCode.NO_EFFECT,
          `Element ${selector} rejected synthetic paste (contentEditable unchanged; editor may gate on isTrusted — try vortex_fill, or a future trusted-paste escalation)`,
          { selector, extras: { attempted: text } },
        );
      }
      const result = { success: true, pasted: text.length, path: "synthetic-clipboard" };
      return __heal.healed ? { ...result, healed: true } : result;
    },
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/dom-paste.test.ts`
Expected: PASS（全部）
Run: `pnpm --filter @vortex-browser/extension exec tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: 提交**（git-commit skill）

```
feat: dom.paste handler 合成 ClipboardEvent 富文本粘贴

MAIN world 构造 DataTransfer + 派发合成 paste 触发编辑器自管 Markdown
转换,族 A 回读护栏内容未变报 NO_EFFECT,非 contentEditable 提示改用 fill
```

---

## Task 3: mcp 暴露 `vortex_paste` 公开工具 + dispatch 路由

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts`（`PUBLIC_TOOLS` 数组，紧随 `vortex_fill` ToolDef 之后）
- Modify: `packages/mcp/src/tools/dispatch.ts`（`dispatchNewTool` switch，加 `case "vortex_paste"`）
- Test: `packages/mcp/tests/vortex-paste-dispatch.test.ts`

**Interfaces:**
- Consumes: `TargetRequired`、`tabFields`（schemas-public.ts 顶部已定义）
- Produces: 公开工具 `vortex_paste`（action 字段 `"dom.paste"`）；dispatch 把 `vortex_paste` → `{ action: "dom.paste", params }`（params 已含 server.ts 翻译后的 selector/index + text/html）

- [ ] **Step 1: 写失败测试**

新建 `packages/mcp/tests/vortex-paste-dispatch.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { dispatchNewTool } from "../src/tools/dispatch.js";
import { getToolDefs } from "../src/tools/registry.js";

describe("vortex_paste 公开工具", () => {
  it("出现在 tools/list", () => {
    const def = getToolDefs().find((d) => d.name === "vortex_paste");
    expect(def).toBeDefined();
    expect(def!.description.length).toBeLessThanOrEqual(60);
  });
  it("schema 含 target + text(必填) + html(可选)", () => {
    const def = getToolDefs().find((d) => d.name === "vortex_paste")!;
    const props = (def.schema as any).properties;
    expect(props.target).toBeDefined();
    expect(props.text).toBeDefined();
    expect(props.html).toBeDefined();
    expect((def.schema as any).required).toEqual(expect.arrayContaining(["target", "text"]));
  });
  it("dispatch 路由到 dom.paste", () => {
    const { action } = dispatchNewTool("vortex_paste", { selector: "#ed", text: "# t" });
    expect(action).toBe("dom.paste");
  });
});
```

> 注：`dispatchNewTool` 的导出名/签名以 `dispatch.ts` 实际为准（可能是默认 switch 函数）；若名称不同，按文件实际导出调整 import 与调用。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/mcp exec vitest run tests/vortex-paste-dispatch.test.ts`
Expected: FAIL（工具未注册 / dispatch 无 case）

- [ ] **Step 3a: 加公开 schema**

在 `packages/mcp/src/tools/schemas-public.ts` 的 `vortex_fill` ToolDef 之后插入：

```typescript
  {
    name: "vortex_paste",
    action: "dom.paste",
    description: "Paste text/html into a rich-text editor (Markdown auto-convert).",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        text: { type: "string" as const },
        html: { type: "string" as const },
        force: { type: "boolean" as const },
        ...tabFields,
      },
      required: ["target", "text"],
    },
  },
```

> description 实测 ≤60 char（"Paste text/html into a rich-text editor (Markdown auto-convert)." = 60）；若超出则去掉括号补语压到 ≤60。

- [ ] **Step 3b: 加 dispatch case**

在 `packages/mcp/src/tools/dispatch.ts` 的 switch 内（`vortex_fill` case 附近）加：

```typescript
    case "vortex_paste":
      // target 已由 server.ts 翻译成 selector / index+snapshotId；text/html 随 params 透传。
      return { action: "dom.paste", params };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @vortex-browser/mcp exec vitest run tests/vortex-paste-dispatch.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**（git-commit skill）

```
feat: 暴露 vortex_paste 公开工具并路由到 dom.paste
```

---

## Task 4: 更新 I15 tools/list 预算不变量

**Files:**
- Modify: `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`

**Interfaces:**
- Consumes: Task 3 注册的 `vortex_paste`
- Produces: 不变量随真实 payload 调整（cap / 数量 20→21 / names / caps 21→22）

- [ ] **Step 1: 先跑现有不变量确认它因新增工具而失败**

Run: `pnpm --filter @vortex-browser/mcp exec vitest run tests/invariants/I15.tools-list-budget.test.ts`
Expected: FAIL（字节超 cap / 数量 ≠20 / names 不匹配）——记录实测 payload 字节数 N。

- [ ] **Step 2: 按实测调整不变量**

1. 顶部追加注释（沿历次格式）：`// <当前版本>: 7800 → <N 向上取整到 +100>。vortex_paste 新增(target+text+html+force schema),payload 实测 <N>B,cap +100 至 <cap>。`
2. 字节断言 `toBeLessThanOrEqual(7800)` → 新 cap；断言文案同步。
3. `expect(defs.length).toBe(20)` → `21`（两处：主断言 + caps「默认面仍 20」→ 21）。
4. caps「--caps=testing 时公开面 = 21」→ `22`。
5. names 列表（line 94-115）按字母序插入 `"vortex_paste"`（在 `"vortex_observe"` 与 `"vortex_press"` 之间）。

- [ ] **Step 3: 跑测试确认通过 + 全量 mcp 测试**

Run: `pnpm --filter @vortex-browser/mcp exec vitest run tests/invariants/I15.tools-list-budget.test.ts`
Expected: PASS
Run: `pnpm --filter @vortex-browser/mcp test`
Expected: 全绿（捕获 v2-shortboards 等其他工具计数耦合；若有数量断言失败一并按真实数更新）

- [ ] **Step 4: 提交**（git-commit skill）

```
test: I15 预算纳入 vortex_paste(cap/数量/names 同步)
```

---

# Phase 2 — 缺口二：动态 SPA act 自愈增强

## Task 5: B1 — heal 候选集窄→宽兜底

**Files:**
- Modify: `packages/extension/src/action/heal.ts`（`tryHealSelector` 的 executeScript func）
- Test: `packages/extension/tests/heal-broaden-candidates.test.ts`

**Interfaces:**
- Consumes: `__vortexDomResolve.queryAllDeep`、注入的 `__inlineMatch`（既有匹配体，不改）
- Produces: 窄候选集（`a,button,input,select,textarea,[role],[onclick],[tabindex]`）按 name 零命中时，回退到宽候选集（追加 `td,th,li,[class]`）再匹配一次；歧义仍由既有 `AMBIGUOUS_DESCRIPTOR` 护栏拒绝。匹配语义（`matchByDescriptor`/`__inlineMatch`）不变 → 无 inline↔真源漂移。

- [ ] **Step 1: 写失败测试**

新建 `packages/extension/tests/heal-broaden-candidates.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { __healInlineBody } from "../src/action/heal.js";

const inlineMatch = new Function(
  "candidates", "desc",
  `${__healInlineBody}; return __inlineMatch(candidates, desc);`,
) as (c: Element[], d: { role?: string; name: string }) => { kind: string; el?: Element };

describe("B1 heal 候选集放宽:裸单元格可被名字命中", () => {
  beforeEach(() => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    (globalThis as any).document = dom.window.document;
    (globalThis as any).Element = dom.window.Element;
  });
  function el(html: string): Element {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild!;
  }
  it("窄选择器集捞不到裸 td(无 role/onclick/tabindex)", () => {
    const narrow = "a,button,input,select,textarea,[role],[onclick],[tabindex]";
    const wrap = el(`<table><tr><td>订单 A123</td></tr></table>`);
    document.body.appendChild(wrap);
    expect(document.querySelectorAll(narrow).length).toBe(0);
  });
  it("宽集含 td → 内联匹配体按可访问名唯一命中", () => {
    const wrap = el(`<table><tr><td>订单 A123</td><td>订单 B456</td></tr></table>`);
    document.body.appendChild(wrap);
    const broad = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role],[onclick],[tabindex],td,th,li,[class]"));
    const r = inlineMatch(broad, { name: "订单 A123" });
    expect(r.kind).toBe("unique");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/heal-broaden-candidates.test.ts`
Expected: FAIL（第二条:宽集匹配前 heal.ts 尚未提供宽集路径——此 jsdom 测试本身验证「宽集能命中」的前提成立，先确认；handler 改动由下方源码契约 + Step 4 全量护栏锁）

> 说明：本测试锁「匹配体对宽候选集能唯一命中裸 td」这一前提；候选集选择字符串改动用下一条源码契约断言锁。

- [ ] **Step 3: 改 heal.ts 候选集（窄→宽兜底）**

在 `packages/extension/src/action/heal.ts` 的 executeScript `func` 内，把原单次窄集匹配改为窄→宽两段：

```typescript
      const NARROW = "a,button,input,select,textarea,[role],[onclick],[tabindex]";
      // B1:虚拟表格单元格常是裸 <td>/<div>(无 role/onclick/tabindex),窄集永远捞不到 →
      // 必然 STALE_REF。窄集按 name 零命中时回退宽集(追加 td/th/li/[class])再匹配一次,
      // 歧义仍由 AMBIGUOUS_DESCRIPTOR 护栏拒绝,不引入误选。
      const BROAD = NARROW + ",td,th,li,[class]";
      let candidates = qad(NARROW) as Element[];
      let r = match(candidates, desc) as { kind: string; el?: Element };
      if (r.kind === "none") {
        candidates = qad(BROAD) as Element[];
        r = match(candidates, desc) as { kind: string; el?: Element };
      }
```

（删除原 `const candidates = qad("a,button,…")` 与紧随的 `const r = match(...)` 单段。）

向测试追加源码契约：

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HEAL_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "action", "heal.ts"), "utf8");
describe("B1 heal.ts 候选集源码契约", () => {
  it("零命中时回退宽集(含 td)", () => {
    expect(HEAL_SRC).toMatch(/r\.kind\s*===\s*"none"/);
    expect(HEAL_SRC).toMatch(/td,th,li/);
  });
});
```

- [ ] **Step 4: 跑测试 + heal 全量回归（守歧义/对齐护栏）**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/heal-broaden-candidates.test.ts tests/heal-inline-alignment.test.ts tests/heal-resolve.test.ts tests/heal-is-stale.test.ts tests/dom-click-heal.test.ts tests/dom-heal-error-semantics.test.ts`
Expected: 全 PASS（含既有歧义拒绝、inline↔真源对齐不破）

- [ ] **Step 5: 提交**（git-commit skill）

```
fix: heal 候选集窄集零命中回退宽集,捞回裸表格单元格

虚拟表格裸 td/div 无 role/onclick/tabindex 落不进窄集必 STALE_REF,
窄集零命中追加 td/th/li/[class] 再匹配,歧义仍由既有护栏拒绝
```

---

## Task 6: B2 — 自旋期 descriptor 重定位

**Files:**
- Modify: `packages/extension/src/action/auto-wait.ts`（`WaitOptions` + `waitActionable` 循环）
- Modify: `packages/extension/src/handlers/dom.ts`（`healAwareGate` 注入重定位回调）
- Test: `packages/extension/tests/auto-wait-reresolve.test.ts`

**Interfaces:**
- Consumes（auto-wait）：`checkActionability`（既有）
- Produces：`WaitOptions` 新增可选 `reresolve?: () => Promise<string | null>`；`waitActionable` 在连续 `NOT_ATTACHED` 累计达阈值（`RERESOLVE_AFTER_MS = 500`）且 `reresolve` 存在时调用一次，返回非空新 selector 则切换 `selector` 继续自旋（每次成功重定位后重置阈值计时，避免无限重定位）。`healAwareGate` 把 `() => tryHealSelector(...).catch(() => null)` 作为 `reresolve` 传入首跑 gate。
- 兼容：未传 `reresolve` 时行为与当前**逐字节一致**（默认 undefined）。

- [ ] **Step 1: 写失败测试**

新建 `packages/extension/tests/auto-wait-reresolve.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const checkMock = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...a: unknown[]) => checkMock(...a),
}));

import { waitActionable } from "../src/action/auto-wait.js";

describe("B2 自旋期 descriptor 重定位", () => {
  beforeEach(() => vi.clearAllMocks());

  it("持续 NOT_ATTACHED 达阈值后调用 reresolve 并切换 selector", async () => {
    // 前若干轮对原 selector 恒 NOT_ATTACHED;reresolve 给出新 selector 后 ok。
    const reresolve = vi.fn().mockResolvedValue("[data-vtx-heal=\"h1\"]");
    let switched = false;
    checkMock.mockImplementation((_t, _f, sel: string) => {
      if (sel.startsWith("[data-vtx-heal")) { switched = true; return Promise.resolve({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 } }); }
      return Promise.resolve({ ok: false, reason: "NOT_ATTACHED" });
    });
    const res = await waitActionable(1, undefined, "#stale", { timeout: 3000, reresolve });
    expect(reresolve).toHaveBeenCalledTimes(1);
    expect(switched).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("未传 reresolve 时维持原超时抛错行为", async () => {
    checkMock.mockResolvedValue({ ok: false, reason: "NOT_ATTACHED" });
    await expect(
      waitActionable(1, undefined, "#stale", { timeout: 300 }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    // 无 reresolve 调用发生（本 case 未提供）。
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/auto-wait-reresolve.test.ts`
Expected: FAIL（`reresolve` 选项未实现，第一条不切换）

- [ ] **Step 3a: 改 auto-wait.ts**

`WaitOptions` 接口加字段：

```typescript
export interface WaitOptions extends CheckOptions {
  /** Default 2000ms. */
  timeout?: number;
  /** B2:持续 NOT_ATTACHED 达阈值时按 descriptor 重定位,返回新 selector(无则 null)。@since 当前版本 */
  reresolve?: () => Promise<string | null>;
}
```

在 `waitActionable` 内，循环前加阈值常量与计时；循环里把固定 `selector` 改为可变 `let curSelector`，并在持续 NOT_ATTACHED 达阈值时重定位：

```typescript
  // B2:descriptor 重定位阈值。持续 NOT_ATTACHED 累计超过此值即按 descriptor 重定位
  // (而非死等整个 timeout 后才自愈一次),应对虚拟表格/富文本高频重渲染。
  const RERESOLVE_AFTER_MS = 500;
  let curSelector = selector;
  let notAttachedSince: number | null = null;
  let reresolved = false;
```

把循环体内 `checkActionability(tabId, frameId, selector, options)` 的 `selector` 改为 `curSelector`；在记录 `lastReason` 之后插入：

```typescript
    if (result.reason === "NOT_ATTACHED" && options.reresolve && !reresolved) {
      const now = Date.now();
      if (notAttachedSince === null) notAttachedSince = now;
      else if (now - notAttachedSince >= RERESOLVE_AFTER_MS) {
        const next = await options.reresolve();
        reresolved = true; // 每跑 gate 最多重定位一次,避免抖动无限重定位
        if (next) { curSelector = next; notAttachedSince = null; continue; }
      }
    } else if (result.reason !== "NOT_ATTACHED") {
      notAttachedSince = null;
    }
```

> 终态错误/heal 上报里若引用 `selector`，统一改 `curSelector`（确保报的是最终用的选择器）。

- [ ] **Step 3b: 改 dom.ts healAwareGate 注入 reresolve**

把 `healAwareGate` 首跑 gate 的调用补上 `reresolve`（仅当 descriptor 存在）。在 `dom.ts` 的 `healAwareGate` 内，首次 `waitActionableAutoForce(...)` 改为透传一个 reresolve 选项：

```typescript
  // B2:首跑 gate 即注入自旋期重定位(descriptor 存在才有意义),让高频重渲染元素
  // 在 2s 超时前就被按名重新锁定,而非死等超时后才一次性 heal。
  const reresolve = descriptor
    ? () => tryHealSelector(tabId, frameId, descriptor).catch(() => null)
    : undefined;
  try {
    await waitActionableAutoForce(tabId, frameId, selector, { ...options, reresolve }, force);
    return { selector, healed: false };
  } catch (err) {
    // 既有的超时后一次性 heal 兜底保留不变(应对首跑 gate reresolve 已用尽/仍失败)。
    ...
  }
```

> 确认 `waitActionableAutoForce` 把 options 透传给 `waitActionable`（若它只取部分字段，需让它 spread options 透传 `reresolve`）。`tryHealSelector` 已在 dom.ts import。

- [ ] **Step 4: 跑测试 + auto-wait/gated 原语全量回归**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/auto-wait-reresolve.test.ts tests/dom-action-default-timeout.test.ts tests/actionability-probe-timeout.test.ts tests/type-not-stable-retry.test.ts tests/dom-fill-not-stable-retry.test.ts tests/dom-click-heal.test.ts`
Expected: 全 PASS（默认行为字节级不变 + 新重定位生效）

- [ ] **Step 5: 提交**（git-commit skill）

```
fix: act 自旋期按 descriptor 重定位,不再死等超时后才自愈一次

持续 NOT_ATTACHED 达 500ms 即按 descriptor 重锁元素切换 selector 继续
自旋,应对虚拟表格/富文本高频重渲染;未传 reresolve 行为字节级不变
```

---

## Task 7: B3 — 终态错误补动态 SPA 指引

**Files:**
- Modify: `packages/extension/src/action/auto-wait.ts`（终态 NOT_ATTACHED/TIMEOUT message）
- Modify（如适用）: `packages/shared/src/errors.hints.ts`（`STALE_REF` / `TIMEOUT` 默认 hint）
- Test: `packages/extension/tests/auto-wait-dynamic-hint.test.ts`

**Interfaces:**
- Produces：gate 因 NOT_ATTACHED 自旋耗尽（且 reresolve 也未救回）时，终态 message/hint 含动态 SPA 套路：「act 前紧贴一次 vortex_observe；强动态区改用 vortex_evaluate 现查 DOM 或框架实例（如 el.__vueParentComponent）；可加大 timeout」。

- [ ] **Step 1: 写失败测试**

新建 `packages/extension/tests/auto-wait-dynamic-hint.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
const checkMock = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...a: unknown[]) => checkMock(...a),
}));
import { waitActionable } from "../src/action/auto-wait.js";

describe("B3 终态动态 SPA 指引", () => {
  beforeEach(() => vi.clearAllMocks());
  it("NOT_ATTACHED 超时终态 message 含 observe/evaluate 套路", async () => {
    checkMock.mockResolvedValue({ ok: false, reason: "NOT_ATTACHED" });
    try {
      await waitActionable(1, undefined, "#stale", { timeout: 200 });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/observe/i);
      expect(e.message).toMatch(/evaluate/i);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/auto-wait-dynamic-hint.test.ts`
Expected: FAIL（现 message 无 observe/evaluate 指引）

- [ ] **Step 3: 改终态 message**

在 `auto-wait.ts` 终态分支（`else { message = \`Actionability timeout after ${timeout}ms; last reason: ${lastReason ...}\` }`）里，当 `lastReason === "NOT_ATTACHED"` 时改用动态 SPA 指引：

```typescript
  } else if (lastReason === "NOT_ATTACHED") {
    message =
      `Actionability timeout after ${timeout}ms; last reason: NOT_ATTACHED ` +
      `(element kept detaching — likely a re-rendering SPA, e.g. virtual-scroll table or rich-text editor). ` +
      `Re-run vortex_observe immediately before act to refresh the ref; for highly dynamic regions ` +
      `locate via vortex_evaluate (query the live DOM or framework instance, e.g. el.__vueParentComponent); ` +
      `or raise timeout.`;
  } else {
    message = `Actionability timeout after ${timeout}ms; last reason: ${lastReason ?? "unknown"}`;
  }
```

- [ ] **Step 4: 跑测试确认通过 + auto-wait 既有终态文案测试回归**

Run: `pnpm --filter @vortex-browser/extension exec vitest run tests/auto-wait-dynamic-hint.test.ts tests/auto-wait-reresolve.test.ts tests/dom-action-default-timeout.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 提交**（git-commit skill）

```
fix: act 终态 NOT_ATTACHED 提示动态 SPA 套路(observe/evaluate)
```

---

# Phase 3 — 文档订正 + 验证收口

## Task 8: 订正原根因文档误诊

**Files:**
- Modify: `docs/2026-06-25-yuque-paste-and-dynamic-spa-rootcause.md`

- [ ] **Step 1: 改写缺口二 §3 + 改进表**

把 §3 第 1 点「act 默认 actionability 超时仅 2000ms…」之外的「死盯同一 stale ref / 不重解析选择器」表述删除，替换为三条真因（B1/B2/B3，照 spec §2）；改进表「动态 SPA act 失稳」行从「自旋时重新解析选择器」改为「heal 候选集放宽 + 自旋期 descriptor 重定位 + 终态指引」。在文首结论补一行：「订正：原『不重解析选择器』为误诊——gate 每轮已重解析选择器（actionability.ts:293），真因见 §3。」

- [ ] **Step 2: 提交**（git-commit skill）

```
docs: 订正根因文档缺口二误诊(改为三条真因)
```

---

## Task 9: 全量回归 + 活浏览器 spike 验证（承重墙 + isTrusted 硬风险）

**Files:** 无（验证 task）

- [ ] **Step 1: 全量单测 + 构建**

Run: `pnpm --filter @vortex-browser/shared build && pnpm --filter @vortex-browser/extension test && pnpm --filter @vortex-browser/mcp test`
Expected: 三包测试全绿。

- [ ] **Step 2: bench 回归**

Run: `pnpm --filter @vortex-browser/vortex-bench bench run`（按仓库实际 bench 命令；smoke 至少 `latency-p50`）
Expected: 无回归（动态 SPA heal/auto-wait 改动不破既有 case）。

- [ ] **Step 3: 活浏览器 spike——缺口一 isTrusted 验证（硬风险）**

用真实登录态 Chrome（dev-all 联调环境）对真实语雀 Lake 文档：
1. `vortex_navigate` 到一篇可编辑语雀文档；`vortex_observe` 定位 Lake 编辑器 contenteditable。
2. `vortex_paste({target:<ref>, text:"# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |"})`。
3. `vortex_screenshot` + `vortex_extract`/`vortex_evaluate` 回读：确认 `#` 标题转为富文本 H1、表格语法转为真实表格（而非纯文本）。
- **通过** → 缺口一收口。
- **不通过（Lake 校验 isTrusted 拒收，返回 NO_EFFECT）** → 记录到 spec §1.6，按 §1.5 方案 T 另开计划（首版不实现，此处只确认降级路径诚实报 NO_EFFECT 非假成功）。

- [ ] **Step 4: 活浏览器 spike——缺口二动态 SPA 验证（承重墙）**

对一个虚拟滚动重渲染场景（voc 工单 vxe-table，或公开虚拟表格 demo）：
1. `vortex_observe` 拿单元格 ref → 滚动触发重渲染 → `vortex_act` click/该单元格。
2. 确认 B1+B2 自愈命中（成功，或 heal 失败时终态 hint 含 observe/evaluate 套路）。
- 记录 spike 结论（成功率 / 降级文案）到本计划末或 memory。

- [ ] **Step 5: 收口提交（如 spike 触发任何微调）**（git-commit skill）

```
chore: vortex_paste + 动态 SPA 自愈 spike 收口
```

---

## Self-Review（写计划后自查）

- **Spec 覆盖**：缺口一 vortex_paste（§1）→ Task 1-4 + Task 9 Step 3；缺口二 B1/B2/B3（§2.1/2.2/2.3）→ Task 5/6/7 + Task 9 Step 4；文档订正（§2.4）→ Task 8；非目标（§5）→ Global Constraints 已列「不实现项」。验收标准（spec §4）→ Task 9。无遗漏。
- **占位符**：无 TBD/TODO；每个改码步骤含完整代码与确切命令。
- **类型一致**：`DomActions.PASTE`="dom.paste" 贯穿 Task 1/2/3；`vortex_paste` action 字段="dom.paste"；`WaitOptions.reresolve: () => Promise<string|null>` 在 Task 6 定义并被 healAwareGate 注入、auto-wait 消费，签名一致；`path:"synthetic-clipboard"` Task 2 产出、Task 2 测试断言一致。
- **已知待实现期确认点**（非占位，是依赖外部实际签名的校验项，已在对应步骤标注）：`dispatchNewTool` 导出名（Task 3 Step 1 注）、`waitActionableAutoForce` 是否透传 options（Task 6 Step 3b 注）、`VtxErrorCode` 是否含 `NOT_CONTENTEDITABLE`（Task 2 Step 3 注，缺则复用 `INVALID_TARGET`）。
