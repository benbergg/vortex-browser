# Vortex SPA Root Delegation 跳转修复 — 设计文档

## Author
- qingwa

## Status
- Draft → pending user review

## Background

V2 京东评测 (V2.1 + V2.2 + V2 早期 + V2 重测版) 跨 3 个商品类目 (3C 详情 / 家电 搜索 / 服饰 搜索) 验证 P0 修复 (修 1+2+3) 端到端通过. 详情页跳转**部分成功**:

| 真品 | 类目 | vortex_act force=true + useRealMouse | 跳转 |
|---|---|---|---|
| iPhone 16 100142621650 | 3C 详情 | ✅ | 成功 → `item.jd.com/100142621650.html` |
| 海尔空调 100146042265 | 家电 搜索 | ❌ | 搜索页停留 |
| NAERSI 10163956330188 | 服饰 搜索 | ❌ | 搜索页停留 |

V2 早期 + V2 重测版 V1 沿用真品 100142621650 跳转成功, 后续 V2.2 海尔空调 / NAERSI 真品同模式不跳.

## 根因分析

Vortex `vortex_act click` useRealMouse 路径:

1. `dom.ts:144` — `await waitActionable(..., { force })` — force 跳过 actionability 质量门 (visible/enabled/editable/obscured + stable 复查)
2. `dom.ts:146-152` — `if (useRealMouse || trustedMode)` → `cdpClickElement(debuggerMgr, tid, frameId, selector)` — **未传 force**
3. `cdp.ts:43-192` — `cdpClickElement` page-side 探测: queryAllDeep + isEnabled + **occlusion 检查** (line 138-158) — **未支持 force 旁路**

**force=true 在 cdpClickElement 路径被丢失**. 京东 海尔空调 真品 1 真品卡被 `login-bottom-bar` 等浮层遮挡 (虽然元素中心点 elementFromPoint 实际不挡, 但 page-side occlusion 检查仍触发 ELEMENT_OCCLUDED 错误码 — 待实测确认).

V2.1 iPhone 16 跳转**意外成功** (V2.1 测试日志): 可能原因是 3C 真品 1 (深青色 100156393069) 周围**无**浮层遮挡, 路径走通. 海尔空调 路径不通, 推测是浮层遮挡触发 cdpClickElement ELEMENT_OCCLUDED 错误码.

## 设计目标

**最小改动**让 force=true 透传到 cdpClickElement, 允许 vortex_act click 跳过 useRealMouse 路径的 occlusion 检查.

## 设计方案

### 改动 1: cdpClickElement 增加 force 参数 (5 行)

`packages/extension/src/adapter/cdp.ts:43-54`:

```typescript
export async function cdpClickElement(
  debuggerMgr: DebuggerManager,
  tabId: number,
  frameId: number | undefined,
  selector: string,
  options: { force?: boolean } = {},  // 新增
): Promise<{...}> {
```

page-side 探测 (line 64-170) `if (force) { /* 跳过 occlusion 检查 */ }` 包围 line 138-158 块.

### 改动 2: dom.ts CLICK handler 透传 force (3 行)

`packages/extension/src/handlers/dom.ts:151`:

```typescript
if (useRealMouse || trustedMode) {
  await loadPageSideModule(tid, frameId, "dom-resolve");
  return await cdpClickElement(debuggerMgr, tid, frameId, selector, { force: args.force as boolean | undefined });
}
```

### 改动 3: 单元测试覆盖 force 旁路 (2 文件)

- `packages/extension/tests/cdp-click-element-force.test.ts` — 验证 force=true 时 page-side 探测不报 ELEMENT_OCCLUDED
- 修复后 vortex_act force=true 京东 海尔空调 真品 跳转**真**成功 — V2.3 京东 3 类目详情页评测验证

## 数据流

```
vortex_act click target=... options={force: true, useRealMouse: true}
  ↓ dom.ts CLICK handler
  ↓ waitActionable(..., { force: true })      [force 跳过质量门]
  ↓ cdpClickElement(..., { force: true })    [force 跳过 occlusion]
  ↓ page-side probe (force=true) → 不报 ELEMENT_OCCLUDED
  ↓ clickBBox CDP 真鼠标 → 京东 SPA 跳转
```

## 错误处理

- force=true 跳过 occlusion, 但**仍**保留 disabled + detached + offscreen 检查
- force=true 跳过 stable 复查 (actionability 层已跳过, 完整 stable 检查)
- force=true 时不抛 ELEMENT_OCCLUDED, 但**仍**抛 ELEMENT_NOT_FOUND / ELEMENT_DISABLED / ELEMENT_DETACHED / ELEMENT_OFFSCREEN / SELECTOR_AMBIGUOUS

## 测试策略

### 单元测试 (1 个新文件)
- `packages/extension/tests/cdp-click-element-force.test.ts`
  - 6 项:
    1. cdpClickElement force=true 不传时不报 occlusion
    2. cdpClickElement force=false 默认行为报 occlusion
    3. force=true 仍报 ELEMENT_NOT_FOUND
    4. force=true 仍报 ELEMENT_DISABLED
    5. force=true 仍报 ELEMENT_OFFSCREEN (force 不跳过 offscreen)
    6. dom.ts CLICK handler 透传 force 到 cdpClickElement

### 端到端验证 (V2.3 评测)
- 京东 海尔空调 100146042265 真品 1: vortex_act force=true mode=realMouse 跳转**真**成功
- 京东 NAERSI 10163956330188 真品 1: 同上
- 京东 3C iPhone 16 100142621650: 不退化, 跳转继续成功

### 风险与回归
- 不破坏 BUG-010 (京东 root delegation) 修复
- 不破坏 BUG-012 (react-virtuoso) 修复
- 不破坏 force=true 跳过 stable 复查语义

## 局限

- **Vortex React root delegation 仍需真 click** (force 透传不能解决所有 SPA 场景)
- 方案 A 只解决浮层遮挡导致的 useRealMouse 路径失败
- 跨平台 (淘宝/天猫/拼多多) root delegation 行为差异, V2.3 评测后评估

## 后续

- V2.3 京东 3 类目详情页评测 (P0 修复 + force 透传后)
- V2.4 跨平台 (淘宝/天猫/拼多多) 评测
- P1 工具设计 (a11y_audit / perf_audit) — V2 评审 §1.1 定位决策
