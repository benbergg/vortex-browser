# M3 评估简报 — Element Plus 官网 dogfood

> 你(MiniMax-M3)是本轮评估的**执行者+记录者**。你的唯一职责是用 vortex MCP 工具操作 Element Plus 官网组件演示页,**如实记录"我做了什么 / 工具返回了什么 / 看到了什么"+ 证据**。

## 铁律(必须遵守)

1. **只记观察,不做根因诊断**。禁止写"这是因为 buildSelector 没有守卫""根因是 xxx 代码"之类推断。你不读 vortex 源码,不猜实现。只写**现象 + 证据**。根因判定由 Opus 负责。
2. **每条异常都要带证据**:工具调用的原始返回值(截断到关键字段)、`vortex_screenshot` 截图、`vortex_evaluate` 读到的 DOM 真值。没有证据的异常不要写。
3. **区分"工具缺陷"与"我操作失误"**:同一操作至少试 2 种合理方式(如 act 文本失败就试 observe 拿 ref 再 act),都失败才记为异常。把两种尝试都写进证据。
4. **不修改任何代码,不提交 git**。你只产出报告文件。

## 🔴 本轮防缓存漂移协议(R2 重跑必须遵守)

上轮(单 tab 内 28 次 `vortex_navigate` 连续切页)疑似触发 **page-side loader 缓存跨导航漂移**,污染了观察。本轮硬性要求:

1. **每个组件页用全新 tab**:用 `vortex_tab_create({url, active:true})` 打开该组件页 → 在该 tab 内完成评估 → `vortex_tab_close` 关掉。**不要**在同一 tab 内 `vortex_navigate` 切到下一个组件页。
2. **每个 tab 的工具调用控制在 ~30 次内**;一页评估完就关 tab、开新 tab 评估下一页。
3. **撞到异常时立刻在全新 tab 里复测一遍**:`vortex_tab_create` 重开同一页 URL → 重复最小操作序列。若新 tab 里不再出现 → 标注「仅旧 tab 出现,新 tab 不复现」;若新 tab 里仍出现 → 标注「新 tab 仍复现」。这一对照是本轮的核心证据。

## 🎯 本轮重点(R2 复验目标)

上轮 Opus 清洁复现已证伪 2 条 anomaly,本轮专门在「无缓存漂移」条件下复核它们是否真不出现:
- **A1**:`select.html`「筛选选项 / Filterable」demo —— `vortex_act action=type` 与 `vortex_fill` 写入筛选框,读 `.el-select__input.value` 是否生效、下拉是否过滤。
- **A2**:`select-v2.html` 基础 demo(1000 项虚拟列表)—— 滚到底后 observe 拿远处/最后一项的 ref,`vortex_act click` 它,读 placeholder 是否变更。

**务必优先、且每项都按上面「撞到异常立刻新 tab 复测」协议做对照。** 其余组件(C3-C16)有余力再覆盖,同样每页新 tab。

## 目标站

Element Plus 官方组件演示站(中文):`https://element-plus.org/zh-CN/component/<组件>.html`

## 工具(仅用 vortex MCP)

`vortex_navigate` / `vortex_observe`(filter=interactive 优先) / `vortex_act` / `vortex_fill` / `vortex_press` / `vortex_evaluate`(读 DOM 真值) / `vortex_screenshot` / `vortex_extract` / `vortex_wait_for`

## 评估范围(逐个组件,重点是表单/浮层/选择类)

按下表逐页评估。每页:先 `vortex_observe` 看 vortex 是否识别出该组件的交互元素,再尝试该组件的核心交互,记录结果。

| # | 组件页 | 核心交互(逐个试) |
|---|--------|------------------|
| C1 | select.html | 单选下拉:打开→选项;多选;可搜索筛选 |
| C2 | select-v2.html | 虚拟列表下拉:打开→滚动→选远处选项 |
| C3 | cascader.html | 级联选择:逐级展开→选叶子 |
| C4 | slider.html | 滑块:键盘方向键调值;范围滑块 |
| C5 | date-picker.html | 日期选择:打开面板→选日期;日期范围 |
| C6 | time-picker.html | 时间选择:打开→选时分秒 |
| C7 | input-number.html | 数字输入:fill 数值;步进按钮 |
| C8 | dialog.html | 对话框:点按钮打开→操作内部→关闭 |
| C9 | drawer.html | 抽屉:打开→内部交互→标准关闭按钮 |
| C10 | popover.html / popconfirm.html | 浮层:触发→点浮层内按钮 |
| C11 | tree.html / tree-select.html | 树:展开节点→勾选 |
| C12 | upload.html | 文件上传:观察 file input 是否被识别 |
| C13 | transfer.html | 穿梭框:选项→移动按钮 |
| C14 | autocomplete.html | 自动补全:输入→选建议项 |
| C15 | form.html | 表单:多字段 fill→提交→读校验态 |
| C16 | table.html | 表格:排序/筛选/选择行 |

(时间/篇幅有限可优先 C1-C11、C15;C12-C14、C16 行有余力再做)

## 输出格式

写到 `reports/dogfood-element-plus-2026-06-13/eval-observations-r2.md`(R2 重跑,勿覆盖 R1),结构如下:

```markdown
# Element Plus 评估观察 (M3)

日期: 2026-06-13 | 站点: element-plus.org | 工具: vortex MCP

## 观察记录

### C1 select.html
- **O-1** [正常] observe 识别出 el-select 触发器(ref=@xx),act 打开成功,选"选项2"成功,evaluate 读 .el-select__placeholder→"选项2"。证据:...
- **O-2** [异常] 多选模式 act 选第二项后...(现象)。证据:返回值 / 截图 / evaluate 真值。
...

## 异常汇总(Anomaly)
| ID | 组件 | 现象一句话 | 严重度(我的主观感受) | 证据位置 |
|----|------|-----------|---------------------|---------|
| A1 | select 多选 | ... | 疑似阻断 | O-2 |
```

- 每条观察标 `[正常]` 或 `[异常]`。
- 异常汇总表只放 `[异常]`,严重度是你的**主观感受**(疑似阻断/体验问题/存疑),不是判定。
- 报告结尾不要写"修复建议""根因",那是 Opus 的活。

## 完成标志

eval-observations.md 写完,异常汇总表非空(若真没异常,明确写"未发现异常"并说明你试了哪些)。
