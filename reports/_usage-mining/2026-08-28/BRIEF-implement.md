# 任务：实施已审核通过的修复方案 + 写测试

## 输入
- 方案：`reports/_usage-mining/2026-08-28/PLAN-opus.md`
- 审核意见：`reports/_usage-mining/2026-08-28/REVIEW-codex.md`（**审核提的必改点全部要落实**）

## 本轮范围（审核已放行，按方案 §5 执行，不要重新设计）

只做**路线 A**：让 `vortex_dev_reload` 的三个失败出口输出统一 `Error [CODE]` 契约。

- `packages/mcp/src/server.ts:436`（HTTP 非 2xx / `body.ok === false`）
- `packages/mcp/src/server.ts:451`（fetch / `r.json()` 抛异常）
- `packages/mcp/src/server.ts:489`（`RELOAD_TIMEOUT`）

**必须用 `packages/mcp/src/lib/dispatch-error.ts:13-32` 的 `formatDispatchError`，不要用 `server.ts:80-85` 的 `formatError`**——后者只处理 `err instanceof VtxError`，HTTP 的 `body.error` 是普通对象，永远命中不了。

**调用 formatter 前必须有一层运行时 guard/normalize**（这是审核的放行条件，不可省）：
- `code` 非字符串、或不在 `Object.values(VtxErrorCode)` 内 → 回退 `INTERNAL_ERROR`
- `message` 缺失或非字符串 → 合理占位
- `RELOAD_TIMEOUT` / `RELOAD_TRIGGER_FAILED` **不是合法错误码**（`packages/shared/src/errors.ts` 枚举内没有），必须映射：超时出口 → `TIMEOUT`；trigger 失败无合法 code → `INTERNAL_ERROR`
- fetch 异常出口固定 `INTERNAL_ERROR` + 指向"确认 localhost:PORT 的 vortex-server 正在运行后重试"的 hint

`server.ts:441-444` 的 hint 硬断言"扩展连着"必须去掉——它是从几百毫秒前第①步成功硬推的，与 hub 当刻回答冲突。改成只陈述当刻可证的事实。

**明确不做**：不修 browserId 失效根因、不加任何重试兜底（路线 B 已被否）、不动 hub 侧代码、不实现 C2。

## 环境限制（审核实测）

codex 沙箱**禁止监听 127.0.0.1**，hub HTTP 集成测试会报 `EPERM` 起不来。所以：
- 你只做 MCP 包内的输出契约测试（mock `fetch`/`sendRequest`，不需要端口）+ 变异验证。
- 需要真实监听的集成测试与 C2 的 live 验证由验收方（Claude Opus）在沙箱外做。
- **不得因为跑不起来就标记为通过或跳过**，须在交付物里明写"该项留给验收"。

## 实施硬约束

1. **TDD**：先写会失败的测试（RED），确认它**因为正确的原因失败**（贴失败输出），再改实现（GREEN）。
   跳过 RED 直接写实现 = 不合格。
2. **测试必须能抓住这个缺陷**：写完后做**变异验证** —— 把修复代码改回缺陷行为，确认测试转红。
   转不红说明测试没测到东西，重写。
3. **禁止假绿的三种写法**：
   - 只比 `Object.keys` 的键集合对照
   - mock 掉恰好是危险路径的那一层
   - 扫描类断言不带命中数（空集也过）
4. **断言粒度**：每个出口都要断言**完整前缀 + 精确 code + message + hint + `isError === true`**。另外必须补：
   - HTTP payload **缺 code / 缺 message / code 不在枚举内** 三种情况各断言 fallback 为 `INTERNAL_ERROR`
   - fetch catch 分支断言 code 为 `INTERNAL_ERROR` 且 hint 指向"检查/启动 vortex-server"，并断言其语义与 `recoverable: true` 一致，不能只断言"有前缀"
5. **变异验证清单**（方案 §5，每条贴输出）：把 `:436` 改回 `JSON.stringify` / 把 hint 改回"扩展连着" / 把 `:451` 改回无前缀纯文本 / 把 `:489` 改回 `JSON.stringify`+`RELOAD_TIMEOUT` / 去掉 payload 枚举校验——五条都必须让对应断言转红
6. **跑测试必须限并发**：`pnpm vitest run --maxWorkers=2 --minWorkers=1 <目标测试文件>`。
   **禁止跑全仓 `pnpm -r test`**（会卡死机器）。只跑你改动涉及的包。
7. **代码注释按仓库规范**：中文、方法体内单行 `//`、每方法 ≤3 条、只写"为什么"不写"做什么"。
8. **不要 git commit**，改完留在工作区，由验收方检查。

## 输出

写到 `reports/_usage-mining/2026-08-28/IMPL-luna.md`：
- 改了哪些文件（`file:line`）、为什么这么改
- RED 阶段的失败输出原文
- GREEN 阶段的通过输出原文
- **变异验证**：把什么改回去了、测试是否转红（贴输出）
- 没做到的部分，明写为什么
