# 辩论任务：伪元素 + 字体真相，选出最优方案

你是对抗方。目标**不是**复核我的选择是否自洽，而是**尽力推翻它**，并在推翻不了时明确说服自己。

## 读什么

1. `docs/style-pseudo-font-approach.md` —— 完整思路文档（含 0.5 段约束分类、三条候选路线、已选定的丙及其理由）
2. `packages/extension/src/handlers/query.ts:759`（`styleProbeFunc`）、`:908`（`want`/`pick`）、`:1946`（style 分支）、`:1951`（`ALL_GROUPS`）—— 要改的地方
3. `packages/extension/src/handlers/query.ts:122-199` —— `tokensProbeFunc`，同类探针的既有写法（自包含约束、分组截断、`roots` 自陈）
4. `docs/style-investigation-approach.md` —— 上一轮（v3.0.0）的同类工作，`contrastStatus` 五态是本次「不自陈即缺陷」标准的来源

## 已实测的地面事实（gamma.app，别再假设，也别推翻，除非你能给出反证）

- `getComputedStyle(el, '::before')` 可读；`content: "none"` 即不渲染。全页 1194 元素 → **25** 个渲染中伪元素（约 2%）
- `document.fonts.check('16px NoSuchFontXYZ')` 返回 **`true`** —— 这条检查完全不可用
- `document.fonts` 有 **95** 个 FontFace，同 family 分 weight 带不同状态（`ESBuild: loaded/400, unloaded/400, loaded/500`）
- CSSOM `CSSFontFaceRule` 可读 **16** 条，含真实 URL（`ESBuild → /fonts/ESBuild/ESBuild-Regular.woff2`）
- 哨兵测量带反向对照：`monospace`=500.91；`NoSuchFontXYZ, monospace`=**500.91**（相同→确认回落）；`ESBuild, monospace`=462.85；`PPMori, monospace`=508.48
- `tools/list` 实测 11280 B / cap 11400，**余量仅 120 B**

## 必须回答（逐条，别合并）

1. **丙错在哪。** 给出至少一个具体失效场景：什么站、什么 CSS 形态下，丙会给出**错误的肯定或错误的否定**（不是「不够好」，是答错）。带机制，不带「可能」。
2. **有没有第四条路线？** 尤其：有没有办法拿到「这个元素实际用哪个 family 渲染」而不插节点、不靠推断？（想过 CDP 没有？`chrome.debugger` 域里有没有相关能力？该仓库已重度使用 CDP —— 若有，这会直接淘汰甲乙丙全部）
3. **测量法的哨兵设计。** 我打算用「声明栈 + monospace 哨兵」对比「纯 monospace」。这个设计在什么情况下会误判？测试字串该用什么？多字串是否必要？元素自身的 `font-size`/`letter-spacing`/`font-weight`/`font-stretch` 要不要一并复制到探测 span 上——不复制会不会导致「元素实际 fallback 了但探测说生效」？
4. **降级判据。** 丙在插节点失败时回落 FontFace 状态。这个「失败」怎么判？CSP 会不会让插节点静默成功但布局为零（→ 宽度相等 → 误报「未生效」）？这是不是比不做还糟？
5. **伪元素部分。** 我只按 `content !== none` 过滤。漏了什么？`display:none` 的伪元素、`content: ""`（空串但有 background-image 的图标块）、`::marker`/`::placeholder`/`::selection` 要不要收？25/1194 这个稀疏度在什么类型的站上会崩（比如图标全走 `::before` 的 Font Awesome 站）？
6. **字节预算。** 余量 120 B 而要加两个组名。丙相比甲/乙在 schema 文本上多花多少？这构成选丙的反对理由吗？
7. **你的推荐。** 明确一条，并写清「若我错了，代价是什么」。

## 纪律

- 每条结论要么带 `file:line`，要么带可复现的实测命令/数值。**禁止类比推理**（「别处也这么做」「业界惯例」不算理由）
- 你有 vortex MCP，可以在真站上实测；gamma.app 已在标签页里。**但注意：vortex 浏览器绑定是全局单值，我这边也在用——你要用先 `vortex_tab_list` 核一下，用完别切绑定。**
- 查过但没问题的项，明写「查过，无问题」+ 依据，不要沉默
- 报告写入 `reports/_review/luna-pseudo-font-debate.md`，正文别贴回对话
