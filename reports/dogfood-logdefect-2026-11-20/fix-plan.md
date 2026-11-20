# 修复计划 — 日志驱动周期 `dogfood-logdefect-2026-11-20`

> 依据：`docs/dogfood-cycle-sop.md` §5（TDD → bench case → 人工闸门 → 记账）。
> 完整设计与逐条验证证据见 `Athena/tasks/20261120-03-vortex缺陷修复/{设计.md,计划.md,报告.md,验证.md}`。
> **人工闸门**：本轮实修已获用户明确授权；**git commit / push / 合并 / 发布仍等用户单独授权**。

## 修复清单（3 条，全部 TDD）

### D-1 —— `vortex_debug_read` 公开契约与运行时不一致

| 项 | 内容 |
|---|---|
| 改什么 | ① `packages/mcp/src/tools/schemas-public.ts:316-345`：公开 schema 补 `pattern`(string) / `includeResources`(boolean)；② `packages/mcp/src/tools/dispatch.ts:283-318`：`filter` 非对象时**前置**返回 `INVALID_PARAMS` 并指向 filter 形状，不再让 `Object.assign` 静默丢弃；③ `packages/mcp/src/tools/schema-fingerprint.ts` + `packages/mcp/src/server.ts`：schemaHash 改哈希 schema 形状（原只哈希 `name:action:description.length`，形状变化不可见）；④ `packages/mcp/src/tools/registry.ts`：`resolveToolDef()` 让诊断工具 `vortex_ping` 可被 `tools/call` 调用（此前无任何可达路径 ⇒ 指纹机制整条链路是死的），但**不进 tools/list** |
| 影响面 | `vortex_debug_read` 一周 65 次调用（基线窗口）；`vortex_ping` 每次连接握手指纹比对 |
| 收益量级 | 形状错误从"报 pattern 缺失"变成"报 filter 形状" ⇒ 客户端重试方向正确（本周该类拒绝 7 次，全部是 filter 形状）；schemaHash 可感知形状变化 ⇒ 客户端缓存可失效 |
| 改动风险 | 中：公开面变大（tools/list payload +216 B）⇒ I15 字节预算上调到 13500 B（**这是门槛调整，已披露**）；schemaHash 算法变更 ⇒ 旧客户端一次指纹不匹配（仓内无固定 hash 消费者） |
| 验证方式 | 单测（公开 schema 对象断言，删属性即红）+ 真机 DAST（改前报 "pattern is required"、改后报 filter 形状错）+ `vortex_ping` 前后 schemaHash 取值不同 + I15 断言绿 |

### D-1b —— 请求不存在时误报 `INTERNAL_ERROR`

| 项 | 内容 |
|---|---|
| 改什么 | ① `packages/shared/src/errors.ts`：新增 `VtxErrorCode.REQUEST_NOT_FOUND`；② `packages/shared/src/errors.hints.ts`：补 `DEFAULT_ERROR_META` 默认 hint（含**合法调用形状** `source='network' and pattern='<url substring>'`，并写明用返回的 `requestId` 作为公开入参 `reqid`）；③ `packages/extension/src/handlers/network.ts:479-506`：改抛 `REQUEST_NOT_FOUND` |
| 影响面 | `vortex_debug_read {source:"request"}` 路径（本周 5 次 `INTERNAL_ERROR` 命中此项） |
| 收益量级 | 5 次/周的可诊断错误从"内部错误"变成"查无此记录 + 可执行 hint" |
| 改动风险 | 低-中：错误码数量断言 48 → 49（`packages/shared/tests/errors.test.ts:63`）；`DEFAULT_ERROR_META` 是穷举 `Record`，漏补直接编译红 |
| 验证方式 | 单测（错误码 + hint 长度/动词/工具名）+ 真机 DAST（改前 `INTERNAL_ERROR`、改后 `REQUEST_NOT_FOUND`）+ I19 断言绿 |

### D-2 —— `routes.vortex` 恒等于 Claude 源

| 项 | 内容 |
|---|---|
| 改什么 | ① `scripts/usage-baseline/collect.mjs`：`browserRoute()` 从"只在 claude 分支调用"改为**按源**统计（claude/pi/codex 分别计 vortex / playwright 份额，sink 单列不叠加）；② 修正 Pi 的 playwright 去重（外层本身是 playwright 时不再计其展开；codemode 内只排除**playwright 祖先**，不排除普通容器祖先；按 `toolCallId` 配对去重后以**外层调用时间**做窗口归属）；③ `scripts/usage-baseline/collect.test.mjs`：新增 7 条反例 fixture（代理+展开=1、普通容器下调用=1、playwright 祖先下展开=1、窗口外的调用（无结果记录）=0、外层在窗口前结果在窗口内=0、codemode 外层在窗口内结果在窗口后=1、同一 toolResult 重复出现=1）；④ 快照自带 `routesMethodology` 口径说明（JSON + MD） |
| 影响面 | 所有基线快照的 `routes` 字段（本周基线即受影响） |
| 收益量级 | 路由份额从"单源口径"变成"三源可比口径"；Pi 源 vortex 调用数从恒 0 变为真实值 |
| 改动风险 | 中：会改变历史快照的 `routes` 数字 ⇒ 跨期比较必须同口径重跑（旧快照标为旧口径） |
| 验证方式 | `node --test scripts/usage-baseline/{collect,extract}.test.mjs` **18/18**（extract 原 14 条 + collect 4 组共 7 条反例） + 同窗口改前/改后双算 + 报告里标注口径变更 |

## bench case

`packages/vortex-bench/cases/contract/debug-read-contract.case.ts` —— 锁 **MCP 层**能保证的那一半契约
（filter 形状错必须指向 filter、必须带 Hint、对象 filter 不回归）。
D-1b 属扩展层 ⇒ 由 `packages/extension/tests/network-request-detail.test.ts` 锁（13/13 绿），
不放进 bench：bench 跑的是浏览器里**已安装**的扩展产物，版本落后时红的是"扩展没更新"而不是"代码有缺陷"。

## 记账

本周期**不**执行 `node scripts/dogfood-rotation.mjs record` —— 它是站点评测周期的记账（`--site <id>`），
本周期没有跑站点评测，记进去等于制造站点评测事实。`reports/_dogfood/ledger.md` 属其它会话的未跟踪文件，未改动。
