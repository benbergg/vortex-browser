# M3 评估简报 — newbeta.bytenew dogfood（r1）· 🚫截图硬门槛

> 你（MiniMax-M3）是执行者+记录者。只记「我做了什么/工具返回什么/看到什么」+证据。**禁 vortex_screenshot、禁改代码、禁提交 git、禁用 evaluate 完成交互**。
> 通用规则见 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`（截图硬门槛/防缓存漂移/裁决来源唯一/铁律）——**务必先读它**。

## 目标站（已登录态，直接 navigate）

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255`（班牛平台，默认打开「工单测试表0611」）

## 本轮场景（r1）：首页/工单表 导航 + 菜单 observe 召回 + act 点击验证

**主考 vortex 能力**：`vortex_observe` 对班牛导航面的召回完整性（裸 `div` onClick 小程序卡、`moreNav` 深浮层、`cursor:pointer` 无 role 控件），以及 `vortex_act` 点击这些非标准控件的可用性。

### 步骤（全新 tab，≤30 次工具调用）

1. `vortex_tab_create({url:"<上面的 URL>", active:true})` → `vortex_wait_for {mode:idle}` → `vortex_observe {filter:interactive}`。
2. **召回核对**（只用 observe 返回值判定，不用 evaluate）：
   - 顶部导航 `首页/犇犇/小程序/搜索` 是否都召回（带 name）？
   - 左侧 26 个小程序卡（`vx预发评测0611`/`工单测试表0611`/`VOC工作台`/`退款管理`/`评价管理（演示专用）`/`工作流`/…）是否都召回为可点 div（带 name）？有无遗漏或无名？
   - `moreNav`（其他应用）是否召回？点击它（`vortex_act click`）后 observe，浮层里的 `物流/发票/数据集成/大脑/服务大厅/知识库/消费者标签/售后/费用/礼赠/退换补/打款…` 子项是否都召回为可点项？**这是深浮层召回重点**。
3. **act 可用性抽验**（核心动作必须走 act，不许 evaluate）：
   - `vortex_act click` 一个小程序卡（如 `VOC工作台`），observe 确认左侧/主区切换（app 切换生效）。
   - `vortex_act click` 顶部 `犇犇` 或 `小程序` tab，observe 确认导航生效。
   - 点 moreNav 里某个子项（如 `知识库`），observe 确认浮层导航生效或新页。
4. **异常判定**：某导航/菜单项 observe **漏召回**（无名/缺失/无法引用），或 `act click` 对它**失败**（≥2 条 vortex 原生路径都失败：如「observe 拿 ref→act 失败」+「act 文本定位失败」），才记异常。
5. **blindspot**：若某菜单/图标项 observe 只给出空名或无法识别其含义（如纯图标无 aria），且 query mode=css 读 class/title 也定不出语义 → 记 `[blindspot]`，填 tried_alternatives。

## 产出（双产物，写到 `reports/_dogfood/newbeta-2026-07-04/`）

1. `eval-observations-r1.md`（人读，格式见通用模板）
2. `anomalies-r1.json`（严格符合 `reports/_dogfood/anomalies.schema.json`，`cycle` 填 `dogfood-newbeta-2026-07-04`，无异常则 `anomalies:[]` 并在 observations 写清试了哪些非视觉路径）

## 完成标志

双产物写完；json schema 合法；每条异常带 ≥2 tried_alternatives + action_path_is_vortex_native；完成后一段话报告：导航/小程序/moreNav 召回是否完整、act 抽验结果、有无异常/blindspot。
