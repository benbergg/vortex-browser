# newbeta.bytenew dogfood 评测循环 · ledger

站点: https://newbeta.bytenew.com/ (已登录态) | 🚫截图硬门槛 | baseline main HEAD: `3ad95b4` (2026-07-04)
协议: 顺序 10 轮·由简到繁·就地修·每轮 ff-merge main | 四桶: vortex-defect / m3-error / site-issue / already-graceful
cycle 目录: reports/_dogfood/newbeta-2026-07-04/

## 前置检查 (Task 1, 2026-07-04)
- vortex-server 6800 LISTEN ✓ | tmux vortex-dev: claude/opencode/m3 ✓
- page-side dist 非陈旧 ✓ (observe 703候选 + fill success + query mode=css 回读 全新鲜)
- opencode 1.17.11 + minimax-cn-coding-plan/MiniMax-M3 provider ✓ (PROBE_OK 42)
- newbeta 已登录态 ✓ (业务页非登录墙)

## 轮次记账

| 轮 | 场景 | 桶归类 | 根因(一句话) | commit | bench | live 判定 | 状态 |
|----|------|--------|-------------|--------|-------|----------|------|
| 0  | recon 站点地图 | — | — | — | — | — | pending |
| 1  | 首页导航/菜单 observe 召回 | — | — | — | — | — | pending |
| 2  | 表单填写 fill + readback 校验 | — | — | — | — | — | pending |
| 3  | 大表格 extract | — | — | — | — | — | pending |
| 4  | 弹窗/popover 模态作用域 | — | — | — | — | — | pending |
| 5  | 分页/筛选/下拉 act + 状态回读 | — | — | — | — | — | pending |
| 6  | 图表识别(几何/style readback) | — | — | — | — | — | pending |
| 7  | 电子表格 query mode=sheet | — | — | — | — | — | pending |
| 8  | 流程图/画布 query mode=flow | — | — | — | — | — | pending |
| 9  | 拖拽/复杂交互 drag + observeEffect | — | — | — | — | — | pending |
| 10 | 综合任务链(多步 act) | — | — | — | — | — | pending |

> 状态: pending / clean(零缺陷) / fixed(有 defect 已修) / deferred(defect 记 backlog 未修) / blocked
> 场景在 Task 3 recon 后按 newbeta 真实页面校准;缺某类内容则等难度替换。

## blindspot 清单 (截图硬门槛副产)
（逐轮累积: 哪类内容非截图无法识别 + 现有工具为何盖不到 + 是否转 vortex-defect）

## backlog (非 vortex-defect 或未修)
（逐轮累积）
