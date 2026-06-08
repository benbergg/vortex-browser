# P2 复跑 · vortex_evaluate description IIFE 提示

**评测时间**: 2026-06-07
**基线 commit**: ef242c7
**复跑目标**: ef242c7 修复（V3 §5.1 P2：vortex_evaluate description 加 IIFE 提示）

---

## 1. 复跑方法

1. 读 `packages/mcp/src/tools/schemas-public.ts`（MCP `tools/list` 暴露的公开工具表）
2. 找 `vortex_evaluate` entry
3. 验证 `description` 含 "IIFE" 关键词
4. 读 `packages/mcp/src/tools/schemas.ts`（内部 36 工具表，vortex 内部 routing 用，不直接暴露给 LLM）

---

## 2. 实测结果

### 2.1 公开工具表（LLM 实际看到）

**`packages/mcp/src/tools/schemas-public.ts:256-258`**
```ts
name: "vortex_evaluate",
action: "js.evaluate",
description: "MAIN world. async=fn body, IIFE. No cross-origin iframe.",
```

**通过判据**:
- ✅ description 含 "IIFE" 关键词
- ✅ 长度 56 字符（< 60 上限，TC-11 invariant I15）
- ✅ 保留 MAIN world + cross-origin iframe + async=fn body 三个 B3-5 既有约束

### 2.2 内部工具表（不可见，不影响 LLM 行为）

**`packages/mcp/src/tools/schemas.ts:449-451`**
```ts
name: "vortex_evaluate",
action: "js.evaluate",
description: "Execute JavaScript in page context. Set async:true for await support.",
```

- 内部表不含 IIFE 提示
- 但 LLM 走 `tools/list` 看到的是 schemas-public.ts 的 description
- 实际不影响 LLM 行为

---

## 3. ef242c7 commit 验证

```
ef242c7 fix(mcp): P2 vortex_evaluate description 加 IIFE 提示
```

**改动** (`packages/mcp/src/tools/schemas-public.ts`):
```diff
-    description: "Eval JS. MAIN world. async=fn body. No cross-origin iframe.",
+    description: "MAIN world. async=fn body, IIFE. No cross-origin iframe.",
```

**测试** (`packages/mcp/tests/v2-shortboards.test.ts`):
- RED 1 failed (缺 IIFE 关键词)
- GREEN 20/20 v2-shortboards + 386/386 mcp 全量
- 0 回归

---

## 4. 验收

| 判据 | 期望 | 实测 | 通过? |
|------|------|------|-------|
| 公开 description 含 "IIFE" | 是 | 是 | ✅ |
| description 长度 ≤ 60 | 是 | 56 | ✅ |
| 修复在 MCP tools/list 暴露 | 是 | 是 | ✅ |
| LLM 一次看明白 IIFE 需求 | 是 | 简略（仅 "IIFE" 单词） | ⚠️ 边际通过 |

**P2 复跑 PASS** ✅

**边际警告**: description 仅含 "IIFE" 单词，**未明确说箭头/function 必须 IIFE 包裹**（虽然在文件 comment 244-255 行有详细说明）。LLM 可能看到 "IIFE" 关键词但不知道具体怎么写。建议 V5 评审时考虑扩展 description（如 `(function(){...})()`），但当前不阻碍 V4 PASS 判据。
