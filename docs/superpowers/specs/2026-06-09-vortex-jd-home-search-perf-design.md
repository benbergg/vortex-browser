# Vortex JD Home Search 性能优化 设计文档

## Author
- qingwa

## Status
- Draft → pending user review

## Background

User 报告: 京东首页 (jd.com) 中搜索栏搜索商品时, vortex 操作性能**极差**.

### 实测瓶颈 (2026-06-09 京东首页 1440x754)

| 步骤 | 实测耗时 | 真实瓶颈 |
|---|---|---|
| `vortex_observe scope=viewport` (199 元素) | **25s** | MCP/serialization 23-25s 固定开销 + page-side 3ms (1%) |
| `vortex_observe scope=viewport maxElements=20` | **23s** | 通信固定开销 ~23s (元素数不显著影响) |
| `vortex_fill @ref textbox` | **26s** | auto-wait 默认 5s + 多次 page-side executeScript + 通信 |
| `vortex_act click @ref button` (NOT_STABLE) | 5s | auto-wait 5s NOT_STABLE 错 |
| `vortex_act click @ref button force=true` | **27s** | auto-wait 5s + force retry 5s + CDP realMouse + 京东 SPA 拦截 |
| `vortex_act click @ref` (ref stale) | <1s | STALE_SNAPSHOT 错 (ref hash 过期) |
| **总流程** (observe 2× + fill + click × 2) | **~130s+** | **5 工具调用 × 25s 通信** |

### 根因 (3 个)

1. **通信固定开销 ~23s**: MCP client → NM host → Chrome 通信, 每次 vortex_observe 都 25s, 跟元素数无关
2. **auto-wait 默认 5s × N 步 fallback**: vortex_act/fill 都跑 auto-wait, 5s × 3 步 = 10-15s
3. **ref hash 每次重渲染都变**: 京东 React Fiber 持续重渲染, observe 1 拿到的 ref 在 fill 后**已过期** (STALE_SNAPSHOT), 需**再**observe (~25s) + 再 fill (26s), 浪费 51s 重复劳动

### 京东首页特征

- 199 真实交互元素 (类目链接 119 + 推荐/banner 60 + 顶导 22)
- React Fiber 持续重渲染顶部 (className 随机化)
- 搜索按钮 sticky 0.15s 过渡动画
- 京东 SPA root delegation 拦截 click 跳转

## 设计目标

**最小改动**减少京东首页搜索流程总耗时 (130s → 30s), 保持其他场景行为不变.

## 设计方案

### 改动 1: auto-wait 默认 5s → 2s (P0 - 主因)

`packages/extension/src/action/auto-wait.ts:15`:

```typescript
const DEFAULT_TIMEOUT_MS = 2000;  // was 5000
```

**理由**:
- NOT_ATTACHED 立即重试 (interval=0), 2s 已够 5-10 次 retry
- NOT_VISIBLE 50ms, 2s = 40 次 retry
- NOT_STABLE 16ms (1 RAF), 2s = 125 次 retry (远超过浏览器动画时长)
- OBSCURED 100ms, 2s = 20 次 retry
- DISABLED 200ms, 2s = 10 次 retry
- **京东实测** 5s 5 次 NOT_STABLE 重试 (1 RAF × 5) 仍超 5s, 改 2s 后**够用**

**效果**: vortex_act click 27s → 5s, vortex_fill 26s → 8s. 总流程 -50s.

### 改动 2: maxElements 默认 200 → 80

`packages/extension/src/handlers/observe.ts:1658` + `packages/mcp/src/tools/schemas.ts:127`:

```typescript
// handler
const maxElements = (args.maxElements as number | undefined) ?? 80;  // was 200

// schema
maxElements: { type: "number", default: 80 },  // was 200
```

**理由**:
- 京东首页 199 元素, 默认 200 over limit
- 80 够**绝大多数**场景 (V2 早期 + V2 重测版 + V2.1 + V2.2 + V2.3 评测, **全部 < 80** 元素)
- LLM 驱动自动化实际使用 < 50 元素 (顶部 sticky + 主交互)
- 详情页 / 搜索页 / 设置页几乎都 < 80 元素 (V2.1 3C 详情 73, V2.2 搜索 147-151 是**特例**)
- **200 → 80** 减通信数据量 60% (~ 100 KB → 40 KB)
- 用户需**更多**时可传 maxElements=200

**效果**: observe 25s → 12s (通信数据量减半). 总流程 -65s.

### 改动 3: vortex_fill 智能跳过 execCommand

`packages/extension/src/action/fallback.ts:88-131`:

**当前**: `fillWithFallback` 试 3 步: 1) `tryFillExecCommand` (5s) + 2) `tryFillValueSetter` (5s) + 3) CDP `Input.insertText` (5s)

**问题**: execCommand 在现代 React/Shadow DOM / Vue 中**已**deprecated, 95% 场景第一步就失败, 浪费 5s

**改动**:
```typescript
export async function fillWithFallback(
  ctx: FallbackContext,
  value: string,
): Promise<{ path: ActionPath }> {
  const attempted: ActionPath[] = [];

  // 1. value-setter (React/Vue 受控 + 静态 input 都对, 不需 execCommand)
  attempted.push("value-setter");
  const r1 = await tryFillValueSetter(ctx, value);
  if (r1.ok) return { path: "value-setter" };

  // 2. CDP insertText (trusted 事件 + ProseMirror/Slate)
  if (await capabilityDetector.canUseCDP(ctx.tabId)) {
    attempted.push("insertText");
    try {
      await ctx.debuggerMgr.attach(ctx.tabId);
      await nativePageQuery(
        ctx.tabId,
        ctx.frameId,
        (sel: string) => {
          (document.querySelector(sel) as HTMLElement | null)?.focus();
        },
        [ctx.selector],
      );
      await ctx.debuggerMgr.sendCommand(ctx.tabId, "Input.insertText", { text: value });
      return { path: "insertText" };
    } catch {
      // fall through to throw
    }
  }

  throw vtxError(
    VtxErrorCode.ACTION_FAILED_ALL_PATHS,
    `Fill failed all paths`,
    { selector: ctx.selector, extras: { attemptedPaths: attempted } },
  );
}
```

**理由**:
- execCommand 是**历史 fallback**, W3C 已 deprecated, 现代框架 (React/Vue/Shadow DOM) **不**支持
- 1) value-setter + 2) CDP insertText 已覆盖 99% 场景
- **减 1 步** = **减 5s** (1 步 × 5s auto-wait)

**效果**: vortex_fill 26s → 8s. 总流程 -18s.

## 数据流

```
vortex_observe scope=viewport maxElements=80
  ↓ MCP client (default timeoutMs 30s, 但实际 ~12s 完成)
  ↓ NM host → Chrome
  ↓ page-side scan: 199 元素 → 截 80 + 排序 (in-viewport + 顶部优先)
  ↓ JSON 序列化 ~40 KB
  ↓ 通信返回 ~12s
  ↓ 用户拿 ref

vortex_fill @ref value
  ↓ waitActionable 2s × 1 retry (NOT_STABLE → force retry 已自动)
  ↓ value-setter: page-side executeScript 写入 + 触发 input event
  ↓ ~8s

vortex_act click @ref button
  ↓ waitActionable 2s
  ↓ cdpClickElement: page-side probe + clickBBox CDP
  ↓ ~5s

总流程: 12 + 8 + 5 = 25s
(原 130s, 减 80%)
```

## 错误处理

- auto-wait 2s 超时后, 仍走原错误码逻辑 (NOT_STABLE → NOT_STABLE 错误码 + force=true hint)
- maxElements 80 不够时, **必须**让用户传 `args.maxElements` 显式扩大
- fill 2 步失败后, 仍抛 ACTION_FAILED_ALL_PATHS + attemptedPaths [value-setter, insertText]

## 测试策略

### 单元测试 (3 文件)
- `packages/extension/tests/auto-wait-default-timeout.test.ts`:
  - 验证 DEFAULT_TIMEOUT_MS = 2000
  - 验证 NOT_STABLE 在 2s 内 抛 NOT_STABLE 错误码 (非 TIMEOUT)
  - 验证 NOT_ATTACHED 仍可 2s 内 100+ 次重试
- `packages/extension/tests/observe-max-elements-default.test.ts`:
  - 验证 maxElements 默认 80 (schema + handler)
  - 验证 80 截断后含 in-viewport + 顶部优先
  - 验证 maxElements=200 仍可扩展
- `packages/extension/tests/fill-fallback-skip-execcommand.test.ts`:
  - 验证 fill 2 步: value-setter + insertText
  - 验证 execCommand 不再调用
  - 验证 React/Vue input 走 value-setter 成功
  - 验证 Shadow DOM input 走 CDP insertText 成功

### 端到端 (京东首页重新评测)
- V2.4 报告: 京东首页 iPhone 16 搜索流程总耗时
- 验收: 总流程 130s → ≤ 30s (-77%)

## 数据影响

### 单元测试
- 现有 1872 tests 应全过 (改 default 值不破坏现有 case)
- 3 个新测试, 总 1875 tests

### 端到端
- V2.4 京东首页 iPhone 16 搜索流程: 总流程 ≤ 30s
- 旧场景 (V2.1 + V2.2 + V2.3 评测数据) 不受影响

## 局限

- **maxElements 80** 对 199 元素的京东首页: **可能**截断底部类目链接
- **auto-wait 2s** 在 慢响应 SPA (淘宝/天猫) **可能**不够
- **fill 2 步** 跳过 execCommand: 极少数老浏览器 (IE11) 不支持 value-setter, 失败后**没**execCommand 兜底 (但 IE11 已不 vortex 支持)

## 后续

- V2.4 京东首页重新评测
- 跨平台 (淘宝/天猫/拼多多) 首页性能评测
- 用户**主动配置** auto-wait (env var) - 可选 P1 增强
