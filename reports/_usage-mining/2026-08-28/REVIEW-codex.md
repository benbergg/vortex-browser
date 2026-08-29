有条件通过（须先收窄 C2 的“已由代码确定”结论，统一 §4/§7/§8 的状态，并把 HTTP payload 的“形状匹配”改成 guard/normalize 后匹配）

## 一、上轮三条意见是否真的修到位

1. **fetch 异常选码**：已修对。v3 改为 `INTERNAL_ERROR`，这是现有枚举中更诚实的选择。
2. **HTTP payload guard 与合法码**：已补到方案和测试判据中，方向正确；但 `formatDispatchError` 入参“正是 HTTP payload 形状”的措辞仍不严谨，见第二节。必须把运行时 guard/normalize 作为实现要求，而不是只写在表格理由里。
3. **C2 spike 不可执行**：探针如何临时进入控制分支已补上，上一轮指出的“直接发原始 action 实际会落到普通 forwardRequest”已修复；但 v3 对 C2 时序结论有新的过度断言，且 §4、§7 仍残留旧的“生死线待验证”表述，见第三、四节。

## 二、§1 与 §5：格式化函数和三个出口

### 1. `formatDispatchError` 的入参形状

结论：**正常 HTTP 错误 payload 的字段子集匹配，但不是可以无条件直接传入的同一类型**。

源码 `packages/mcp/src/lib/dispatch-error.ts:6-11` 要求 `code: string`、`message: string`、可选 `hint`。hub 正常通过 `sendError` 返回的 `body.error` 至少有这些字段，额外的 `recoverable/context` 会被 formatter 忽略，因此选择该 formatter 的方向正确。

但当前 `packages/mcp/src/server.ts:426-430` 对 HTTP body 的声明是 `error?: { code?: string; message?: string }`，code/message 仍是可选；这是外部 JSON，TypeScript cast 不能保证字段存在。v3 已要求缺字段归一化，这点是实质修复，但 §5 的“入参形状正是”应改为“经过 guard/normalize 后形成 formatter 所需的 `{code,message,hint?}`”。

此外，formatter 接受任意字符串 code，不验证 `VtxErrorCode`。v3 的表格已经要求对 `Object.values(VtxErrorCode)` 校验并将非法值回退 `INTERNAL_ERROR`，这能满足 §1；实现和测试不能省掉这一步。

### 2. 三个出口的选码

- HTTP 非 2xx 或 `body.ok === false`：先校验 hub code，再透传合法 code；缺 code、缺 message、非法 code 回退 `INTERNAL_ERROR`，合理。`http-routes.ts:216`、`:256` 当前确实会给出合法错误码，但不能把当前 hub 实现当成外部 JSON 永远可信的保证。
- fetch/`r.json()` 异常：改成 `INTERNAL_ERROR` 是合理且比 `EXTENSION_NOT_CONNECTED` 更准确的修订。该 catch 覆盖 `fetch` 和 JSON 解析，事实只能证明 MCP 无法完成本地 HTTP 调用，不能证明扩展未连接。`EXTENSION_NOT_CONNECTED` 的元数据在 `packages/shared/src/errors.hints.ts:214-216` 是 `recoverable: false`，hint 引导打开浏览器和扩展；`INTERNAL_ERROR` 在 `:204-206` 是 `recoverable: true`，hint 引导检查 server/MCP 并重试。v3 的专用 server hint 与事实和动作一致。
- `RELOAD_TIMEOUT`：映射 `TIMEOUT` 合理。`TIMEOUT` 的 `recoverable` 和重试/增加预算方向与超时事实一致；C1 路径错配只能作为可能原因保留，不能写成已证实根因。

因此，用户特别要求核对的第 1、2、3 点结论分别是：**payload 仅在正常字段子集意义上匹配，必须先归一化；fetch 选 `INTERNAL_ERROR` 合理；两个自造码确实不在 `errors.ts` 枚举内**。

## 三、C2 第 5 条：源码是否真的推翻了原“生死线”

### 直接连接关系：成立

v3 这条核心观察是对的：

- `packages/server/src/hub-link.ts:121-128` 的默认 `reloadExtension` 只是用 `sendToExtension` 写入 NM 控制消息，然后立即 `return true`。
- `hub-link.ts:294-297` await 到这个立即完成的返回值后，`:309-322` 立刻在 server↔hub 的 WS 上发送 `agent-result`。
- 扩展 `packages/extension/src/background.ts:55-67` 收到控制消息后还要等待 50ms 才调用 `chrome.runtime.reload()`；被直接触发断开的首先是 server↔扩展 NM 通道，而不是承载 agent-result 的 server↔hub WS。

所以，原先“reload 必须在同一条承载响应的连接上完成，响应可能永远回不来”的直接生死线确实不存在。把 §8 从“验证这一条直接生死线”降级为“确认真实环境时序和投递”是合理的。

### 间接影响：不能说“由代码已经确定没有风险”

v3 的“最大风险不成立/代码层面已经确定”仍然过强。`packages/server/src/index.ts:102-106` 表明 NM 的 `stdin` 结束后会调用 `hubLink.stop()`；`hub-link.ts:162-165` 会清空 pending 并关闭 server↔hub WS，`:393-397` 的异常关闭路径也会清空 pending。也就是说：

1. reload 不是直接切断承载 agent-result 的连接；
2. 但 NM 断开可能随后让 server 停止并间接关闭 HubLink↔hub WS；
3. 若 agent-result 虽已调用 `socket.send`，但进程/WS 关闭时尚未实际送达 hub，仍存在投递时序风险。

50ms 延迟和源码调用顺序使“agent-result 发送调用先于 reload”很有把握，但不能仅凭源码证明跨进程/网络帧已经到达 hub，也不能证明 host 进程在所有环境都会保持到帧发送完成。因此第 5 条应改成“直接同连接生死线被证伪，间接关闭与投递仍需 live 确认”，不能写成整个风险已确定消失。

## 四、§4、§6、§7、§8 的一致性

### §6 第 5 条

“两条连接不是同一条”核实正确；“原生死线不存在”在直接因果意义上正确。需要补上 `index.ts:102-106` 的间接关闭事实，避免把“不同连接”误推成“不会丢响应”。

### §8 降级是否合理

合理，但应把验证目标改为：确认 agent-result 的发送与 hub 收到、MCP 收到同 id 响应，且 NM 断开/host stop 不会在送达前清空相关 pending。现在 §8 的具体探针搭法已解决上一轮的路由不可达问题；保留 live 验证也合理，因为 mock 无法证明真实断连和进程生命周期。

建议保留以下成功判据：同一 request id 的响应最终到达 MCP，且在 NM 断开后没有因 HubLink stop 丢失；失败包括 pending 被清空、响应超时、或只收到重连后的无关帧。无需再把“同一条连接被 reload 直接切断”作为失败判据。

### 文档状态仍未统一

v3 §8 已写“生死线由源码判定、spike 降级”，但：

- §1 仍写“C2 spike 得出结论”，未说明已经不是原生死线 spike；
- §4 仍称“C2 的生死线”并写“spike 通过再决定”；
- §7 仍把“响应能否在连接被切断前返回”列为“推的、未坐实”；
- §8/§9 又说该生死线已经由源码判定。

这些不是源码错误，但会让实施/验收方不知道该项是“直接机制待判断”还是“间接时序待确认”。必须统一成：直接机制已由源码排除，live 仅确认间接关闭、消息投递和真实时序。

## 五、六个审核问题的最终结论

1. **问题成立**：三个失败出口确实存在，两个自造码不在合法枚举内；v3 对此已修订正确。
2. **A 是治标**：仍只修错误自陈，不修 browserId 失效根因；方案没有误称为根因修复。
3. **改前/改后行为不同**：对真实 `{}`→旧 ID 404 入参，底层仍失败，但文本由 JSON/矛盾 hint 变为合法 `Error [INVALID_PARAMS]`；对 fetch 异常，v3 的 `INTERNAL_ERROR` 输出也与旧纯文本不同。
4. **真实路径**：A 的三个出口能在真实环境触发；C2 探针现已说明要临时进入控制分支，但仍须补间接 WS/pending 生命周期的 live 判据。
5. **测试**：值断言、变异点、payload 缺失/非法 code 断言已补齐；还应确保 fetch 测试精确断言 `INTERNAL_ERROR` 与 server hint，且 HTTP code guard 不是只存在于 mock 假设中。
6. **复用机制**：`formatDispatchError`、共享错误码/元数据、既有 `sendAgentCommand` 和 client 传输重试均已识别；formatter 仍必须接收 normalize 后的 payload。

## 放行条件

完成以下三项后可放行：

1. 将 §5/§7 对 formatter 的措辞改为“guard/normalize 后匹配”，并明确非法/缺失 code 和 message 的实际 fallback 实现要求。
2. 将 fetch 异常固定为 `INTERNAL_ERROR` + server hint，并把 `recoverable:true`/“检查 server 后重试”作为测试断言的语义要求，而不只是理由文字。
3. 统一 §1、§4、§7、§8、§9：删除“直接生死线仍待验证”的旧状态，保留“NM 断开可能间接关闭 HubLink、需 live 确认消息投递”的时序验证。
