# 验收结论（第 5 阶段，Claude Opus）

日期：2026-08-28

## 结论（终版）：**路线 A 通过**

> 首轮判打回（必修项见下），实施方已修复；验收方独立复跑与独立变异验证均通过。以下保留首轮打回记录，便于追溯。

### 复验结果（2026-08-28 二轮）

- 实现已解耦：`code` 判定中的 `hasMessage &&` 已移除，两条规则独立。
- 测试期望已修正："缺 message"用例改为期望 `Error [INVALID_PARAMS]: reload trigger failed (HTTP 400)`，保留 hub 给的准确码。
- 已补对照用例（`dev-reload-error-contract.test.ts:105-119`）：非法 code **且**缺 message → `INTERNAL_ERROR` + 占位 message，钉住"降级只由 code 非法触发"。
- **验收方独立变异验证**（不采信交付物所贴输出）：把 `hasMessage &&` 加回 code 判定，"缺 message"用例立即转红（`1 failed | 6 passed`），随即恢复并确认缺陷版本已移除。
- **验收方独立回归**：MCP 包 `769/769`、hub 包 `248/248` 全绿（沙箱外，含实施方因 `EPERM` 跑不了的需监听端口的集成测试）。

## 首轮打回记录：**一处必修**

实现方向正确、范围守住了（只动 `server.ts` 三个出口 + 两个测试文件，没有越界改 hub、没有加重试）。既有测试的改写不是弱化——从 `JSON.parse` 断言改成完整文本断言，粒度反而更严。独立复跑 11/11 通过，与交付物所贴输出一致。

但有一处实质缺陷，且**它被自己写的测试锁死了**。

## 必修项：`code` 的合法性判定被 `message` 是否存在绑架

`packages/mcp/src/server.ts` `normalizeReloadError`：

```js
const code =
  hasMessage && typeof rawCode === "string" && Object.values(VtxErrorCode).includes(rawCode as VtxErrorCode)
    ? rawCode as VtxErrorCode
    : VtxErrorCode.INTERNAL_ERROR;
```

`hasMessage` 不该参与 `code` 的判定。方案 §5 写的是**两条独立规则**：

- `code` 非字符串或不在枚举内 → `INTERNAL_ERROR`
- `message` 缺失或非字符串 → 合理占位

**后果**：hub 返回 `{code: "INVALID_PARAMS"}` 而 message 恰好为空时，一个**完全合法且准确**的错误码会被降级成含糊的 `INTERNAL_ERROR`。这直接削弱本次修复的目标（让错误码准确可归类），而且触发了审核上一轮用来翻转选码的那条判据——**`recoverable` 语义反转**：`INVALID_PARAMS` 是 `recoverable: false`（参数错，别重试），`INTERNAL_ERROR` 是 `recoverable: true`（可重试）。降级会告诉调用方去重试一个重试必然再失败的请求。

**测试锁死了这个行为**：`tests/dev-reload-error-contract.test.ts:76-80` 的"缺 message"用例传的是 `{ code: "INVALID_PARAMS" }`——一个合法码——却断言输出 `INTERNAL_ERROR`。

**验收方已实测确认**（不是推断）：把实现改成 §5 的正确行为（从 `code` 判定中去掉 `hasMessage &&`），该用例立刻转红：

```text
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

即：**修正缺陷会让测试变红**——这正是"测试锁死缺陷行为"的定义。验收方已将实现恢复原状，未替你修改。

## 怎么修

1. `normalizeReloadError` 中把 `code` 与 `message` 的判定解耦：`hasMessage` 只决定 `message` 用不用占位，不参与 `code`。
2. 修正 `tests/dev-reload-error-contract.test.ts` 的"缺 message"用例期望：`{code: "INVALID_PARAMS"}` 无 message 时应输出 `Error [INVALID_PARAMS]: reload trigger failed (HTTP 400)`，保留 hub 给的准确码。
3. **补一条新用例**把两条规则的独立性钉住：`{code: "RELOAD_TRIGGER_FAILED"}`（非法码）**且**无 message → `INTERNAL_ERROR` + 占位 message；与上一条对照，证明降级只由 code 非法触发，与 message 无关。
4. 重跑变异验证：把 `hasMessage &&` 加回去，第 2 条用例必须转红。

## 已验收通过的部分

- 三个失败出口（`server.ts` 的 HTTP 失败 / fetch 异常 / 轮询超时）均已走 `formatDispatchError`，输出统一 `Error [CODE]` 前缀。
- 未再使用 `formatError`（该函数只处理 `VtxError` 实例，对 HTTP payload 无效）。
- `RELOAD_TIMEOUT` → `TIMEOUT`、trigger 失败 → 合法码映射到位；两个自造码已不再出现在输出中。
- fetch 异常固定 `INTERNAL_ERROR` + 指向 vortex-server 的 hint，与 `recoverable: true` 语义一致。
- `:441-444` 的"扩展连着"硬断言已移除，改为只陈述 `diagnostics.version` 当刻返回了什么。
- 范围守住：未动 hub、未加重试、未实现 C2、未 git commit。

## 留给验收方（Opus）的项，未完成

- hub HTTP 集成测试（需真实监听端口，codex 沙箱 `EPERM`）。
- C2 的 live 时序确认（方案 §8）：NM 断开触发的 `hubLink.stop()` 是否会在 agent-result 送达 hub 前清空 pending。
- 这两项**不阻塞路线 A 的交付**，A 与 C2 相互独立。

## 遗留项（不阻塞路线 A 交付）

### 1. ~~跨层契约未被测试锁住~~ → **已补（2026-08-28，验收方直接实施，轻量档）**

补在 `packages/hub/tests/http-routes.test.ts`：

1. 既有用例 `rejects an unspecified reload with multiple browsers` 增加 `expect(body.error?.code).toBe(VtxErrorCode.INVALID_PARAMS)`。
2. **新增用例** `rejects a reload for an unknown browserId with a typed error code`：`POST /dev/reload-extension` 带不存在的 browserId → 404 + `error.code === INVALID_PARAMS`。这条是 MCP 日志里**真实命中**的路径（`未知 browser: <uuid>`），此前完全没有测试覆盖。

**针对性变异验证**（全局变异证明不了这两条的价值，因为既有测试已覆盖 `error` 字段本身）：只把 `selectBrowser` 内的 `INVALID_PARAMS` 改成 `INTERNAL_ERROR`，结果 `2 failed | 45 passed` —— 转红的恰是新增的两条，其余 45 条全绿。这同时证明：**在补这两条之前，改动 reload 路由的错误码不会被任何测试抓到**。

回归：hub 包 `249/249` 全绿。

原问题描述（保留备查）：

MCP 侧的 guard 依赖"hub 会在 `body.error.code` 给出合法错误码"这条契约。核实：

- hub 的 `sendError`（`packages/hub/src/http-routes.ts:411-420`）确实返回 `{ message, error: { code, message, recoverable } }`，契约当前成立。
- **但 hub 侧的失败用例 `packages/hub/tests/http-routes.test.ts:1203-1213` 只断言 `body.message`，没有断言 `body.error.code`。**

后果：若将来有人改动 `sendError` 的响应形状（例如只留 `message`），hub 测试仍会全绿，而 MCP 侧的 guard 会**静默降级**到 `INTERNAL_ERROR`，悄悄丢掉准确错误码——恰是本次修复要消灭的那类问题，只是换了触发方式。

guard 的存在保证了不会崩，所以不是阻塞项。**补法**：在该用例加一条 `expect(body.error?.code).toBe("INVALID_PARAMS")`，把 MCP guard 依赖的字段锁住。这属于新增工作，未在本轮实施。

### 2. C2 的 live 时序确认（方案 §8）

未执行。它需要先在 hub 侧搭临时探针分支（`browser-control.ts` 白名单 + `router.ts` 独立分支）才能让请求真正走到 `sendAgentCommand`，属于新的开发工作而非验收动作，且临时分支不进交付。要回答的问题仍是：NM 断开触发的 `hubLink.stop()`（`packages/server/src/index.ts:102-106` → `hub-link.ts:162-165` 的 `pending.clear()`）是否会在 agent-result 送达 hub 前清空 pending。

与路线 A 相互独立，A 的交付不依赖它。
