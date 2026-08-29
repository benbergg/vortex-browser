# 任务：代码审核（你审的是实际改动，不是方案）

你是 Claude Opus 代码审核者。前面已有一轮 codex 审核，但那审的是**方案**（`PLAN-opus.md`）。**你审的是实际写出来的代码。**

## 输入

- 实际改动：`git diff`（工作区，未提交）。主要在 `packages/extension/src/action/candidate-suggest.ts` 与 `packages/extension/src/handlers/dom.ts`
- 方案（要求来源，v2）：`reports/_usage-mining/2026-08-28-act/PLAN-opus.md`
- 实施方自述：`reports/_usage-mining/2026-08-28-act/IMPL-luna.md`
- 背景分析：`reports/_usage-mining/2026-08-28-act/FINDINGS-luna.md`

**不要采信 IMPL 自述里贴的任何测试输出**——自己跑。

## 背景一句话

`vortex_act` 的定位条件命中多个元素时，工具手里攥着完整的元素列表（`dom.ts:362`）却只回传 `matchCount` 把它们丢了，导致调用方 12/20 次绕开工具改用 `evaluate` 自己查 DOM。本次把命中元素的可辨识摘要写进错误正文。

## 必须逐条核的五个翻车点（都是前一轮审核实测出来的）

1. **第六处出口的查询语义**：`dom.ts:1972` 原本用 `document.querySelectorAll`（只 light DOM），前五处用 `queryAllDeep`（穿 open shadow）。**核实改动没有把第六处误统一成深度查询。**
2. **候选是否真的进了 message**：`packages/mcp/src/lib/dispatch-error.ts:13-32` 只渲染 `code`/`message`/`hint`，`extras` 除 `lastReason` 外不进回传文本。若候选只放进 `extras`，调用方根本看不到 —— 那等于什么都没修。
3. **长度预算是否真的实现了**：action 错误路径 `packages/mcp/src/server.ts:923-930` 直接 `formatDispatchError` 返回，**没有 `RESPONSE_SIZE_LIMIT` 保护**（那只在成功路径 `:1092-1098`）。核实分字段上限、整条 message 总预算、属性白名单、候选数上限与省略计数是否都落地。
4. **是否用已命中的 `els`**：不得在错误分支之后重新 query。核实摘要来源就是触发拒绝的那一批元素。
5. **分层边界**：page-side 注入函数生成可序列化 DTO，host 侧纯函数只组装文案。核实没有把 Element、闭包 helper 或跨 world 对象传给 host —— 本仓有过 `executeScript` 注入丢模块作用域导致 `X is not defined` 的教训。

## 你必须自己动手做的验证（不许只读代码下结论）

1. **自己跑测试**：`pnpm --filter @vortex-browser/extension exec vitest run <目标文件> --maxWorkers=2 --minWorkers=1`。**禁止 `pnpm -r test`**。
2. **自己做逐出口变异验证**：分别破坏六个出口的摘要拼接，确认对应测试各自转红。只删共享 builder 不算数——那证明不了六处都接上了。做完**务必恢复现场**（先备份文件）。
3. **找假绿**：
   - 有没有只比 `Object.keys` 的键集合对照？
   - 有没有 mock 掉恰好是危险路径的那一层？
   - 纯函数测试是否被当成了跨层接线的证据？（本仓结论：纯函数测试证明不了接线）
   - `new Function` 的注入测试是否真的复刻了传给 `executeScript` 的函数与参数，还是只包了个纯函数进去（后者测不出注入丢作用域）？
4. **同形候选**：11 个共享 class、无文本、无唯一属性的候选，正文是否明确报告"无法仅凭摘要区分"，而不是暗示已有唯一目标？是否仍然 fail-closed（没有自动挑第一个、没有把多命中降为成功）？
5. **成功路径**：是否逐字节不变？有没有可执行的回归断言？

## 也要看方案没覆盖到的

方案是我写的，可能有盲区。如果你发现改动里有**方案没要求但实施方擅自加的东西**，或**方案要求了但明显不该做的**，直接指出。同样，如果代码有方案和前一轮审核都没提到的真实缺陷（错误处理、边界、性能、可维护性），也请报告。

## 输出

写到 `reports/_usage-mining/2026-08-28-act/CODE-REVIEW-opus.md`，**第一行给结论**：`通过` / `有条件通过（列出必须先改的点）` / `不通过（列出理由）`。

每条发现必须带 `file:line` 和你**实际跑出来的证据**（命令 + 输出），不接受"看起来可能有问题"。宁可只报 1 条坐实的，也不要报 5 条推测的。0 条问题是可接受的结论，但前提是你真的动手验过上面每一项。
