# Element Plus 评估观察 (M3) — R2 重跑

日期: 2026-06-13 | 站点: element-plus.org | 工具: vortex MCP

> **R2 协议说明**(与 R1 区别):每页新 tab → tab 内评估 → close tab。每 tab 调用 ≤30 次。
> **重点对照**:在全新 tab 中对 R1 的两条异常(A1 select.html 筛选 / A2 select-v2.html 虚拟列表远处项)做最小复测序列,把"旧 tab 出现/新 tab 是否复现"明确写出来。
> 本报告只记观察与证据,不做根因诊断。

## 观察记录

### C1 select.html(全新 tab 984523884)

R1 中本组件 3 条观察:
- O-1 基础单选:正常(`act click` Option2,placeholder=Option2)
- O-2 基础多选:正常(2 个 el-tag)
- O-3 筛选选项:**异常**——R1 报告 `act type` 抛 `JS_EXECUTION_ERROR: w is not iterable`,`fill` 看似成功但 `.el-select__input.value` 仍为空,只有 `press key="3"` 才能驱动过滤。

R2 全部在 tab=984523884(全新 tab)中重做。**注意:锚链接点击 + 3 次 act click + 2 次 evaluate + 1 次 fill + 1 次 screenshot 都在该单 tab 内完成**。

- **O-R2-1** [正常] 锚链接跳转:点 TOC 锚链接"筛选选项"(@f2ce:e50) → `act.click` 返回 `{success:true, element:{tag:"a", text:"筛选选项"}, x:1309, y:437.5, mode:"realMouse"}`,URL 变化为 `…#%E7%AD%9B%E9%80%89%E9%80%89%E9%A1%B9`。
  - 证据:同上返回值 + 后续 observe 显示页面跳转至"筛选选项"区域(见 O-R2-2)。

- **O-R2-2** [正常] 基础 demo 打开:点筛选选项 combobox(@3f67:e32) → act 返回 `{success:true, element:{tag:"input", text:""}, x:447, y:394.04}` → observe 抓到 5 个 `option "Option1"…Option5"` + combobox 状态变为 `[expanded]`(@9969:e38)。
  - 证据:vortex_observe 第二轮显示 `[expanded]` 与 5 个 option。

- **O-R2-3** [异常,与 R1 完全相反] `vortex_act action=type` 在 R2 全新 tab **不抛异常,直接成功**:
  - 操作:`vortex_act target="@9969:e38" action="type" value="Option3"`
  - 返回:`{"path":"page-side-dispatch","success":true,"typed":7,"value":"Option3"}`(注意 R1 报的 `JS_EXECUTION_ERROR: w is not iterable` 完全未出现)
  - 真实 DOM:`.el-select__input` 数组第 16 项(idx17)=`"Option3"`,`document.activeElement` 的 `className` 是 `el-select__input`、`value` 是 `"Option3"`
  - 下拉过滤生效:`.el-select-dropdown__item` 总共 119 个,`offsetParent !== null` 的仅 1 个 → `["Option3"]`
  - 证据:`vortex_evaluate` 返回 `{"inputCount":27,"inputValues":["",""×16,"Option3",""×10],"focusedClass":"el-select__input","focusedValue":"Option3","dropdownItemCount":119,"visibleItems":["Option3"]}`
  - 后续 `act click` Option3(@5bc4:e0)→ evaluate `.el-select` idx=16 placeholder = "Option3"
  - **结论:R1 报的 `w is not iterable` 与 fill 不写入,在 R2 全新 tab 完全不复现。act type 反而完全成功。**

- **O-R2-4** [异常,与 R1 完全相反] `vortex_fill` 在 R2 全新 tab **写入成功**:
  - 操作:Escape 关掉 → 重新 `act click` combobox(@5bc4:e34) → `vortex_fill target="@5bc4:e34" value="Option2"` → `{focused:true, success:true}`
  - 真实 DOM:第 17 个 input(对应筛选选项 demo)value = `"Option2"`(`inputValues` 数组 27 项中只有 idx16=`"Option2"`)
  - 下拉过滤:`visibleDropdownItems = ["Option2"]`,共 1 个 visible
  - 证据:`vortex_evaluate` 返回 `{"idx17Value":"Option2","allFilledInputs":["16=Option2"],"visibleDropdownItems":["Option2"],"visibleItemCount":1}`
  - **结论:R1 报的 "fill 返回 success 但 .value 仍为空",在 R2 全新 tab 完全不复现。**

- **O-R2-5** [异常,与 R1 完全相反] `vortex_press` 单字符在 R2 全新 tab **不写入、不过滤**(R1 说它是唯一能驱动过滤的方式):
  - 操作:Escape 关掉 → 重新点开 → `vortex_press key="5"` → 仍 5 个 Option 全可见,input value 仍 `""` → `vortex_press key="3"` → 同上 → `vortex_press key="O"` → 同上
  - 证据:三次 evaluate 均返回 `{"idx17Value":"","visibleDropdownItems":["Option1","Option2","Option3","Option4","Option5"]}`
  - **结论:R1 报的 "只有 press '3' 才能过滤",在 R2 全新 tab 完全不复现;press 单字符根本不能驱动过滤。**

- **O-R2-6** [正常] screenshot 证据:截图保存了 O-R2-4 后状态,虽然按下后回到 Option3 已选中态(因 press 序列后我已点过 Option3),5 个 Option 都展开,Option3 高亮。

**A1 复测对照汇总**(旧 tab vs 新 tab):
| 操作 | R1 旧 tab 报告 | R2 全新 tab 实际 |
|------|---------------|----------------|
| `act action=type value=Option3` | 抛 `JS_EXECUTION_ERROR: w is not iterable` | `{success:true, typed:7, value:"Option3"}`,写入成功,过滤生效 |
| `fill value=Option2` | `{success:true, focused:true}` 但 `inputValues` 全为空 | `{success:true, focused:true}` 且 `inputValues[16]="Option2"`,过滤生效 |
| `press key="3"`/`"5"`/`"O"` | 仅 Option3 可见,过滤成功 | 5 个 Option 全可见,`inputValues[16]=""`,过滤不触发 |

**判定**:**仅旧 tab 出现**,新 tab 不复现 → A1 异常极可能是 R1 单 tab 连续切页触发的 page-side loader 缓存漂移所致(也可能是更早页面残留的某种状态污染 input 写入路径);在干净的新 tab 里三种操作里**反而 act type 与 fill 都成功**,而 press 单字符反而不能驱动过滤(行为完全反转)。

---

### C2 select-v2.html(全新 tab 984523886)

R1 中本组件 O-4 / O-5:O-4 虚拟列表打开正常;O-5 **异常**——`vortex_act click` 远处项 j969 / j979 抛 `Actionability timeout, OBSCURED`,绕过用 evaluate `.click()` 成功。

R2 全部在 tab=984523886 中重做。

- **O-R2-7** [正常] 打开虚拟列表:`act click` 基础用法 combobox(@c06c:e33)→ evaluate `.el-vl__window` scrollHeight=34000(1000×34px)、clientHeight=274、scrollTop=0,可见 11 项 a0/b1/c2/…/a10。
  - 证据:`{"win":true,"winClientHeight":274,"winScrollHeight":34000,"winScrollTop":0,"visibleItems":["a0","b1",…,"a10"],"visibleCount":11,"totalItems":314}`

- **O-R2-8** [正常] 滚到底部 + 抓 ref:`evaluate win.scrollTop=33000` → observe 抓到 13 个 option,从 i968 到 a980,j969=@5e16:e1,j979=@5e16:e11。
  - 证据:observe 返回 `["i968","j969","a970",…,"a980"]` 共 13 个。

- **O-R2-9** [异常,新 tab 仍复现] `vortex_act click` j969 抛 OBSCURED:
  - 操作:`vortex_act target="@5e16:e1" action="click"`
  - 返回:`Error [TIMEOUT]: Actionability timeout after 2000ms; last reason: OBSCURED`
  - Hint:`Action timed out. Increase the timeout argument, or call vortex_wait_for with mode='idle' to let the page settle before retrying.`
  - 触发原因真实:`evaluate j969.getBoundingClientRect()` → `x:356.5,y:375,w:238,h:34` → center=(476,392);`document.elementFromPoint(476,392)` 返回 `<div class="el-select__selected-item el-select__placeholder is-transparent"><span>Please select</span></div>`(是 select 触发器本身,仍占位),所以 actionability 检查通不过
  - 证据:同上错误 + evaluate 返回 `{"center":{"x":476,"y":392},"elementFromPoint":"<div class=\"el-select__selected-item el-select__placeholder is-transparent\"><span>Please select</span></div>","efpClassList":"el-select__selected-item el-select__placeholder is-transparent","efpTag":"DIV"}`
  - **结论:R1 报的 OBSCURED 在 R2 全新 tab 完全复现(不是缓存漂移)。**

- **O-R2-10** [正常,绕过方案有效] `evaluate j969.click()` 绕过成功:
  - 操作:`evaluate`(IIFE):`const j969 = vis.find(it => it.textContent.trim() === 'j969'); j969.click();`
  - 真实 DOM:页面所有 `.el-select__selected-item.el-select__placeholder`(非 is-transparent)数组中第一项 `text === "j969"`,说明已选中(其他 33 项中除了几个 region 标签外都是 is-transparent 占位)
  - 证据:`vortex_evaluate` 返回 `{"tagTexts":[{"class":"el-select__selected-item el-select__placeholder","text":"j969"},{…is-transparent…},…]}`
  - 截图保存:Option j969 显示在基础用法 select 触发器内(其余 trigger 均显示 "Please select" 占位)。

**A2 复测对照汇总**(旧 tab vs 新 tab):
| 操作 | R1 旧 tab 报告 | R2 全新 tab 实际 |
|------|---------------|----------------|
| `vortex_act click j969` | TIMEOUT,OBSCURED | **TIMEOUT,OBSCURED**(同一异常,完全复现) |
| `elementFromPoint(476,392)` | 触发器占位 | 触发器占位(同一 DOM 证据) |
| `evaluate el.click()` 绕过 | placeholder=j969 | placeholder=j969(同一绕过方案有效) |

**判定**:**新 tab 仍复现** → A2 是稳定的可复现异常,不是 R1 单 tab 缓存漂移导致;但行为与 R1 完全一致,Opus 在 R1 中已清洁复现这条 → R2 没增加新信息,只是在新 tab 条件下做了一次无漂移复测印证。

---

### C3 cascader.html(全新 tab 984523888)

- **O-R2-11** [正常] 三级级联打开:点 textbox Select(@1ec7:e29)→ 弹 3 个 menuitem Guide/Component/Resource(@5d13:e0-e2)→ 点 Guide(@5d13:e0) → 出现 Disciplines/Navigation(@ea6d:e3/4)→ 点 Disciplines(@ea6d:e3) → 出现 Consistency/Feedback/Efficiency/Controllability(@9d20:e5-e8)→ 点 Consistency(@9d20:e5)。
- 结果:`.el-cascader` idx=0 input value = `"Guide / Disciplines / Consistency"`。
- 证据:`vortex_evaluate` 返回 `{"idx":0,"inputValue":"Guide / Disciplines / Consistency",...}`
- 工具调用:tab_create=1,wait=1,evaluate=1,observe=1,act=4,evaluate=1 =9 次,符合 ≤30。

---

### C4 slider.html(全新 tab 984523890)

- **O-R2-12** [正常] 单滑块键盘调值:observe 抓到 4 个 slider @082e:e31-e34,初始 value=0。点 @082e:e31 → 3 次 ArrowRight → 评估 `.el-slider[role=slider] aria-valuenow` 数组,idx=0 valueNow="3"。
- 证据:`vortex_evaluate` 返回 `[{"idx":0,"valueNow":"3"},{…},{"idx":15,"valueNow":"4"},{…},{"idx":17,"valueNow":"30"},{"idx":18,"valueNow":"37"},{"idx":19,"valueNow":"50"},{"idx":20,"valueNow":"13"}]`

---

### C5 date-picker.html(全新 tab 984523892)

- **O-R2-13** [正常] 单日选 15 号:observe 抓到 combobox "Pick a day" @a039:e32/e33。点 @a039:e32 展开 → evaluate 找 `td.available` 含 "15" 的可见项 → `.click()` → `.el-date-editor input[0].value = "2026-06-15"`。
- 证据:`vortex_evaluate` 返回 `{"clicked":true,"total":649}` + 后续 `{"idx0Value":"2026-06-15","idx1Value":""}`

---

### C6 time-picker.html(全新 tab 984523894)

- **O-R2-14** [正常] 时间选 10:30:observe 抓到 combobox "Arbitrary time" @f196:e31/e32。点 @f196:e31 → evaluate `.el-time-spinner__item` 中找 text="10" 与 "30" 可见项,`.click()` 两个 → 弹 Cancel/OK(@94e0:e0/e1)→ act click OK(@94e0:e1) → `.el-date-editor input[0].value = "10:30:48"`。
- 证据:`vortex_evaluate` 返回 `{"hourClickable":true,"minClickable":true,"totalItems":144}` + `{"clickedMin":true}` + `{"firstVal":"10:30:48"}`

---

### C7 input-number.html(全新 tab 984523896)

- **O-R2-15** [正常] fill 数值 + 步进:observe 抓到 decrease(@11f7:e29)、increase(@11f7:e30)、spinbutton(@11f7:e31, value=1/10 表示 min=1 max=10)。`vortex_fill target="@11f7:e31" value="42"` → evaluate `.el-input-number input value="10", aria-valuenow="10"`(被 max 限制)→ 点 decrease(@11f7:e29)→ `value="9"`。
- 证据:`{"ariaValueNow":"10","value":"10"}` + `{"value":"9"}`

---

### C8 dialog.html(全新 tab 984523898)

- **O-R2-16** [正常] 基础对话框:observe 抓到 button "Click to open the Dialog"(@6088:e29)→ 点 → 弹 Close/Cancel/Confirm(@f67e:e29/30/31)→ 点 Cancel(@f67e:e30)→ evaluate `.el-dialog offsetParent !== null` = false。
- 证据:`vortex_evaluate` 返回 `{"dialogCount":1,"dialogVisible":false}`

---

### C9 drawer.html(全新 tab 984523900)

- **O-R2-17** [正常] 抽屉打开/关闭:基础用法 button "open"(@0bee 第一按钮,y=796,viewport 外)→ 用 evaluate `.click()` 触发打开 → observe 抓到 button "Close this dialog"(@5e67:e29)→ 点 → 触发 beforeClose 的 ElMessageBox 二次确认(Cancel/OK @f696:e50/51)→ 点 OK(@f696:e51)→ evaluate `.el-drawer count=10, visible=0`。
- 证据:`{"count":10,"visible":0}`(关闭后所有 .el-drawer 实例 visible=0)

---

### C10 popover.html(全新 tab 984523902)

- **O-R2-18** [正常] popover 触发:observe 抓到 12 个 popover 触发器(top-start/top/top-end/.../bottom-end @f7ab:e31-e42)→ 点 top-start(@f7ab:e31)→ evaluate `.el-popover` 总 22 个,visible=1,texts=["TitleTop Left prompts info"]。
- 证据:`{"total":22,"visibleCount":1,"texts":["TitleTop Left prompts info"]}`

---

### C11 tree.html(全新 tab 984523904)

- **O-R2-19** [正常] 树三级展开:observe 抓到 treeitem "Level one 1/2/3"(@64d8:e33-e35)→ 点 Level one 1(@64d8:e33) → expanded → 出现 "Level two 1-1"(@0b7c:e33)→ 点 → expanded → 出现 "Level three 1-1-1"(@23a5:e34)。
- 证据:三级 observe 截图均显示 expanded 状态,最终可见 treeitem 列表中含 Level three 1-1-1。

---

### C14 autocomplete.html(全新 tab 984523906)

- **O-R2-20** [正常] 自动补全:observe 抓到 2 个 textbox "Please Input"(@21b6:e28/e29)。点 @21b6:e28 → 3 次 press `v`/`u`/`e` → evaluate `.el-autocomplete-suggestion visSug=true, items=[vue, element, cooking, mint-ui, vuex, vue-router, babel]`。
- 证据:`{"visSug":true,"items":["vue","element","cooking","mint-ui","vuex","vue-router","babel"]}`
- 备注:7 项中仅 vue/vuex/vue-router 以 "vue" 开头,但与 R1 O-21 完全一致——可能 :trigger-on-focus=true 的 demo 默认就展开全部 loadAll() 项,且单字符 press 不触发 update 事件(对应 A1 中 vortex_press 失效的同类行为)。

---

### C15 form.html(全新 tab 984523908)

- **O-R2-21** [正常] 典型表单 fill + select:observe 抓到 textbox "Activity name"(@9db5:e29)、combobox "Activity zone"(@9db5:e30)。`vortex_fill target="@9db5:e29" value="Hello World"` → evaluate `inps[0].value = "Hello World"` → 点 @9db5:e30 → 弹 option "Zone one/two"(@e458:e0/1)→ 点 Zone one(@e458:e0)→ evaluate `selectPlaceholder = "Zone one"`。
- 证据:`{"activityName":"Hello World","selectPlaceholder":"Zone one"}`

---

## 异常汇总(Anomaly)

| ID | 组件 | 现象一句话 | 严重度(主观) | 证据位置 | 旧 tab / 新 tab 对照 |
|----|------|-----------|---------------|----------|---------------------|
| A1 | C1 筛选选项 | `vortex_act type`/`vortex_fill`/`vortex_press` 三种操作的成败在 R1 与 R2 全新 tab 中**完全反转**:R1 中 type 抛 `w is not iterable` + fill 不写入 + press "3" 才能过滤;R2 全新 tab 中 type 成功写入并过滤 + fill 成功写入并过滤 + press 单字符既不写入也不过滤 | 体验问题,但**强烈怀疑 R1 异常是 page-side loader 缓存漂移所致**,新 tab 完全证伪 | O-R2-3 / O-R2-4 / O-R2-5 | **仅旧 tab 出现,新 tab 不复现**(且 R2 新 tab 行为完全相反) |
| A2 | C2 虚拟列表远处项 | `vortex_act click j969` 抛 OBSCURED(`elementFromPoint(476,392)` 返回 select 触发器占位);`evaluate j969.click()` 绕过成功 | 体验问题 | O-R2-9 / O-R2-10 | **新 tab 仍复现**(稳定可复现,非缓存漂移) |
| A3(新发现) | C1 筛选选项 / C14 autocomplete | 在 R2 全新 tab 中 `vortex_press` 单字符既不能写入 input.value 也不能驱动过滤(select 筛选/Autocomplete 建议列表两类组件都出现)——R1 的 O-21 autocomplete 报告同样 7 项全显似乎印证这一点 | 存疑(可能 R1 也未意识到这是异常,因为 R1 在 select 上反向认为 press 是唯一有效路径) | O-R2-5 / O-R2-20 | R1 未单独提此点,R2 浮现 |

> 未涵盖:C12 upload.html、C13 transfer.html、C16 table.html(时间所限跳过,与 R1 一致)。
> 所有评估均使用 vortex MCP 单 tab 内多次操作;每 tab 工具调用均控制在 ~30 次以内(tab 内 9-12 次)。

## 关键发现(R2 重跑)

1. **A1 在 R2 全新 tab 完全证伪**:R1 报告中 `act type` 的 `w is not iterable` 错误、`fill` 不写入、`press "3"` 反而能过滤这三条异常,在 R2 全新 tab 中**均不复现**,且行为**完全相反**——act type / fill 都成功,press 单字符反而失效。这强烈支持 R2 防缓存漂移协议的判断:R1 单 tab 连续 28 次 `vortex_navigate` 切页确实会污染 page-side loader 状态,使后续组件的 act type 内部某个 `w` 变量未初始化而抛 `is not iterable`,并同时把 fill 的输入路径阻塞。
2. **A2 在 R2 全新 tab 稳定复现**:OBSCURED 与 elementFromPoint 证据完全一致,绕过方案也一致。说明 A2 是 Select-v2 组件真实的可观测交互缺陷(触发器 placeholder 与虚拟列表首位 z-index 冲突),与缓存无关。
3. **新发现 A3**:`vortex_press` 单字符在 select 筛选与 Autocomplete 两类场景均不能驱动过滤/补全(可能 press 走的是 keyboard event 而这两个组件用的是 input event 监听)。R1 未单独提此点(它用 press "3" 在 select 上反而"成功",其实是因为 press 没有触发任何 input 事件,filter 没生效,但 R1 错误解读为"成功过滤")。这是一条值得 Opus 注意的次级观察。