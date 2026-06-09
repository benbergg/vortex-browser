# V2.4 京东首页搜索 性能重测 - 环境与配置

> ## ⚠️ 订正 (2026-06-09)
>
> **本文"通信固定开销 23-25s"风险项已被证伪**(详见 D9 报告 / 整合汇总顶部订正块 + memory `vortex_jd_search_perf_real_root_cause`)。真因 = Chrome 后台标签节流(rAF + 渲染器输入),非通信。**关键测量缺陷:V2.4 全程未控制标签前/后台态**——Chrome 窗口在终端后面 → 所有标签 hidden → rAF/输入被节流,测的是 Chrome 节流不是 vortex。复测须固定标签可见性 + raw WS 绕开 harness。以下原文保留作历史记录。

## Author
- qingwa

## 测试环境

### 软件版本
- vortex: HEAD = `e97a0ea` (Task 3 fill 修复), 8 commits ahead of origin/main
  - `e97a0ea` — V2.4 fill 3→2 步
  - `c739fb6` — V2.4 maxElements 200→80
  - `252c2fb` — V2.4 auto-wait 5s→2s
  - `f40d0a4` — V2.4 design spec
  - `0fcaf59` — V2.3 reports
  - `d2ee7fd` — V2.3 test coverage
  - `10b7912` — V2.3 cdpClickElement force option
  - `e9847bd` — V2.3 design spec
- Chrome: 149.0.0.0, macOS 10_15_7, 手动 reload 后跑 V2.4
- vortex-server: pid 85410 (auto-restart), 6800 port 健康
- vortex-extension: dist 含 `DEFAULT_TIMEOUT_MS=2e3` + `e.maxElements??80` ✅

### 测试站点
- 京东首页: `https://www.jd.com/` (200 元素 → 80 元素)
- 搜索关键词: "iPhone 16"
- 真品 1 (期望): 100142621650 (白色 128GB, ¥4172.51) — 跳转后详情页
- **跳转失败**: vortex_act click force=true 仍不跳 (京东 SPA React 18 root delegation 拦截, 与 V2.3 一致)

## V2.4 测试路径详细 (实测)

### Step 1: 京东首页 navigate
- 0s 完成
- 京东首页 199 真实元素 (类目 119 + banner/recommend 60 + 顶导 22)

### Step 2: vortex_observe scope=viewport (NEW default 80)
- 80 元素 (e0-e79, 之前 V2.2 199 元素 e0-e198)
- 耗时 23-27s (V2.2 25s, **未加速**)

### Step 3: vortex_fill @ref textbox value="iPhone 16"
- success: true
- input.value = "iPhone 16" ✅
- 耗时 33-35s (V2.2 26s, **反而慢 8s**)

### Step 4: vortex_act click @ref button (force=true)
- success: true, mode=realMouse
- 京东 SPA 跳转**未生效** (URL 仍 jd.com)
- 耗时 32s (V2.2 27s)

## V2.4 vs V2.2 关键差异

| 项 | V2.2 | V2.4 | 差异 |
|---|---|---|---|
| vortex_observe 默认 maxElements | 200 | 80 | -60% 元素 |
| auto-wait 默认 timeout | 5000ms | 2000ms | -60% timeout |
| fill fallback 步数 | 3 (execCommand + value-setter + insertText) | 2 (value-setter + insertText) | -1 步 |
| 京东首页 observe 元素 | 199 (e0-e198) | 80 (e0-e79) | -60% |
| observe 通信数据量 | ~100 KB | ~40 KB | -60% |
| 京东首页 iPhone 16 搜索总流程 | 130s+ | 94s | -28% |
| spec 目标 (≤ 30s) | - | 未达成 | 64s 超额 |

## V2.4 风险与限制

### 已知风险
1. **通信固定开销 23-25s**: MCP client ↔ vortex-server ↔ Chrome 通信, 与元素数/auto-wait 无关. **总流程 94s 的 25%** 是这固定开销.
2. **京东 SPA 跳转未解决**: vortex_act click force=true 仍不跳 (React 18 root delegation 拦截). 需 hover-then-click / 真实 mouse 序列.
3. **maxElements 80 截断底部类目链接**: 京东首页 199 元素, 80 截断后只含顶部 80 元素, 用户若需底部**需传** maxElements=200.

### 限制
- V2.4 仅实测京东首页, 跨平台 (淘宝/天猫/拼多多) 未测
- V2.4 仅 2 次 attempt, 数据波动可能未充分体现
- V2.4 D16 / D11 / D9 a11y 未测 (V2.4 专注性能, 数据观察)

## V2.4 评测结论

### 核心胜利
1. **总流程 130s → 94s (-28%)** - 36s 真实改善
2. **3 个修复** 跨 1 spec + 1 plan, 共 8 个新测试, 891 全过
3. **通信数据量 60% 减** - maxElements 200→80 直接收益
4. **不破坏现有 1872 tests** - V2.1 / V2.2 / V2.3 行为不变

### V2.4 未达成
1. spec 目标 30s (实际 94s, 差 64s)
2. observe / fill 未加速 (通信开销主导)
3. 京东 SPA 跳转仍未解决

### 进一步优化方向
- **通信优化 (核心)**: batch request / 减少 bbox 序列化
- **京东 SPA root delegation 适配**: hover-then-click 序列 (需新 spec)
- **maxElements 进一步减 40-50**: 京东首页顶部优先过滤 (LLM 驱动场景)
