# 审核任务：伪元素 + 字体真相的实现（路线丁）

你上一轮的辩论结论被采纳了（`reports/_review/luna-pseudo-font-debate.md`，路线丁 CDP
`CSS.getPlatformFontsForNode`）。现在审实现。

## 读什么

- `git show 80be083 --stat`，然后 `git diff main...HEAD`（分支 `feat/query-pseudo-font`）
- `docs/style-pseudo-font-approach.md` —— §7 已回填实施后的实测结果与三个自查出的缺陷
- 新增源码：`packages/extension/src/lib/{style-evidence,platform-fonts,deep-query-expr}.ts`
- 新增测试：`packages/extension/tests/{style-evidence,platform-fonts,deep-query-expr,query-style-pseudo-font}.test.ts`
- 改动：`query.ts`（探针 + `finalizeStyleResult`）、`background.ts`、`cdp-domains.ts`、
  `tests/helpers/fake-debugger.ts`、`schemas-public.ts`

## 我已经做过的，别重复报

- 每个判据都跑了变异验证，共 20+ 条变异，全部转红。过程中抓到并修掉 3 条**死条件**
  （删掉仍全绿的分支）：`hasImage`、长度 `>0`、下标过滤（靠补 `__proto__` 假数据才锁住）
- 真站验收（gamma.app / 知乎 / 构造 FA 图标），抓到并修掉 3 个真缺陷：
  `rendered:[]` 误报 `firstChoiceInUse:false`、`-apple-system` 硬比名字、
  @font-face 原样返回 81KB
- 全量：extension 2397 测试、mcp 755 测试、shared 全绿；`pnpm build` 过

## 重点看这些

1. **降级的诚实性。** 有没有哪条路径会把「没看」输出成「看过了」？特别是
   `finalizeStyleResult` 里 fonts 为 `{reason}` / 单元素 `null` / `wantFont=false`
   三种情况的分支，以及 `buildFontEvidence` 的 `firstChoiceInUse` 三态。
2. **对齐是否真的 fail-closed。** `deepQuerySelectorAllExpr` 与探针 `queryAllDeep`
   是两份代码（一份注入、一份表达式字符串），靠行为对拍测试 + 运行时数量校验。
   有没有两者不一致但数量恰好相同的场景？那会静默错位。
3. **探针改动的自包含性。** `collectFontFaces` 与 pseudo 读取都在注入函数体内，
   有没有引用到模块作用域的标识符（注入后会 `X is not defined`）？
   既有测试 `注入自包含:剥离模块作用域后仍可运行` 是否真能覆盖新增部分。
4. **CDP 代价。** 缺省六组全开意味着不传 `attr` 的 style 查询会 attach debugger。
   这个默认值对不对？`attr` 显式不含 font 时确实一次 CDP 都不发吗（看 handler 实参）？
5. **字节与契约。** `attr` description 加了组名，I15 仍在 11100 cap 内。
   新返回字段（`pseudo` / `font` / `fontFaces` / `fontFamiliesTotal` / `fontFacesTruncated`）
   的语义有没有在哪里说清？调用方能不能从返回本身分辨证据等级？
6. **注释规范。** 中文、方法体内单行 `//`、每条 ≤60 字、同一方法体 ≤3 条、不复述代码。

## 纪律

- 每条结论带 `file:line` 或可复现命令；禁止类比推理
- 查过没问题的明写「查过，无问题」+ 依据
- 报告写 `reports/_review/luna-pseudo-font-impl-review.md`，别贴回对话
- 要用 vortex 先 `vortex_tab_list` 核浏览器（当前绑定已漂到 Google Chrome），用完别切
