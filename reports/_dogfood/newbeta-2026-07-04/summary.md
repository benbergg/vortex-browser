# newbeta.bytenew dogfood 评测循环 · 完整汇总 (2026-07-04/05)

范围:Round 0-10 全跑 + 2 deferred spike。基线 main `3ad95b4` → `506de62`。截图硬门槛全程零 `vortex_screenshot`。

## 轮次结果一览

| 轮 | 场景 | 结果 | 桶 |
|----|------|------|-----|
| 0 | recon 站点地图 | 阶梯校准 | — |
| 1 | 导航/菜单 observe 召回 | clean | already-graceful |
| 2 | 表单 fill + readback | **FIXED+SHIPPED** | **vortex-defect** |
| 3 | 大表格 extract | clean(Spike1 推翻误诊) | 截断非盲区 |
| 4 | 弹窗模态作用域 | clean(3 误诊推翻) | already-graceful |
| 5 | 分页/排序/tab 状态回读 | clean(3 by-design) | already-graceful |
| 6 | 图文卡片非截图识别 | clean(0 blindspot) | +增强候选 |
| 7 | 探未知 app | clean(新 widget 全处理) | site-issue |
| 8 | 流程布局画布 | clean(mode=flow 降级正确) | site-issue |
| 9 | 拖拽排序 | clean(drag 真生效) | already-graceful |
| 10 | 综合任务链 | clean(stale fail-safe 正确) | site-issue(3 真站 bug) |

**结论**:10 轮唯一真 vortex 缺陷 = R2 el-select verify(已修上线)。其余 9 轮全 clean / site-issue / 误诊推翻。vortex 在成熟复杂真站(班牛 Vue/vxe/SortableJS)表现稳健。

## 唯一真缺陷(已修上线)

**el-select commit verify 漏读只读 input.value → 假报 COMMIT_FAILED**(`be434e8`)
根因:verify 只读 `wrapper.innerText`+selected-item span(不含 input.value),班牛单选值渲染进只读 input → 值已提交却报失败。与 aria-select react-select 假 COMMIT_FAILED 同族。JSDOM 真执行 TDD + live 双证 + 5744 测试零回归。

## vortex 正面亮点(经 live 白盒确认)

- **observe**:模态作用域裁剪正确(aria-modal + [behind-modal] 逃生口)、忠实读 ARIA、occlusion 门正确(遮挡/覆盖层)、无名控件 controlRoleFromClass 命名、canvas/flow blindspot 降级信号。
- **act/fill/drag**:fill 非假成功(query 回读一致)、精确命中真实 handler、SortableJS 非原生拖拽真生效、OBSCURED 正确检测冻结 mask、stale ref fail-safe(STALE_SNAPSHOT 不静默错点)。
- **query mode=flow**:无流程图时优雅降级报错非静默漏。
- **新 widget**:解密显示 decrypt-on-click、39 字段 walk-point 向导全非截图 readout。

## M3 评测误诊率(四桶闸门 + live 白盒的价值)

M3 报告的"缺陷"绝大多数经 Claude live 白盒推翻:
- R3 observe 漏冻结列 → 80-item 截断(elementFromPoint 证)
- R4 模态漏主 dialog → viewport 作用域(scope=full 全召回)
- A-2 datetime fill 假成功 → M3 索引错位读错字段(input[2]=文本框≠date)
- R1 VOC 卡不切换 / R5 状态回读 / R7-R10 多数 → 站点 UX/config/ARIA 缺失/真站 bug
教训:M3 产出默认不可信,四桶闸门 + live 白盒不可省。

## 增强候选 backlog(非缺陷,值独立立项)

1. **[顶级·最贴合非截图主题] `query mode=chart`**:echarts/G2 canvas 图表数据(series/axis/values via getOption)无原生 readback,须 evaluate。
2. **observe class-based 状态推断**:班牛零 ARIA,纯 `.active/.selected` class;observe 可从常见状态 class 推断(FP 风险,白名单)。
3. **超视口模态"N more below"提示**:tall modal 默认 viewport observe 只出顶部控件,无下方提示。
4. observe [draggable] 覆盖 SortableJS 非原生拖拽项(drag 已生效,仅信号补全)。

## 低优 backlog

- observe filter=all 间歇 30s 超时(无确定 repro,watch)
- el-date 非法值无格式预校验(倾向 by-design)

## 工程教训(已沉淀 memory)

- vite `build:main` 清空 dist/ 连带删 page-side bundle → 改 dom.ts 须完整 `pnpm build`。
- 承重墙禁无 live 证据投机改动(datetime fix 目标不可复现即回退)。
