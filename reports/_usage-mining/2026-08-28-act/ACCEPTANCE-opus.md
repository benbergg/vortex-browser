# 验收结论（act 轮）：**通过**

> 首轮判打回（必修项见下），实施方已修复；验收方独立复核全部通过。以下保留打回记录便于追溯。

## 复验结果（2026-08-28 二轮）

**决定性验证——拆线变异**（首轮此处 12/12 全绿，即测试完全无效）：

```
基线: Tests 11 passed (11)
$ perl -i -pe 's/enrichAmbiguousError\((r|probe|res), selector\)/$1/g' packages/extension/src/handlers/dom.ts
拆线后接线数(应为1=仅定义): 1
   × 六个真实 handler 的 DTO→host→VtxError.message 链路 > dom.click 将候选摘要送入最终 VtxError.message
   × ... dom.type / dom.fill / dom.select / dom.hover / dom.commit（各一条）
   × 真实注入函数只查询一次；第六个出口仍只使用 light DOM
⎯⎯⎯ Failed Tests 7 ⎯⎯⎯
```

**拆掉接线转红 7 条**，测试现在真的走通 `page-side DTO → host builder → 最终 VtxError.message`。

逐项复核：

| 必修项 | 状态 | 验收方独立证据 |
|---|---|---|
| P0-1 接线零覆盖 | ✅ | 拆线变异 7 条转红（上轮 12/12 全绿） |
| P0-2 打红既有测试 + 自述不实 | ✅ | extension 全量 **285 files / 2638 tests 全绿**，HOVER 两条已修 |
| P1-1 平行实现 | ✅ | `AMBIGUOUS_PAGE_PROBES` 出现次数 0；测试改为 mock `chrome.scripting.executeScript` 走真实 handler |
| P1-2 trusted/realMouse 盲区 | ✅ 只做统计未改码 | 20 条样本中 click 且 `useRealMouse=true` **0/20**、`trustedMode` **0/20**；盲区在代码路径存在但当前样本占比为 0 |
| P1-3 extras 副本 | ✅ | `dom.ts:44` `delete extras.candidates`，保留 `matchCount` |
| P2-1 预算截断恢复指引 | ✅ | `candidate-suggest.ts:170` 先预留 suffix/计数/标点的最坏情况空间 |
| 文案中英混用 | ✅ | 已统一 |

**跨包回归**（验收方自跑）：extension 285/2638、shared 12/339、mcp 75/770、hub 47/249 全绿；`pnpm --filter @vortex-browser/extension build` 通过（含 page-side bundles）。

**现场干净**：无 `AMBIGUOUS_PAGE_PROBES` 残留，`enrichAmbiguousError` 计数 7（1 定义 + 6 调用），无变异痕迹遗留。

## P1-2 的决策（编排方）

trusted/realMouse CLICK 路径的盲区**不纳入本轮**：当前 20 条样本中该路径产生 `SELECTOR_AMBIGUOUS` 的占比为 0/20。记为已知盲区，留待后续日志出现该形态样本时再评估。这条盲区源于方案只列了六处 page-side 抛出点，责任在方案（我）。

---

# 首轮打回记录

日期：2026-08-28 ｜ 验收方：Claude Opus（编排方）

本轮有两层审核：codex 审方案（`REVIEW-codex.md`，有条件通过）、Claude Opus 审代码（`CODE-REVIEW-opus.md`，**不通过**）。验收方独立复核了代码审核的核心结论，**判定成立，打回**。

## 验收方独立复核（不采信任何一方所贴输出）

**复核对象**：代码审核的头号结论「六出口接线零测试覆盖」。

```
$ perl -i -pe 's/enrichAmbiguousError\((r|probe|res), selector\)/$1/g' packages/extension/src/handlers/dom.ts
拆线后 enrichAmbiguousError 出现次数: 1 (应为 1=仅定义)
$ pnpm --filter @vortex-browser/extension exec vitest run tests/selector-ambiguous-candidates.test.ts --maxWorkers=2 --minWorkers=1
      Tests  12 passed (12)
--- 恢复后 md5 --- f085c3f3697633b8bf8954f56e5b1b84（与变异前逐字节一致）
```

**把六处 host 接线全部拆掉、候选永远进不了 message、功能完全死掉，测试仍 12/12 全绿。** 结论成立。

## 必修项

### P0-1 六出口接线零测试覆盖，变异判据被源码正则冒名满足

唯一的"六出口"测试是对 `dom.ts` **源码文本**做 `toContain` 正则匹配（`selector-ambiguous-candidates.test.ts:99-105`），不是行为验证。所以：逐出口删摘要拼接能转红（因为字面量没了），但拆掉全部接线、或把候选数组恒置空，都全绿。

全仓测试中 `enrichAmbiguousError` 出现 **0 次**；测试是在测试内部手工把探针输出喂给 builder，**生产代码本该完成的接线那一步，由测试自己代劳了**。

这正是方案 §判据 6 要堵的失效模式，被绕开了。本仓已归档同类教训：纯函数测试证明不了接线；源码 regex 匹配 = 假覆盖。

**改法**：至少一条测试让「page-side DTO → host builder → 最终 message」整条链走真代码——对六个 handler 分别 mock `chrome.scripting.executeScript` 返回多命中结果，断言抛出的 `VtxError.message` 含候选摘要；再对该断言做「拆接线」变异确认转红。

### P0-2 打红两条既有测试，且自述回归结果与实际不符

`packages/extension/tests/act-primitives-p0-batch1.test.ts:92-108` 两条 HOVER 用例转红。stash 对照：改动前 14/14 绿，改动后 2 failed。包内全量为 285 files / 2639 tests、2 红。

直接原因：那两条断言用固定窗口切源码（`DOM_SRC.slice(hoverIdx, hoverIdx + 3500)`），HOVER 出口新插入的约 14 行把被断言内容挤出窗口。既有测试写法本身脆（同一族源码文本断言的老账），但**本次改动是打红它的直接原因，必须一并处理**，不能留红。

`IMPL-luna.md:113-121` 自述"成功路径回归 8 passed / 49 passed"与实际不符。**自述所贴输出不作为验收证据。**

### P1-1 `AMBIGUOUS_PAGE_PROBES` 是仅供测试的平行实现，且与真实注入函数行为已不一致

`dom.ts:39-104` 定义、生产代码 **0 处引用**（构建产物已被 tree-shake）。测试用 `new Function` 跑的是这份副本，不是实际注入的那份。

两份已经不一致：探针版只有 `click` 有 `slice(0, 10)`，其余五个没有；真实六处出口**全部**有 `slice(0, 10)`。即：**候选数上限这条硬约束，在被测的那份里根本不存在**——测试通过恰恰说明它测的不是生产路径。

**改法**：删掉平行实现，把真实六处的 inline 注入函数抽成模块级常量，handler 与测试**共用同一份**，再用 `new Function` 剥离作用域跑。符合本仓既有结论「探测/门单一真源共享纯函数」。

### P1-2 trusted / realMouse 的 CLICK 路径未覆盖 —— **这是方案的盲区，责任在方案（我）**

`dom.ts:418-420` 在合成探针之前就早返回，走 CDP 路径（`adapter/cdp.ts:121` → `:200`），仍是老的无候选报错。

方案 §2 只列了六处 page-side 抛出点，没考虑 CDP/trusted 提前返回的分支。**实施方没做错，是方案没要求。** 但日志里的多命中失败有多少来自该路径需要确认——若占比可观，本次修复对真实使用的覆盖会大打折扣。

**处理**：实施方**先只做统计确认**（该路径是否产生 `SELECTOR_AMBIGUOUS`、日志样本里占比多少），把结论写进交付物；**不要**在本轮扩大范围去改 CDP 路径，是否纳入由编排方按数据决定。

### P1-3 `extras.candidates` 是永不渲染的副本，绕过 message 预算

候选已进 message；`extras` 除 `lastReason` 外不进回传文本（`dispatch-error.ts:13-32`，本轮新增的 `packages/mcp/tests/dispatch-error.test.ts:31-40` 也断言了）。于是 `extras.candidates`（10 条 × 最多约 500 字节 ≈ 4KB）跨 NM/hub/MCP 全程搬运却永不显示，且**不计入** `buildAmbiguousMessage` 的 4096 预算——方案 §5 建的总预算实际被绕过一半，错误响应体积约为预算两倍。

**改法**：host 侧组装完 message 后从 extras 删除 `candidates`，保留 `matchCount`。

### P2-1 正文预算算漏末尾计数，恢复指引可被截断

`candidate-suggest.ts` 循环内按 `Showing N; omitted M` 试算预算，break 后实际拼接用的是另一组数字，最终再 `clipToBytes` 兜底——预算逼近上限时，**最该保留的恢复指引（`suffix`）会被截掉**。

**改法**：把 `head + bodyPrefix + suffix + countText` 的固定开销先预留出来，body 只在剩余预算内增长，保证恢复指引恒不被截。

## 顺带

`candidate-suggest.ts` 的 `suffix` 两个分支一中一英（同形分支中文、非同形分支英文），同一条错误消息里语言不一致，请统一（该文件既有文案为英文）。

## 已确认做对的部分

- 六处真实抛出点确实都改为携带 `candidates`（`dom.ts:470/838/1158/1347/1735/2139`），接线本身是真的。
- 第六处保留了 `document.querySelectorAll` 的 light-DOM 语义，未被误统一成深度查询。
- 候选走 message 而非 extras 的判断落实正确。
- 长度约束的四项（字段 120 字符 / 单候选 480 字节 / 候选数 10 / 整条 4096 字节）均已定义并生效，属性按原 selector 出现过的属性取白名单。
- 保持 fail-closed：未自动挑第一个，未把多命中降为成功。
- 现场干净：代码审核方变异后已恢复，md5 与变异前逐字节一致。

---

# Dogfood 验证（2026-08-29，验收方在真实浏览器执行）

## 生效确认

真实 Chrome 上触发多命中，候选摘要**已生效**：

```
Error [SELECTOR_AMBIGUOUS]: Selector "div" matched 323 elements.
Matched candidates: #1 <div> name=".grecaptcha-badge { visibility: hidden; } #intercom-container > div..." visible;
#2 <div> name="gWgavin li's Workspace家媒体模板资料库设置更多..." visible; #3 <div> hidden; ...
Showing 10; omitted 313. Rewrite the selector with a distinguishing attribute or text, then retry vortex_act.
```

预算、候选数上限、省略计数、fail-closed 均按设计生效。**单测无法暴露、只有真实页面能暴露的问题见下。**

## D-1 `accessibleName` 取 `textContent`，对容器元素产出噪声（必修）

`#1` 的 name 是页面的 **CSS 样式文本**（`<style>` 子节点内容被 `textContent` 吞入）；`#2` 是整棵子树文本的拼接。这类摘要**无法用于改写 selector**，而那正是方案 §1 判据 2 的目标——摘要"存在"了，但不"可辨识"。

**改法**：`accessibleName` 只取真正的可访问名（`aria-label` / `title` / `alt` 一类），不再回退 `textContent`；文本归 `text` 字段，且必须跳过 `<style>` / `<script>` 子树，优先取元素自身的直接文本节点而非整棵子树拼接。

## D-2 `text` 字段永远不显示（必修）

`formatMatchedCandidate` 的条件是 `if (text && text !== name)`，而 `name` 本身取自 `textContent`，两者恒等 —— 该字段设计了却永远输出不了。修完 D-1 后两者来源分离，此条自然成立，但需**补断言锁住**。

## D-3 shared 包未构建，hint 改动在真实链路完全没生效（已由验收方修复）

返回的 hint 仍是旧文案。核实：`errors.hints.ts` 源码已改，但 `packages/shared/dist/errors.hints.js` 仍是旧内容。**vitest 跑 TS 源码所以单测全绿，真实运行时加载 dist** —— "陈旧 dist"型假绿，与本仓归档的 page-side dist 陷阱同族。

验收方已执行 `pnpm --filter @vortex-browser/shared build`，dist 已更新。MCP server 进程持有旧模块，需会话重启才加载。

**流程缺口**：改 shared 包后不 build，所有单测照常全绿。

## 新线索（与本轮改动无关，未深挖，留待后续）

- `div` 匹配 323 个，但 `div[class]` / `span` / `nav` / `a[href]` 全部零命中（走零命中路径，本轮未动）
- 数分钟后连 `div` 也零命中，URL 与 status 均未变，疑似 page-side 注入丢失后**静默返回空而非报错**

---

## 验收（第二轮，D-1/D-2 修复后）2026-08-29

验收方独立复跑，不采信实施方自述数字。

### 1. 变异验证：拆掉六处接线 → 7 条转红

```
perl -i -pe 's/enrichAmbiguousError\((r|probe|res), selector\)/$1/g' packages/extension/src/handlers/dom.ts
# 拆线后 enrichAmbiguousError 出现次数 = 1（仅函数定义）
Tests  7 failed | 4 passed (11)
Received: "Selector \".candidate\" matched 4 elements"
```

恢复后 md5 与拆线前一致（`b3c56f0304002672871ff9d911ddfff3`），无残留污染。这条性质在 D-1/D-2 修复后仍然成立。

### 2. 六份 page-side 采集块一致性（机器比对，非目测）

正则抽出六个 `SELECTOR_AMBIGUOUS` 出口的 DTO 采集块，剥空白后取哈希：#1–#5 完全同哈希；#6 只差两处，均为预期差异——`Array.from(els)`（`document.querySelectorAll` 返回 NodeList）与对象字面量字段顺序。**COMMIT 出口的 light-DOM 查询语义按 REVIEW-codex §1.1 要求被保住，没有被误统一成深度查询。**

### 3. 全量回归（验收方自跑）

| 包 | 结果 |
|----|------|
| extension | 285 files / 2638 tests passed（173s） |
| shared | 12 files / 339 tests passed |
| mcp | 75 files / 770 tests passed |

### 4. 补回被漏掉的评审要求项

REVIEW-codex §3.2 要求断言"属性值清洗"，实施方最后一轮把测试从 12 条收到 11 条时把它漏掉了。验收方补 `属性名和属性值都被清洗与截断，不把控制字符带进正文`，并做变异验证：把 `formatMatchedCandidate` 的 `clipSummaryText(value)` 改回 `value` → 该条转红（`Tests 1 failed | 11 passed`），确认不是空断言。

### 5. 真实浏览器复测（Chrome，gamma.app，扩展已 dev_reload 到 `4.0.0+mtdln7w2`）

**D-1 已修**（`<style>` / `<script>` 内容不再进正文，`name=` 只取 aria-label/title/alt）：

```
Error [SELECTOR_AMBIGUOUS]: Selector "button" matched 121 elements.
Matched candidates: #1 <button> name="家" visible; #2 <button> name="打开页面面板" visible;
#3 <button> text="主题" visible; #4 <button> text="分享" visible;
#5 <button> name="用 AI 编辑所有幻灯片" text="Agent" visible; ...
Showing 10; omitted 111. Rewrite the selector with a distinguishing attribute or text, then retry vortex_act.
```

对照修复前同一页面的输出（`name=".grecaptcha-badge { visibility: hidden; } #intercom-container > div..."`），CSS 文本已消失。

**D-2 已修**：`text=` 字段真实出现（#3/#4/#5），修复前 `text && text !== name` 恒 false 从不渲染。

**属性白名单按原 selector 生效**：`div[class]` 的候选带上 `class="chakra-stack css-mopakl"`，`button`（不含 `.`/`#`/`[`）则不带任何属性。

### 6. 遗留观察（不阻塞验收，登记为线索）

1. **无直接文本的嵌套包裹层摘要趋同**：`text` 取值是 `直接文本节点 || 整棵子树文本`。`div` 匹配 536 个时，前 5 个是层层包裹的祖先 div，子树文本相同、截断到 120 字后完全一样，只能靠没有的属性区分。这是 `div` 这种退化 selector 的固有问题，且回退到子树文本是评审明确要求（否则深层嵌套文本容器什么都显示不出来），本轮不改；但它意味着"候选可区分"在包裹层场景下不成立，正文的 fail-closed 措辞此时不会触发（因为第 6 个候选起就不同形了）。
2. **图标按钮仍无标识**：`#8 <button> visible` —— 标签在 `<svg>` 里，`descendantText` 取不到。非本轮引入。
3. **扩展 reload 后首次调用的错误自陈不诚实**：dev_reload 后立刻 `act div` 依次得到 `PAGE_NOT_READY` → `EXTENSION_NOT_CONNECTED` → `NOT_ATTACHED: target "div" matched no element`。第三条是假的——页面上有 536 个 div，真实原因是 page-side resolver 尚未注入完成。这与本流水线要治的是同一类病（把内部未就绪说成"页面上没有"），登记为下一轮候选。
4. **binding 漂移复现**：dev_reload 期间 `vortex_browser()` 报 current=Chrome，而 `vortex_tab_list` 的 `browserLabel` 是 Microsoft Edge；数秒后 Chrome 重连即回正。按既定纪律先核 `browserLabel` 才没误报成缺陷。
5. **dom.ts 改动量远超计划 §5**：`git diff -w` 为 +1062 / -873。原因是把六个 page-side 注入函数从内联提到模块级常量（`DOM_*_PAGE_FUNC`）——这是验收方在 CODE-REVIEW 轮要求"测试必须驱动真实注入函数"的直接后果，不是实施方擅自扩大范围。风险是移动过的函数体内若有行为漂移，diff 里看不出来；已用逐行筛查确认非候选相关的增删全部是花括号/缩进位移与整段搬迁的同名行，且 285 files 全量回归覆盖这些 handler。

### 结论

**通过。** D-1、D-2 在真实浏览器上确认修复，评审漏项已补齐并做过变异验证，三包全量回归自跑通过，六处接线的真实链路性质保持。剩余 5 条为登记线索，不阻塞。
