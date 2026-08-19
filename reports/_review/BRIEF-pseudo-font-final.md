# 终审：第二轮意见已修 + 新增布局能力

分支 `feat/query-pseudo-font`，现 5 个 commit。上轮报告 `luna-pseudo-font-recheck.md`。

## 逐条处置（`6fa7010`）

| 你报的 | 处置 |
|--------|------|
| High 指纹碰撞（两个 `<button>` 文本都 4 字 → `BUTTON||4`） | **采纳**。改用**树中路径**（`nodeName:位置` 逐级上溯，穿 shadow 经 host），对同一棵树唯一、重排必变。fixture 扩到碰撞/shadow/嵌套/空文本/多元素逐项 |
| Medium 三处一致性 fixture 太弱 | **采纳**，见上。真源函数 / CDP 表达式 / 探针内联三处在 5 组 fixture 上逐项对拍 |
| Medium 深度截断静默丢规则 | **采纳**，`depth > 5` 时置 `partial = true` |
| Medium `walk` 用「有 cssRules」当判据 + 无异常隔离 | **部分采纳**。加了 grouping 白名单，但**变异验证证明它行为等价**（异常真正由每条规则的 try/catch 兜住），所以注释写明它是性能项不是防线。异常隔离**采纳**：单规则失败标 partial 并继续，同表后续规则照收 |
| Medium release 无 deadline 可能挂死 | **采纳**，并发 + 1s deadline，补「releaseObject 永不 settle」的 fake timer 测试 |

## 新增（`aafa164`，用户批准的新范围）

`box` 组补 flex/grid 七个属性。过去只给 `display`，「这排是 flex 还是 grid、gap 多少、
怎么对齐」拿不到。**按初始值裁剪而不是看 display**：非容器上这些全是初始值，一条不出现；
多列布局在 `display:block` 上真设过的 `gap` 仍保留。

## 请终审

1. 路径身份是否还有漏的场景？特别是：`parts.length < 24` 截断（超深 DOM 两个元素的路径
   前 24 段相同怎么办）、`p.host` 穿 shadow 是否覆盖 closed shadow 与 iframe 边界。
2. 新增的布局裁剪：`LAYOUT_INITIALS` 表是否漏了初始值的其他合法表示（如 `gap` 的
   `0px` vs `normal`、`justify-content` 的 `flex-start` 是否该算初始值）？裁掉真实设置
   的值会是静默丢信息。
3. 三轮下来我改了很多，**有没有哪一处修复引入了新问题**，或哪条早先通过的判据被后续改动
   破坏了（回归）。
4. 还有没有「把没看说成看过了」的路径。

全量：extension 2434，mcp 757+2；`pnpm build` 过；真站（知乎）复验字体与布局路径正常。
变异验证累计 30+ 条，其中 5 条曾是死条件（已补测试或降级为非防线）。

报告写 `reports/_review/luna-pseudo-font-final.md`。带 `file:line`，禁类比推理。
