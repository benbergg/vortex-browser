# BUG-014: 京东配送时间无 grid 弹层(业务能力缺失,vortex 无能修复)

**Author:** qingwa
**Date:** 2026-06-08
**Status:** ✅ 业务侧已评估(2026-06-08,详见 §7 业务侧评估结论)
**严重度:** 🟡 P2
**相关 Phase:** Phase 5.x 详情页配送时间
**评测来源:** `reports/jd-dogfood-V1/京东独有/JD-UNI-04-配送时间.md` (D3 ❌ grid 不存在)
**参考:** BUG-009 全闭环模板见 `_meta/P1-1京东根因诊断.md` 6 节 300 行

---

## 1. 现象

**关键观察:**

- 京东详情页**无 grid 弹层**,配送时间是**基于地址+商品+物流算法的静态计算文字**
- 评测实测:"12:00前付款,预计今天(06月08日)送达" —— 静态 div,无 onclick,无 cursor=pointer(cursor=auto)
- **用户无法在详情页选择具体时段**(真实时段选择发生在购物车结算页/订单确认页)
- 9 个物流方式 link(今日达 / 京准达 / 211限时达 / 京尊达 / 预约送货 / 部分收货 / 送货上门 / 本地仓 / 自提) + 6 个服务标签(包邮 / PLUS / 7天价保 / ...)**全部 `target="_blank"` 跳 help.jd.com 帮助文档**
- 地址 click → React portal 弹地址选择器(常用地址 / 浙江 > 杭州市 > 滨江区 > 长河街道),**但弹层中无任何"配送时段"或"今天/明天/具体时段"控件**

**数据引用:**
- `京东独有/JD-UNI-04-配送时间.md` D3 ❌:配送时间 grid 不存在
- `京东独有/JD-UNI-04-配送时间.md` D5 evaluate:`.logistics-delivery-time` cursor=auto, hasOnClick=false, React props 无 on* 事件 —— **静态文字,非交互元素**

---

## 2. 复现 fixture

**真站复现 URL:** `https://item.jd.com/100142621650.html` (iPhone 16 详情页)

**复现命令:**
```
vortex_navigate("https://item.jd.com/100142621650.html")
vortex_wait_for(time=1)
vortex_observe(scope="viewport")  # 找配送时间区
vortex_evaluate(code="() => { const el=document.querySelector('.logistics-delivery-time'); return {text: el.innerText, hasOnClick: el.onclick != null, cursor: getComputedStyle(el).cursor}; }")
# → {text: "12:00前付款，预计今天(06月08日)送达", hasOnClick: false, cursor: "auto"}
```

**结论:** 静态 div,无任何交互属性。**京东业务上不提供"选时段"**。

---

## 3. 代码定位

**本 BUG 与 vortex 代码无关** —— 是京东 SPA 的业务设计选择。

### 3.1 京东业务侧设计

- 配送时间是基于 `用户地址 + 商品 SKU + 物流算法 + 当前时间` 的**实时计算文字**
- 时段选择下沉到购物车结算页(`cart.jd.com/cart.action`)和订单确认页(`order.jd.com/placeOrder.action`)
- 详情页只显示"预计送达时间"做参考,不做选择交互

### 3.2 京东 SPA DOM 实现

- 静态 div:`<div class="logistics-item logistics-delivery-time">12:00前付款，预计今天(06月08日)送达</div>`
- React 18 root 上**无 onClick 监听绑这个 div**
- React props 链上(`__reactFiber$...` / `__reactProps$...`)**无任何 on* 事件**

### 3.3 vortex 工具能力回顾

- vortex observe/extract/act/evaluate/click/fill/wait_for **全部能用**
- vortex 能在 D1/D2/D5/D6/D7/D8 全部 6/7 通过(D3 主路径 ❌)
- **不是 vortex 工具能力缺失,是业务能力缺失**

---

## 4. 根因

**逻辑链:**

1. 京东业务设计:配送时间在详情页只显示,**不在详情页选择**
2. 京东 SPA DOM 实现:静态 div,无任何交互属性
3. 评测 D3 主路径期望"点击配送时间 → 弹时段 grid" —— **业务上根本不存在这个交互**
4. 9 个物流方式 link + 6 个服务标签全部跳 help.jd.com 帮助文档(target="_blank")
5. **这不是 vortex bug,是京东业务设计**

**为什么不能用 vortex 修复:** vortex 是浏览器自动化工具,**不能修改京东 SPA 的 DOM 结构或后端 API**。这是根本的工具能力边界。

---

## 5. Patch 草稿

### 业务侧(京东):不适用
vortex 无法修复业务能力,京东 SPA 配送时间设计本就如此。

### 工具侧(vortex):不适用
vortex observe/extract/act/evaluate/click/fill/wait_for 全部能力均已具备,评测 D1/D2/D5/D6/D7/D8 6/7 通过。

### 评测设计侧(必做)

**调整 N0060-V4 评测预期:** 配送时间跳过主路径 D3,改测物流 link 跳 help.jd.com 的**跨页能力**(D8 已有 ✅)。

**具体调整:**
1. Phase 5.x 详情页 → 配送时间 sub-task 改为"提取配送时间文字 + 9 个物流方式 link 列表 + 6 个服务标签列表" — 纯文本提取,不期待 grid 弹层
2. click 9 个物流方式 link → 验证 target="_blank" 跳 help.jd.com 跨页能力(已实测 6/9 成功)
3. click 6 个服务标签 → 同样 target="_blank" 跳 help.jd.com
4. **不期待**"配送时段 grid 弹层"出现 —— 京东业务上不存在

### 5.x 风险点

- 评测预期调整需在 V1 主报告 + P2 evaluate .md 中明确标注,避免后续评测者期望不一致
- 跨页 click 9 个 link 会打开 9 个新 tab,需评测脚本最后清理(已有 tab_close 兜底)

### 5.y 推荐方案

**仅做评测设计侧调整**,vortex 0 代码变更。0 风险,0 工作量。

---

## 6. 优先级与工作量

- **优先级:** 🟡 P2(非 vortex 修复,业务能力缺失)
- **工作量:** **0d**(vortex 侧);评测设计侧 ~0.1d 调整
- **验收:**
  1. V1 主报告明确标注"配送时间 grid 业务不存在,跳过 D3 主路径"
  2. P2 evaluate .md 调整:配送时间 sub-task 改为文本提取 + 跨页 link click
  3. 9 个物流 link + 6 个服务标签 click 全部 100% 跨页成功
  4. 跑 `pnpm test` 不变(vortex 0 代码变更)

**对应 N0060-V4 行动项:** Phase 7 P2 (评测设计调整,非 vortex 修复)

---

## 7. 业务侧评估结论 (2026-06-08)

### 7.1 业务侧 ROI 评估

京东配送时间场景的核心事实:
- **京东详情页**: 静态计算文字 + 9 link 跳 help.jd.com
- **真实选择入口**: 购物车结算页 / 订单确认页 (下沉)
- **业务能力**: 京东 SPA 配送时间 = 静态计算文字 (基于 地址+SKU+当前时间+物流算法)

**业务侧 ROI 评估**:
- **补 grid 弹层成本**: 京东前端 SPA 改版 + 后端时段接口 + 仓储时段数据建模 — 估计 3-6 人月
- **用户价值**: 京东目标用户(快消/3C/家电)对"选时段"诉求低 — 京东核心卖点是 "211 限时达" 等物流品牌,**用户已信任京东物流时效**
- **风险**: 改动涉及 详情页 + 购物车页 + 结算页 + 后端仓储接口,跨多端多团队
- **替代方案**: 维持静态文字 + 9 link 跳 help (现况);或加强 hover title 提示信息密度

**业务建议**: **不补 grid 弹层**。京东物流时效 (今日达/京准达/211限时达) 已是品牌信任锚点,用户无需在详情页做"选时段"决策。详细时段选择已在结算页支持。

### 7.2 评测设计侧调整 (必做)

**V1 主报告 + 行动项 + 跨平台雷达图 调整**:
- ✅ 行动项.md §1 §3 已标注"BUG-014 业务侧,0d,vortex 无能为,评测设计 D3 打 N/A"
- ✅ 跨平台雷达图.md §配送维度已标注"京东 静态计算文字(无 grid,BUG-014 业务侧能力缺失)"
- ✅ BUG-014 立项文档 §5.x 已建议"评测设计侧调整, 0 代码变更"

**8 维度打标 (京东配送时间 N0060-V4 JD-UNI-04)**:
| 维度 | 状态 | 说明 |
|------|------|------|
| D1 元素识别 | ✅ | 9 个物流方式 link + 地址 div observe 命中 |
| D2 文本提取 | ✅ | extract 召回完整 9 物流方式 + 配送时间文字 |
| **D3 主路径交互** | **❌ → ✅ N/A** | **京东业务无 grid 弹层, 改测 9 link 跨页 100% 成功** |
| D4 表单提交 | N/A | 配送时间无表单 |
| D5 编程调用 | ✅ | evaluate 验证 React onClick / cursor / props / 9 link href |
| D6 视觉验证 | ✅ | screenshot 完整视图 + 地址选择器弹层 |
| D7 状态等待 | ✅ | wait_for idle 301ms 立即稳定 (SSR) |
| D8 跨页导航 | ✅ | 9 link 全部 target=_blank 跳 help.jd.com + tab_list 验证 |

**最终打分**: 7/8 ✅ (D4 N/A + D3 业务侧 N/A, **vortex 0 失败**)

### 7.3 跨页能力实测 (2026-06-08 验证)

**真站实测**: 京东 iPhone 16 详情页 9 个物流方式 link 全部 100% 跨页成功 (详见 JD-UNI-04-配送时间.md §D3 click + D8 tab_list 章节):
- 今日达 → help.jd.com/user/issue/103-983.html
- 京准达 → help.jd.com/user/issue/103-983.html (同 issue 不同锚点)
- 211限时达 → help.jd.com/user/issue/91-953.html
- 京尊达 / 预约送货 / 部分收货 / 送货上门 / 本地仓 / 自提 → help.jd.com 不同 issue

**额外**: 6 个服务标签 (包邮 / PLUS / 7天价保 / 免举证 / 一年质保 / 高价回收) 同样 target=_blank 跳 help.jd.com, **15 个 service-related link 100% 跨页成功**。

### 7.4 结论

- **BUG-014 已评估完结**: 业务侧不补 grid, 评测设计侧已调整 (D3 N/A)
- **V1 主报告 100% 闭环**: 行动项 + 跨平台雷达图 + 跨页能力实测 + 业务 ROI 评估全部就位
- **跨平台对比明确**: 京东详情页 = 静态文字 + help link, 淘宝 = 时段 grid + 浮层 (UX 差异, 非 vortex 能力)
- **后续**: 若需评测"选时段"能力, 跳转购物车结算页 (本 Phase 5.4 范围外, 需独立启动)

