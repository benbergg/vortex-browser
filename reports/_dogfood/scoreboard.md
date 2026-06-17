# vortex 生产化 scoreboard

> 跟踪验收线进度（设计：`docs/superpowers/specs/2026-06-17-vortex-production-readiness-loop-design.md`）
> 分支：`feat/production-readiness-loop`

## 验收线（停止条件）
| 线 | 状态 | 说明 |
|----|------|------|
| 真站通过率 ≥95% + 失败优雅降级 | ⏳ 待测 | 需 Chrome 扩展起后真站 spike |
| bench 全绿 + 无 silent false-success | ⏳ 未跑 | 环境就绪后基线 rerun |
| 效率达标（extract/screenshot/observe 延迟）| ⏳ 未测 | |
| 覆盖指定真站 | ⏳ 0/批 | A 族 spike 站点：Excalidraw/ag-grid/closed-shadow 等 |

## 迭代记账
| 轮 | 日期 | 范围 | 结果 |
|----|------|------|------|
| Phase 0 | 2026-06-17 | 三层并行设计审计 | 23 候选 → backlog |
| 证伪 R0 | 2026-06-17 | B1/C1/B3 读码核实 | **全证伪**（执行/协议层成熟）；真缺口=感知层 A 族盲区信号 |
| spike R1 | 2026-06-17 | A 族真站 spike | **A1/A2/A3 真站实锤 + A4/A5 读码确认**；证据 `spike-perception-blindspot-2026-06-17.md`；下一步 brainstorm 信号契约 |
| 实现 R2 | 2026-06-17 | A 族盲区信号 TDD 实现 | **A1 canvas/A2 虚拟列表/A4 截断量化 ✅ 实现+live 复验**(`# blindspots:`/`[blindspot=canvas]`/`# truncated:`)；**A3 closed-shadow defer**(host 未收集需专扫,最低价值)；mcp 503+ext 新增 20 测试全绿，普通页负例无误报；bench `observe-blindspot` 93/93 PR #51 |
| 证伪 R3 | 2026-06-17 | B/C/D 残余读码证伪 | **C2/C3/C4/D1 全证伪**(诚实失败/有意设计/已有 NO_EFFECT 守卫;C3 aria-select typeahead 兜底+批次4b live+bench el-autocomplete 绿)；连同 R0 的 B1/C1/B3 共 7 候选证伪 → **执行/协议层生产级成熟确认**；唯余 B2(STALE_SNAPSHOT 码不分「无快照/过期」,消息已分,P2 体验)defer。**无代码改动=正确结论** |

## 待办（按 Phase 1 策略）
- **A 族盲区信号**（brainstorm 设计闸门 → TDD 实现）：A2 虚拟列表 → A1 canvas → A3 closed-shadow → A4/A5 截断/iframe。**阻塞：需 Chrome 扩展起 + 真站 spike 确认盲区。**
- **B/C/D 残余**（/loop 全自动快速证伪）：B2/C2/C3/C4 + D1-D8。低 yield，逐条证伪记账。
