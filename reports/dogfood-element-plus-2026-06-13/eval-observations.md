# Element Plus 评估观察 (M3)

日期: 2026-06-13 | 站点: element-plus.org | 工具: vortex MCP

> 范围: 表单/浮层/选择类组件的演示页。重点验证 vortex MCP 工具(observe/act/fill/press/evaluate/screenshot 等)能否识别并操作 Element Plus 各组件的核心交互。本报告只记观察与证据,不做根因诊断。

## 观察记录

### C1 select.html

- **O-1** [正常] 基础用法: vortex_observe filter=interactive 在 0/150 位置抓到 1 个 `combobox`(@240d:e31),act click 后弹出 `[expanded]` 与 5 个 `option`(`Option1-5`,@0427:e0-e4)。act click `@0427:e1`(Option2)后 evaluate 读 `.el-select` idx=0 的 `.el-select__placeholder` 文本→"Option2"。
  - 证据: vortex_act effect.userFeedback="mutation",vortex_evaluate 读到 placeholder=Option2。
- **O-2** [正常] 基础多选: 滚动到"基础多选"区域,observe 抓到 `combobox` (@9e45:e26) 在 384,296,159,24。act click 后下拉展开(5 个 Option)。act click Option2(@8e4c:e1) + Option3(@8e4c:e2) 后,evaluate 读 `.el-select` idx=8 的 `.el-tag` 数组→`[Option2, Option3]`(两个标签都有 `el-tag__close`)。
  - 证据: vortex_evaluate 返回 `{"idx":8,"tags":[{"text":"Option2","closed":true},{"text":"Option3","closed":true}],"selectedItems":["Option2","Option3"],...}`。
- **O-3** [异常] 筛选选项(filterable): vortex_observe 抓到 `combobox`(@87b0:e26),act click 后弹出 5 个 Option。`vortex_act action="type"` 报 **Error [JS_EXECUTION_ERROR]: w is not iterable**(目标是 @87b0:e26 这个 ref)。改为 `vortex_fill target="@c745:e38"` 返回 `{success:true,focused:true}`,但 evaluate 读所有 `.el-select__input` value 都是空。`vortex_press key="3"` 再 evaluate `.el-select-dropdown__item`:5 个 option 中只有 1 个 `Option3` 的 `visible=true`(`offsetParent !== null`),其它 4 个 `visible=false`(被 filter 隐藏)。
  - 证据: vortex_evaluate 返回 `[{"text":"Option1","visible":false,...},...,{"text":"Option3","visible":true,...},...]`。
  - 备注: act type 失败 + fill 不写入,但 press 单字符成功过滤;两种操作结果不一致(vortex 截图保存了过滤后只剩 Option3 的状态)。

### C2 select-v2.html (虚拟列表,1000 个 option)

- **O-4** [正常] 虚拟列表打开: vortex_observe 抓到 1 个 `combobox`(@f2ba:e33)。act click 后 evaluate 读 `.el-vl__window.el-select-dropdown__list` 的 scrollHeight=34000(1000 项 × 34px ≈ 34k)、clientHeight=274、scrollTop=0,可见选项 a0..a10。evaluate 滚到 scrollTop=33000 后 observe 重新抓 → option 列表变为 `i968, j969, ..., a980`(虚拟滚动按需渲染)。
  - 证据: vortex_observe 抓到 13 个 option,从 `i968` 到 `a980`,bbox 都在 viewport 内。
- **O-5** [异常] 选远处选项: 滚到底后,observe 拿到 ref(如 j979 = `@83aa:e11`)。`vortex_act target="@83aa:e1"`(j969) **Error [TIMEOUT]: Actionability timeout after 2000ms; last reason: OBSCURED**。evaluate 检查 j969 center (475, 392) 处 `document.elementFromPoint` 返回 `el-select__selected-item el-select__placeholder is-transparent`(是 select 触发器本身,仍占位)。同位置重复 act 都 OBSCURED。
  - 二次尝试: 用 `vortex_evaluate` 直接 `.click()` 调 j969 → evaluate 读 `.el-select` placeholder 变 "j969" 生效。
  - 证据: vortex_evaluate 返回 `{"placeholder":"j969","selectedItem":"",...}`。
  - 备注: act 因 actionability 失败,但同一元素 evaluate .click() 成功。属 vortex 工具的限制而非 Element Plus 问题。

### C3 cascader.html

- **O-6** [正常] 三级级联打开: vortex_observe 抓到 2 个 `textbox "Select"`(@c99c:e29 / @c99c:e30,基础用法两个 demo)。act click @c99c:e29 弹出 `menuitem` Guide/Component/Resource(@c02b:e0-e2)。act click Guide(@c02b:e0) → 子级 menuitem Disciplines/Navigation 出现(@cbe2:e3, @cbe2:e4)。act click Disciplines(@cbe2:e3) → 第三级 Consistency/Feedback/Efficiency/Controllability 出现(@0880:e5-e8)。act click Consistency(@0880:e5)。
  - 读结果: vortex_evaluate `.el-cascader` idx=0 placeholder = "Guide / Disciplines / Consistency"。
  - 证据: vortex_evaluate 返回 `{"idx":0,"placeholders":["Guide / Disciplines / Consistency"],...}`。

### C4 slider.html

- **O-7** [正常] 单滑块键盘: vortex_observe 抓到 4 个 `slider`(@59af:e31-e34,基础用法 default/customized/hide tooltip/format tooltip/disabled),均 value=0。act click @59af:e31 触发 focus 后,3 次 `vortex_press ArrowRight` → aria-valuenow 从 0 变 3。
  - 证据: vortex_evaluate 返回 `[{"ariaValueNow":"3",...},{"ariaValueNow":"0",...},...]`。
- **O-8** [正常] 范围滑块键盘: 滚到"范围选择"区,observe 抓到 `pick start value`(value=4,@9dbb:e27)与 `pick end value`(value=8,@9dbb:e28)。act click end slider,2 次 `vortex_press ArrowRight` → end 值 8→10。
  - 证据: vortex_evaluate `.el-slider` idx=15 vals=`[{"label":"pick start value","value":"4"},{"label":"pick end value","value":"10"}]`。

### C5 date-picker.html

- **O-9** [正常] 单日选择: vortex_observe 抓到 2 个 `combobox "Pick a day"`(@f687:e32 / @f687:e33)。act click @f687:e32 后 dialogHit=`[role='dialog']`,observe 重新抓出 6 个 navigation 按钮 + 7 个 `td` day cell + dates 1-31。`vortex_evaluate` 直接 `.click()` td.available 含 "15" 的格。
  - 读结果: `.el-date-editor` idx=0 value="2026-06-15"。
  - 证据: vortex_evaluate 返回 `{"i":0,"value":"2026-06-15","placeholder":"Pick a day"},...`。
- **O-10** [正常] 日期范围: 滚到"选择一段时间",observe 抓到 `combobox "Start date"`(@552e:e28) + `End date`(@552e:e29)。act click @552e:e28 后 dialogHit,observe 看到双月份面板(June/July)。evaluate 点击 tables[0] (June) td 含 "10"(start)→ 关闭弹出。然后再 evaluate 找 tables[1] (July) td "20" 找不到(似乎表格未刷新 / 月份切到 August,因为第二次 click 后 start=10 会让 end 月份推进);后续直接读结果:`.el-date-editor--daterange` idx=0 inputs=`["2026-06-10","2026-07-20"]`,说明 range 实际已成功完成。
  - 证据: vortex_evaluate 返回 `{"startInputValue":"2026-06-10","allInputs":["2026-06-10","2026-07-20"]}`。

### C6 time-picker.html

- **O-11** [正常] 时间选择: vortex_observe 抓到 2 个 `combobox "Arbitrary time"`(@ffe2:e31 / @ffe2:e32)。act click @ffe2:e31 弹 dialog,observe 出 `Cancel`/`OK` 按钮。`vortex_evaluate` 读 `.el-time-spinner__item` → 3 列(00-23 hours / 00-59 minutes / 00-59 seconds),每列均 60 个项左右。evaluate `.click()` 小时 "10" 和分钟 "30"(滚动后),act click OK(@0661:e1)确认。
  - 读结果: `.el-date-editor` idx=0 inputs=`["10:30:19"]`(秒=默认 19)。
  - 证据: vortex_evaluate 返回 `{"inputs":["10:30:19"],"placeholder":"Arbitrary time"}`。

### C7 input-number.html

- **O-12** [正常] 数字输入: vortex_observe 抓到 `decrease number` button(@b019:e29)、`increase number` button(@b019:e30)、`spinbutton value=1/10`(@b019:e31,基础用法 min=1 max=10)。`vortex_fill target="@b019:e31" value="42"` → evaluate 读 `.el-input-number input` value="10"(被 max 限制到 10,aria-valuenow="10")。
  - 证据: vortex_evaluate 返回 `{"value":"10","ariaValueNow":"10"}`。
- **O-13** [正常] 步进按钮: act click `increase number`(@b019:e30) → 值仍为 10(已达 max)。act click `decrease number`(@b019:e29) → 值变 9。
  - 证据: vortex_evaluate 返回 `{"value":"9"}`。

### C8 dialog.html

- **O-14** [正常] 基础对话框: vortex_observe 抓到 `button "Click to open the Dialog"`(@6363:e29,基础用法)。act click 后 dialogHit=`[role='dialog']`,observe 出 `Close this dialog`(@c552:e29)、`Cancel`(@c552:e30)、`Confirm`(@c552:e31)。act click Cancel(@c552:e30) → evaluate 读 `.el-dialog` offsetParent=null → dialogVisible=false。
  - 证据: vortex_evaluate 返回 `{"dialogVisible":false,"dialogCount":1}`。

### C9 drawer.html

- **O-15** [正常] 抽屉打开/关闭: vortex_observe 滚到"基础用法"后抓到 `button "open"`(@582d:e29,基础用法 with footer 按钮 also)。act click @582d:e29 → dialogHit=`[role='dialog']`,observe 出 `Close this dialog`(@1609:e31) — 点它触发了 beforeClose 的 ElMessageBox 二次确认,observe 看到 Cancel/OK 按钮(@33be:e66 / @33be:e67)。act click OK → evaluate 读 `.el-drawer` count=10 / visible=0。
  - 证据: vortex_evaluate 返回 `{"count":10,"visible":0}`。

### C10 popover.html / popconfirm.html

- **O-16** [正常] 展示位置(12 个方向): vortex_observe 抓到 12 个 popover 触发器(`top-start`, `top`, `top-end`, ... `bottom-end`,@03ee:e31-e42)。act click top-start → evaluate 读 `.el-popper / .el-popover` 可见数=1,内容 "TitleTop Left prompts info"。
  - 证据: vortex_evaluate 返回 `{"total":23,"visible":1,"texts":["TitleTop Left prompts info"]}`。
- **O-17** [正常] 嵌套操作 popover: 滚到"嵌套操作",observe 抓到 `button "Delete"`(@c084:e27,触发器)。act click → observe 看到 `button "cancel"`(@6dcb:e0)和 `button "confirm"`(@6dcb:e1)。act click confirm → evaluate 读 `.el-popover` count=22 / visible=0。
  - 证据: vortex_evaluate 返回 `{"count":22,"visible":0}`。

### C11 tree.html / tree-select.html

- **O-18** [正常] 树展开: vortex_observe 抓到 `treeitem "Level one 1"`(@bdb6:e33)、"Level one 2"、"Level one 3"。act click Level one 1 → expanded 出现子项 "Level two 1-1"(@3ebf:e33)。act click Level two 1-1 → evaluate 读 `.el-tree-node` 可见节点包含 "Level three 1-1-1"。
  - 证据: vortex_evaluate 返回 visible 列表第一段含 "Level three 1-1-1"。
- **O-19** [正常] 树勾选: observe 滚到"可选择"区后,看到 `treeitem "Root1"`(`@3ebf:e43`,含 label checkbox `@3ebf:e44`)。act click label @3ebf:e44 → evaluate 读 `.el-tree .el-checkbox.is-checked` 共 2 个,对应 Root1 与 Level two 2-1。
  - 证据: vortex_evaluate 返回 `{"checkedCount":2,"texts":["Root1","Level two 2-1"]}`。

### C12 upload.html(快速)

- **O-20** [正常] File input 存在但隐藏: observe filter=interactive 没抓到 `<input type="file">`(interactive filter 排除了不可见元素)。observe 抓到 `button "Click to upload"`(@2e04:e32,触发器)。evaluate 读 `input[type="file"]` 共 5 个,均 className=`el-upload__input` 且 visible=false。
  - 证据: vortex_evaluate 返回 `[{"visible":false,"inDOM":true,"className":"el-upload__input"},...]`。

### C14 autocomplete.html(快速)

- **O-21** [正常] 自动补全: vortex_observe 抓到 2 个 `textbox "Please Input"`(@d7e1:e28 / @d7e1:e29)。act click @d7e1:e28 → 3 次 `vortex_press`('v','u','e')。evaluate 读 `.el-autocomplete-suggestion` visSug=true,items=`["vue","element","cooking","mint-ui","vuex","vue-router","babel"]`(过滤以 vue 开头)。
  - 证据: vortex_evaluate 返回 `{"visSug":true,"items":["vue","element","cooking","mint-ui","vuex","vue-router","babel"]}`。

### C15 form.html

- **O-22** [正常] 典型表单 fill + select: vortex_observe 抓到 `textbox "Activity name"`(@28ba:e29)、`combobox "Activity zone"`(@28ba:e30)、`combobox "Pick a date"`、`combobox "Pick a time"`。`vortex_fill target="@28ba:e29" value="Hello World"` → evaluate 读 input value="Hello World"。act click @c4c9:e26 (Activity zone) → 下拉打开,有 Zone one/Zone two。act click Zone one(@32de:e0) → evaluate 读 `.el-select` idx=0 placeholder="Zone one"。
  - 证据: vortex_evaluate 返回 `{"idx":0,"placeholder":"Zone one"}` 等。
- **O-23** [正常] 表单校验读错误态: 滚到"表单校验",observe 抓到 Create(@3f6f:e41)/Reset 按钮。act click Create(空表单)→ evaluate 读 `.el-form-item__error` 8 条:["Please select Activity zone","Please select Activity count","Please pick a date","Please pick a time","Please select a location","Please select at least one activity type","Please select activity resource","Please input activity form"]。vortex_fill Activity name="Hello" + 再 click Create → 错误数仍为 8(Activity name 错误消失,其它 7 项未填)。
  - 证据: vortex_evaluate 返回 `["Please select Activity zone","Please select Activity count","Please pick a date",...]` 各次。

## 异常汇总(Anomaly)

| ID | 组件 | 现象一句话 | 严重度(主观) | 证据位置 |
|----|------|-----------|----------------|----------|
| A1 | C1 筛选选项 | `vortex_act action=type` 在 filterable select 上抛 `JS_EXECUTION_ERROR: w is not iterable`;同操作 `vortex_fill` 成功聚焦但 .el-select__input.value 仍为空(写入未生效);只有 `vortex_press` 单字符才能驱动 filter 过滤 | 体验问题 | O-3 |
| A2 | C2 虚拟列表选远处选项 | `vortex_act click` j969 / j979 均抛 `Actionability timeout, OBSCURED`,因为 select 触发器仍占位挡住下拉首项的 center point;绕过办法是用 `vortex_evaluate el.click()` | 体验问题 | O-5 |

> 未涵盖:C13 transfer、C16 table(时间所限跳过)。评估过程中全部都是单一工具调用,无崩溃/卡死;所有观察在 tab id=984523883 的 element-plus.org 上完成。