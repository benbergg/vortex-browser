# vortex_dev_reload 路线 A 实施记录

日期：2026-08-28

本轮严格执行路线 A，只修正 `vortex_dev_reload` 三个失败出口的错误输出契约；未实施路线 B、C2、重试逻辑、browserId 根因修复或 hub 改动。未执行 git commit。

## 1. 改动文件

- `packages/mcp/src/server.ts:64`：引入 `VtxErrorCode`，用于运行时错误码校验和 `TIMEOUT`/`INTERNAL_ERROR` 映射。
- `packages/mcp/src/server.ts:88-107`：新增 `normalizeReloadError`，在调用 `formatDispatchError` 前对外部 HTTP JSON 做运行时 guard/normalize；缺失、非字符串或非法 code 回退 `INTERNAL_ERROR`，缺失/空 message 使用 HTTP 状态占位，hint 使用响应 hint 或当前可证事实。
- `packages/mcp/src/server.ts:452-463`：HTTP 非 2xx 或 `body.ok === false` 改用统一 `Error [CODE]` 格式。
- `packages/mcp/src/server.ts:466-476`：fetch/JSON 异常固定为 `INTERNAL_ERROR`，hint 指向确认 `localhost:PORT` 的 vortex-server 正在运行后重试。
- `packages/mcp/src/server.ts:509-522`：超时出口改为合法 `TIMEOUT`，将 `fromStamp`、`targetStamp`、`waitedMs` 放入 message，并保留原排查 hint。
- `packages/mcp/tests/dev-reload-error-contract.test.ts:1-143`：新增三个失败出口的契约测试，包含缺 code、缺 message、非法 code 的 fallback 测试。
- `packages/mcp/tests/dev-reload-browser-binding.test.ts:102-151`：将既有 browser binding 失败断言更新为统一文本契约，并移除“扩展未连”的无依据断言。

## 2. TDD RED

先加入契约测试，未改实现时运行：

```text
pnpm --filter @vortex-browser/mcp exec vitest run tests/dev-reload-error-contract.test.ts --maxWorkers=2 --minWorkers=1
```

原始失败输出：

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (6 tests | 6 failed) 1283ms
   × vortex_dev_reload 错误契约 > HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
     → expected '{\n  "reloaded": false,\n  "error": "…' to be 'Error [INVALID_PARAMS]: browserId 必填\…'
   × vortex_dev_reload 错误契约 > HTTP 失败 '缺 code' 时回退 INTERNAL_ERROR 并保留合理 message
     → expected '{\n  "reloaded": false,\n  "error": "…' to be 'Error [INTERNAL_ERROR]: hub failure\n…'
   × vortex_dev_reload 错误契约 > HTTP 失败 '缺 message' 时回退 INTERNAL_ERROR 并保留合理 message
     → expected '{\n  "reloaded": false,\n  "error": "…' to be 'Error [INTERNAL_ERROR]: reload trigge…'
   × vortex_dev_reload 错误契约 > HTTP 失败 '非法 code' 时回退 INTERNAL_ERROR 并保留合理 message
     → expected '{\n  "reloaded": false,\n  "error": "…' to be 'Error [INTERNAL_ERROR]: hub rejected…'
   × vortex_dev_reload 错误契约 > fetch 异常返回可恢复的 INTERNAL_ERROR，并指向检查 server 后重试
     → expected 'vortex-server unreachable at localhos…' to be 'Error [INTERNAL_ERROR]: vortex-server…'
   × vortex_dev_reload 错误契约 > 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint
     → expected '{\n  "reloaded": false,\n  "error": "…' to match /^Error \[TIMEOUT\]: vortex_dev…/server

 Test Files  1 failed (1)
      Tests  6 failed (6)
```

失败原因均对应待修复契约：HTTP/超时仍为裸 JSON，fetch 异常无 `Error [CODE]` 前缀，HTTP 外部 payload 尚未运行时校验。

## 3. TDD GREEN

完成实现并修正缺 message 必须回退 `INTERNAL_ERROR` 的归一化边界后运行：

```text
pnpm --filter @vortex-browser/mcp exec vitest run tests/dev-reload-error-contract.test.ts --maxWorkers=2 --minWorkers=1
```

原始通过输出：

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ✓ tests/dev-reload-error-contract.test.ts (6 tests) 1002ms
   ✓ vortex_dev_reload 错误契约 > HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
   ✓ vortex_dev_reload 错误契约 > 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

随后兼容更新后的既有 binding 测试，最终相关测试通过：

```text
pnpm --filter @vortex-browser/mcp exec vitest run tests/dev-reload-error-contract.test.ts tests/dev-reload-browser-binding.test.ts --maxWorkers=2 --minWorkers=1
```

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ✓ tests/dev-reload-error-contract.test.ts (6 tests) 1242ms
 ✓ tests/dev-reload-browser-binding.test.ts (5 tests) 1545ms

 Test Files  2 passed (2)
      Tests  11 passed (11)
```

MCP 包构建也通过：

```text
$ tsc
```

## 4. 五条变异验证

每条变异均只临时回退一个缺陷点，运行同一命令后立即恢复正确实现。以下为各次转红的原始测试输出摘要；所有变异均未留在工作区。

### 变异 1：HTTP 出口改回 `JSON.stringify`

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (6 tests | 4 failed) 914ms
   × HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
     → expected '{\n  "code": "INVALID_PARAMS",\n  "me…' to be 'Error [INVALID_PARAMS]: browserId 必填…'
   × HTTP 失败 '缺 code' 时回退 INTERNAL_ERROR 并保留合理 message
   × HTTP 失败 '缺 message' 时回退 INTERNAL_ERROR 并保留合理 message
   × HTTP 失败 '非法 code' 时回退 INTERNAL_ERROR 并保留合理 message
   ✓ 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint

 Test Files  1 failed (1)
      Tests  4 failed | 2 passed (6)
```

### 变异 2：hint 改回“扩展连着”硬断言

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (6 tests | 4 failed) 1151ms
   × HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
     → Expected: diagnostics.version 曾返回 browserId=chrome-uuid-1；本次 reload 请求被 vortex-server 拒绝，请依据错误信息处理。
       Received: 扩展连着(当前绑定 chrome-uuid-1),重载触发被 hub 拒绝——按上面的 error/message 处理,不要去查扩展是否加载。
   × HTTP 失败 '缺 code' 时回退 INTERNAL_ERROR 并保留合理 message
   × HTTP 失败 '缺 message' 时回退 INTERNAL_ERROR 并保留合理 message
   × HTTP 失败 '非法 code' 时回退 INTERNAL_ERROR 并保留合理 message
   ✓ 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint

 Test Files  1 failed (1)
      Tests  4 failed | 2 passed (6)
```

### 变异 3：fetch catch 改回无前缀纯文本

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (6 tests | 1 failed) 975ms
   ✓ HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
   × fetch 异常返回可恢复的 INTERNAL_ERROR，并指向检查 server 后重试
     → expected 'vortex-server unreachable at localhos…' to be 'Error [INTERNAL_ERROR]: vortex-server…'
   ✓ 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

### 变异 4：超时出口改回 JSON + `RELOAD_TIMEOUT`

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (6 tests | 1 failed) 867ms
   ✓ HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
   × 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint
     → expected '{\n  "reloaded": false,\n  "error": "…' to match /^Error \[TIMEOUT\]: vortex_dev…/server
   ✓ fetch 异常返回可恢复的 INTERNAL_ERROR，并指向检查 server 后重试

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

### 变异 5：移除 HTTP payload 枚举校验

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (6 tests | 1 failed) 1011ms
   ✓ HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
   × HTTP 失败 '非法 code' 时回退 INTERNAL_ERROR 并保留合理 message
     → expected 'Error [RELOAD_TRIGGER_FAILED]: hub re…' to be 'Error [INTERNAL_ERROR]: hub rejected…'
   ✓ 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

五条变异均按预期击穿对应断言，随后已恢复正式实现；恢复后的相关测试结果为 11/11 通过。

## 5. 未完成项与环境边界

- 未执行真实监听端口的 hub 集成测试：当前 codex 沙箱禁止监听 `127.0.0.1`，按 brief 留给沙箱外验收，未将其标记为通过或跳过。
- 未执行 C2 live spike；本轮严格只做路线 A，C2 的真实链路时序验证留给验收/后续任务。
- 未改 hub、extension 或其他源码，未添加重试，未修复 browserId 失效根因。

## 6. 验收返工：解耦 code 与 message 归一化

验收意见指出：`normalizeReloadError` 原先用 `hasMessage &&` 参与 code 判定，导致合法 `{ code: "INVALID_PARAMS" }` 在 message 缺失时错误降级为 `INTERNAL_ERROR`，并把 `recoverable: false` 的参数错误错误地变成 `recoverable: true` 的内部错误。

### 步骤 1-2：先修测试并确认 RED

将既有“缺 message”用例改为期望保留 `INVALID_PARAMS`，并新增对照用例：非法 `RELOAD_TRIGGER_FAILED` 且缺 message 时才回退 `INTERNAL_ERROR`。运行：

```text
pnpm --filter @vortex-browser/mcp exec vitest run tests/dev-reload-error-contract.test.ts --maxWorkers=2 --minWorkers=1
```

修正测试后的原始 RED：

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (7 tests | 1 failed) 1821ms
   ✓ vortex_dev_reload 错误契约 > HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
   × vortex_dev_reload 错误契约 > HTTP 失败 '缺 message' 时独立归一化 code 与 message
     → expected 'Error [INTERNAL_ERROR]: reload trigge…' to be 'Error [INVALID_PARAMS]: reload trigge…'
   ✓ vortex_dev_reload 错误契约 > 轮询超时返回 TIMEOUT，message 携带重载 hint

 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

该 RED 精确复现验收指出的错误：合法 code 因缺 message 被降级。

### 步骤 3：修正实现并确认 GREEN

将 code 判定改为只检查 `typeof rawCode === "string"` 及 `Object.values(VtxErrorCode)`；`hasMessage` 只控制 message 是否使用 HTTP 状态占位。为满足 TypeScript 的控制流收窄，message 分支使用显式 `as string`，不改变运行时规则。

修正后原始 GREEN：

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ✓ tests/dev-reload-error-contract.test.ts (7 tests) 1743ms
   ✓ vortex_dev_reload 错误契约 > HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
   ✓ vortex_dev_reload 错误契约 > 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

最终相关回归与构建：

```text
 ✓ tests/dev-reload-error-contract.test.ts (7 tests)
 ✓ tests/dev-reload-browser-binding.test.ts (5 tests)
 Test Files  2 passed (2)
      Tests  12 passed (12)

$ tsc
```

第一次构建曾因 `hasMessage` 布尔变量无法自动收窄 `payload.message: unknown` 报 `src/server.ts(106,18): error TS2322`；增加显式字符串收窄后重新构建通过。

### 步骤 4：把 `hasMessage &&` 加回去的变异验证

临时恢复验收指出的缺陷：

```typescript
hasMessage && typeof rawCode === "string" && Object.values(VtxErrorCode).includes(rawCode as VtxErrorCode)
```

运行同一目标测试后的原始转红输出：

```text
 RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp

 ❯ tests/dev-reload-error-contract.test.ts (7 tests | 1 failed) 1862ms
   ✓ vortex_dev_reload 错误契约 > HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint
   × vortex_dev_reload 错误契约 > HTTP 失败 '缺 message' 时独立归一化 code 与 message
     → expected 'Error [INTERNAL_ERROR]: reload trigge…' to be 'Error [INVALID_PARAMS]: reload trigge…'
   ✓ vortex_dev_reload 错误契约 > 轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint

 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

变异验证后已恢复为不带 `hasMessage &&` 的正确实现；最终测试与 `tsc` 均通过。未执行 git commit。
