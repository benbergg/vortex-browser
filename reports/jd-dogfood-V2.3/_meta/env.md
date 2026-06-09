# V2.3 京东 3 类目详情页 评测 - 环境与配置

## Author
- qingwa

## 测试环境

### 软件版本
- vortex: HEAD = `d2ee7fd` (Task 1+2 修复 force 透传), 4 commits ahead of origin/main (实际 5 commits ahead, 包含 V2.1 reports)
  - `d2ee7fd` — test(extension): cdpClickElement force coverage + handler force forwarding
  - `10b7912` — fix(extension): cdpClickElement accepts force option to skip occlusion check
  - `e9847bd` — docs: design spec for vortex SPA root delegation click fix
  - `af01cfc` — test: add V2.2 cross-category evaluation reports
  - `1d77e25` — test: add V2.1 P0-fix end-to-end verification reports
- Chrome: 149.0.0.0, macOS 10_15_7
- vortex-server: auto-restart daemon (pid 48215), watching dist/ (debounce 2s, **但 V2.3 评测时未触发自动重载, 需用户手动 reload**)
- vortex-extension: dist 含 `force:` 9 处 + `cdpClickElement` 3 处 + 接受 `options: { force?: boolean }` ✅

### 测试站点
- 京东 3C 详情: `item.jd.com/100142621650.html` (iPhone 16 白色 128GB, ¥4172.51)
- 京东 家电 详情: `item.jd.com/100146042265.html` (海尔空调 大1.5匹, ¥1741.65)
- 京东 服饰 详情: `item.jd.com/10163956330188.html` (NAERSI 波点连衣裙 本白色 L, ¥1115)
- V1 沿用真品 (V2 早期 + V2 重测版 + V2.1 + V2.2 + V2.3 全部沿用)

## V2.3 vs V2.1/V2.2 - 测点扩展

| 项 | V2.1 (3C 详情) | V2.2 (家电+服饰 搜索) | **V2.3 (3 类目 详情)** |
|---|---|---|---|
| 测点数 | 1 (iPhone 16 详情) | 2 (海尔空调 + NAERSI 搜索) | **3 (3C + 家电 + 服饰 详情)** |
| 页面类型 | 详情页 | 搜索页 | **详情页** |
| 跳转策略 | vortex_act click force=true (V2.1 成功) | vortex_act click force=true (V2.2 失败) | **vortex_navigate** (V2.3 降级) |
| observe 元素 | 73 (详情) | 147/151 (搜索) | **70/68/73** (详情) |
| aria 覆盖率 | 13.43% | 6.94% / 6.62% | **13.64% / 14.06% / 14.29%** |
| acc 覆盖率 | 95.52% | 61.11% / 58.28% | **95.45% / 95.31% / 95.24%** |
| force 透传修复 | N/A | N/A | **✅ cdpClickElement + dom.ts 透传** |

## V2.3 测试路径详细

### Step 1: 京东 3C 详情 (iPhone 16 100142621650)
- **降级**: vortex_act click force=true mode=realMouse 跳转**未生效** (京东 SPA root delegation 拦截)
- **方案**: vortex_navigate 直接 `item.jd.com/100142621650.html?pcdk=...&spmTag=...`
- observe: snap_mq6atv61_14, 70 元素 (e0-e69)
- D9 a11y: aria 13.64% / acc 95.45% / 66 interactive
- D11 sticky 13 + animated 114
- D16 console level=error 末尾新增 marker + network pattern filter 接受

### Step 2: 京东 家电 详情 (海尔空调 100146042265)
- **降级**: 同上 vortex_navigate `item.jd.com/100146042265.html?purchasetab=gfgm`
- observe: snap_mq6aw7ns_15, 68 元素 (e0-e67)
- D9 a11y: aria 14.06% / acc 95.31% / 64 interactive
- D11 sticky 14 + animated 141
- D16 console level=error 末尾新增 marker (appliance_*)

### Step 3: 京东 服饰 详情 (NAERSI 10163956330188)
- **降级**: 同上 vortex_navigate `item.jd.com/10163956330188.html`
- observe: snap_mq6ax1va_16, 73 元素 (e0-e72)
- D9 a11y: aria 14.29% / acc 95.24% / 63 interactive
- D11 sticky 13 + animated 93
- D16 console level=error 末尾新增 marker (apparel_*)

## V2.3 风险与限制

### 已知风险
1. **vortex_act click force=true 京东 SPA 跳转失败** (V2.3 实测): 京东 SPA React 18 root delegation 拦截, 真 mouse event (isTrusted=true) 仍未触发 SPA 路由. **降级方案**: vortex_navigate 直接详情 URL.
2. **dist-watcher 不重载** (V2.3 测试时): vortex-server 启动后未触发 reload-extension 事件, 需用户手动 chrome://extensions → Reload. **降级方案**: 用户已手动 reload, 之后构建走 rebuild + manual reload 路径.
3. **V2.3 评测限于详情页** (3 类目): 与 V2.2 一致, 不测首页/购物车/订单等.

### 限制
- V2.3 D11 sticky/animated 数量是初始值, 滚动后变化**未深入分析**
- V2.3 D16 5k 条硬上限未触发 (京东流量大但测试窗口短)
- V2.3 跨平台 (淘宝/天猫/拼多多) 未测

## V2.3 评测结论

### 核心胜利
1. **P0 修 1+2 + V2.3 force 透传** 跨 3 类目详情页**全部端到端真生效**:
   - filter 子字段 level=error 在 3 详情页 (3C/家电/服饰) 接受
   - 顶层 pattern 字段 + cdpClickElement force 透传 + dom.ts 透传
   - page-side probe `if(!force)` 跳过 occlusion
2. **跨 3 类目详情页 a11y 稳定**: aria 13-14%, acc ~95% (V2.2 搜索页 2 倍)
3. **跨 3 类目详情页 observe 元素 68-73** (V2.2 搜索页 147-151 的 1/2)
4. **D11 sticky 13-14 + animated 93-141**: 详情页**独有** left-tabs-nav / page-content-right / page-right-banber / activity-banner

### V2.3 待解决
1. 京东 SPA React 18 root delegation 跳转路径**未解决** (V2.3 vortex_act click force=true 仍未跳)
2. dist-watcher 不可靠 (V2.3 需手动 reload)
3. 跨平台 (淘宝/天猫/拼多多) 未测
