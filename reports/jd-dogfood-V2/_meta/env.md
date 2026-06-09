# 京东评测 V2 环境 (V2 重测版, 京东主平台完整 22 格子)

**Author**: qingwa
**Date**: 2026-06-09
**Git commit:** 83a892048a32e60ccf629aab3d6df149fcb5f961
**Git status:** clean
**dist hash:** 1.0.0 (与 git HEAD 83a8920 "docs: V4 修复实施计划 + BUG-012 react-virtuoso fixture 入库" 一致)
**Chrome 状态:** stable + extension 加载
**vortex-server:** PID 63370, listening 6800 (IPv6 [::]:6800)
**vortex MCP:** vortex 工具集 17 个, vortex-server 健康
**R8 白盒核对:**
- `schemas-public.ts:201` vortex_debug_read filter: `{ type: "object" }` **无 description, 未声明子字段** (level / urlPattern / statusMin / statusMax) — D16 真 gap = schema 文档化 (非能力缺失)
- `console.ts:160-163` handler 已实现 `args.level` 过滤 (`logs.filter((l) => l.level === level)`) — 能力具备, 缺 schema 暴露
- `network.ts:305-321` handler 已实现 `urlPattern` (line 253) / `url` (line 305) / `statusMin` / `statusMax` 过滤 — **字段名 3 处不统一**, 实际 handler 错误信息说要 `pattern`
- `js.ts:106` evaluate `userGesture: false` — INP 不会产生, V2 D10 删 INP 判据源码佐证
- `js.ts:61-71` async=true 包装 `return (async () => (${c}))()`, handler 已 await — V2 实施计划 Opus 订正要求 (P0 致命) 源码佐证
- `js.ts:266-285` `expandHost` 函数处理 Promise/Map/Set 等非可枚举对象, sync 模式 (无 async) 不 await → 返 `{}`
- `observe.ts:228` `applyReactClickableMarker` 是 handler 顶层 export, 但 dist build 未内联进 page-side inject func → **observe ReferenceError 真发现 (D9 真 gap)**
**京东登录态:** ✅ (用户名 `jd_130679dqq...` — 京东截断显示, 已脱敏)
**网络:** ✅ 京东真站可访问 (search.jd.com / item.jd.com 200 OK)

---

## 真实 item id 落档 (V1 同款, 跨 V1/V2 对比)

**真实 item id (V2 重测版, V1 沿用同款)**:
- **3C** = `100142621650` (Apple/苹果 iPhone 16 128GB 白色 ¥3972.51)
- **家电** = `100146042265` (海尔空调 净省电 大1.5匹 一级能效 变频冷暖)
- **服饰** = `10163956330188` (NAERSI 娜尔思 连衣裙 **本白色 L** ¥1115 — 需 query `NAERSI 连衣裙 本白色` 命中)

(京东商品卡 selector: `[data-sku]`, **非** `href`; V1 §7.3 已记)

---

## D11 react-virtuoso 前置验证 (V2 重测确认)

**D11 react-virtuoso 真站可复现:** ❌ (京东详情页评价区不是 react-virtuoso)

实测:
- `[data-virtuoso-scroller]` / `[data-testid*="virtuoso"]` / `[class*="virtuoso"]` / `[class*="Virtuoso"]` → **0 命中**
- `[class*="virtual-list"]` / `[class*="VirtualList"]` → **0 命中**
- `[class*="virtual"]` / `[class*="Virtual"]` → **0 命中**
- 评价项 selector `[class*="comment-item"]` 命中 15 个 (京东自渲染, **非** react-virtuoso)
- 评价 tab selector: `.left-tabs-item.everyone-reviews` (200万+买家评价)
- **评价区关闭按钮**: `._closeIcon_1ygkr_39` (V2 重测严格按 `ecom-anti-detection` skill 显式关闭)

**分支执行 (V2 实施计划 Task 2.1 前置分支)**:
- ❌ 京东真站**不**触发 react-virtuoso, D11 BUG-012 回归改在 **fixture 上跑** (`bench` 已 fixture 化 BUG-012 @ `93f60fb`)
- 真站只测"动画状态可读 (getComputedStyle) + wait_for 停止" 3 详情
- BUG-012 沿用 V1 真站京东验证 (V1 BUG-012 PASS, 见 V1 reports)

---

## V2 重测版实测覆盖 (京东主平台 22 格子)

| 维度 | 京东实测 | 淘宝实测 (V2 沿用) | 总计 |
|------|----------|---------------------|------|
| **D9 a11y** | **15 格子** (3 品类 × 5 阶段全实测, 含评价+加购) | 0 格子 (重测版不跑, V1 沿用) | 15 京东 |
| **D11 动效** | **3 详情** (3C 家电 服饰, 工具现状) | 0 格子 (重测版不跑) | 3 京东 |
| **D16 可观察性** | **1 详情** (服饰实测) | 4 格子 (V2 沿用) | 1 京东 + 4 淘宝 |
| **D10 性能** | **3 详情** (3C 搜索 / 家电 详情 / 服饰 详情) | 3 搜索 (V2 沿用) | 3 京东 + 3 淘宝 |
| **D12 暗黑** | 0 (沿用淘宝结论) | 1 探针 (V2 沿用) | 0 京东 + 1 淘宝 |
| **D15 错误恢复** | 0 (沿用淘宝结论) | 1 探针 (V2 沿用) | 0 京东 + 1 淘宝 |
| **合计京东实测** | **22 格子** | - | - |

---

## ⚠️ V2 重测版关键发现 (D9 + D10 + D16)

### 1. vortex_observe 在 main frame 0 全部扫空 (V2 跨双平台真发现, V2 重测仍复现)

**现象** (京东 + 淘宝 + example.com 同症状):
```
vortex_observe scope=viewport/full filter=interactive/all
  → "# frame 0 not scanned (url=...)"
```

**根因** (debug_read console error 实证):
```
ReferenceError: applyReactClickableMarker is not defined
    at <anonymous>:1:14814
    at <anonymous>:1:15441
```

**源码分析**:
- `packages/extension/src/handlers/observe.ts:228` `applyReactClickableMarker` 是 handler 顶层 export 函数
- 在 `scanOneFrame` (observe.ts:254) 用 `chrome.scripting.executeScript` 注入 page-side MAIN world 时, **`func` 参数被序列化为字符串**, background scope 中定义的 `applyReactClickableMarker` / `REACT_CLICKABLE_HINT` 不进字符串
- dist build (`background.ts--x5mOpJ-.js`) 验证: 函数定义在 background scope, 引用在 inject func body 内, **序列化时引用对象未带过去**
- 结果: page-side MAIN world 抛 ReferenceError → `scanOneFrame` 返 null → "frame 0 not scanned"

**实测覆盖** (V2 重测确认):
- search.jd.com ❌
- item.jd.com ❌
- s.taobao.com ❌
- example.com ❌
- 双平台一致 → **不是** 平台问题, **是** vortex 自身 bug

**修复建议** (V2.1 P0 候选, 真原语层):
- 方案 A: 在 page-side inject func 内**内联** `applyReactClickableMarker` 逻辑 (0.3d, 最简)
- 方案 B: 移到 page-side 模块通过 `loadPageSideModule` 注入
- 方案 C: 改 dist build 让 `applyReactClickableMarker` 真 inline

### 2. vortex_debug_read.filter 子字段未文档化 + handler 字段名不统一 (D16 ROI 最高, V2 重测仍复现)

- **`schemas-public.ts:201` filter 字段无 description**
- **handler 字段名 3 处不统一** (`urlPattern` / `url` / `pattern`)
- **修复**: 一行 description + 1-2 行源码统一 = 修复 (0.15d)

### 3. 京东 3C 搜索页 FCP=116960ms (116 秒, V2 重测真发现, 严重超阈值)

- 京东搜索页 SPA 客户端渲染, 116s 才出 FCP
- 京东详情页 FCP 1.4-7s (正常)
- 京东搜索 vs 详情 FCP 差 80x
- **真**是京东平台级性能问题, **不是** vortex 工具缺陷
- 与 V1 京东 618 期间 78.3% 通过率 (主要靠详情/评价) 一致

---

## Runbook 兜底 (R1-R8) + 京东操作人化规范 (按 ecom-anti-detection skill)

- **R1** ✅: `pkill -f vortex-bench/playground` (PID 63370 不在 bench 进程列表)
- **R2** ✅: vortex-server PID 63370 listening 6800
- **R3** ✅: vortex MCP 健康
- **R4**: D1-D8 沿用 V1, 口径一致
- **R5**: V2 D9-D16 不涉及京东独有
- **R6**: D9/D11/D16 用 `vortex_evaluate + observe + debug_read` 组合
- **R7** ✅: dist version 1.0.0 与 git HEAD 83a8920 对应
- **R8** ✅: codegraph 白盒核对 (见上)
- **L1 状态卫生** ✅: 评价区用 `._closeIcon_1ygkr_39` 显式关闭 (不依赖"切到商品详情 tab"代替)
- **L1 人化路径** ✅:
  - 京东首页 → 真实搜索 (input value setter + Enter) → mouse_drag 商品卡
  - 跨品类 navigate 搜索页 (类目切换合法) + 真实点击
  - **绝对不**直接 navigate `item.jd.com/<id>` (冷跳 = 风控元凶)
- **L2 节奏** ✅: 跨域 8-10s, 跨品类 10-12s, 状态稳定 3-5s
- **L3 登录态复用** ✅: V1 沿用登录 profile `jd_130679dqq...`, 不动指纹
- **L4 风控监测** ✅: debug_read console 监测 console.error, 命中走退避决策树
