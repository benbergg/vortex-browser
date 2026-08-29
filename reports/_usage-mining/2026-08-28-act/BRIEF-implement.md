# 任务：实施 act 多命中候选摘要（路线 A，审核已放行）

## 输入
- 方案：`reports/_usage-mining/2026-08-28-act/PLAN-opus.md`（**v2，已按审核意见修订，以它为准**）
- 审核意见：`reports/_usage-mining/2026-08-28-act/REVIEW-codex.md`（必改项已并入方案，无需重复解读）

## 本轮范围（不要重新设计，不要扩大）

多命中（`SELECTOR_AMBIGUOUS`）失败时，把**已经命中的那批元素**的可辨识摘要写进错误正文。六处抛出点：
`packages/extension/src/handlers/dom.ts:368` / `:724` / `:1032` / `:1209` / `:1585` / `:1978`

**明确不做**：不改 `vortex_act` 入参、不生成定位串、不碰 `OBSCURED` 与 `act|TIMEOUT`、不动成功路径、不自动挑第一个候选。

## 五条最容易翻车的地方（都是审核实测出来的，别踩）

1. **第六处查询语义不同**：`dom.ts:1972` 用 `document.querySelectorAll`（只 light DOM），前五处用 `queryAllDeep`（穿 open shadow）。**保持各自原样**，不要统一成深度查询。
2. **候选必须写进 message，不能只放 extras**：`packages/mcp/src/lib/dispatch-error.ts:13-32` 只渲染 `code`/`message`/`hint`，`extras` 除 `lastReason` 外不进回传文本。`extras` 可以继续保留作结构化上下文，但它**不是调用方可见通道**。
3. **错误正文没有任何长度兜底**：`RESPONSE_SIZE_LIMIT` 截断只在成功路径（`server.ts:1092-1098`），action 错误路径（`:923-930`）直接返回。预算必须你自己实现——见方案 §5「长度与隐私」四条硬约束。
4. **必须用已命中的 `els` 生成摘要，不得在错误分支后重新 query**：DOM 变了重查的就不是触发拒绝的那批。
5. **分层**：page-side 注入函数生成裁剪后的可序列化 DTO；host 侧纯函数只接收 DTO 组装文案。**不要把 Element、闭包 helper 或跨 world 对象传给 host**。

## 实施硬约束

1. **TDD**：先写会失败的测试（RED），确认它因正确原因失败（贴输出），再实现（GREEN）。跳过 RED = 不合格。
2. **测试清单按方案 §5「测试清单」六条逐条落实**，尤其：
   - 候选只放 `extras` 时最终 MCP 文本**不可见**的反向断言
   - 2 个候选与 **11 个候选**（对应真实样本 `div.relative.aspect-video`）都要测
   - 同形候选必须断言正文明确报告"无法仅凭摘要区分"，不得暗示已有唯一目标
   - 六个注入函数各自用 `new Function` 剥离模块作用域运行，前五个 shadow fixture、第六个 light-DOM fixture
3. **逐出口变异验证**：分别删除**每一个**出口的摘要拼接，对应出口测试必须转红。只删共享 builder 不算数——那证明不了六处都接上了。每条贴输出。
4. **禁止假绿**：只比 `Object.keys` 的键集合对照 / mock 掉恰好是危险路径的那一层 / 扫描类断言不带命中数。
5. **保持 fail-closed**：摘要只用于诊断，不得自动挑第一个，不得把多命中降为成功。
6. **跑测试限并发**：`pnpm --filter <包> exec vitest run <目标文件> --maxWorkers=2 --minWorkers=1`。**禁止 `pnpm -r test`**。只跑你改动涉及的包。
7. **代码注释按仓库规范**：中文、方法体内单行 `//`、每方法 ≤3 条、只写"为什么"不写"做什么"。
8. **不要 git commit**，改动留在工作区。

## 输出

写到 `reports/_usage-mining/2026-08-28-act/IMPL-luna.md`：改了哪些文件（`file:line`）与为什么、RED 原始输出、GREEN 原始输出、**六条逐出口变异验证的输出**、成功路径回归结果、没做到的部分及原因。
