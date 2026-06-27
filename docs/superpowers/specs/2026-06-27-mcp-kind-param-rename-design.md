# 设计文档：MCP 顶层 `kind` 参数改名（规避 OpenHands SDK 撞名）

- created: 2026-06-27
- status: draft
- scope: `packages/mcp`、`packages/extension`(仅 LLM 文案)、`packages/vortex-migrate`

## 1. 背景与根因

在 agent-canvas 中配置 vortex MCP 测试时，OpenHands 加载 `vortex_fill` 工具时崩溃：

```
Field 'kind' of class 'MCPVortexFillAction' overrides symbol of same name in a
parent class. This override with a computed_field is incompatible.
```

**根因**：报错来自 OpenHands 的 `openhands-sdk`，而非 vortex。其工作机制：

1. SDK `openhands/sdk/tool/schema.py: Schema.from_mcp_schema()` 把 MCP 工具 `inputSchema`
   的**每个顶层参数**都 `create_model()` 成一个 Pydantic 字段，动态类继承自 `Schema`。
2. `Schema → DiscriminatedUnionMixin`（`openhands/sdk/utils/models.py`）有一个**保留字段
   `kind`**，作为整个 SDK tagged-union 的判别器（discriminator），在 pydantic 内部被特殊化
   （rebuild 时改成 `Literal[...]`，表现为 computed/受保护字段）。
3. vortex 的 `vortex_fill` 顶层正好有一个业务参数也叫 `kind`（`COMMIT_KINDS`：cascader /
   select / daterange 等复合控件分派）。动态类 `MCPVortexFillAction.kind` 覆盖父类判别器，
   pydantic 拒绝 → 报错。

**佐证为 SDK 疏漏**：SDK 在 `to_mcp_schema` 与 `action_from_arguments` 两处都**显式排除了
`kind`**，唯独 `from_mcp_schema` 创建模型时漏掉。任何把 `kind` 当顶层参数名的 MCP server 接入
OpenHands 都会崩。

**更深的不兼容**：即便绕过创建报错，`action_from_arguments` 会用
`exclude_fields = DiscriminatedUnionMixin.model_fields.keys()`（含 `kind`）在 `model_dump`
时把名为 `kind` 的值丢掉——`kind` 参数根本传不到 vortex。故 `kind` 这一参数名与 OpenHands
MCP 集成**根本不兼容**，必须改名。

## 2. 目标与非目标

**目标**
- 消除所有**顶层** `kind` MCP 参数，使 vortex 工具能被 OpenHands agent-canvas 正常加载与调用。
- 复合控件 / idle 等待能力在改名后**功能等价**（参数能正确传到 extension）。

**非目标**
- 不改 extension 内部 wire protocol（`dom.commit` driver 等仍按 `kind` 取参）。
- 不改 `COMMIT_KINDS` 枚举值本身（cascader/daterange… 不变，只改参数键名）。
- 不改 SDK（第三方包，单独反馈上游）。

## 3. 命名决策（已与用户确认）

| 工具 | 旧顶层参数 | 新参数名 | 语义 | 兼容策略 |
|------|-----------|---------|------|---------|
| `vortex_fill` | `kind` | `widget` | 面向哪种复合控件（Element Plus / Ant Design） | 硬切，不保留 `kind` |
| `vortex_fill_form` | `fields[].kind` | `fields[].widget` | 同上（与 fill 统一） | 硬切 |
| `vortex_wait_idle` | `kind` | `until` | 等待哪种 idle（xhr/network/dom） | 硬切 |

> `vortex_fill_form` 顶层 properties 是 `{fields, ...tabFields}`，`kind` 嵌在 `fields[]`
> item 内（非顶层），本身不触发 SDK 撞名；但为与 `vortex_fill` 语义统一、避免 LLM 困惑，一并改名。

## 4. 边界：wire protocol vs 面向 LLM

- **wire protocol（不动）**：extension 端所有 `kind`——`commit-drivers`、`handlers/dom.ts`、
  `action/auto-wait.ts`、`action/heal.ts`、`content-isolated.ts`、`lib/observe-render.ts`。
  映射层负责把新名映射回 `kind` 再下发。
- **面向 LLM（必改）**：MCP schema 参数键名、工具描述、`fill-reject` 的 `suggestedTool` /
  `fixExample` 提示文案。

## 5. 详细改动清单

### A. `packages/mcp`（核心）

1. **`src/tools/schemas-public.ts`**
   - `vortex_fill`（L377）：`kind: { enum: [...COMMIT_KINDS] }` → `widget: { enum: [...COMMIT_KINDS] }`
   - `vortex_fill_form`（L421）：`fields[].kind` → `fields[].widget`
   - 描述（L371、L410）：`kind=cascader/...` → `widget=cascader/...`
2. **`src/tools/schemas.ts`**
   - internal `vortex_fill`（L358）：`kind` → `widget`；描述（L352）同步
   - `vortex_wait_idle`（L293）：`kind` → `until`；描述（L289）同步，`action` 默认仍 `page.waitForXhrIdle`
3. **`src/tools/dispatch.ts`**
   - `case "vortex_fill"`（L67-78）：解构 `widget` 而非 `kind`；下发
     `{ action: "dom.commit", params: { kind: widget, value, ...rest } }`（**映射回 kind**）。
     纯文本分支判据由 `!kind` 改为 `!widget`。
   - `case "vortex_wait_idle"`（L56-66）：解构 `until` 而非 `kind`；action 选择与 `idleKey`
     判据由 `kind === ...` 改为 `until === ...`。该工具不下发 kind 给 extension（转成 action），无需反向映射。
4. **`src/server.ts`**
   - `vortex_fill_form` 分支（L504-510 类型、L559-566 逻辑）：字段类型 `kind?` → `widget?`；
     `if (!field.kind)` → `if (!field.widget)`；`fieldParams.kind = field.widget`（**映射回 kind**）。

### B. `packages/extension`（面向 LLM 文案）

5. **`src/patterns/fill-reject.ts`**（L33-53）：`suggestedTool` / `fixExample` 中
   `kind="..."` → `widget="..."`，注释（L5）同步。page-side 注入的提示语经此输出给 LLM，
   不改会教模型继续写已废弃的 `kind`。

### C. 测试更新

- `packages/mcp/tests`：`fill-form`、`vortex_fill_force`、`tool-dispatch`、`server-handler`、
  `v2-shortboards`、`invariants/I15.tools-list-budget` —— 顶层/field 级 `kind` 断言 → `widget`，
  `vortex_wait_idle` 用例 `kind` → `until`。枚举值不变。
- `packages/extension/tests/fill-reject-patterns.test.ts`：`fixExample` 断言 `kind:` → `widget:`。

### D. 迁移说明（**不改 vortex-migrate 代码**，已与用户确认）

**架构现实**：`vortex-migrate` 是一次性 v0.5→v0.6 codemod，`TOOL_MAP` 是
`Record<旧工具名, 单一目标>`。`TOOL_MAP["vortex_fill"]` 已占用为 `{ v06: "vortex_act" }`、
`vortex_wait_idle` 已占用为 `{ v06: "vortex_wait_for" }`。要加「目标仍是 `vortex_fill` 自身」
的 `kind→widget` 规则会与现有映射**直接冲突**（同一旧名不能两个目标），无法在现有架构内干净表达。

**决定**：本次**不动** `vortex-migrate`。改为在 **CHANGELOG / 迁移文档**记录手动迁移指引：

- `vortex_fill({ kind: X })` → `vortex_fill({ widget: X })`
- `vortex_fill_form({ fields: [{ kind: X }] })` → `vortex_fill_form({ fields: [{ widget: X }] })`
- `vortex_wait_idle({ kind: X })` → `vortex_wait_idle({ until: X })`

## 6. 风险与回归

- **遗漏映射**：fill/fill_form 改名后若 dispatch/server 未把 `widget` 映射回 `kind`，复合控件
  填充会静默走 `dom.fill` 失效。由 `tool-dispatch` / `fill-form` 测试守护。
- **I15 invariant**：锁定 public schema enum === `COMMIT_KINDS`；本次只改 key 名不改 enum 值，
  需确认 I15 断言的是 enum 值而非 `properties.kind` 键名，必要时同步更新断言。
- **硬切破坏兼容**：直接用 `kind` 的旧脚本会失效；由 §5.D 的迁移文档指引兜底（手动改写）。

## 7. 验证方式

1. `pnpm -F @vortex-browser/mcp test` 与 extension / vortex-migrate 包测试全绿。
2. `pnpm -F @vortex-browser/mcp build`（tsc）无类型错误。
3. 端到端：在 agent-canvas 重新加载 vortex MCP，确认 `vortex_fill` 工具不再报
   `MCPVortexFillAction` 撞名，且能对 Element Plus daterange/cascader 实际填充。

## 8. 已知后续（不在本次）

- 向 OpenHands / openhands-sdk 反馈：`from_mcp_schema` 应像 `to_mcp_schema` /
  `action_from_arguments` 一样过滤或重命名与判别器保留字段（`kind`）撞名的 MCP 参数，
  否则任何用 `kind` 作顶层参数名的 MCP server 都会崩。
