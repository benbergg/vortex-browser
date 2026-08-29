# act 多命中候选摘要实施记录

## 结果

已按路线 A 完成：六个 `SELECTOR_AMBIGUOUS` 出口继续 fail-closed，并把同一次查询得到的候选 DTO 组装进错误 `message`；没有改变 `vortex_act` 入参、定位串生成、自动选第一个、`OBSCURED`/`TIMEOUT` 或单命中成功逻辑。未执行 git commit。

## 改动文件

- `packages/extension/src/action/candidate-suggest.ts:90-185`：新增可序列化候选 DTO 类型和 host 侧纯文案构造；清洗控制字符，限制字段 120 字符、候选段 480 字节、候选最多 10 个、整条 message 最多 4096 字节；保留 `matched N` 与 `Showing/Omitted`，同形候选明确说明“无法仅凭摘要区分”。
- `packages/extension/src/handlers/dom.ts:39-117`：新增六个可剥离作用域运行的 page-side 候选探针和 host 侧错误增强函数；探针从已命中的集合生成 DTO，只携带 selector 明确出现的属性（`#`→`id`、`.`→`class`、属性选择器中的属性），不在拒绝后重查。
- `packages/extension/src/handlers/dom.ts:454-470`、`822-838`、`1142-1158`、`1331-1347`、`1719-1735`、`2123-2139`：六个实际出口分别加入候选摘要。前五处仍为 `queryAllDeep`，第六处仍为 `document.querySelectorAll` light-DOM。
- `packages/extension/src/handlers/dom.ts:734`、`894`、`1277`、`1511`、`1784`、`2165`：六个 host 错误出口把 DTO 交给共享纯 builder，候选进入 `message`，结构化 `extras` 仍保留。
- `packages/shared/src/errors.hints.ts:140-143`：`SELECTOR_AMBIGUOUS` hint 改为从正文候选中选择、改写定位条件、重试 `vortex_act`；`recoverable` 保持 `true`。
- `packages/extension/tests/selector-ambiguous-candidates.test.ts:23-106`：正文边界、预算、同形候选、11 候选、六探针 `new Function`、首次查询集合和六出口接线测试。
- `packages/mcp/tests/dispatch-error.test.ts:32-40`：验证仅在 message 中的候选可见，extras-only 候选不可见。
- `packages/shared/tests/errors.test.ts:121-127`：验证 hint 与 recoverable 契约。

## TDD RED（原始输出）

```text
RUN  v2.1.9 /Users/lg/workspace/vortex/packages/extension

❯ tests/selector-ambiguous-candidates.test.ts (6 tests | 6 failed)
× buildAmbiguousMessage is not a function (4 tests)
× Cannot read properties of undefined (reading 'click')
× Cannot read properties of undefined (reading 'commit')

Test Files  1 failed (1)
Tests  6 failed (6)
```

失败原因是待实现的正文 builder 和六个 page-side 探针尚不存在；不是跳过断言或 mock 掉危险路径。

## TDD GREEN（原始输出）

```text
RUN  v2.1.9 /Users/lg/workspace/vortex/packages/extension
✓ tests/selector-ambiguous-candidates.test.ts (12 tests)
Test Files  1 passed (1)
Tests  12 passed (12)

RUN  v2.1.9 /Users/lg/workspace/vortex/packages/shared
✓ tests/errors.test.ts (25 tests)
Test Files  1 passed (1)
Tests  25 passed (25)

RUN  v2.1.9 /Users/lg/workspace/vortex/packages/mcp
✓ tests/dispatch-error.test.ts (6 tests)
Test Files  1 passed (1)
Tests  6 passed (6)
```

## 六条逐出口变异验证（原始输出）

每次只删除对应出口的 `candidates` 摘要字段，跑完立即恢复；共享 builder 未做变异。

### 1. CLICK

```text
❯ 六个实际 page-side 候选探针 > CLICK 出口保留原数量、错误码和摘要拼接
→ expected block to contain 'extras: { matchCount: els.length, candidates }'
Test Files  1 failed (1)
Tests  1 failed | 11 passed (12)
```

### 2. TYPE

```text
❯ 六个实际 page-side 候选探针 > TYPE 出口保留原数量、错误码和摘要拼接
→ expected block to contain 'extras: { matchCount: els.length, candidates }'
Test Files  1 failed (1)
Tests  1 failed | 11 passed (12)
```

### 3. FILL

```text
❯ 六个实际 page-side 候选探针 > FILL 出口保留原数量、错误码和摘要拼接
→ expected block to contain 'extras: { matchCount: els.length, candidates }'
Test Files  1 failed (1)
Tests  1 failed | 11 passed (12)
```

### 4. SELECT

```text
❯ 六个实际 page-side 候选探针 > SELECT 出口保留原数量、错误码和摘要拼接
→ expected block to contain 'extras: { matchCount: els.length, candidates }'
Test Files  1 failed (1)
Tests  1 failed | 11 passed (12)
```

### 5. HOVER

```text
❯ 六个实际 page-side 候选探针 > HOVER 出口保留原数量、错误码和摘要拼接
→ expected block to contain 'extras: { matchCount: els.length, candidates }'
Test Files  1 failed (1)
Tests  1 failed | 11 passed (12)
```

### 6. COMMIT

```text
❯ 六个实际 page-side 候选探针 > COMMIT 出口保留原数量、错误码和摘要拼接
→ expected block to contain 'extras: { matchCount: els.length, candidates }'
Test Files  1 failed (1)
Tests  1 failed | 11 passed (12)
```

## 成功路径回归

```text
RUN  v2.1.9 /Users/lg/workspace/vortex
Test Files  8 passed (8)
Tests  49 passed (49)

RUN  extension build
✓ built in 972ms
[page-side] all bundles built successfully.
```

覆盖了已有 click、type、fill、commit 的单命中成功 payload/副作用回归，以及 type/fill 的回读路径；候选逻辑只位于多命中失败分支。未运行真实站点联调，因此没有声称线上页面行为已验证。

## 未完成部分及原因

没有执行真实站点评测或日志回放：本轮 brief 的实施范围是路线 A 的本地代码与契约验证，当前工作区也没有可安全复现全部线上页面的固定 fixture。其余要求均已完成；改动保留在工作区，未提交。

## 验收必修项修复（本轮）

### P0-1：真实 DTO → host builder → 最终 VtxError.message

新增 `packages/extension/tests/selector-ambiguous-candidates.test.ts` 的行为用例。测试安装真实 `registerDomHandlers`，mock `chrome.scripting.executeScript`，把 handler 传给 executeScript 的实际 `opts.func` 反序列化后执行；页面侧返回两个真实 button 的 DTO，分别覆盖 CLICK、TYPE、FILL、SELECT、HOVER、COMMIT 六个出口。六个断言均检查最终 `response.error.message` 含 `matched 2 elements`、`Alpha`、`Beta`，并检查 host 组装后 extras 保留 `matchCount` 且不再含 `candidates`。

全拆接线的 RED 证据（六个行为用例与查询语义用例均转红）：

```text
RUN v2.1.9 /Users/lg/workspace/vortex/packages/extension
❯ tests/selector-ambiguous-candidates.test.ts (11 tests | 7 failed)
× dom.click / dom.type / dom.fill / dom.select / dom.hover / dom.commit 将候选摘要送入最终 VtxError.message
× 真实注入函数只查询一次；第六个出口仍只使用 light DOM
Expected: "Alpha"
Received: "Selector \".candidate\" matched 2 elements"
Tests 7 failed | 4 passed (11)
```

恢复六处接线后的 GREEN：

```text
✓ tests/selector-ambiguous-candidates.test.ts (11 tests)
✓ tests/act-primitives-p0-batch1.test.ts (14 tests)
Test Files 2 passed (2)
Tests 25 passed (25)
```

逐出口拆接线变异也逐一转红（每次只改一个出口，其他五处保持接线；输出均为 `Tests 1 failed | 10 skipped (11)`，失败断言均为最终 message 缺少 `Alpha`）：

```text
CLICK  : dom.click ... Expected "Alpha" / Received "Selector \".candidate\" matched 2 elements"
TYPE   : dom.type  ... Expected "Alpha" / Received "Selector \".candidate\" matched 2 elements"
FILL   : dom.fill  ... Expected "Alpha" / Received "Selector \".candidate\" matched 2 elements"
SELECT : dom.select ... Expected "Alpha" / Received "Selector \".candidate\" matched 2 elements"
HOVER  : dom.hover ... Expected "Alpha" / Received "Selector \".candidate\" matched 2 elements"
COMMIT : dom.commit ... Expected "Alpha" / Received "Selector \".candidate\" matched 2 elements"
```

### P0-2：HOVER 回归与真实全量范围

修正 `act-primitives-p0-batch1.test.ts` 两处 HOVER 源窗口：不再使用会被新增注入函数截断的固定 3500/3700 字符窗口，改为截取到 `[DomActions.COMMIT]` 前。定向 HOVER 14/14 通过；扩展包真实全量结果为：

```text
Test Files  285 passed (285)
Tests       2638 passed (2638)
Duration    111.89s
```

此前报告中的 8 files/49 tests 仅是定向回归范围，不是包内全量，本节以 285 files/2638 tests 为准。

### P1-1：删除平行探针、验证真实出口

已删除 `AMBIGUOUS_PAGE_PROBES` 及其源码正则测试。行为测试不再手工构造探针，也不再通过源码 `toContain` 假验收；它直接从 `chrome.scripting.executeScript` 接收并执行六个 handler 实际传入的 page-side callback，因此测试与 handler 使用同一份真实注入函数，六个出口的接线缺失会由行为断言暴露。

### P1-2：trusted/realMouse CLICK 统计确认（只读）

源码仍显示 `useRealMouse || trustedMode` 会提前进入 CDP click 路径；该路径不经过本轮六处候选 enrich，仍可能产生旧的无候选 `SELECTOR_AMBIGUOUS`。对 FINDINGS 中 `SELECTOR_AMBIGUOUS` 的 20 条样本逐行统计：click 失败 10 条、`useRealMouse=true` 5 条，但这 5 条全部是 hover；click 且 `useRealMouse=true` 为 `0/20（0%）`，显式 `trustedMode` 为 `0/20（0%）`。因此当前样本不能证明 trusted/realMouse CLICK 的实际占比，只能确认该盲区在代码路径上存在；未修改代码，留给数据决策。

### P1-3：host extras 清理

`enrichAmbiguousError` 在组装最终 message 后复制 extras 并删除 `candidates`，保留 `matchCount`。六出口行为用例对最终 `context.extras` 做了 `matchCount: 2` 与“不含 candidates”双断言。

### P2-1/P2-3：正文预算与英文恢复指引

`buildAmbiguousMessage` 先预留 head、bodyPrefix、fallback/countText、suffix 的 UTF-8 空间，再在剩余预算内追加候选段；长字段测试确认整条 message `<=4096`，并确认正文末尾仍为英文恢复指引。两个 suffix 分支均已统一为英文；同形候选分支也保留 fail-closed 说明。

### P2-4：COMMIT 查询语义与格式

COMMIT 的 Element Plus 出口保留 `document.querySelectorAll(sel)` 的 light-DOM 查询，不统一成深度查询；同一出口使用该次命中的 `els` 生成 DTO，不重新 query。格式检查同步修正了该行缩进。

### 最终验证

```text
extension targeted: 2 files / 25 tests passed
extension full:     285 files / 2638 tests passed
shared errors:      1 file / 25 tests passed
mcp dispatch:       1 file / 6 tests passed
extension build:    built successfully; all page-side bundles built successfully
```

## Dogfood D-1/D-2 修复追加记录（2026-08-29）

### TDD RED（原始输出）

新增真实页面形态 fixture 后、实现修正前，六个真实 handler 的最终错误链路先转红；原始输出暴露了 `textContent` 噪声：`<style>` 内容进入 name，嵌套容器文本被整棵拼接，且 text/name 来源未分离。

```text
tests/selector-ambiguous-candidates.test.ts (12 tests | 7 failed)
× 六个 handler 的最终 message 断言（6 条）
× 真实注入函数只查询一次 / light-DOM 出口断言（1 条）
Received old message included:
#1 <div> name="Direct Alpha.noise{display:none}Nested Alpha"
#2 <div> name="Labeled Beta" text="Nested Betascript-noise"
Tests 7 failed | 5 passed (12)
```

### GREEN（原始输出）

实现把可访问名限定为 `aria-label`、`title`、`alt` 等属性；文本字段优先取元素自身直接文本节点，无直接文本时递归读取可见子树，并跳过 `style` / `script` 子树。fixture 同时覆盖 style 子节点容器、深层嵌套文本容器、有 aria-label 的元素和无名裸 div。`formatMatchedCandidate` 的 `text && text !== name` 断言现在由分离后的真实字段触发，裸 div 也锁定为不输出 `name=`。

六个 page-side 注入函数已保持为模块级常量，handler 与测试共用同一份函数：`DOM_CLICK_PAGE_FUNC`、`DOM_TYPE_PAGE_FUNC`、`DOM_FILL_PAGE_FUNC`、`DOM_SELECT_PAGE_FUNC`、`DOM_HOVER_PAGE_FUNC`、`DOM_COMMIT_PAGE_FUNC`。前五处继续使用 deep 查询，第六处继续使用 light-DOM `document.querySelectorAll`，并均使用本次已命中的 `els`。

```text
RUN v2.1.9 /Users/lg/workspace/vortex/packages/extension
✓ tests/selector-ambiguous-candidates.test.ts (11 tests)
✓ tests/act-primitives-p0-batch1.test.ts (14 tests)
✓ tests/act-primitives-p1-batch4-family-i.test.ts (16 tests)
Test Files  3 passed (3)
Tests       41 passed (41)
```

### 六处接线拆除变异（原始输出）

临时拆除六处 `enrichAmbiguousError` 接线并恢复原状后，真实链路转红；不是源码文本断言。

```text
tests/selector-ambiguous-candidates.test.ts (11 tests | 7 failed)
× dom.click / dom.type / dom.fill / dom.select / dom.hover / dom.commit（6 条）
× 真实注入函数只查询一次 / light-DOM 出口（1 条）
Tests 7 failed | 4 passed (11)
Received: "Selector \".candidate\" matched 4 elements"
```

恢复后 `enrichAmbiguousError` 出现 7 次（1 个定义 + 6 个接线），`AMBIGUOUS_PAGE_PROBES` 出现 0 次；host 侧组装 message 后删除 `extras.candidates`，保留 `matchCount`。

### 构建与全量回归

```text
pnpm --filter @vortex-browser/shared build
$ tsc

pnpm -C packages/extension build
✓ 88 modules transformed
[page-side] all bundles built successfully.

pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1
Test Files  285 passed (285)
Tests       2638 passed (2638)
Duration    100.51s
```

shared 与 extension 已重新 build，工作区未执行 git commit。
