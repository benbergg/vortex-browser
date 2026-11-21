# 修复计划 — 循环 `dogfood-history-2026-11-21`（第 2 版，已按独立审核处置）

> 依据：`docs/dogfood-cycle-sop.md` §5（先交方案评审 → 评审通过再动手 → TDD → bench case → 验收）。
> 缺陷详情见 `validated-defects.md`（D-HIST-1）。**第 1 轮审核结论 = 不批准**，本版逐条回填处置（§4）。
> **人工闸门**：实修已获用户授权（m02745 第 9 条）；推送另需授权。

## 1. D-HIST-1 —— `vortex_history` 退到浏览器拒绝恢复的历史项 ⇒ 裸 CDP 错误

| 项 | 内容 |
|---|---|
| **改什么** | ① `packages/extension/src/handlers/page.ts:163-165`：**只**在 `Page.navigateToHistoryEntry` 这一个 await 外面加 catch。捕获后按真实 Chrome 拒绝形态解析：把错误消息当 JSON 解析，**精确**匹配 `code === -32000 && message === "Not allowed"`；命中 ⇒ 抛 `vtxError(VtxErrorCode.NO_EFFECT, …)`，并显式 `recoverable: false`（`NO_EFFECT` 默认 `recoverable: true` ⇒ 必须显式关掉，见 `packages/shared/src/errors.hints.ts:7-10,387-389`）。**解析失败 / code 或 message 不匹配 ⇒ 原样重抛**（不吞错、不改分类）。<br>② 消息措辞：先陈述「浏览器拒绝恢复该历史项」；**只有**当目标 entry 的 URL 是浏览器内部页 scheme（`chrome:` / `edge:` / `about:`）时，才补一句「该历史项是浏览器内部页（如新标签页），无法回退」。**不做无条件归因**（拒绝原因可能不止一种）。<br>③ `packages/shared/src/errors.hints.ts`：新 hint 抽成**共享常量**并登记进 `OVERRIDE_HINTS`（`:150-165` 的硬约定：第 4 参数 override hint 必须登记），否则 I19/I20/I21 的 hint 质量扫描扫不到（`packages/shared/tests/invariants/I19.error-hint-quality.test.ts:23-25` 只枚举两张表）。⇒ **改动面是 shared + extension 两处**，不是只有 extension。<br>④ `packages/extension/src/handlers/page.ts:151` 的 entries 类型从 `Array<{id:number}>` 放宽到 `Array<{id:number; url?:string}>`（只为诊断时能说出是哪个 URL ⇒ 不新增接口） |
| **为什么用 `NO_EFFECT` 而不是新增错误码** | ① 语义一致：同函数的索引越界边界已经是 `NO_EFFECT` ⇒ 同一类结局、同一套调用方处置（改用 `vortex_navigate`）；② 现有 49 个码里 `NAVIGATION_FAILED` 过泛、`PERMISSION_DENIED` 暗示权限恢复，都不如既有边界处置贴合；③ 新增码要动 `packages/shared/src/errors.ts`（49 → 50）、`errors.hints.ts`、`packages/shared/tests/errors.test.ts:63` 的数量断言、I19 的 hint 质量闸 ⇒ 代价大于收益。**注：错误码表当前是 49 个（第 1 轮审核指出方案原文写 48 有误）** |
| **不做 URL scheme 事前拦截** | `NavigationEntry` 带 URL，但「内部 scheme」≠「必然不可历史导航」⇒ 事前拦截会替浏览器做判定、改变原有行为 ⇒ URL 只用于**诊断措辞**，不用于拦截 |
| **影响面（调用量，已按审核纠正）** | **客户端 transcript 侧：1 次 `vortex_history` 调用、0 错误** ⇒ **真实 agent 流量里尚未观测到本缺陷**。基线快照的 `history` 13 次调用 / 6 次错误里，**12 次来自服务端 sink**（`~/.vortex/logs/mcp-2026-11-21.jsonl`，client 全为 `vortex-history-dast@0.0.0` —— 本轮 DAST 自身），只有 1 次来自客户端。⇒ 原方案「每周命中两次 / 覆盖 2/6」的结论**作废**（那是把自己的 DAST 流量算进了 agent 流量）。<br>sink 里 2 条 `JS_EXECUTION_ERROR` 也不是两个独立有效 back 命中：一条是 `history_back_edge`（有效 back），另一条是 `history_bad_direction`（`direction:"sideways"` 落到 back 分支 ⇒ 输入校验问题，不算独立 back 场景）⇒ **有效命中 = 1 次/本轮 DAST**。 |
| **收益量级** | 单次省：把「裸 CDP 错误 + 误导 hint（让人改 selector）」变成「结构化 `NO_EFFECT` + 可执行 hint（改用 `vortex_navigate`）+ `recoverable:false`（明确告知重试无意义）」。**× 频次未知**（真实 agent 频次 = **缺测量**）⇒ 补的尺子：**服务端 sink 现已开启**（`VORTEX_USAGE_LOG=1` ⇒ L-05 已闭合）⇒ 后续每周基线快照的 `sink` 源会给出真实频次 ⇒ **本轮不给"每周 N 次"的数字** |
| **改动风险** | 低-中：<br>① 只影响 `vortex_history` 的单条 CDP 命令；其它错误原样抛 ⇒ 不吞错 ✓<br>② 精确匹配（`code === -32000 && message === "Not allowed"`）⇒ 误分类面比模糊子串小得多 ✓（但仍依赖 Chrome 拒绝文案 ⇒ 若 Chrome 改文案，行为回落到"裸错" ⇒ 与今天一致，不算退化 ✓）<br>③ `recoverable:false` 会让客户端**不再重试**该动作 ⇒ 若拒绝其实是暂时的 ⇒ 客户端会直接放弃 ⇒ 因此必须**只在确认的拒绝形态**上置 false ✓<br>④ 公开 schema / description **不变** ⇒ tools/list 字节**预期** 0 B 变化（预期≠实测，实测见 §2 验收）<br>⑤ 新 hint 必须登记 `OVERRIDE_HINTS`，否则 I19/I20/I21 扫描不到 ⇒ 漏登记会被门禁拦下 ✓ |
| **验证方式（按第 1 轮审核的防假绿要求重写）** | ① **RED 单测**（扩展 `packages/extension/tests/page-history-cdp.test.ts` 的既有 `mkDebuggerMgr` mock，不另起炉灶）：用**真实 Chrome 拒绝形态**作 fixture —— `new Error(JSON.stringify({ code: -32000, message: "Not allowed" }))` ⇒ 断言 (a) `Page.navigateToHistoryEntry` 确实被调用且带 `entryId`（**证明走的是新分支、不是索引越界分支**）(b) 错误码 `NO_EFFECT` (c) hint 含 `vortex_navigate` (d) `extra.recoverable === false`。<br>**负例**：其它 message / 其它 code / 非 JSON 文本 / `Page.getNavigationHistory` 失败 ⇒ 均原样抛出（`rejects.toBe(originalError)`，对象同一性）。<br>② **真机 DAST 带断言**：改 `/tmp/vortex-history-dast.mjs` ⇒ 每步输出 PASS/FAIL 判据、任一判据失败则**非零退出**；断言目标 entry 的真值（目标 URL、当前 URL、失败后 URL 不变）；并**显式指定构建来源**（MCP 用 worktree 的 `packages/mcp/dist/src/server.js`，扩展用 worktree 构建并核对 `buildStamp`）⇒ 防止测错版本造成假绿。<br>③ **bench case**：`packages/vortex-bench/cases/contract/history-back-refused.case.ts` ⇒ **必须断言命中的是新拒绝分支**（错误消息含「浏览器拒绝恢复」/ hint 含 `vortex_navigate`），**不能只断言 `NO_EFFECT`** —— 因为原有索引越界分支也返回 `NO_EFFECT` ⇒ 只断言错误码会假绿。固定自建 tabId，前序导航成功后再触发，结尾关自建 tab。<br>④ **sink 判据收窄**：只检查**本次运行**写入的行（按本次 client 名 + PID + 时间窗过滤），**不是**整份历史日志（旧记录不会消失 ⇒ 整份检查必然失败）。<br>⑤ 逐包回归：`pnpm --filter @vortex-browser/{extension,shared,mcp} exec vitest run tests/<file>.test.ts --maxWorkers=2 --minWorkers=1`。<br>⑥ 门禁：`pnpm lint:errors`、`pnpm ship:preflight` + gate4 等效检查（工作区 diff + 未跟踪文件）。<br>⑦ 体积：`node scripts/measure-runtime-surface.mjs` + `node scripts/measure-token-surface.mjs --compare <path>`；**要"与 main 逐字节相同"必须用同一序列化口径比较 tools/list 实际 payload**（这两个脚本输出的是 token 估算与 bench 报告对比，不等于字节相等 ⇒ 字节相等这一条由 I15 断言 + 直接序列化 payload 来验）。<br>⑧ SAST：`semgrep --config /tmp/vortex-audit.yml`（已重建）+ `codeql database create/analyze`（按当前源重建 DB）。<br>⑨ 缺陷**必须真机 DAST 复现/证伪才算数**（mock 过 ≠ 验证完成） |

## 2. 本轮明确「缺测量、暂缓」的方向（不写代码）

| 方向 | 性质 | 缺什么 / 补哪把尺子 |
|---|---|---|
| `vortex_history` 的 `go(index)` | **不是缺测量，是契约未定义** | 公开契约（`packages/mcp/src/tools/schemas-public.ts:365-375`）的 `direction` 只有 `back`/`forward` ⇒ 没有 `go`。第 1 轮审核指出「back/forward/go」是 `docs/audit-ledger.md` 旧文案的措辞（该文件在本轮已改写为不含 `go`）⇒ **本轮不新增功能**，也不写成"缺测量" |
| 真实 agent 命中频次 | **缺测量** | 客户端 transcript 里 history 只有 1 次调用、0 错误 ⇒ 频次未知。补的尺子：**服务端 sink 已开启**（L-05 闭合）⇒ 后续每周快照的 `sink` 源可给真实频次；本轮不做频次承诺 |
| hint 措辞是否让 agent 真的改用 `vortex_navigate` | **部分可测** | "收到拒绝 → 执行 hint 指向的 `vortex_navigate` → 核对 URL"**现在就能测**（纯 vortex 路径，DAST 可做）⇒ 本轮补上；"agent 是否自主选择该动作"需要 agent 评测 ⇒ 暂缓，**不承诺"不再盲目重试"** |
| 站点轴 80 站全量轮转 | **暂缓（合理）** | 浏览器历史边界修复不需要以 80 站全量为前置门禁 ⇒ 本轮只跑最小一轮（quill）⇒ 覆盖不足 ⇒ 不能给"站点面无缺陷"的结论 |
| BACK/FORWARD 加载监听时序（第 1 轮审核非阻塞建议） | **独立问题** | handler 在导航完成后才挂加载监听（`page.ts:283-293`）⇒ 存在独立的时序窗口 ⇒ 不纳入本次修复，另立条目 |

## 3. 本轮的其它产出（非修复）

| 产出 | 位置 | 价值 |
|---|---|---|
| **服务端 sink 打通** | `~/.vortex/logs/mcp-2026-11-21.jsonl` | `docs/audit-ledger.md` **L-05 闭合**（本轮已更新该行） |
| **基线快照（含 sink 源）** | `reports/_eval/baseline/2026-11-21-week-2026-11-21-sink.{json,md}` | 可被下周机械 diff；口径沿用 `routesMethodology` ✓ |
| **同窗口重跑可复现性** | `--from 2026-11-13T13:30:00Z --to 2026-11-20T13:30:00Z` 重跑 vs 上一轮快照 | 逐工具错误率**全部 ≈**（6.7% → 6.7%、空返回率 7.0% → 7.0%）⇒ 尺子稳定 ✓ |
| **参数级漂移守门**（上一轮） | `packages/mcp/tests/public-tool-params-drift.test.ts` | 公开契约 vs 运行时差异仍需真机 DAST 才能发现 ✓ |

## 4. 第 1 轮独立审核的逐条处置

审核：`openai-codex/gpt-6.1-sol`，会话 `2026-11-21T04-39-19-183Z_7ccbffcd-…`，结论 **不批准**。

| 编号 | 审核意见 | 处置 |
|---|---|---|
| B1 | `/not allowed/i` 会误伤其它错误；`.code` 可能匹配不到（仓内没有把 Chrome 拒绝转成带 `.code` 的对象）；只覆盖 hint 会继承 `recoverable:true`；`"Not allowed"` 不能证明目标一定是内部页 | ✅ 已改：只包 `Page.navigateToHistoryEntry`；用**真实形态** fixture（JSON 文本解析后精确比 `code === -32000 && message === "Not allowed"`）；显式 `recoverable:false`；文案先陈述「浏览器拒绝恢复该历史项」，内部页归因**仅在目标 URL 是内部 scheme 时**才加 |
| B2 | 统计来源错误：快照聚合把 sink 事件一起算了 ⇒ 「每周两次」不成立 | ✅ 已改：影响面改为「客户端 1 次调用 0 错误；12 次来自本轮 DAST 的 sink」；收益量级改为「频次未知 + 补的尺子 = 服务端 sink」 |
| B3 | 新 hint 绕过 `OVERRIDE_HINTS` 登记 ⇒ I19/I20/I21 扫不到 | ✅ 已改：hint 抽成共享常量并登记进 `OVERRIDE_HINTS`；改动面明确为 shared + extension |
| B4 | 错误码数量写错（48 → 实际 49） | ✅ 已改：注明当前 49 个码 |
| B5 | DAST 只打印、无断言、无失败退出码；未确认构建来源 | ✅ 已改：DAST 加判据 + 非零退出 + 显式指定 worktree 构建 + 核对 `buildStamp` |
| B6 | bench 只断言 `NO_EFFECT` 会假绿（索引越界分支也返回它） | ✅ 已改：bench 必须断言命中**新拒绝分支**的特征（消息/hint） |
| B7 | sink 判据用整份日志必然失败（旧记录不会消失） | ✅ 已改：只检查本次运行（client 名 + PID + 时间窗） |
| B8 | `go(index)` 不该写成"缺测量" | ✅ 已改：定性为"契约未定义"，且指出「back/forward/go」是台账旧文案（本轮已改写） |
| B9 | hint 行为闭环里"收到拒绝→用 hint 的动作→核对 URL"现在就能测 | ✅ 已改：列入本轮 DAST 验证项；"agent 是否自主选择"仍暂缓且不承诺 |
| B10 | `measure-*-surface` 的输出不等于字节相等 | ✅ 已改：字节相等改由 I15 断言 + 直接序列化 tools/list payload 来验；脚本输出只作 token/体积参考 |

---

## 5. 第 2 轮独立审核的逐条处置（第 3 版增补，2026-11-21）

审核：`openai-codex/gpt-6.1-sol`，会话 `2026-11-21T04-44-54-710Z_ff0cb29f-1268-4329-a078-62e36bc0a11f-062792d6-16c524e3-278c`，结论 **不批准**（阻塞项与第 1 轮同源，另有细化）。下面对第 1 版正文做**增量修订**，正文其余部分不变。

| 编号 | 审核意见 | 处置（覆盖正文对应处） |
|---|---|---|
| C1 | 错误分类规则未定稿 + 缺负向测试 | ✅ **只**捕获 `Page.navigateToHistoryEntry` 的异常（不包 attach / getNavigationHistory / 等待加载）；把错误消息当 JSON 解析后**精确**比 `protocol.code === -32000 && protocol.message === "Not allowed"`；解析失败或不匹配 ⇒ **抛回原异常对象**（断言对象同一性）。负向用例必须齐：① 非匹配错误保持身份 `rejects.toBe(original)` ② 同 code 不同 message 不翻译 ③ attach/getHistory 失败不翻译 ④ forward 方向同样可翻译（成功与索引边界既有用例保留） |
| C2 | 把合成 DAST 计数写成了真实客户端流量 | ✅ 影响面口径改为：**客户端 transcript 侧 history = 1 次调用 / 0 错误**；快照聚合的 13 次里 **12 次来自本轮合成 DAST**（sink 内 client 全为 `vortex-history-dast@0.0.0`，同 pid 56263）。引用 `2/13`、`2/6` 时只能标为**该混合采样集内的占比**，不得外推为真实用户周频率 |
| C3 | 验收条件可能假绿 / 不可成立 | ✅ sink 判据改为**本轮 pid/client/时间窗内正向断言**「拒绝调用返回 `NO_EFFECT`」（不再断言"错误数为零"，因为旧记录不会消失）；DAST 判据化 + 失败非零退出（已落地 `/tmp/vortex-history-dast.mjs`）；构建来源显式指定（MCP=`VORTEX_SERVER` 指 worktree dist；扩展须核对 buildStamp，**`VORTEX_REPO` 只决定脚本产物、不能证明浏览器加载了它**）；**字节相等改用固定基线 `307c594` + 同一序列化 ⇒ 比字节数 + sha256**（`measure-runtime-surface` 是 token 估算、`measure-token-surface --compare` 比的是 bench 报告，二者都不等于字节相等）；回归命令固定 `--maxWorkers=2 --minWorkers=1` |
| C4 | `JS_EXECUTION_ERROR` 的默认 hint 并未字面要求"调整 selector"，不必夸大 | ✅ 措辞改为「通用 hint（让人重试 / 换方法）」；只主张**错误分类过泛**，不主张 hint 内容误导 |
| C5 | `recoverable` 语义：沿用默认 `true` 不会变成不可恢复，但也不代表重试同一历史项有意义 | ✅ 对**已确认的拒绝形态**显式 `recoverable:false`（重试同一历史项无意义 ⇒ 与 `packages/shared/src/errors.hints.ts:7-10` 的约定一致），并加断言锁住 |
| C6 | bench 应避免外网可用性影响结果 | ✅ 用**本地 fixture 的两个 URL**；`suite:"b"`、`ctx.baseUrl`、显式 `tabId`、`finally` 关闭自建 tab |
| C7 | 未取得实际 entries URL 前，不要断言"所有内部 scheme 都不可回退" | ✅ 文案只陈述「浏览器拒绝恢复该历史项」+ 目标 URL；**仅当目标 URL 确实是内部 scheme 时**才补该归因，否则不归因 |
| C8 | 确认排除：不需要新增错误码 / 不做 scheme 预拒绝 / 不加 `go` / 不跑 80 站全量 | ✅ 已按此收窄，方案未越界；`go(index)` 定性为**未公开功能**（公开 schema 只有 back/forward），不是"缺测量" |
| C9 | `ship:preflight` 读提交范围，未提交的实现不能靠它证明已覆盖；它也不代替跑单测 | ✅ 验收里把 preflight 定位为**提交后的门禁**，单测/DAST 才是实现正确性的证据 |

---

## 6. 修复执行结果（2026-11-21）

**状态**：实现完成 + 验证全绿；**已提交 `faf0f76` 并 ff 合并进本地 `main`**（用户授权，未推送）。

| 计划步骤 | 状态 | 证据 |
|---|---|---|
| D1 根因定位 | ✅ | `packages/extension/src/handlers/page.ts:163-165`（`Page.navigateToHistoryEntry` 无 catch）；分类兜底在 `packages/extension/src/lib/router.ts:97-126` |
| D2 方案 | ✅ | 本文件 §1-§3（含暂缓项与补哪把尺子） |
| D3 独立审核先过 | ✅ | 3 轮 `openai-codex/gpt-6.1-sol`（会话 `…T04-39-19…` / `…T04-44-54…` / `…T05-2x…`），逐条处置见 §4/§5/§6；第 3 轮的两条阻塞（DAST 场景混在一起、buildStamp 未核对）已在 DAST 里改掉：拒绝场景与索引边界场景**分开**、读 hub 上报的 `browsers[].buildStamp` 并与期望值比对 |
| D4 TDD RED | ✅ | 扩展 `packages/extension/tests/page-history-cdp.test.ts`，新断言先红（12/15） |
| D5 GREEN | ✅ | 精确匹配 + `recoverable:false` + hint 登记 `OVERRIDE_HINTS`；DAST 16/16 |
| D6 bench case | ✅ | `packages/vortex-bench/cases/contract/history-back-refused.case.ts`（suite b，本地 fixture）PASS |
| D7 逐包回归 | ✅ | extension / shared / mcp 相关包绿；`extension` 全量套件 5 个文件 30 个用例失败 ⇒ **在基线源码（stash 掉改动）上同样失败、逐条相同** ⇒ 既有欠账，与本次改动无关 |
| D8 门禁 | ✅ | `lint:errors`、`ship:preflight` 改动前后**输出逐字相同**；gate4 等效检查 PASS（+1 fallback 在 page.ts，有对应测试文件） |
| D9 体积前后 | ✅ | tools/list 24369 B / sha256 `daea76e2…`（`packages/mcp/src` 未改 ⇒ 前后相同）；`measure-runtime-surface` 24 工具 / 3432 tokens；`measure-token-surface` 工具面 7705 tokens / 26041 chars（与上一任务基线同值） |
| D10 SAST | ✅ | semgrep 改动文件 0 命中；CodeQL 15 条（3 error + 12 warning）、改动文件 0 命中 |
| D11 真机 DAST 复验 | ✅ | 16/16 PASS；sink 同一调用 `errorCode:"NO_EFFECT"` |
| D12 记账 | ⚠️ 部分 | `docs/audit-ledger.md` 已记（审计表 + 计数 + 下一候选原语 `drag`）；`dogfood-rotation.mjs record` **不适用**（本轮是 vortex 原生路径，无站点 ⇒ 写进池子会污染站点缺陷趋势）；另发现 SOP §6 说 `record` 会写 `reports/_dogfood/ledger.md`，但脚本实际只写 `rotation-pool.json`（脚本与 SOP 不一致，记为残留问题） |

**合并后复验（E2，2026-11-21 17:1x）**：主仓 `main` = `faf0f76`；重编译后 `buildStamp=4.1.0+mwq70ba3`，浏览器已重载该构建；主仓逐包回归 extension 17/17、shared errors 26/26、mcp 3/3；主仓 dist 的 DAST **16/16 PASS**。

**未做（需单独授权）**：推送（禁推 master/main）。
