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

## 待办（按 Phase 1 策略）
- **A 族盲区信号**（brainstorm 设计闸门 → TDD 实现）：A2 虚拟列表 → A1 canvas → A3 closed-shadow → A4/A5 截断/iframe。**阻塞：需 Chrome 扩展起 + 真站 spike 确认盲区。**
- **B/C/D 残余**（/loop 全自动快速证伪）：B2/C2/C3/C4 + D1-D8。低 yield，逐条证伪记账。
