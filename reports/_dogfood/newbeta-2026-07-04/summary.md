# newbeta.bytenew dogfood 评测循环 · 第一阶段汇总 (2026-07-04)

范围:Round 0-3 + 2 个 deferred spike。基线 main `3ad95b4` → `3d2d021`(7 提交,全推 main)。

## 交付一览

| 项 | 结果 | commit |
|----|------|--------|
| 脚手架 | 禁截图 EVAL-BRIEF-noshot + ledger | `7b5a462` |
| R0 recon | 站点地图 + 阶梯校准 | `46d6074` |
| R1 导航召回 | **clean** | `0bf5f22` |
| R2 表单 fill | **fixed+shipped** (真缺陷) | `be434e8` |
| R3 大表格 extract | 误诊(Spike1 推翻) | `266cd33`/`8884481` |
| Spike2 datetime | 误诊(推翻,回退投机改动) | `3d2d021` |

## 唯一真缺陷(已修上线)

**el-select commit verify 漏读只读 input.value → 假报 COMMIT_FAILED**(`be434e8`)
- 现象:`vortex_fill widget=select` 对班牛 el-select(单选值渲染进只读 `<input>`)返回 `COMMIT_FAILED: trigger shows ""`,而值实际已提交。
- 根因:verify 只读 `wrapper.innerText` + selected-item span(均不含 input.value)。与 aria-select react-select 假 COMMIT_FAILED 同族(verify 回读面窄于渲染面)。
- 修:verify 并入 wrapper 内 input.value 回读。JSDOM 真执行 TDD + live 双证(filterable/非 filterable) + 5744 测试零回归。

## 三个 live 推翻的误诊(spike 价值)

1. **R3 observe 漏 vxe 冻结列** → 实为 **80-item 显示截断**。elementFromPoint 证:body checkbox 被 fixed-left 覆盖层遮挡(observe 正确丢),fixed-left checkbox 过 occlusion 门已收集;控件时隐时现=截断变异非扫描盲区。
2. **R2 A-2 datetime fill 假成功** → **M3 索引错位伪缺陷**。M3 读 `input[2]`(文本框) ≠ date(e3);真实 fill 值留存并提交(popper 开/关均可)。
3. **R1 VOC 父卡 click 不切换** → 班牛 UX(选中露 add/more),act 精确命中真实 handler,非缺陷。

## 教训

- **M3 产出默认不可信**:3/4 报告的"缺陷"经 Claude live 白盒推翻(索引错位/旁路 evaluate/截断误读/UX 误判)。四桶闸门是核心,live 白盒不可省。
- **vite `build:main` 清空 dist/**:连带删 dist/page-side/*.js(page-side bundle)→ act 报 `Could not load page-side/actionability.js`。改动后须跑完整 `pnpm build`(vite build && build-page-side),非单 build:main。
- **承重墙禁投机改动**:datetime fix 目标不可 live 复现即回退,不为不存在的缺陷给核心 fill 加 RAF。

## 剩余 backlog(低优/观察)

- observe filter=all 间歇 30s 超时(无确定 repro,watch-item)
- el-date 非法值无格式预校验(readback==write,倾向 by-design)
- 密集表 + 常驻左栏时行控件被挤出 80 显示窗(截断取舍,改=提 cap 或 in-content 优先排序,产品决策)

## 未跑

R4-R10(弹窗模态/分页筛选/图文卡片识别/未知 app/流程 dialog/拖拽/综合任务链)——用户选择转攻 spike,暂停。
