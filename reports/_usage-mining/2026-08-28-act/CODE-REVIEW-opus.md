# 代码审核结论：不通过

审核对象：工作区未提交改动（`packages/extension/src/action/candidate-suggest.ts`、`packages/extension/src/handlers/dom.ts`、`packages/shared/src/errors.hints.ts` 及三个测试文件）
审核者：Claude Opus（第 4 阶段，审代码不审方案）
日期：2026-08-28

不通过的两条理由（均已实测坐实）：

1. **方案 §1 判据 6「逐出口变异验证」名义满足、实质落空**：把六个出口的 host 侧接线**全部拆掉**（候选永远进不了 message，功能等于没做），测试仍 12/12 全绿；把六个出口的候选数组**全部置空**，测试仍 12/12 全绿。唯一的"六出口"测试是对 `dom.ts` **源码文本**做正则匹配，不是行为验证。
2. **改动打红了两条既有测试**（改动前 14/14 绿，改动后 2 failed），IMPL-luna.md 自述的"成功路径回归 8 passed / 49 passed"与实际不符。

---

## 0. 我实际跑了什么

现场保护：动手前把 `dom.ts` / `candidate-suggest.ts` / `errors.hints.ts` 备份到 scratchpad，每轮变异后按备份恢复并核 md5。审核结束时：

```
$ md5 packages/extension/src/handlers/dom.ts packages/extension/src/action/candidate-suggest.ts
MD5 (packages/extension/src/handlers/dom.ts) = f085c3f3697633b8bf8954f56e5b1b84
MD5 (packages/extension/src/action/candidate-suggest.ts) = 4948625a5f537d3a5860fb98151ccf98
```
与变异前逐字节一致，`grep -c enrichAmbiguousError dom.ts` = 7（1 定义 + 6 调用），临时探测测试文件已删除。**现场已恢复。**

基线（自己跑的，非采信 IMPL）：

```
$ pnpm --filter @vortex-browser/extension exec vitest run tests/selector-ambiguous-candidates.test.ts --maxWorkers=2 --minWorkers=1
 ✓ tests/selector-ambiguous-candidates.test.ts (12 tests) 16ms
      Tests  12 passed (12)

$ pnpm --filter @vortex-browser/mcp exec vitest run tests/dispatch-error.test.ts --maxWorkers=2 --minWorkers=1
      Tests  6 passed (6)

$ pnpm --filter @vortex-browser/shared exec vitest run tests/errors.test.ts --maxWorkers=2 --minWorkers=1
      Tests  25 passed (25)

$ pnpm --filter @vortex-browser/extension build
✓ built in 2.50s / [page-side] all bundles built successfully.
```

---

## P0-1 六出口接线零测试覆盖，变异判据被源码正则冒名满足

**位置**：`packages/extension/tests/selector-ambiguous-candidates.test.ts:91-106`（"六出口"测试）、`packages/extension/src/handlers/dom.ts:106-118`（`enrichAmbiguousError`）、`dom.ts:734`/`894`/`1277`/`1511`/`1784`/`2165`（六处 host 接线）

那条"六出口"测试的全部内容是把 `dom.ts` 当字符串切片再做 `toContain`：

```ts
// selector-ambiguous-candidates.test.ts:99-105
const start = DOM_SRC.indexOf(marker);
const block = DOM_SRC.slice(start, next < 0 ? undefined : next);
expect(block).toContain("extras: { matchCount: els.length, candidates }");
```

**变异 1（按 brief 要求，逐出口删摘要拼接）**——六处各自转红，看起来达标：

```
=== MUTATE CLICK (line 470) ===   × CLICK 出口…  Tests  1 failed | 11 passed (12)
=== MUTATE TYPE (line 838) ===    × TYPE 出口…   Tests  1 failed | 11 passed (12)
=== MUTATE FILL (line 1158) ===   × FILL 出口…   Tests  1 failed | 11 passed (12)
=== MUTATE SELECT (line 1347) === × SELECT 出口… Tests  1 failed | 11 passed (12)
=== MUTATE HOVER (line 1735) ===  × HOVER 出口…  Tests  1 failed | 11 passed (12)
=== MUTATE COMMIT (line 2139) === × COMMIT 出口… Tests  1 failed | 11 passed (12)
```

但这只证明"源码里那串字面量还在"。下面两个变异说明它证明不了别的：

**变异 2（拆掉全部六处 host 接线 —— 候选永远到不了 message，功能完全死掉）**：

```
$ perl -i -pe 's/enrichAmbiguousError\((r|probe|res), selector\)/$1/g' packages/extension/src/handlers/dom.ts
$ grep -n "enrichAmbiguousError" packages/extension/src/handlers/dom.ts
106:function enrichAmbiguousError(          ← 只剩定义，六处调用全没了
$ pnpm --filter @vortex-browser/extension exec vitest run tests/selector-ambiguous-candidates.test.ts --maxWorkers=2 --minWorkers=1
 Test Files  1 passed (1)
      Tests  12 passed (12)          ← 全绿
```

**变异 3（保留全部被断言的字面量，只把六处候选数组恒置空）**：

```
$ perl -i -pe 's/els\.slice\(0, 10\)\.map/els.slice(0, 0).map/g; s/Array\.from\(els\)\.slice\(0, 10\)\.map/Array.from(els).slice(0, 0).map/g' packages/extension/src/handlers/dom.ts
$ pnpm --filter @vortex-browser/extension exec vitest run tests/selector-ambiguous-candidates.test.ts --maxWorkers=2 --minWorkers=1
      Tests  12 passed (12)          ← 全绿
```

**佐证**：全仓测试里 `enrichAmbiguousError` 出现 0 次：

```
$ grep -rn "enrichAmbiguousError\|buildAmbiguousMessage" packages/*/tests/
packages/extension/tests/selector-ambiguous-candidates.test.ts:6,25,35,45,54,74,88   ← 只有 buildAmbiguousMessage
```

而 `:74` / `:88` 是**测试自己**把探针输出喂给 builder：

```ts
expect(buildAmbiguousMessage(".candidate", payload.extras.matchCount, payload.extras.candidates)).toContain("matched 2 elements");
```

——测试在测试里手工完成了生产代码本该完成的那一步接线。这正是本仓已归档的失效模式（`vortex_test_pageside_pure_fn`：纯函数测试证明不了接线；`mock_safe_dangerous_path`：源码 regex 匹配 = 假覆盖），方案 §判据 6 就是为堵它写的，现在被绕开了。

**必须改**：至少一条测试要让"page-side DTO → host builder → 最终 message"整条链走真代码。可行做法：对六个 handler 分别 mock `chrome.scripting.executeScript` 返回一个多命中结果，断言抛出的 `VtxError.message` 含候选摘要；再对该断言做变异 2 验证转红。

---

## P0-2 打红两条既有测试，且自述回归结果与实际不符

**位置**：`packages/extension/tests/act-primitives-p0-batch1.test.ts:92-108`

我自己跑的 extension 全量（185s）：

```
$ pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1
 Test Files  1 failed | 284 passed (285)
      Tests  2 failed | 2637 passed (2639)
```

失败两条：

```
× 族 C — HOVER 走 CDP 真鼠标触发 CSS :hover(#2) > HOVER probe 先 scrollIntoView 再算中心坐标
× 族 C — HOVER 走 CDP 真鼠标触发 CSS :hover(#2) > mouseenter 合成事件用 bubbles:false 修正语义
```

**改动前后对照（stash 法）**：

```
$ git stash push -- packages/extension/src/handlers/dom.ts packages/extension/src/action/candidate-suggest.ts
$ pnpm --filter @vortex-browser/extension exec vitest run tests/act-primitives-p0-batch1.test.ts --maxWorkers=2 --minWorkers=1
      Tests  14 passed (14)          ← 改动前全绿
$ git stash pop
$ pnpm --filter @vortex-browser/extension exec vitest run tests/act-primitives-p0-batch1.test.ts --maxWorkers=2 --minWorkers=1
      Tests  2 failed | 12 passed (14)   ← 改动后
```

**原因**：那两条断言用固定窗口切源码（`DOM_SRC.slice(hoverIdx, hoverIdx + 3500)` / `+ 3700`），HOVER 出口新插入的 ~14 行把被断言的内容挤出了窗口。既有测试写法本身脆（这是同一族"源码文本断言"的老账，见 P0-1），但**本次改动是打红它的直接原因，必须一并处理**（把窗口断言换成对 HOVER 块的定位切片，或按需扩窗），不能留红提交。

**同时**：IMPL-luna.md:113-121 写的"成功路径回归 Test Files 8 passed (8) / Tests 49 passed (49)"与实际不符——真实的包内回归面是 285 个文件 2639 条，其中 2 条红。自述里贴的输出不能作为验收证据。

---

## P1-1 `AMBIGUOUS_PAGE_PROBES` 是仅供测试的平行实现，且与真实注入函数行为不同

**位置**：`packages/extension/src/handlers/dom.ts:39-104`

```
$ grep -rn "AMBIGUOUS_PAGE_PROBES" packages/
packages/extension/src/handlers/dom.ts:39:export const AMBIGUOUS_PAGE_PROBES = {
packages/extension/tests/selector-ambiguous-candidates.test.ts:9,65,79
```

生产代码里 **0 处引用**（构建产物里也被 tree-shake 掉了：`grep -c "did not have multiple matches" dist/assets/background.ts-*.js` 全为 0）。方案 §判据 7 要求「复刻**实际传给** `chrome.scripting.executeScript` 的函数及参数」，实施方的做法是另写一份长得像的函数放进 src 再用 `new Function` 测它——测的不是注入的那份。

而且两份已经不一致：

```
$ sed -n '39,104p' packages/extension/src/handlers/dom.ts | grep -n "els.slice\|els.map\|Array.from(els)"
11:  const candidates = els.slice(0, 10).map(...)   ← click 探针有 slice
26:  const candidates = els.map(...)                 ← type 探针无 slice
35:  const candidates = els.map(...)                 ← fill 探针无 slice
44:  const candidates = els.map(...)                 ← select 探针无 slice
53:  const candidates = els.map(...)                 ← hover 探针无 slice
63:  const candidates = Array.from(els).map(...)     ← commit 探针无 slice
```

真实六处出口（`dom.ts:460 / 828 / 1148 / 1337 / 1725 / 2129`）**全部**是 `slice(0, 10)`。也就是说：探针版在 1000 个命中时会生成 1000 条 DTO（候选数上限这条硬约束在被测的那份里根本不存在），真实版才有上限——测试通过恰恰说明它测的不是生产路径。

**必须改**：删掉这份平行实现，改为把真实六处的 inline 注入函数抽成模块级常量、由 handler 与测试**共用同一份**，再用 `new Function` 剥离作用域跑。这也符合本仓已有结论「探测/门单一真源共享纯函数」。

---

## P1-2 `useRealMouse` / `trustedMode` 的 CLICK 路径仍是老的无候选报错（方案与 codex 都没提）

**位置**：`packages/extension/src/handlers/dom.ts:418-420` → `packages/extension/src/adapter/cdp.ts:121` → `cdp.ts:200`

```ts
// dom.ts:418-420  —— 在合成探针之前就早返回
if (useRealMouse || trustedMode) {
  try { return await cdpClickPath(); }
```

```ts
// cdp.ts:118-126（未改）
if (els.length > 1) {
  return { errorCode: "SELECTOR_AMBIGUOUS",
           error: `Selector "${sel}" matched ${els.length} elements`,
           extras: { matchCount: els.length } };     ← 无 candidates
}
// cdp.ts:200
if (rectRes?.error) mapPageError(rectRes, selector);  ← 未经 enrichAmbiguousError
```

`useRealMouse` 是 `vortex_act` 的**公开入参**（`packages/mcp/src/tools/schemas-public.ts:65`），`trustedMode` 是会话级开关且注释写明"此时 click 默认走 CDP trusted"。也就是说：**在 trusted 模式下点一个多命中 selector，调用方拿到的仍然是本次要修的那条老错误**。方案把范围定成"六处出口"，这一处不在里面，但它是同一个工具、同一个错误码、同一类调用方，属于方案盲区。

（同族的 `page-side/commit-drivers/{select,aria-select,checkbox-group}.ts` 也各有一处未增强的 `SELECTOR_AMBIGUOUS`，但它们用的是与 `dom.ts:2120` 完全相同的 `document.querySelectorAll(sel)`、在 COMMIT 门之后才执行，实际不可达，不要求本轮处理。）

---

## P2-1 正文预算算漏了末尾的 `Showing/omitted`，恢复指引可被截断

**位置**：`packages/extension/src/action/candidate-suggest.ts:167-180`

循环内的预算试算（`:172-176`）在**加入最后一个候选**时 `omittedIfAdded === 0`，于是 `omittedText` 为空串；但循环结束后 `:178-180` 无条件拼上 ` Showing N; omitted 0.`（约 24 字节）再交给 `clipToBytes`。差额落在 4096 边界上时，被砍掉的是**末尾的恢复指引**。

实测（我写的临时扫描，跑完已删）：在 n=2..10 × 字段长度 0..120 × 属性数 0..3 的网格内命中 **22 个**输入，正文末尾被截断：

```
截断样本数= 22
n=9 L=21 k=2 bytes=4096 tail="e selector with a distinguishing attribute or text, then retry vortex…"
n=9 L=21 k=3 bytes=4096 tail="e selector with a distinguishing attribute or text, then retry vortex…"
n=9 L=22 k=2 bytes=4096 tail="the selector with a distinguishing attribute or text, then retry vort…"
```

好消息：同形分支不受影响——同形告警"无法仅凭摘要区分"位于后缀开头，同一网格扫描下 **0 个**样本丢失该告警，方案 §1 判据 2 成立。修法一行：循环内试算时把 `omittedText` 按"总是存在"计算，或把 `suffix` 从 `clipToBytes` 的裁剪范围里摘出来单独拼接。

## P2-2 `extras.candidates` 与 message 重复承载同一份页面文本，且不受 4096 预算约束

**位置**：`dom.ts:470/838/1158/1347/1735/2139`（extras 保留 candidates）→ `adapter/native.ts:109`（`extras` 原样进 `vtxError` context）

方案 §0.5 自己证明过 `extras` 除 `lastReason` 外不进回传文本（`dispatch-error.ts:13-32`，本轮新增的 `packages/mcp/tests/dispatch-error.test.ts:31-40` 也断言了这一点）。既然候选已经进了 message，`extras.candidates` 就是一份**永不渲染**的副本：10 条 × 每条最多 ~500 字节 ≈ 4KB，跨 NM/hub/MCP 全程搬运，且**不在** `buildAmbiguousMessage` 的 4096 预算内——方案 §5 花力气建的总预算实际被绕过一半，错误响应体积约为预算的两倍。建议 host 侧组装完 message 后从 extras 里删掉 `candidates`（保留 `matchCount`）。

## P2-3 中英混排

`candidate-suggest.ts:163-165`：同形分支的后缀是中文（"这些候选摘要完全相同，无法仅凭摘要区分；保持拒绝执行……"），而 head、`Matched candidates:`、`Showing/omitted`、非同形后缀全是英文，同一条 message 里两种语言。本仓 `errors.hints.ts` 的 hint 与 `buildNoMatchMessage` 都是纯英文。建议统一英文。

## P2-4 缩进被改坏

`dom.ts:2120`：`const els = document.querySelectorAll(sel);` 比同级少 2 空格（上下文 `:2119` 注释与 `:2121` `if` 都是 12 空格，该行是 10 空格）。

---

## 方案要求里我核过、**成立**的部分

- **第六处查询语义未被误统一**：`dom.ts:2120` 仍是 `document.querySelectorAll(sel)`，前五处 `dom.ts:456/824/1138/1327/1715` 仍是 `__vortexDomResolve.queryAllDeep`。✅
- **候选确实进 message 而非只进 extras**：`enrichAmbiguousError`（`dom.ts:106-118`）用 `buildAmbiguousMessage` 覆写 `error`；`packages/mcp/tests/dispatch-error.test.ts:31-40` 用真断言证明 `extras` 里的内容不出现在回传文本中（`expect(visible).not.toContain("extras-only-secret")`，不是键集合对照）。✅（但接线本身无测试，见 P0-1）
- **用的是已命中的 `els`，没有在拒绝分支后重查**：六处的候选映射与 `els.length > 1` 判定在同一次 page-side 调用、同一个 `els` 上。✅
- **分层边界**：DTO 只含 `index/tag/accessibleName/text/attributes/visible`，全是可序列化标量；注入函数内的 `cleanCandidate` 是 inline 定义、`getComputedStyle` 是页面全局，没有模块级或闭包 helper 泄漏进注入体。✅（`pnpm --filter @vortex-browser/extension build` 通过）
- **长度预算落地**：字段 120 字符（`AMBIGUOUS_FIELD_MAX_CHARS`）、单候选 480 字节、候选数 10、整条 4096 字节，均在 `candidate-suggest.ts:96-99` 定义并生效；属性白名单按原 selector 出现过的属性取（`#`→id、`.`→class、`[attr` 正则）。✅（边界一处漏算见 P2-1）
- **同形 fail-closed**：11 个同形候选正文含"无法仅凭摘要区分"、含"保持拒绝执行"，且六处分支仍原样 `return { errorCode: "SELECTOR_AMBIGUOUS" }`，没有自动挑第一个、没有把多命中降为成功。✅
- **成功路径**：新增逻辑全部在 `els.length > 1` 分支内，`enrichAmbiguousError` 只在 `errorCode === "SELECTOR_AMBIGUOUS"` 时改写，其余原样返回；`mapPageError` 的 `hitOwnershipOverride` 只对 `ELEMENT_OCCLUDED` 生效（`native.ts:81`），不与新 message 冲突。除 P0-2 那两条源码窗口断言外，包内其余 2637 条测试全绿。✅
- **hint 契约**：`errors.hints.ts:141` 新文案含 next-action 动词与 `vortex_act`，`recoverable` 仍为 `true`，`packages/shared/tests/errors.test.ts:121-127` 有真断言。✅

## 假绿排查（brief §3 逐条）

- **只比 `Object.keys` 的键集合对照**：无。
- **mock 掉恰好是危险路径的那一层**：`dispatch-error.test.ts` 没有 mock，直接调真函数；`selector-ambiguous-candidates.test.ts` 也没 mock——但它**整层跳过**了危险路径（`chrome.scripting.executeScript` 注入与 host 接线一次都没走），比 mock 掉更彻底，见 P0-1。
- **纯函数测试被当接线证据**：是，见 P0-1。
- **`new Function` 是否复刻了真实注入函数**：否，见 P1-1。

## 与本次任务无关的工作区改动（提交前需隔离）

`.mcp.json`、`packages/mcp/src/server.ts`、`packages/hub/tests/http-routes.test.ts`、`packages/mcp/tests/dev-reload-browser-binding.test.ts`、`packages/mcp/tests/dev-reload-error-contract.test.ts` 的 mtime 均为 18:41–18:53，早于本次实施（21:17–21:25），属前一轮 dev-reload 工作的遗留，不是本实施方的越界。但 `git commit` 前必须只挑本次相关文件。

---

## 放行条件

1. 补一条**真接线**测试（page-side DTO → host → 最终 `VtxError.message`），并证明拆掉 `enrichAmbiguousError` 后它转红。
2. 修好 `act-primitives-p0-batch1.test.ts` 的两条红。
3. 删掉 `AMBIGUOUS_PAGE_PROBES` 平行实现，改为与生产共用同一份注入函数。
4. P1-2（`useRealMouse`/`trustedMode` 路径）：要么补上，要么在方案里写明本轮不覆盖及理由。
5. P2 四条建议随手改掉（P2-1 一行、P2-2 一行、P2-3 文案、P2-4 缩进）。
