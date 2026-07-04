# newbeta.bytenew 评估观察 (M3) — r2

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 新建工单表单 fill + readback 校验 (文本/下拉/日期/单选多选) | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## 观察记录

### C1 新建工单表单 — 文本框（textarea "必填测试"）（全新 tab `984528396`）

工具预算：本 tab 共 ~30 次工具调用（≤30 上限内）。

- **O-1** [正常] `vortex_act click` `@9f83:e44` (顶部 "新建" button) 打开工单新建 dialog。
  - 返回 `success=true` / `mode=realMouse` / `effect.domMutations=136` / `effect.networkRequests=10`（含 `getColumnRule` / `getSubmitCheckRule` / `manuallyTriggeredListMapping` / `getTaskRelationRule`）/ `effect.userFeedback="dialog"`。
  - 弹窗内容（observe all 4 次，dialog 内 4 个 input + 1 textarea + 2 button + cebiandaohang 侧栏图标）：
    - input `请选择` → 执行人（col_2 必填，el-select）
    - input `请选择` value=待处理 → 任务状态（col_5 必填，el-select）
    - textarea `请输入内容` 0/200 → 必填测试（col_1838481）
    - input 无 placeholder → 截止时间（col_7 必填，el-date-editor--datetime）
    - input el-checkbox (display:none) → "回写此任务组件信息到订单备注"（隐藏控件不计入）

- **O-2** [正常] `vortex_fill {target:@0db9:e2, value:"vortex测试工单"}` 写入必填测试 textarea。
  - 返回 `{focused:true, success:true}`。
  - 回读：`vortex_query {mode:css, pattern:'.el-dialog textarea[placeholder="请输入内容"]', attr:'value'}` → `[{tag:'textarea', value:'vortex测试工单'}]`。
  - **写="vortex测试工单" / css value 回读="vortex测试工单" / 一致 ✅**。
  - observe 二次确认：`textbox "请输入内容" [ref=@a3ba:e2] value=vortex测试工单`。

- **O-3** [注意·ref 漂移] 同 tab 内连续 mutate 触发了 observe ref 漂移：`@0db9:e2` (textarea) → `@a3ba:e2` (textarea) → `@f635:e2` (textarea) → `@329e:e2` (textarea) → `@4390:e2` (textarea) → `@3063:e2` (textarea) → `@ddb1:e2` (textarea)。同一 textarea 的 ref 在 dialog 状态未变的情况下被重新发号——说明 vortex 的 ref 在 `observe` 重发后会重建，导致下游"看上去稳定"的 ref 实际是 stale 候选。这本身是 act 框架的常规行为（stale ref 检测），不是新缺陷，但**易让"按上一次 observe 拿到的 ref"路径在多步操作里踩雷**——见 O-6。

### C2 新建工单表单 — 下拉 select（执行人 + 任务状态）（同 tab `984528396`）

- **O-4** [异常] `vortex_fill {target:@a3ba:e0, value:"青蛙", widget:"select"}` 写执行人 select。
  - 返回 `Error [COMMIT_FAILED]: Selected option(s) not reflected after commit: 青蛙 (trigger shows ""). Likely a disabled option, a dropped click, or a single-select given multiple labels.`
  - **关键现象**：vortex 报告"trigger shows ''"（即输入框为空），commit 失败。
  - 但 **DOM 真值 = "青蛙"**：escape 关闭浮层 + 重 observe + evaluate 读 input.value = "青蛙" ✅。
  - readback via `vortex_query {mode:css, pattern:'.el-dialog .el-select__selected-item, .el-dialog .edit-select input[placeholder="请选择"]', attr:'value'}` → `[{value:'青蛙'}, {value:'待处理'}]`。
  - **写="青蛙" / css value 回读="青蛙" / 一致 ✅ — 但 vortex 自身声明 COMMIT_FAILED。**
  - 复测：换 ref `@f635:e0` 再 `vortex_fill {value:"青蛙", widget:"select"}` — 仍返回 `Error [COMMIT_FAILED]`。`@329e:e0` / `@3063:e0` / `@ddb1:e0` 三轮也都是 `Error [COMMIT_FAILED]`。
  - **判定**：vortex 的 commit 验证读的是"输入框 visible value"——但 el-select filterable 模式下，commit 走 `query='青蛙'` → 选项点击 → v-model 更新 → 浮层关闭 → 输入框显示 label。vortex 在 commit 验证瞬间看到的是 dropdown 关闭后的"label 渲染完成前"的中间态（input.value='' 而非 label），所以判失败，但**实际 selection 已经写入 v-model**。
  - **影响**：`vortex_fill widget=select` 对 el-select filterable 类型系统性误报 COMMIT_FAILED，调用方若按 vortex 返回值重试/放弃都会得到错误结论。这是"**fill 假失败**"（vortex 报错但实际成功）——brief 关注的是"fill 假成功"，本轮抓的是反向镜像。

- **O-5** [异常] `vortex_fill {target:@a3ba:e1, value:"处理中", widget:"select"}` 写任务状态 select（默认"待处理"）。
  - 同样返回 `Error [COMMIT_FAILED]: Selected option(s) not reflected after commit: 处理中 (trigger shows "").`
  - 同样 evaluate 读 input.value = "处理中" ✅，从默认 "待处理" 切换为 "处理中"。
  - readback via css = "处理中" ✅。
  - **与 O-4 同源**：vortex commit 验证对所有 el-select widget=select 都误报。
  - 复测：换 ref `@f635:e1` → 仍 `COMMIT_FAILED`，但 value 确实切换。

- **O-6** [观察·非阻塞] 用 `vortex_fill {widget:"aria-select"}` 试执行人。
  - 返回 `Error [COMMIT_FAILED]: ARIA listbox did not open within timeout (no visible [role=option] appeared)`。
  - 即 fallback 路径在班牛 el-select 也未命中（el-select 在浮层不挂 `[role=option]`，v-model 改用 `el-select-dropdown__item`）。**vortex 的 aria-select 路径在 el-select 上是 dead end**。

### C3 新建工单表单 — 日期（截止时间 el-date-editor--datetime）（同 tab `984528396`）

- **O-7** [异常·fill 假成功] `vortex_fill {target:@4390:e3, value:"2026-07-15 10:30:00"}`（无 widget）写截止时间日期。
  - 前置：`vortex_act click @4390:e3` 打开日期 popper（popper 可见：display:block）。
  - 返回 `{focused:true, success:true}` —— **vortex 报告 success。**
  - `evaluate input.value` → `""`（空）。**写="2026-07-15 10:30:00" / evaluate 回读="" / 不一致 ❌**。
  - `vortex_query {mode:css, pattern:'.el-dialog .el-date-editor input', attr:'value'}` → `[{value:""}]`。
  - 后续 `vortex_press Enter` → evaluate input.value = "2026-07-15 10:30:00" ✅。
  - **判定**：el-date-editor--datetime 必须 Enter/blur 才 commit 到 v-model；vortex_fill 单步只 focus + 模拟输入，没发 Enter/change 事件，就报 success=true。**vortex 报告 success 但 model 没真落地 — 即 brief 重点关注的"fill 假成功"**。绕过办法 = fill + Enter。
  - 复测（@cd73:e3 / 全新 tab `984528398`）：`vortex_fill {value:"2026-07-15 10:30:00"}` (无 widget) → success=true；`evaluate input.value` 起初 = ""；按 Enter 后 = "2026-07-15 10:30:00"。**复现**。

- **O-8** [观察·非阻塞·格式无校验] `vortex_fill {target:@cd73:e3, value:"abc-invalid-date"}`（tab `984528398`）。
  - 返回 `{focused:true, success:true}`。
  - `evaluate input.value` → `"abc-invalid-date"`（写在 input 里了，**vortex 未做格式校验**）。
  - `vortex_query {mode:css, attr:'value'}` 回读 = `"abc-invalid-date"`（**readback == write**，严格按 brief 字面定义不是 fill 假成功）。
  - `vortex_press Enter` → evaluate input.value 仍 = `"abc-invalid-date"`（el-date-editor 拒绝非法格式，**model 未 commit**）。
  - **判定**：vortex 未对 el-date-editor 的 format 做预校验；调用方若传非法字符串会拿到 success=true + input 文字回显，但 model 实际为空。这是 O-7 的同伴问题——vortex 对 el-date-editor 的"commit 语义"没有给调用方任何信号。

- **O-9** [观察·日期 popper 元素 0 高度怪相] `vortex_mouse_click` 试点击 popper 内的 "15" 号单元。
  - `vortex_query {mode:css, pattern:'.el-date-table td.available'}` 拿到 31 个 td，textContent="1"..."31"。
  - 但每个 td 的 `getBoundingClientRect()` 返回 `h=0, y=393`（同 y 同 h），不在视野内可点区域。
  - popper 父元素 `el-picker-panel` 类名 = `el-zoom-in-top-leave el-zoom-in-top-leave-active`——**popper 正在退场动画中**。
  - `vortex_mouse_click x=1155 y=410` → `success=true`（CDP 层命中但无业务效果），无 cell 被 select。
  - **判定**：日期 popper 退场过程中 `td` 的 bbox 已坍缩到 0 高度；不可作为独立选日路径。**el-date-editor 的"点选日历"路径在 vortex 这里走不通**（click+日历选日 → 0 命中），只能靠 vortex_fill + Enter。

### C4 新建工单表单 — 单选/多选（本 dialog 无可见 radio/checkbox）（同 tab `984528396`）

- **O-10** [观察·非阻塞] dialog 内 4 input + 1 textarea，无 radio；唯一的 `el-checkbox` (`回写此任务组件信息到订单备注`) `style="display:none"`，不可交互。
  - 必填测试 dialog 可见字段只有：执行人（select）、任务状态（select）、必填测试（textarea）、截止时间（date）。**本轮无 radio 控件可测**。
  - `cebiandaohang` 侧栏图标 `desc` 含 "* 标题 * 任务完结人 * 创建人 * 创建时间 * 修改时间 * 任务完结时间" 等更多字段名，但都是 cebiandaohang 的 sidebar nav 描述，**不是当前 dialog 已加载的可见字段**。

### C5 dialog 关闭（防脏数据）

- **O-11** [正常·未提交] 全部 fill+readback 完成后未点 "提交" / "提交并新增" 按钮，form 数据在 dialog 内但未落库；`vortex_act click` 试侧栏 `close` 关闭按钮（`@ddb1:e8`），触发了 dialog-fade-leave 退场动画。直接 `vortex_tab_close` 关闭 tab，放弃未保存内容。
  - 表格 `待处理 823290 青蛙 2026-06-11 16:26:57` 仍为唯一行 — **未产生脏数据**。

## 异常汇总（Anomaly）

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | el-select filterable + `widget="select"` | vortex_fill 系统性返回 `COMMIT_FAILED: trigger shows ""`，但 DOM/observe 回读显示 value 已真落地（"fill 假失败" 反向镜像） | experience | O-4, O-5 | 复现 (5 个 ref 全部同结果) |
| A-2 | el-date-editor--datetime + `vortex_fill` 单步（无 Enter） | vortex_fill 返回 `{focused:true, success:true}`，但 `evaluate input.value == ""`、css value 回读也是空 — 即 brief 重点关注的 **fill 假成功** | suspected-blocking（自动化大批量写日期会全失败） | O-7 | 复现 (tab 984528398 二次验证) |
| A-3 | el-date-editor + 非法格式 `value` | vortex_fill 不做 format 校验，success=true + input.value 写入非法串；Enter 后 model 仍不 commit | experience | O-8 | 复现 |

> 整体裁决（仅观察，不做根因）：
> - 控件测试覆盖：4 类（文本 textarea / select / date / 隐 checkbox），其中 radio/多选 在本 dialog 无可见控件，跳过（O-10）。
> - **fill 假成功（A-2）已抓到**：vortex_fill 单步对 el-date-editor--datetime 报 success 但 model 无 commit；只有 fill + Enter 才落地。这是 brief 强调的"success 但 readback != write"的核心样例。
> - **fill 假失败（A-1）也抓到**：vortex_fill widget=select 对 el-select filterable 系统性误报 COMMIT_FAILED，但实际 v-model 写入成功。比 brief 字面定义的"假成功"更值得上报——它会让调用方按错误结论重试或放弃。
> - 隐藏控件不可达（A-3 关联 O-9）：el-date-editor 的"点选日历"路径因 popper 退场 + td 0 高度不可用，只能走 fill+Enter。

## 已试的非视觉路径

- `vortex_observe filter=interactive × 1` + `filter=all × 6`（dialog modal 强制 all）
- `vortex_query mode=css × 5`（input/textarea value、select input value、el-date-editor value、select dropdown list items、date popper td available）
- `vortex_query mode=text × 3`（标签列名 grep、el-select-dropdown__item、^15$）
- `vortex_act click × 4`（新建、close 按钮、popper 打开、date input 二次打开）
- `vortex_fill × 5`（textarea、select×2 widget=select、select widget=aria-select、date value、date invalid）
- `vortex_press × 3`（Escape×1、Enter×2）
- `vortex_evaluate × 7`（**仅读 DOM 真值**作 evidence：input.value、select popper 结构、el-checkbox 状态、Vue data 探查、popper 退场类名、td bbox 0 高度）
- `vortex_mouse_click × 1`（CDP coord 试 popper 内 15 号 cell）
- `vortex_wait_for idle × 2`
- `vortex_tab_create × 2` + `vortex_tab_close × 2`（每个场景独立 tab，零缓存漂移）

(End of file - total 87 lines)
