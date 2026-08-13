# 连接类错误的提示错配 —— 实现思路

来源：2026-08-13 对 Claude Code transcript 最近 3 天窗口（1107 次 vortex 调用 / 60 次错误）的挖掘。
CDP 附着本身健康（2 次失败，均已正确分类）；真缺陷是**连接类故障的 hint 指向错误动作**。

## 0. 实现流程图

```mermaid
flowchart TD
    subgraph hub["packages/hub"]
        A1["router.ts:144<br/>偏好不匹配<br/>EXTENSION_NOT_CONNECTED"]
        A2["router.ts:306,318<br/>RPC 超时<br/>TIMEOUT"]
        A3["http-routes.ts:311<br/>HTTP RPC 超时<br/>TIMEOUT"]
        E["router.ts:949 error(code,message)<br/>vtxError(code,msg) — 不传 override"]
        A1 --> E
        A2 --> E
        A3 -.-> |自造 payload,绕过 error()| OUT
    end
    subgraph mcp["packages/mcp"]
        D1["server.ts:425-434<br/>dev_reload 自造 JSON<br/>硬编码 hint"]
    end
    E --> V{"errors.hints.ts:257<br/>hint = override ?? DEFAULT_ERROR_META[code]"}
    V --> |"❌ 断点在此:override 恒为空<br/>→ 落到按码查表的通用文案"| OUT["VtxErrorPayload<br/>hint = 表文案"]
    OUT --> R{"server.ts:818-826 三层兜底"}
    R --> |"① resp.error.hint 存在 → 恒命中"| AGENT["Agent 读到错误动作指引"]
    R -.-> |"②③ 表兜底/中文兜底<br/>仅对不走 vtxError 的裸 error 生效"| H2["实际形同虚设"]
    D1 --> AGENT
```

断点单一：**三处抛错点都没给 `vtxError` 传 override**，于是 hint 在构造时就被填成按错误码查表的通用文案。
消费端 `server.ts:819` 的 remote-hint 分支恒命中，所以只要抛错点传了 override，就能一路穿透到 agent。

## 1. 目标与判据

改后必须能验证：

- **J1**：偏好不匹配（`No browser matching "chrome"; online: Microsoft Edge`）的 hint 指向「换 `browser` 参数或启动目标浏览器」，不含「确保扩展已启用」。
- **J2**：hub↔扩展 RPC 超时（`Request <action> timed out`）的 hint 不再建议 `vortex_wait_for mode='idle'`（页面稳定与通道超时无关）。
- **J3**：`dev_reload` 失败时 hint 与自报错误码一致——报 `INVALID_PARAMS: browserId 必填` 时不得说「扩展未连」。
- **J4**：`packages/shared/tests/errors.test.ts` 的 I19/I20 hint 契约（50-300 字符、含 next-action 动词、引用工具名在公开 11 内）保持全绿。
- **J5**：三天窗口里的 6 个真实错误样本作为回放 fixture，逐条断言改后 hint 文本。

不包含：CDP attach 分类（`dd3a2c5` 已修，本轮实测有效）、`NOT_ATTACHED` 与 `CDP_NOT_ATTACHED` 的命名撞车（另议）。

## 2. 现状勘察

**hint 生效链路**
- 消费端三层兜底：`packages/mcp/src/server.ts:818-826` —— `resp.error.hint` > `DEFAULT_ERROR_META[code]` > STALE_SNAPSHOT 中文兜底。**自带 hint 优先**，这是覆盖机制。
- 扩展侧同样回填：`packages/extension/src/lib/router.ts:70-73`。
- 表与契约：`packages/shared/src/errors.hints.ts:23`（`DEFAULT_ERROR_META`），契约写在 :12-17。
- 覆盖范式（已验证可用）：`packages/extension/src/lib/debugger-manager.ts:75-90` 的 `rawAttach`，`dd3a2c5` 用它把 attach 失败从 `JS_EXECUTION_ERROR` 改判为带对症 hint 的 `CDP_NOT_ATTACHED`。

**三处缺陷**
1. `packages/hub/src/router.ts:144` + `packages/hub/src/browser-match.ts:32-42` —— 偏好不匹配复用 `EXTENSION_NOT_CONNECTED`。message 已含 `online: <label>` 正确信息，被表 hint（`errors.hints.ts:119-122`）盖掉。日志 3/60 次。
2. `packages/hub/src/router.ts:306,318` 与 `packages/hub/src/http-routes.ts:311-315` —— RPC 层超时复用 `TIMEOUT`，与页面 actionability 超时共用 hint（`errors.hints.ts:93-96`）。日志 3/60 次。
3. `packages/mcp/src/server.ts:425-434` —— `dev_reload` 走自造 JSON 而非 `vtxError`，hint 硬编码为「扩展未连」，与其转发的 `INVALID_PARAMS` 矛盾；且因不带 `Error [CODE]` 前缀，在错误统计里显示为 `UNCODED`。日志 2/60 次。

**根因通道**
- `packages/shared/src/errors.hints.ts:249-262`：`vtxError(code, message, context?, override?)`，`hint = override?.hint ?? DEFAULT_ERROR_META[code].hint`——**hint 在构造时就被填好**，override 是唯一的 case-specific 通道。
- `packages/hub/src/router.ts:949`：`private error(code, message)` 恒调 `vtxError(code, message)`，**签名里就没有 override 参数**——hub 无法表达 case-specific hint。
- `packages/hub/src/http-routes.ts:311-315` 更绕过 `error()`，直接字面量构造 `VtxErrorPayload`。

**硬约束**
- 错误码是对外契约：`packages/shared/dist/errors.d.ts` 已发布，bench 断言（`packages/vortex-bench/src/runner/run-case.ts:44`）按码字符串匹配。
- **现有测试锁定了缺陷行为**：`packages/hub/tests/error-payload.test.ts:35,48` 断言 hub 的 TIMEOUT / EXTENSION_NOT_CONNECTED hint **等于**表文案。改动必然让这两条变红，需连同断言一起改写并说明理由。
- hint 契约（`errors.hints.ts:12-17` 注释：50-300 字符、含 next-action 动词、工具名在公开 11 内）**实际并未被断言**——`packages/shared/tests/errors.test.ts:98-103` 只查 `length > 10`。所以表内表外都无强制；新 hint 需自行补等价断言，不能指望既有测试兜住。

**同族残留（本轮不修，登记）**：`extract` 3 次报 `JS_EXECUTION_ERROR: page-side module "dom-resolve" injection timed out`，hint 让人「检查你注入的 JS」，但那是 vortex 自身模块注入超时，与 `dd3a2c5` 同构。

## 3. 候选路线

**A — 就地覆盖 hint**
给 `router.ts:949` 的 `error()` 加可选 `extra` 参数，三处抛错点各传对症 hint；`dev_reload` 改用统一错误形态。
- 切入点：抛错点本身，改动落在 hub 抛错层 + mcp dev 分支。
- 为什么行：消费端 `server.ts:819` 已优先读 `resp.error.hint`，通道现成，`dd3a2c5` 已在扩展侧证明可用。
- 代价：hint 文案散落三处，游离于 I19/I20 契约测试之外。
- 失效条件：第四个场景再复用 `EXTENSION_NOT_CONNECTED` 时，问题原样重演——治标不治本。

**B — 细分错误码**
新增 `BROWSER_NOT_MATCHED`、`RPC_TIMEOUT` 两个码，进 `DEFAULT_ERROR_META`，抛错点换码。
- 切入点：`shared/errors.ts` + 表 + 三处抛错点。
- 为什么行：hint 自动纳入契约测试；语义一次分清，后续复用不会退化。
- 代价：错误码是已发布的对外契约，新增需同步 `schemas-public`、CHANGELOG、bench 断言；下游按码 switch 的地方要兜新码。
- 失效条件：若调用方（含 agent 提示词）对码做了穷举假设，新码会落到未处理分支。

**C — 集中式 hint 精化器**
在 shared 加 `refineHint(code, message, context)`，插在 `server.ts:818` 三层兜底之前，按 code + message 特征挑更精确的文案。
- 切入点：单一函数，抛错点零改动。
- 为什么行：所有错误最终都过这一处渲染，改一点覆盖全部。
- 代价：靠 message 正则识别场景，抛错点改文案就静默失配（假绿风险高）。
- 失效条件：`noBrowserMessage` 的文案一变，精化规则失效且无人察觉。

## 4. 取舍与选定（待你选）

倾向 **A**，理由是三处缺陷里只有 1 是真正的语义混用，2 和 3 属于「该带 hint 却没带」，用不着动对外契约。

- 放弃 C：它把判据建在 message 字符串上，而 message 恰恰是最易变的一层；`browser-match.ts:41` 改一个词就静默退化，且回放 fixture 会因为用同一份文案而假绿——这正是 [[vortex_test_pageside_pure_fn]] 记过的坑。
- 对 B 保留：单独给「偏好不匹配」立码确有价值（它和「扩展真的没连」需要的用户动作完全相反），但代价是动已发布的错误码契约，需同步 4 处下游。若你要一次做透，B 只在缺陷 1 上用、2 和 3 走 A，是更省的组合。

## 5. 改动地图（按路线 A）

| 位置 | 改动 |
|---|---|
| `packages/hub/src/router.ts:949` | `error()` 增加可选第 3 参 `extra?: VtxErrorExtra`，透传给 `vtxError` |
| `packages/hub/src/router.ts:144` | 偏好不匹配处传 hint：指向改 `browser` 参数 / 启动目标浏览器，并复述在线清单 |
| `packages/hub/src/router.ts:306,318` | RPC 超时传 hint：指向通道/重试语义，剔除 `wait_for mode='idle'` 指引 |
| `packages/hub/src/http-routes.ts:311-315` | 改走 `vtxError`，与上一条共用同一 hint 常量 |
| `packages/mcp/src/server.ts:425-434` | 失败分支改为转发 hub 的 code + message，hint 按 code 分支给；输出统一成 `Error [CODE]:` 形态 |
| 新增测试 | 三天窗口 6 个真实样本回放 fixture + hub error 通道带 hint 的单测 |

数据流不变，仅在既有 payload 上补 `hint` 字段。

## 6. 被证伪的直觉

- **「CDP 断连是主要问题」** —— 全量窗口 40 次 `Actionability timeout; last reason: NOT_ATTACHED` 看着像 CDP 未附着，实查全是「target 未匹配到元素」，与 CDP 无关。是错误码命名撞车导致的误读。
- **「vortex 与 playwright 抢 debugger」**（[[vortex_usage_log_mining_loop]] 记载）—— 三天窗口 0/6 共现，全量 2/54，且那 2 次是同一 session 的连续重试。本窗口无证据支持。
- **「screenshot 不走 CDP」**（`ccbdd23` 改走 `captureVisibleTab`）—— `packages/extension/src/handlers/capture.ts:257` 的注释确实说绕开 CDP，但 08-02 的 `format:jpeg,quality:70` 样本报出 attach 占用，说明仍有走 CDP 的分支（未定位到具体条件）。

## 7. 待验证假设 —— 实施后的结论

| # | 假设 | 结论 |
|---|---|---|
| 1 | hub 构造的 hint 能穿透到 MCP 文本 | ✅ **live 已证**（见下方验收记录）。承重墙成立。 |
| 2 | `dev_reload` 那 2 次真因是「扩展未连」还是「Chrome+Edge 同时在线」 | ✅ 已由 `packages/mcp/tests/dev-reload-browser-binding.test.ts:1-13` 的头注释解答：2026-08-11 live 实测为**多浏览器同时在线**，且传 `browserId` 的修复已落地，我日志里的 2 次样本在该修复之前。改法不再依赖此假设——hint 改按**本地已观测事实**（`boundBrowserId` 是否拿到）分支。 |
| 3 | `capture.screenshot timed out` 是 RPC 层超时而非扩展侧慢 | ⚠️ **仍未验证**。它确实经 router 超时路径，因此会拿到新 hint；新文案对两种真因都成立（「页面可能没事，加大 timeout 或查扩展是否还在响应」），故不阻塞本次改动。 |
| 4 | 表外 per-call hint 不受 I19/I20 检查 | ✅ 实查确认，并**发现表内也没被真正检查**——`errors.test.ts:98-103` 只断言 `length > 10`，注释里的 50-300 字符/动词/工具名三条从未落地。新 hint 因此在 `connection-error-hints.test.ts` 里自带 `expectHintQuality`。 |

## 8. 验收记录

**live 承重墙**（真实 vortex-server 进程，Chrome + Edge 均在线）：

改前 —— 两个浏览器都连着，hint 却让人去查扩展：
```
code: EXTENSION_NOT_CONNECTED
message: No browser matching "firefox"; online: Google Chrome, Microsoft Edge
hint: Vortex extension is not connected. Ensure the target browser ... is open with the vortex extension enabled ...
```
改后 —— agent 视角（经 MCP `server.ts:819` 渲染）：
```
Error [EXTENSION_NOT_CONNECTED]: No browser matching "firefox"; online: Google Chrome, Microsoft Edge
Hint: The extension is connected, but no browser matches "firefox". Call vortex_browser with one of the
online labels (Google Chrome, Microsoft Edge), or start the requested browser and retry. Set VORTEX_BROWSER to pin a default.
```

**测试**：hub 197/197、mcp 667/667 全绿；新增 `connection-error-hints.test.ts` 8 例、`dev-reload-browser-binding.test.ts` +2 例。
`error-payload.test.ts:35` 原断言锁死了缺陷行为（hub TIMEOUT hint == 表文案），已连同理由改写。

**未做的一项**：思路里提过把 `dev_reload` 失败输出统一成 `Error [CODE]:` 形态以解决统计里的 `UNCODED`。实施时判定这是**我的挖掘脚本的正则问题，不是产品缺陷**——JSON 里 error/message/hint 齐全，agent 能读懂。改形态只会带来无谓的兼容风险，故放弃。

**RPC 超时**只有测试级证据（含 fetch 打真 hub 的端到端用例），未做真站 live——触发真实 RPC 超时需要让扩展卡死，成本高于收益。
