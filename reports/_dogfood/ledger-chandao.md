# chandao(禅道) dogfood 评测循环 · ledger (R11-R20)

站点: https://chandao.bytenew.com/zentao/ (已登录态·用户「青蛙」) | 🚫截图硬门槛 | baseline main HEAD: `0bf8fbc` (2026-07-05)
协议: 顺序 10 轮·由简到繁·**只读评测为主**·就地修·每轮 ff-merge main | 四桶: vortex-defect / m3-error / site-issue / already-graceful
强 oracle: 禅道 API skill (`~/.claude/skills/zentao-api/`) 拉真值交叉核对 UI 读数
cycle 目录: reports/_dogfood/chandao-2026-07-05/

## 前置检查 (Task 9, 2026-07-05)
- vortex-server 6800 LISTEN ✓ (PID 69634) | tmux vortex-dev: claude/opencode/m3 window ✓
- opencode 1.17.13 + minimax-cn-coding-plan/MiniMax-M3 ✓
- page-side dist 非陈旧 ✓ (observe 745 候选正常召回, ref 新鲜, frame 616)
- 禅道已登录态 ✓ (地盘页 my.html, 用户「青蛙」, 366 任务/6 需求/1077 resolvedBy bug)

## Round 0 recon 结论 (2026-07-05, Claude live observe 地盘)

标准禅道 **18.3**。主导航: 地盘/项目集/产品/项目/执行/测试/看板/文档/组织/后台。**关键发现**:
- **禅道用真 ARIA**: observe 召回 `navigation`/`landmark`/`list`/`listitem`/`searchbox`/`progressbar`(value/valuemin/valuemax) 全出。与上轮班牛「零 ARIA 纯 class」正交 → observe 基线更好, 缺陷更可能在 iframe 详情/echarts 图/Zui dropdown/树/看板拖拽。
- **技术栈**: PHP 服务端渲染 + Zui(Bootstrap 衍生) + jQuery, 部分模块(看板/仪表盘)含 Vue/echarts。与上轮 Vue/vxe/SortableJS 完全正交。
- **数据量充足**: 366 任务/6 需求/1077 resolvedBy bug → 表格/翻页/筛选压力足。
- **图表**: 项目仪表盘 `/project-index-{id}.html` 含燃尽图(禅道 18.x = echarts) → R18 复用 mode=chart 验证。
- **iframe**: 禅道详情/编辑弹层惯用 iframe 整页加载 → R19 modal×frame 交叉。

## 场景阶梯 (recon 校准)

| 轮 | 场景 | 主考能力 | URL |
|----|------|----------|-----|
| R11 | 我的任务 列表读取 | 表格行/状态徽章/优先级/ARIA 召回 | /my-work-task.html |
| R12 | 任务详情 字段读取 | 详情页/iframe · label-value 配对 · 工时 | /task-view-{id}.html |
| R13 | 需求列表 下拉筛选+关键字搜索 | Zui dropdown · 高级搜索 · 结果回读 | /product-story-{id}.html |
| R14 | Bug 列表 翻页+排序回读 | jQuery 分页器 · 排序箭头态 · 每页N条 | /bug-browse-{id}.html |
| R15 | 看板 kanban 浏览 | 列分组/卡片/`[draggable]` 盲区(只读不拖) | /execution-kanban-{id}.html |
| R16 | 产品/模块 树形导航 | 模块树展开态/虚拟 | /product-browse.html |
| R17 | 富文本详情+附件列表 | 描述 HTML/附件表/评论流 | (需求/bug view) |
| R18 | 项目仪表盘 燃尽图 | **chart blindspot**(复用 mode=chart 验禅道 echarts) | /project-index-{id}.html |
| R19 | 编辑弹层(iframe 模态·只读观察 scope) | modal scope × frame(OOPIF) 交叉 | (edit iframe modal) |
| R20 | 综合链: 跨模块导航 + API oracle 交叉核对 | 端到端 + 真值判定 | 多页 |

## 轮次记账

| 轮 | 场景 | 主考能力 | 桶归类 | 根因 | commit | bench | live | 状态 |
|----|------|----------|--------|------|--------|-------|------|------|
| R0 | recon 站点地图 | — | — | — | — | — | Claude live observe 地盘 | done |
| R11 | 我的任务列表 | 行/状态/优先级/排序/翻页非截图识别 | already-graceful×3 + m3-error×1(+DX改进) | A1 observe不召回纯文本span→extract一次读全表(状态/优先级齐)=分工正确; A2 排序态无aria-sort→href含_asc/_desc+query attr=class可读; A3 attr管道"class 竖 title"静默{}→单属性正常=m3误用,采纳DX改进(attr分隔符拆分+消静默空); A4 iframe需frameId=by-design(observe ref前缀已暴露frameId=640) | `daddd2b`(DX) | 1850/1850 无回归 | Claude live白盒+双证: extract全表齐/attr单属正常/observe穿iframe640/**attr=class竖href 修复后返双键(修前{})** | fixed(DX改进) |
| R12 | 任务详情 | — | — | — | — | — | — | pending |
| R13 | 需求筛选搜索 | — | — | — | — | — | — | pending |
| R14 | Bug 翻页排序 | — | — | — | — | — | — | pending |
| R15 | 看板浏览 | — | — | — | — | — | — | pending |
| R16 | 模块树导航 | — | — | — | — | — | — | pending |
| R17 | 富文本+附件 | — | — | — | — | — | — | pending |
| R18 | 燃尽图 | — | — | — | — | — | — | pending |
| R19 | iframe 模态 | — | — | — | — | — | — | pending |
| R20 | 综合链+oracle | — | — | — | — | — | — | pending |

> 状态: pending / clean(零缺陷) / fixed(有 defect 已修) / deferred(defect 记 backlog 未修) / blocked

## blindspot 清单 (截图硬门槛副产)
（逐轮累积: 哪类内容非截图无法识别 + 现有工具为何盖不到 + 是否转 vortex-defect）
- **[R11] 无 true blindspot**。任务表所有语义(任务名/状态/优先级/工时/截止)均非截图可读:observe 召回交互元素(任务名/操作 link)、**extract 一次读全表**(含状态"已完成"/优先级"2")、query mode=css/style 补属性/颜色。observe 不召回无 role 纯文本 span(状态/优先级)属 filter 分工(extract 覆盖),非盲区。

## backlog (非 vortex-defect 或未修)
（逐轮累积）
- **[R11 A-2 排序态 class 推断 — 增强候选,延续上轮 R5]** 禅道表头排序态用 `<a class="sort-up|sort-down|header">` 无 aria-sort,observe 忠实读 ARIA 故不表达方向;补足路径足够(href 含 `_asc/_desc` 方向 + query attr=class 可读)。增强项=observe 从常见排序 class 推断 `[sort=asc/desc]`,与上轮"class-based 状态推断(.active/.selected)"同族,同样有 FP 风险,留产品决策。
- **[R11 A-4 iframe 需 frameId — by-design,已优雅]** evaluate/query 默认 main frame,禅道任务表在 iframe#appIframe-my 需显式 frameId;observe frames=all-permitted 自动穿透且 ref 前缀暴露 frameId(如 @ebbe:f640e49),agent 可据前缀传 frameId。非缺陷。
