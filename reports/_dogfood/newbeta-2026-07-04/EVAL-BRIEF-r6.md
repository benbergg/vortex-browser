# M3 评估简报 — newbeta.bytenew dogfood（r6）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot(本轮核心练功点)、禁改代码、禁提交、禁 evaluate 完成交互**(evaluate 仅读 DOM 真值证据)。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站(已登录态)

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255` → observe 左侧点「退款管理大脑看板」卡切换(或找它的 boardNew 入口)。另可试「VOC工作表看板」「啾啾测试看板」。

## 本轮场景(r6):看板「图文卡片」非截图识别 —— 练不截图读视觉内容的功力

**主考 vortex 能力**:退款管理大脑看板有 4 张「图文卡片」(IMG 图片 + 文字)。**不用截图**,能否用 `vortex_extract` / `vortex_query` 读出每张卡片的语义(标题、图内数据、图片含义)?这正是"遇到截图先反思能不能不截图"的练功场。

### 步骤(每看板新 tab,≤30 次工具调用)

1. 打开退款管理大脑看板 → `vortex_extract`(默认 + `includeAlt:true`):能否拿到 4 张卡片的标题文字(如"今年十一对比去年618")?
2. **图片语义**:卡片主体是 `<img>`。`vortex_extract {includeAlt:true}` 是否读出 img 的 alt 文本?若 img 无 alt(纯视觉图表截图),`vortex_query mode=css pattern="img" attr="src"` / `attr="alt"` 看有无可读语义;`vortex_query mode=text` grep 卡片内数字/标签。
3. **几何/结构**:`vortex_query mode=geometry` 看 4 卡片布局;`observe` 看卡片是否作为可交互元素召回(点卡片能否下钻)。
4. **关键反思**:哪些卡片内容**能**非截图读出(alt/文字/数字),哪些**只能**靠截图(纯图片无 alt 无文字)?后者就是 **blindspot**——记 `[blindspot]`,写明"这张卡片是纯视觉图片、无 alt、query/extract 都读不到语义,现有工具须截图才能识别",填 tried_alternatives(extract/query 各 mode 的返回)。
5. **对照 VOC/啾啾空看板**:确认空看板 observe/extract 是否给出"空看板"信号(而非静默空)。

## 产出(写到 `reports/_dogfood/newbeta-2026-07-04/`)

1. `eval-observations-r6.md`(每卡片记:extract 拿到什么文字/alt、query 拿到什么、能否非截图识别、是否 blindspot)
2. `anomalies-r6.json`(schema,cycle=`dogfood-newbeta-2026-07-04`;blindspot 类 phenomenon 以 `[blindspot]` 开头)

## 完成标志

双产物写完;4 张图文卡片逐张试非视觉识别;明确区分"能非截图读"vs"blindspot 须截图";blindspot 带 tried_alternatives;报告:几张卡能非截图识别、几张是 blindspot、现有工具对图文卡片的识别边界。
