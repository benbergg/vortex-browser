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

## 广度 dogfood（验收线「覆盖真站」）
| 站点/视图 | 日期 | 结果 |
|----------|------|------|
| 班牛 工单测试表(applet 58860) | 2026-06-17 | **0 缺陷**：observe 召回良好；div-onClick 状态下拉浮层(N0064 focus-container 病灶)端到端正常——8 status label 带 checked 态全召回 + act click ariaChanged 生效；小数据视图无虚拟/canvas 正确不触发盲区信号(无误报)。**N0064 修复真站持续生效** |
| 班牛 流程布局(LogicFlow 入口) | 2026-06-17 | **非缺陷**：「流程布局」菜单项 `disabled`+`cursor:not-allowed`+无 listener → observe(interactive) 正确省略(already-graceful);LogicFlow 画布此视图不可达(工作流未配置/无权限),A1 canvas 信号未能在班牛复验(已在 Excalidraw live 验证) |
| Semi Design Table 文档页 | 2026-06-17 | **0 缺陷 + 关键负例 PASS**：74 个装饰 Monaco minimap canvas(115×500 超阈值)**未过报** `[blindspot=canvas]`(无交互信号不被收集,A1 收集门挡住装饰 canvas);**A2 覆盖观察**:Semi `aria-rowcount=渲染数` → ARIA-based A2 不触发非 ARIA 虚拟化(见新 backlog A2-fb);filter=all 超重页(303 行+111 canvas)超时(页面固有) |
| Naive UI data-table | 2026-06-17 | **A2-fb 缺口 live 确认真实**：`.v-vl` 虚拟表总 ~1000/~2921 行,DOM 仅 9-12 行,**全页 0 aria-rowcount** → A2(ARIA-based)不触发。**→ 随即实现 A2-fb 并 live 复验通过**(见下) |

## 实现 R4 — A2-fb 非 ARIA 虚拟化(dogfood 驱动)
- **缺口来源**:广度 dogfood(Naive)发现 A2 只认 ARIA 声明虚拟化,漏 Semi/Naive/react-window。
- **实现**:`detectVirtualByScroll`(强滚动 scrollH≥clientH×4 + estTotal=scrollH/rowH >> 渲染数;虚拟本质=只渲染窗口,普通滚动列表渲染全部故 est≈rendered 不触发),inline 进 page-side dedicated pass,`# blindspots: <name> virtual(~N/M)` confidence:low(~ 标估算)。
- **live 验证**(Naive,新 build):检出 3 虚拟表(~2958/11、~1000/8、~635/55,ratio 42-561×),**43 表中 40 普通/分页表零误报**(__seenScrollers dedup 折叠嵌套表)。
- **回归**:mcp 504 + ext 1183 + 17 blindspot 单测;bench fixture 加 A2-fb 正例(~N/10)+负例(普通 30 行滚动不报);**全量 bench 93/93 ALL GREEN + baseline 刷新**;顺带修 logicflow-connect pointermove 合并 flaky(>=STEPS→>=2+buttons 合并容错)。
- **教训**:广度 dogfood(多库)抓出单站(ag-grid)A 族漏掉的真 P1;A1 收集门=误报防线(Semi 74 装饰 canvas 不报);A2-fb 误报靠「est>>rendered」判据天然区分虚拟 vs 普通滚动。

## 待办（按 Phase 1 策略）
- **A 族盲区信号**（brainstorm 设计闸门 → TDD 实现）：A2 虚拟列表 → A1 canvas → A3 closed-shadow → A4/A5 截断/iframe。**阻塞：需 Chrome 扩展起 + 真站 spike 确认盲区。**
- **B/C/D 残余**（/loop 全自动快速证伪）：B2/C2/C3/C4 + D1-D8。低 yield，逐条证伪记账。
