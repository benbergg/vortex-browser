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
| GitHub(搜索→仓库→issues→issue) | 2026-06-17 | **0 缺陷**:observe 密集列表 ref 完整(分页非虚拟正确不报盲区)、act click→导航捕获、extract 忠实返回 DOM(issue 正文仅 "Problem" 一节点=GitHub React viewer 懒渲染,非 extract 漏抓,evaluate 核实 textContent===innerText)、**A4 截断量化信号真实生产页生效** `# truncated: returned 80 of ~146`、query 精确 element_path。执行/感知层成熟再印证 |
| **YouTube(搜索结果,Polymer+Trusted Types)** | 2026-06-17 | **发现 1 真 P0 并 TDD 修复**:observe 完美穿透 ytd open shadow;追加式懒加载正确不触发 A2-fb。**缺陷=`vortex_evaluate({async:true})` 多语句在 TT 站 100% 崩**(根因 `new Function` 不接受 TrustedScript,仅 eval 接受);**修复 `0db53f9`**(async 改 eval+表达式 IIFE + handler CDP 回退认 TT + 修 false-green mock);live 复验 async 多语句/纯表达式/await 全通过 |
| Google Maps(瓦片 canvas+drag) | 2026-06-17 | **0 缺陷**:observe 召回结果 feed、地图大 canvas(cursor:auto 非交互)A1 优雅不误报(可操作内容全在 DOM)、act click→SPA 详情面板(observeEffect 捕获)、**mouse_drag 成功平移重型瓦片 canvas**(截图证「在此区域搜索」按钮出现)、screenshot/evaluate 正常。canvas+drag 在异于 Excalidraw 的形态下确认成熟 |
| Booking.com(widget 表单) | 2026-06-17 | **inert/DISABLED 行为正确(非缺陷)+ 诊断质量 P2 修复**:加载弹 modal→背景内容 [inert]→搜索框 isEnabledElement=false,vortex 正确拒绝 type(关 modal 后立即成功)。但 DISABLED 对「inert 背景化」与「原生 disabled」一视同仁,泛化 hint 误导。**修复 `d50f885`**:probe 区分 inert(extras.inert)→ waitActionable 超时消息追加关遮挡指引;live 验证 inert→改进消息 / 原生 disabled→纯消息无过触发 |

## 实现 R6 — inert(modal 背景化)DISABLED 诊断可 actionable(Booking.com dogfood 驱动)
- **缺口来源**:广度 dogfood 第三轮 Booking.com。加载即弹 modal+背景 [inert] 是极常见真实模式,第一个真实表单站就撞上。
- **非缺陷部分**:vortex 拒绝写 inert 元素**正确**(关 modal 后 type 立即成功),inert 处理(2026-06-04 审计)工作正常。
- **诊断缺口(P2)**:actionability DISABLED 对「inert 背景化(关遮挡)」与「原生 disabled 控件(满足前置)」一视同仁,泛化 hint「增大 timeout / wait_for idle」对 inert 场景误导(等待无用)。
- **修复 `d50f885`**:① probe DISABLED 失败时探测 `el.closest("[inert]")` 携 extras.inert;② waitActionable 超时 lastReason=DISABLED 且 inert 时,消息追加「元素在 [inert] 子树,常见 modal/overlay 背景,先关闭遮挡层(Escape/关闭按钮)再重试」。
- **回归**:扩展 1192 + bench 93/93 + 2 新测试;live Booking.com 注入 inert→改进消息、原生 disabled→纯消息(无过触发)。
- **教训**:① 行为正确 ≠ 诊断到位——「失败优雅降级」要求 actionable 信号,inert/modal 是最常见的表单阻塞模式;② 实时重渲染站(Booking React)live 验证须用受控注入排除重渲染干扰(FORM 打 inert 触发重渲染致 NOT_ATTACHED 干扰)。

## 实现 R5 — evaluate async Trusted Types 崩溃(YouTube dogfood 驱动)
- **缺口来源**:广度 dogfood 第二轮(代表性应用场景:GitHub SaaS + YouTube 媒体)。GitHub 全清,YouTube 抓出 P0。
- **缺陷**:`vortex_evaluate({async:true})` 多语句代码在 Trusted Types 强制站(YouTube/Google/GitHub 等一大类主流站)100% 崩 `JS_EXECUTION_ERROR: ...violates Trusted Type assignment`。
- **根因(live 实证矩阵)**:`eval(p.createScript(c))`→成功 vs `new Function(p.createScript(src))`→TT 崩。**TT 下 eval 接受 TrustedScript,new Function 不接受**(参数 ToString 后重新校验)。同步 EVALUATE 走 eval 故正常,EVALUATE_ASYNC 走 new Function 故崩。
- **修复 `0db53f9`**:① async page-side 改用 `eval` + 表达式 IIFE 形式(无顶层 return,exprSrc 先试 SyntaxError 回退 stmtSrc);② handler CDP 终极回退增加 `isTrustedTypesBlocked`(policy-allowlist 站兜底,CDP 绕过 TT);③ 修正 false-green mock(`new Function(TrustedScript)` 应恒抛)。
- **回归**:扩展 1190 + mcp 504 单测全绿;bench 93/93;新增 9 测试。**live YouTube**:async 多语句/纯表达式/await 全通过(修前全崩)+ 非 TT localhost 回归正常。
- **教训**:① false-green mock 是「承重墙必活浏览器」的反面教材——mock 编码错误假设(new Function 接受 TrustedScript)让坏路径单测假绿;② TT 下 eval≠new Function 的 TrustedScript 豁免差异;③ 代表性应用场景(真实 SaaS/媒体站)比组件库 demo 更能抓出 CSP/TT 类基础设施缺陷。

## 实现 R4 — A2-fb 非 ARIA 虚拟化(dogfood 驱动)
- **缺口来源**:广度 dogfood(Naive)发现 A2 只认 ARIA 声明虚拟化,漏 Semi/Naive/react-window。
- **实现**:`detectVirtualByScroll`(强滚动 scrollH≥clientH×4 + estTotal=scrollH/rowH >> 渲染数;虚拟本质=只渲染窗口,普通滚动列表渲染全部故 est≈rendered 不触发),inline 进 page-side dedicated pass,`# blindspots: <name> virtual(~N/M)` confidence:low(~ 标估算)。
- **live 验证**(Naive,新 build):检出 3 虚拟表(~2958/11、~1000/8、~635/55,ratio 42-561×),**43 表中 40 普通/分页表零误报**(__seenScrollers dedup 折叠嵌套表)。
- **回归**:mcp 504 + ext 1183 + 17 blindspot 单测;bench fixture 加 A2-fb 正例(~N/10)+负例(普通 30 行滚动不报);**全量 bench 93/93 ALL GREEN + baseline 刷新**;顺带修 logicflow-connect pointermove 合并 flaky(>=STEPS→>=2+buttons 合并容错)。
- **教训**:广度 dogfood(多库)抓出单站(ag-grid)A 族漏掉的真 P1;A1 收集门=误报防线(Semi 74 装饰 canvas 不报);A2-fb 误报靠「est>>rendered」判据天然区分虚拟 vs 普通滚动。

## 待办（按 Phase 1 策略）
- **A 族盲区信号**（brainstorm 设计闸门 → TDD 实现）：A2 虚拟列表 → A1 canvas → A3 closed-shadow → A4/A5 截断/iframe。**阻塞：需 Chrome 扩展起 + 真站 spike 确认盲区。**
- **B/C/D 残余**（/loop 全自动快速证伪）：B2/C2/C3/C4 + D1-D8。低 yield，逐条证伪记账。
