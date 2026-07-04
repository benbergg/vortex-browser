# newbeta.bytenew dogfood 评测循环 · ledger

站点: https://newbeta.bytenew.com/ (已登录态) | 🚫截图硬门槛 | baseline main HEAD: `3ad95b4` (2026-07-04)
协议: 顺序 10 轮·由简到繁·就地修·每轮 ff-merge main | 四桶: vortex-defect / m3-error / site-issue / already-graceful
cycle 目录: reports/_dogfood/newbeta-2026-07-04/

## 前置检查 (Task 1, 2026-07-04)
- vortex-server 6800 LISTEN ✓ | tmux vortex-dev: claude/opencode/m3 ✓
- page-side dist 非陈旧 ✓ (observe 703候选 + fill success + query mode=css 回读 全新鲜)
- opencode 1.17.11 + minimax-cn-coding-plan/MiniMax-M3 provider ✓ (PROBE_OK 42)
- newbeta 已登录态 ✓ (业务页非登录墙)

## Round 0 recon 结论 (2026-07-04, M3 探 5 app/7 页 + Claude live 校准)

班牛低代码平台,26 个小程序。**关键发现**:
- **无 echarts canvas 图表**(所有已探页 canvas=0,svg 仅图标级);看板多为空或「图文卡片」(退款管理大脑看板=4 张 img+text 卡片)。
- **无 canvas 电子表格**(全是 DOM `<table>`/vxe)。
- **流程画布**:工作流演示「流程」按钮→「流程布局」开 **dialog**(admin 流程设计器),画布本体未证实;主视图是节点状态列表表格。
- **拖拽**:仅左侧菜单 dragItem admin 排序,业务行内无。
- **M3「observe 全页超时」未复现**:Claude live 在工作流演示(824 候选)`filter=interactive` observe 正常无超时。疑 M3 用了 filter=all/scope=full。列为待观察,非缺陷。
- 未探: 新评价模板3.2/售后管理/ERP工作台/计算组件/产品体验大盘(名字特殊,可能含表单/特殊控件/图表)→ 折入 R7 自适应探未知。

据此**重排场景阶梯**(缺 echarts/canvas 表格→替换为等难度真实挑战;保留非截图 readback 练功于 R6 图文卡片/R8 flow-若存在):

## 轮次记账

| 轮 | 场景(recon 校准后) | 主考能力 | 桶归类 | 根因 | commit | bench | live | 状态 |
|----|------|----------|--------|------|--------|-------|------|------|
| 0  | recon 站点地图 | — | — | — | — | — | — | done |
| 1  | 首页/工单表 导航+菜单 observe 召回 | 裸 div onClick 小程序卡/moreNav 深浮层/cursor:pointer | already-graceful | 无缺陷:召回完整(顶部5/5·卡28·moreNav19/19),act 可靠;VOC父卡 click 不切换=班牛 UX(露 add/more,getAppDetail 已发) | — | 无回归 | Claude live 证实 act 精确命中+触发真实 handler | clean |
| 2  | 工单表 新建工单 表单填写 | fill/fill_form + mode=css/component readback 校验 | **vortex-defect** (A-1) | el-select verify 只读 wrapper.innerText+selected-item span,不含只读 `<input>.value`;班牛单选值渲染进 input→假报 COMMIT_FAILED(同族 aria-select 2026-06-14) | 见提交 | 5744 过/select 全绿 | live 双证:filterable执行人+任务状态 fill widget=select 均 success 且真提交 | fixed |
| 3  | 工单表/工作流演示 大表格 extract | 行列结构/无名 checkbox 召回/节点状态语义 | — | — | — | — | — | pending |
| 4  | 弹窗/浮层 模态作用域 observe | 筛选/流程/列表设置 dialog aria-modal 裁剪+焦点容器 | — | — | — | — | — | pending |
| 5  | 分页/筛选/下拉/排序 act+状态回读 | 10条/页 select/排序 arrow/视图 tab 切换 | — | — | — | — | — | pending |
| 6  | 看板「图文卡片」非截图识别 | 退款管理大脑看板 4 卡 img alt/text→extract/query 读语义(替原 echarts 轮) | — | — | — | — | — | pending |
| 7  | 探未知 template app 组件 | 新评价模板3.2/计算组件/产品体验大盘 自适应,遇特殊控件/图表 | — | — | — | — | — | pending |
| 8  | 流程布局 dialog 画布 | 探 admin 流程设计器;有 x6/antv 画布→mode=flow readback,否则记 blindspot/降级 | — | — | — | — | — | pending |
| 9  | 拖拽 drag+observeEffect | 左侧小程序菜单 dragItem 排序/看板卡拖入(班牛唯一拖拽面) | — | — | — | — | — | pending |
| 10 | 综合任务链 多步 act | 筛选→选中 checkbox→行操作→处理 dialog 填写→提交;descriptor 自愈/stale ref 跨步稳态 | — | — | — | — | — | pending |

> 状态: pending / clean(零缺陷) / fixed(有 defect 已修) / deferred(defect 记 backlog 未修) / blocked

## blindspot 清单 (截图硬门槛副产)
（逐轮累积: 哪类内容非截图无法识别 + 现有工具为何盖不到 + 是否转 vortex-defect）

## backlog (非 vortex-defect 或未修)
- **[r2 A-2 确诊待 spike]** `vortex_fill`(无 widget) 对 el-date-editor--datetime 单步返回 success 但 model 空、须 Enter 才 commit(fill 假成功)。单 datetime 无对应 commit driver kind(仅 daterange/datetimerange/time)。真因需 spike:el-date-editor commit 时序 + 是否补 `datetime` commit driver。**优先级高**(silent 数据丢失)。
- **[r2 A-3 by-design/低]** `vortex_fill` 对 el-date-editor 不做格式预校验,非法串 `abc-invalid-date` 返回 success+input.value 写入,Enter 后 model 不 commit。readback==write(非严格 fill 假成功);fill 只管输入、app 拒格式。倾向 by-design,暂不修。
- **[r2 observe filter=all 间歇超时]** M3 在重 DOM churn 下撞 observe.snapshot 30s MCP 超时 2 次,Claude live 同页 filter=all 正常返回(784 候选)未复现。间歇性、无确定性 repro→无法 TDD。列 watch-item,若后续轮复现且可稳定触发再开 spike。
