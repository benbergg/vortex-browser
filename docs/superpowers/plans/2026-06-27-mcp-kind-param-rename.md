# MCP 顶层 `kind` 参数改名 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 vortex MCP 三个工具的顶层 `kind` 参数改名（fill/fill_form→`widget`，wait_idle→`until`），规避 OpenHands SDK 判别器字段撞名，使 agent-canvas 能正常加载 vortex MCP。

**Architecture:** 只改面向 LLM 的 MCP 参数键名；extension 内部 `dom.commit` driver 仍按 `kind` 取参，由 dispatch / server 映射层把新名映射回 `kind` 再下发，extension 零改动。`COMMIT_KINDS` 枚举值不变。

**Tech Stack:** TypeScript、pnpm monorepo、vitest。

## Global Constraints

- 硬切，不保留旧 `kind`：schema 与映射层只认新名。
- `COMMIT_KINDS` 枚举值（cascader/select/daterange…）保持不变，只改参数键名。
- extension 端 wire protocol（`dom.commit`/`dom.ts`/`commit-drivers` 等的 `kind`）**不动**。
- `vortex_fill_form` schema 的 properties 字段**禁带 description**（I15 §0.2.1 字节预算）。
- **不改 `vortex-migrate` 代码**；迁移靠 CHANGELOG 文档指引（见 Task 5）。
- 提交一律使用 **froggo-skills:git-commit** skill（全局规范），不裸跑 `git commit`。
- 测试命令：在对应包目录下 `npx vitest run <file>`；全量 `npx vitest run`。
- vortex 仓库当前有未跟踪的 `reports/` 与若干已删除测试文件，**提交时只 `git add` 本计划涉及的文件**，不要 `git add -A`。

---

### Task 1: `vortex_fill` 顶层 `kind` → `widget`（schema + dispatch）

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:369-383`（public fill def）
- Modify: `packages/mcp/src/tools/schemas.ts:350-369`（internal fill def）
- Modify: `packages/mcp/src/tools/dispatch.ts:67-78`（`case "vortex_fill"`）
- Test: `packages/mcp/tests/tool-dispatch.test.ts`、`packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`、`packages/mcp/tests/vortex_fill_force.test.ts`

**Interfaces:**
- Produces: `dispatchNewTool("vortex_fill", { widget, value, ... })` → 输出 `{ action: "dom.commit", params: { kind: <widget值>, value, ... } }`（**输出仍带 `kind`**，映射给 extension）。无 `widget` → `{ action: "dom.fill", ... }`。

- [ ] **Step 1: 改测试为新参数名（先红）**

`packages/mcp/tests/tool-dispatch.test.ts` —— 把所有 `vortex_fill` 用例的**输入** `kind:` 改为 `widget:`，**输出**断言 `params.kind` 保持不变：

```typescript
  it("vortex_fill widget:cascader → dom.commit", () => {
    const { action } = dispatchNewTool("vortex_fill", { widget: "cascader", value: "x" })!;
    expect(action).toBe("dom.commit");
  });

  it("vortex_fill widget:checkbox-group → dom.commit", () => {
    const { action } = dispatchNewTool("vortex_fill", { widget: "checkbox-group", value: ["a"] })!;
    expect(action).toBe("dom.commit");
  });

  it("vortex_fill 无 widget → dom.fill", () => {
    const { action } = dispatchNewTool("vortex_fill", { value: "x" })!;
    expect(action).toBe("dom.fill");
  });
```

并把下方结构化 value 用例（原 L302-329）输入 `kind` 改 `widget`，**输出 `params.kind` 断言保持**：

```typescript
  it("vortex_fill(widget=cascader, value 为 JSON 字符串数组) 解析回数组", () => {
    const { action, params } = dispatchNewTool("vortex_fill", {
      target: "@e1",
      widget: "cascader",
      value: '["Guide","Disciplines","Consistency"]',
    })!;
    expect(action).toBe("dom.commit");
    expect(params.value).toEqual(["Guide", "Disciplines", "Consistency"]);
    expect(params.kind).toBe("cascader"); // 映射回 kind 下发 extension
  });

  it("vortex_fill(widget=checkbox-group, value 为 JSON 字符串对象) 解析回对象", () => {
    const { params } = dispatchNewTool("vortex_fill", {
      target: "@e1",
      widget: "checkbox-group",
      value: '{"values":["A","B"]}',
    })!;
    expect(params.value).toEqual({ values: ["A", "B"] });
  });

  it("vortex_fill(widget=select, 单值普通字符串) 不被 JSON.parse 误伤", () => {
    const { params } = dispatchNewTool("vortex_fill", {
      target: "@e1",
      widget: "select",
      value: "北京",
    })!;
    expect(params.value).toBe("北京");
  });
```

（原「纯文本 fill，无 kind」用例去掉 `kind`/`widget` 即可，断言不变。）

`packages/mcp/tests/invariants/I15.tools-list-budget.test.ts` —— H-7 两个用例（原 L212-220）把 `properties.kind.enum` 改 `properties.widget.enum`：

```typescript
  it("public vortex_fill.widget.enum == COMMIT_KINDS", () => {
    const fill = getPublicToolDefs().find((d) => d.name === "vortex_fill")!;
    const enumVals = (fill.schema as { properties: { widget: { enum: string[] } } }).properties.widget.enum;
    expect(enumVals).toEqual([...COMMIT_KINDS]);
  });

  it("internal vortex_fill.widget.enum == COMMIT_KINDS", () => {
    const fill = getAllToolDefs().find((d) => d.name === "vortex_fill")!;
    const enumVals = (fill.schema as { properties: { widget: { enum: string[] } } }).properties.widget.enum;
    expect(enumVals).toEqual([...COMMIT_KINDS]);
  });
```

> 保持原文件里 `getPublicToolDefs`/`getAllToolDefs` 的既有引用方式；只改 `kind`→`widget` 与用例标题。

`packages/mcp/tests/vortex_fill_force.test.ts:47-49` —— 断言数组里的 `"kind"` 改 `"widget"`：

```typescript
      expect.arrayContaining(["target", "value", "widget", "force"]),
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd packages/mcp && npx vitest run tests/tool-dispatch.test.ts tests/invariants/I15.tools-list-budget.test.ts tests/vortex_fill_force.test.ts
```
Expected: FAIL（dispatch 仍解构 `kind`；schema properties 仍是 `kind`）。

- [ ] **Step 3: 改 dispatch 实现**

`packages/mcp/src/tools/dispatch.ts` `case "vortex_fill"`：

```typescript
    case "vortex_fill": {
      const { widget, value, ...rest } = params;
      if (!widget) {
        // 纯文本 fill：value 是字符串数据，原样透传（不 parse，避免误把
        // 形似 JSON 的文本当结构化值）。
        return { action: "dom.fill", params: { value, ...rest } };
      }
      // 面向 LLM 的参数名是 widget；extension 的 dom.commit driver 仍按 kind 取参，
      // 此处映射回 kind 下发。结构化 value 可能被 client 序列化成 JSON 字符串，先还原。
      return { action: "dom.commit", params: { kind: widget, value: parseStructuredValue(value), ...rest } };
    }
```

- [ ] **Step 4: 改 schema（public + internal）**

`packages/mcp/src/tools/schemas-public.ts` 的 `vortex_fill`：描述（L371）与字段（L377）：

```typescript
    description: "Fill form field; widget=cascader/select/daterange for composite widgets.",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        value: {},
        widget: { enum: [...COMMIT_KINDS] },
        force: { type: "boolean" },
        ...tabFields,
      },
      required: ["target", "value"],
    },
```

`packages/mcp/src/tools/schemas.ts` 的 internal `vortex_fill`：描述（L352）与字段（L358）：

```typescript
      description: "Set field value directly. Use widget for framework components. value shape depends on widget: daterange/datetimerange={start,end}; cascader=[level1,level2,...]; select/checkbox-group=string|string[].",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          value: { description: "Plain value for inputs; {start,end} for date ranges; array for cascader/multi-select." },
          widget: {
            type: "string",
            enum: [...COMMIT_KINDS],
            description: "Omit for plain inputs. Targets Element Plus / Ant Design composite widgets.",
          },
          fallbackToNative: { type: "boolean", default: false },
          timeout: { type: "number", default: 8000 },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["value"],
      },
```

- [ ] **Step 5: 跑测试确认绿**

```bash
cd packages/mcp && npx vitest run tests/tool-dispatch.test.ts tests/invariants/I15.tools-list-budget.test.ts tests/vortex_fill_force.test.ts
```
Expected: PASS。

- [ ] **Step 6: 提交（用 git-commit skill）**

`git add` 仅限本 task 文件：`schemas-public.ts schemas.ts dispatch.ts tests/tool-dispatch.test.ts tests/invariants/I15.tools-list-budget.test.ts tests/vortex_fill_force.test.ts`，然后用 froggo-skills:git-commit skill 提交，message 形如：`fix(mcp): rename vortex_fill top-level kind param to widget`。

---

### Task 2: `vortex_fill_form` `fields[].kind` → `widget`（schema + server）

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:405-431`（fill_form def）
- Modify: `packages/mcp/src/server.ts:504-580`（fill_form 分支）
- Test: `packages/mcp/tests/fill-form.test.ts`

**Interfaces:**
- Consumes: server 端 `field.widget` 决定 `dom.fill` vs `dom.commit`；存在时下发 `fieldParams.kind = field.widget`。

- [ ] **Step 1: 改测试（先红）**

`packages/mcp/tests/fill-form.test.ts:30-35`：

```typescript
  it("vortex_fill_form schema.fields.items 支持可选 widget", () => {
    const def = getToolDef("vortex_fill_form");
    const props = (def!.schema as { properties: Record<string, any> }).properties;
    const items = props.fields.items as Record<string, any>;
    expect(items.properties?.widget).toBeDefined();
  });
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd packages/mcp && npx vitest run tests/fill-form.test.ts
```
Expected: FAIL（`items.properties.widget` 未定义）。

- [ ] **Step 3: 改 schema**

`packages/mcp/src/tools/schemas-public.ts` 的 `vortex_fill_form`：描述（L410）与 `fields[].kind`（L421）：

```typescript
    description: "Batch-fill multiple fields; partial-success per field. widget=cascader/select/daterange for composite widgets.",
    schema: {
      type: "object",
      properties: {
        fields: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              target: TargetRequired,
              value: {},
              widget: { enum: [...COMMIT_KINDS] },
              force: { type: "boolean" as const },
            },
            required: ["target", "value"],
          },
        },
        ...tabFields,
      },
      required: ["fields"],
    },
```

- [ ] **Step 4: 改 server fill_form 分支**

`packages/mcp/src/server.ts` —— 字段类型声明（原 L505-510）`kind?` → `widget?`：

```typescript
    const fields = params.fields as Array<{
      target: string;
      value: unknown;
      widget?: string;
      force?: boolean;
    }>;
```

分发逻辑（原 L559-566）`field.kind` → `field.widget`，下发仍用 `fieldParams.kind`：

```typescript
      // 复用 vortex_fill dispatch 逻辑：widget 存在 → dom.commit；否则 → dom.fill。
      // 面向 LLM 的字段名是 widget，映射回 kind 下发给 extension dom.commit driver。
      let action: string;
      if (!field.widget) {
        action = "dom.fill";
        fieldParams.value = field.value;
      } else {
        action = "dom.commit";
        fieldParams.kind = field.widget;
        // 结构化 value 可能被 client 序列化为 JSON 字符串，还原
        const raw = field.value;
        if (typeof raw === "string") {
          try {
            const parsed: unknown = JSON.parse(raw);
            fieldParams.value = parsed !== null && typeof parsed === "object" ? parsed : raw;
          } catch {
            fieldParams.value = raw;
          }
        } else {
          fieldParams.value = raw;
        }
      }
```

- [ ] **Step 5: 跑测试确认绿 + 类型检查**

```bash
cd packages/mcp && npx vitest run tests/fill-form.test.ts && npx tsc --noEmit
```
Expected: PASS，无类型错误。

- [ ] **Step 6: 提交（用 git-commit skill）**

`git add packages/mcp/src/tools/schemas-public.ts packages/mcp/src/server.ts packages/mcp/tests/fill-form.test.ts`，用 froggo-skills:git-commit 提交：`fix(mcp): rename vortex_fill_form field kind to widget`。

---

### Task 3: `vortex_wait_idle` 顶层 `kind` → `until`（schema + dispatch）

**Files:**
- Modify: `packages/mcp/src/tools/schemas.ts:286-305`（wait_idle def）
- Modify: `packages/mcp/src/tools/dispatch.ts:56-66`（`case "vortex_wait_idle"`）
- Test: `packages/mcp/tests/tool-dispatch.test.ts`

**Interfaces:**
- Produces: `dispatchNewTool("vortex_wait_idle", { until, idleMs })` → action 由 `until` 值（xhr/network/dom）决定；`idleMs` 仍映射到 `idleTime`/`quietMs`。该工具不下发 `kind` 给 extension（转成 action）。

- [ ] **Step 1: 改测试（先红）**

`packages/mcp/tests/tool-dispatch.test.ts` —— wait_idle 五个用例（原 L35-60）输入 `kind:` 改 `until:`：

```typescript
  it("vortex_wait_idle until:dom → dom.waitSettled", () => {
    const { action } = dispatchNewTool("vortex_wait_idle", { until: "dom" })!;
    expect(action).toBe("dom.waitSettled");
  });

  it("vortex_wait_idle until:network → page.waitForNetworkIdle", () => {
    const { action } = dispatchNewTool("vortex_wait_idle", { until: "network" })!;
    expect(action).toBe("page.waitForNetworkIdle");
  });

  it("vortex_wait_idle until:xhr → page.waitForXhrIdle", () => {
    const { action } = dispatchNewTool("vortex_wait_idle", { until: "xhr" })!;
    expect(action).toBe("page.waitForXhrIdle");
  });

  it("vortex_wait_idle idleMs 映射到 idleTime（xhr）", () => {
    const { params } = dispatchNewTool("vortex_wait_idle", { until: "xhr", idleMs: 300 })!;
    expect(params.idleTime).toBe(300);
    expect(params).not.toHaveProperty("idleMs");
  });

  it("vortex_wait_idle idleMs 映射到 quietMs（dom）", () => {
    const { params } = dispatchNewTool("vortex_wait_idle", { until: "dom", idleMs: 500 })!;
    expect(params.quietMs).toBe(500);
    expect(params).not.toHaveProperty("idleMs");
  });
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd packages/mcp && npx vitest run tests/tool-dispatch.test.ts -t "wait_idle"
```
Expected: FAIL（dispatch 仍解构 `kind`，`until` 为 undefined → 走默认 xhr 分支）。

- [ ] **Step 3: 改 dispatch 实现**

`packages/mcp/src/tools/dispatch.ts` `case "vortex_wait_idle"`：

```typescript
    case "vortex_wait_idle": {
      const { until, idleMs, ...rest } = params;
      const action = until === "network"
        ? "page.waitForNetworkIdle"
        : until === "dom"
        ? "dom.waitSettled"
        : "page.waitForXhrIdle";
      // idleMs → idleTime（network/xhr）或 quietMs（dom）
      const idleKey = until === "dom" ? "quietMs" : "idleTime";
      return { action, params: idleMs != null ? { [idleKey]: idleMs, ...rest } : rest };
    }
```

- [ ] **Step 4: 改 schema**

`packages/mcp/src/tools/schemas.ts` 的 `vortex_wait_idle`：描述（L289）与字段（L293）：

```typescript
      description: "Wait for network/XHR/DOM idle. until: 'xhr' (default) | 'network' | 'dom'.",
      schema: {
        type: "object",
        properties: {
          until: {
            type: "string",
            enum: ["xhr", "network", "dom"],
            default: "xhr",
          },
          idleMs: { type: "number" },
          timeout: { type: "number", default: 10000 },
          target: { type: "string" },
          ...optionalTabId,
        },
        required: [],
      },
```

- [ ] **Step 5: 跑测试确认绿**

```bash
cd packages/mcp && npx vitest run tests/tool-dispatch.test.ts
```
Expected: PASS（全文件，含工具总数等其余用例不受影响）。

- [ ] **Step 6: 提交（用 git-commit skill）**

`git add packages/mcp/src/tools/schemas.ts packages/mcp/src/tools/dispatch.ts packages/mcp/tests/tool-dispatch.test.ts`，用 froggo-skills:git-commit 提交：`fix(mcp): rename vortex_wait_idle kind param to until`。

---

### Task 4: `fill-reject` 面向 LLM 文案 `kind` → `widget`

**Files:**
- Modify: `packages/extension/src/patterns/fill-reject.ts:5,33-53`
- Test: `packages/extension/tests/fill-reject-patterns.test.ts:29`

**Interfaces:**
- Produces: `FILL_REJECT_PATTERNS[].suggestedTool` / `.fixExample` 文案使用 `widget=` / `widget:`（page-side 注入后输出给 LLM）。

- [ ] **Step 1: 改测试（先红）**

`packages/extension/tests/fill-reject-patterns.test.ts:29`：

```typescript
      expect(p.fixExample).toMatch(/widget:/);
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd packages/extension && npx vitest run tests/fill-reject-patterns.test.ts
```
Expected: FAIL（fixExample 仍含 `kind:`）。

- [ ] **Step 3: 改文案**

`packages/extension/src/patterns/fill-reject.ts` —— 三个 pattern 的 `suggestedTool` / `fixExample` 里 `kind=` → `widget=`、`kind:` → `widget:`，注释（L5）同步：

```typescript
// ...提示调用方改走 vortex_fill 的 widget 参数。
```

```typescript
    suggestedTool: 'vortex_fill with widget="datetimerange" (or "daterange" for date-only)',
    fixExample:
      'vortex_fill({target:"@eN", widget:"datetimerange", value:{start:"2026-03-01 00:00:00", end:"2026-03-31 23:59:59"}})',
```

```typescript
    suggestedTool: 'vortex_fill with widget="cascader"',
    fixExample:
      'vortex_fill({target:"@eN", widget:"cascader", value:["level1","level2"]})',
```

```typescript
    suggestedTool: 'vortex_fill with widget="daterange" (or "datetimerange" if it includes time)',
    fixExample:
      'vortex_fill({target:"@eN", widget:"daterange", value:{start:"2026-03-01", end:"2026-03-31"}})',
```

- [ ] **Step 4: 跑测试确认绿**

```bash
cd packages/extension && npx vitest run tests/fill-reject-patterns.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交（用 git-commit skill）**

`git add packages/extension/src/patterns/fill-reject.ts packages/extension/tests/fill-reject-patterns.test.ts`，用 froggo-skills:git-commit 提交：`fix(extension): update fill-reject hints kind→widget`。

---

### Task 5: 迁移文档 + 全量验证

**Files:**
- Modify: `CHANGELOG.md`（仓库根）

- [ ] **Step 1: CHANGELOG 记录手动迁移指引**

在 `CHANGELOG.md` 顶部新增一节（Breaking）：

```markdown
### Breaking — MCP 参数改名（规避 OpenHands SDK `kind` 判别器撞名）

顶层 `kind` 参数与 OpenHands agent-sdk 的判别器保留字段冲突，已硬切改名：

- `vortex_fill({ kind: X })` → `vortex_fill({ widget: X })`
- `vortex_fill_form({ fields: [{ kind: X }] })` → `vortex_fill_form({ fields: [{ widget: X }] })`
- `vortex_wait_idle({ kind: X })` → `vortex_wait_idle({ until: X })`

枚举值不变（cascader/select/daterange…）。无自动 codemod，请按上表手动改写调用方。
```

- [ ] **Step 2: 全量测试 + 构建**

```bash
cd packages/mcp && npx vitest run && npx tsc --noEmit
cd ../extension && npx vitest run
```
Expected: 全绿，无类型错误。

- [ ] **Step 3: 端到端手验（agent-canvas）**

重新加载 vortex MCP，确认：
1. `vortex_fill` 工具加载不再报 `MCPVortexFillAction` 撞名。
2. 对 Element Plus daterange / cascader 用 `widget=` 能实际填充。

- [ ] **Step 4: 提交（用 git-commit skill）**

`git add CHANGELOG.md`，用 froggo-skills:git-commit 提交：`docs: note kind→widget/until MCP param rename`。

---

## 附：本次**不触碰**的 `kind`（wire protocol / 无关）

- extension：`commit-drivers/*`、`handlers/dom.ts`、`action/auto-wait.ts`、`action/heal.ts`、`content-isolated.ts`、`lib/observe-render.ts`、`lib/ref-parser.ts` 的 `kind` —— 内部协议，由映射层桥接。
- `packages/vortex-migrate/*` —— 架构不支持干净加规则，改用文档迁移（见 spec §5.D）。
- `packages/mcp/tests/server-handler.test.ts`、`v2-shortboards.test.ts` —— 引用 `vortex_fill` 但不涉及 `kind` 参数，无需改。
