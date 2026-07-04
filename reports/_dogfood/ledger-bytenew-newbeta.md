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
| 3  | 工单表/工作流演示 大表格 extract | 行列结构/无名 checkbox 召回/节点状态语义 | ~~vortex-defect~~ → **误诊(Spike1 推翻)** | ~~observe 漏冻结列~~ 实为 80-item 显示截断:body checkbox 被 fixed-left 覆盖层遮挡(observe 正确丢),fixed-left checkbox 过 occlusion 门+controlRoleFromClass 命名=已收集,但密集表被左栏 26 app 挤出 80 显示窗 | — | — | Spike1 live:elementFromPoint 证遮挡+同页不同 observe 操作按钮时隐时现=截断变异非盲区 | clean(误诊已订正) |
| 4  | 弹窗/浮层 模态作用域 observe | 筛选/流程/列表设置 dialog aria-modal 裁剪+焦点容器 | already-graceful (3 误诊推翻) | 无缺陷:A-1 role=tooltip 忠实 ARIA+非模态不裁正确;A-2 disabled 经 cursor 缺失表达;A-3 observe 正确裁到 wizard dialog,scope=full 全召回(下一步/close/跳过),默认 viewport 裁掉超视口底部 | — | — | Claude live:DOM 证唯一可见 dialog=工作流配置引导 aria-modal,scope=full 全出 | clean |
| 5  | 分页/筛选/下拉/排序 act+状态回读 | 10条/页 select/排序 arrow/视图 tab 切换 | already-graceful (3 异常 by-design) | 无 act 假成功;3 异常全是 observe 不表达班牛 class 态(active/desc/selected)——班牛零 ARIA(role/aria-selected/aria-sort 全 null),observe 忠实读 ARIA 故不表达。A-1 分页 value 实际观察里有(value=10条/页) | — | — | Claude live evaluate:tab role=null/aria-selected=null 只 .active class,ariaSort=0 | clean |
| 6  | 看板「图文卡片」非截图识别 | 退款管理大脑看板 4 卡→extract/query 读语义 | already-graceful | 0 blindspot:4 卡标题全非截图可读,1 张 echarts 数据 getOption 可读,3 卡「图」DOM 不渲染(title-only),空看板信号清晰非静默 | — | — | M3 extract+query 全读出;echarts 靠 evaluate getOption | clean(+增强候选) |
| 7  | 探未知 template app 组件 | 计算组件/新评价模板3.2/售后管理/ERP工作台 | site-issue (0 vortex 缺陷) | 0 blindspot;vortex 完美处理新 widget「解密显示」decrypt-on-click + 39 字段 walk-point 向导,全非截图。A-1 特殊 widget 被 admin 配置降级 string(配置层)/A-2 空 template app(admin 未建 worksheet)——均 site-issue | — | — | M3 报 2 异常自证 site-config,vortex 端全 readout | clean |
| 8  | 流程布局 dialog 画布 | 探 admin 流程设计器 | site-issue (mode=flow 降级正确) | 流程布局画布 admin 锁定不可达(开关 disabled,点击只收起)=site-issue;vortex 行为正确:query mode=flow 优雅降级报"未检测到流程图"非静默漏,主面板 canvas=0=普通 DOM table。非 blindspot | — | — | recon+r8 两次独立尝试均无法达画布 | clean |
| 9  | 拖拽 drag+observeEffect | 左侧小程序菜单 dragItem 排序/看板卡拖入(班牛唯一拖拽面) | — | — | — | — | — | pending |
| 10 | 综合任务链 多步 act | 筛选→选中 checkbox→行操作→处理 dialog 填写→提交;descriptor 自愈/stale ref 跨步稳态 | — | — | — | — | — | pending |

> 状态: pending / clean(零缺陷) / fixed(有 defect 已修) / deferred(defect 记 backlog 未修) / blocked

## blindspot 清单 (截图硬门槛副产)
（逐轮累积: 哪类内容非截图无法识别 + 现有工具为何盖不到 + 是否转 vortex-defect）

## backlog (非 vortex-defect 或未修)
- **[r2 A-2 — Spike2 推翻误诊]** 原判"datetime fill 假成功"**不成立**。Spike2 live:`vortex_fill` 对 bytenew 截止时间 el-date-editor 填 `2026-07-15 10:30:00` → query mode=css 回读值**留存并提交**(popper 开/关均可,面板开启时也不清空)。M3 的 A-2 证据是 `fill @e3` 后读 `.el-dialog input[2]`,但本 dialog input 顺序 [2]=请输入内容(文本框,未填故空) ≠ date(e3=[3])——**M3 索引错位读错字段的伪缺陷**。真实 datetime fill 无缺陷。曾据 A-2 加 fill 异步再验(dom.ts RAF re-check),因目标不可复现 + 给核心 fill 每次加 RAF 属无 live 证据投机改动,**已回退**(承重墙纪律)。
- **[r2 A-3 by-design/低]** `vortex_fill` 对 el-date-editor 不做格式预校验,非法串 `abc-invalid-date` 返回 success+input.value 写入,Enter 后 model 不 commit。readback==write(非严格 fill 假成功);fill 只管输入、app 拒格式。倾向 by-design,暂不修。
- **[r3 observe 漏 vxe 冻结列 — Spike1 推翻误诊,降级]** 原判"observe 盲于冻结列"**不成立**。真相:vxe fixed-left 是 absolute 覆盖层(z5),body checkbox 被其遮挡→observe occlusion 门正确丢弃;fixed-left checkbox 是顶层、过 occlusion+controlRoleFromClass 命名=**已收集**。控件时隐时现于 observe 输出=**80-item 显示截断变异**(左侧 26 app 启动栏 DOM 序在前吃半配额),非扫描盲区。→ 非缺陷。**残留低优观察**:密集表 + 常驻左栏时行控件易被挤出 80 显示窗,agent 拿不到 ref 则不可达。属截断/排序取舍(既有 80-cap),若要改=提 cap 或"in-content 控件优先于常驻 nav"排序,属产品决策非 bug,暂不动。
- **[r6 query mode=chart echarts 数据 readback — 顶级增强候选,最贴合非截图主题]** echarts/G2 canvas 图表只能被 observe 检测为 blindspot(readback:chart),但**数据(series/xAxis/legend/values)无原生 readback**,须 evaluate `window.echarts.getInstanceByDom(dom).getOption()`。增强=新增 `vortex_query mode=chart`:定位 echarts 实例→getOption→提结构化 {title,series,xAxis,legend,values}(类比 mode=sheet/flow)。G2/Chart.js 各自 API。**最贴合"练不截图识别图表"主题**,应独立 brainstorm→spec→implement。参 [[vortex_hardvisual_eval_phase2_chart]](已有 chart 检测,缺数据提取)。
- **[r5 observe 不推断 class-based 状态 — 增强候选,产品决策]** 班牛(及许多国内组件库)用纯 class 表达状态(`.active` tab / `.desc` 排序 / `.selected` 选中),零 ARIA(role/aria-selected/aria-sort 全无)。observe 忠实读 ARIA 故不表达这些态,agent 须 query mode=css attr=class 补读(可达)。增强项:observe 从常见状态 class(`.active/.is-active/.selected/.current/.checked`)推断 `[active]/[selected]`。**风险**:`.active` 等 class 语义不唯一(动画/hover/非选中态)→ FP,需白名单+谨慎。非缺陷(状态 query 可达),留产品决策。
- **[r4 超视口模态无"更多"提示 — 低优观察]** 模态 dialog 比视口高时,默认 viewport observe 只出视口内控件(如 wizard 只出 close)+`# modal:(suppressed N)`,但**无 off-viewport modal 控件的"N more below"提示**→ agent 可能误以为模态只有 close 而关掉、错过 下一步 向导流。控件 scope=full 可达故非硬缺陷;增强项=模态裁剪时对视口外 modal 内控件补 offScreenActionable/"N more below"。
- **[r2 observe filter=all 间歇超时]** M3 在重 DOM churn 下撞 observe.snapshot 30s MCP 超时 2 次,Claude live 同页 filter=all 正常返回(784 候选)未复现。间歇性、无确定性 repro→无法 TDD。列 watch-item,若后续轮复现且可稳定触发再开 spike。
