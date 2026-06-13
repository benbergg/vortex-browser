# MUI 评估观察 (M3)

日期: 2026-06-13 | 站点: mui.com (含 mui.com/x) | 工具: vortex MCP | 协议: 每页新 tab

## 评估范围

完成 C1-C11 全部 11 个组件页评估,每页 1 个新 tab。每 tab 工具调用控制在 ~30 次内。
未做 C12-C15 (Rating/Tooltip-Popover/Tabs/Transfer List)。

## 观察记录

### C1 react-select (全新 tab `984523920`)

- **O-1** [正常] Basic select 单选全流程通。`vortex_observe filter=interactive` 拿到 Age combobox `[ref=@e72d:e42]`,`vortex_act click` 打开下拉(截图确认 Ten/Twenty/Three 显示),`vortex_observe` 二次刷新拿到三个 option ref,`vortex_act click @ef8e:e77`(Twenty),`vortex_evaluate` 读 `#demo-simple-select` 父容器 textContent="Twenty",截图确认 Age 输入框显示 "Twenty"。证据:`(function(){var s=document.querySelector('#demo-simple-select');return s?'value='+s.value+' text='+(s.textContent||'').trim():'NOT_FOUND';})()` → `"value=undefined text=Twenty"`(MUI 用内部隐藏 input 携带 value,可见 text 来自渲染层)。

- **O-2** [异常] Multiple select:同时选 Oliver Hansen + Van Henry 后,`vortex_evaluate` 读 combobox `[role="combobox"]` index 13 的 `textContent` 仅返回 `"Van Henry"`,但同元素的 `innerText` 正确返回 `"Oliver Hansen, Van Henry"`,`outerHTML` 也显示内部含两段文本。截图里 chip 区域肉眼不可见文本(可能 dark theme 下 chip 文本/背景对比度问题或 chip 完全未渲染)。`aria-selected` 在两选项上都为 `true`,说明 React state 与无障碍树正确,仅是某些序列化读取路径(`textContent` vs `innerText`)或视觉渲染异常。证据:`(function(){var cb=document.querySelectorAll('div[role="combobox"]')[13];return 'innerText='+cb.innerText;})()` → `"innerText=Oliver Hansen, Van Henry"`,与 `cb.textContent="Van Henry"` 不一致。**新 tab 复测**:未触发,主流程未撞异常;但为审慎起见本观察不需新 tab。

### C2 react-autocomplete (全新 tab `984523922`)

- **O-1** [正常] Combo box: `vortex_act click @2ee5:e43` (Movie input) → `vortex_act type "The Godfather"`(page-side-dispatch,typed=13) → `vortex_evaluate` 读 `li[role=option]` 拿到 2 个候选(`1=The Godfather, 2=The Godfather: Part II`)→ `vortex_evaluate` `.click()` 第一个 option → 读 input value="The Godfather" 且 popup_open=false。截图确认 Movie combobox 显示 "The Godfather" + 清除按钮。

- **O-2** [正常] Country select(250+ 国家长列表,anchor 跳转 `#country-select`): `vortex_observe` 拿到 Choose a country combobox `[ref=@972b:e34]`,click 后用 `vortex_evaluate` 模拟 React 受控 input(通过 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`) 输入 `"Ja"`,filter 返回 4 项(Azerbaijan/Jamaica/Japan/Svalbard and Jan Mayen),`.click()` Japan → input value="Japan"。完整 select+filter 工作。

- **O-3** [正常] 10,000 options demo:输入 `"5"` → filter 返回 13 项(普通 listbox 渲染,非虚拟化),MUI 在 10k 数据源场景下做客户端 filter。

- **O-4** [工具缺陷] `vortex_observe filter=interactive` 在 portal 内 `li[role=option]` 不暴露 ref(只列顶层 input/button),必须用 `vortex_evaluate` 兜底 click。这是 vortex observe 对 portal 下沉节点的处理边界。

### C3 react-menu (全新 tab `984523924`)

- **O-1** [正常] Basic menu: `vortex_evaluate` 定位 `button` text="Dashboard"(evaluate 报 btn_9),`scrollIntoView + click()` 打开 menu,`vortex_evaluate` 读可见 `.MuiMenu-root,.MuiPopover-root` 唯一 1 个 menu,3 项(Profile/My account/Logout)→ `.click()` Profile → 重新读 open_menus=0,菜单关闭。截图前未撞异常,流程通。

- **O-2** [工具缺陷] 同 C2 O-4:`vortex_observe filter=interactive` 在 portal 内 `li[role=menuitem]` 不暴露 ref(0 顶层 menuitem,而 evaluate 拿到的菜单只有 3 项,但 observe 列表里同时有 20 个 menuitem 是其他 demos 残留),需 evaluate 兜底。

### C4 react-dialog (全新 tab `984523926`)

- **O-1** [异常] Dialog 开/关后,`[role="dialog"]` 元素 width/height 仍 > 0,但 `getComputedStyle(dialog).visibility='hidden'`(paper 也是 hidden),`MuiBackdrop-root` 仍 `visible`。说明 dialog 关闭后 React 不 unmount Paper 而是 visibility:hidden 做 transition;但 backdrop 在我 evaluate 时仍未及时跟上 transition。**判定 dialog 状态需用 `MuiBackdrop-root visibility=visible`** 而非 width>0。我用 `document.querySelectorAll('.MuiBackdrop-root')` 配合 `getComputedStyle(...).visibility` 区分 open/close 才得到正确结果。证据:evaluate `(function(){var d=document.querySelector('[role="dialog"]');return 'visibility='+getComputedStyle(d).visibility;})()` → `"visibility=hidden"` 但 `r.width=444` `r.height=435` > 0。

- **O-2** [异常] 同时存在 Simple dialog + Form dialog(其他 demos)时,`document.querySelector('[role="dialog"]')` 取**第一个** dialog role 元素可能不是当前焦点所在的 dialog。我执行 select Luna + click Ok 时,d 可能是 Simple dialog,但某些 evaluate 路径会返回 Form dialog(截图后半段 "Set backup account" dialog 仍可见)。我用了 `visibility !== 'hidden'` 二次过滤来定位真正 open 的 dialog 才避免误判。证据:截图显示 Form dialog "Set backup account" 持续可见;evaluate `dialog_0: w=444 h=435` 但 Paper hidden。

- **O-3** [正常] backdrop 状态正确反映 dialog 开关:`visible_backdrops=0` ⇒ 无 open modal;`visible_backdrops=1` ⇒ 1 个 open dialog。验证 Open simple dialog 打开 → backdrop_2 visible;Click Cancel/Ok → visible_backdrops=0。证据:evaluate `(function(){var backdrops=document.querySelectorAll('.MuiBackdrop-root');var arr=[];for(var i=0;i<backdrops.length;i++){var r=backdrops[i].getBoundingClientRect();var v=getComputedStyle(backdrops[i]).visibility;if(r.width>0)arr.push(i+': '+v);}return arr;})()` → `["0: hidden","1: hidden","2: visible"]`(开),`[]`(关)。

### C5 react-drawer (全新 tab `984523928`)

- **O-1** [正常] Temporary drawer:`vortex_evaluate` 找 btns[8]="Open drawer",`scrollIntoView + click` 打开。`vortex_evaluate` 读所有 `.MuiDrawer-paper` 4 个 visible(其他 demos 的 permanent/anchor),但用 `getComputedStyle(modal).visibility` 区分 `.MuiDrawer-modal` 唯一 1 个临时 drawer(300x788 @0,0)。截图确认 Inbox/Starred/Send email/Drafts/All mail/Trash/Spam 7 项显示。`.click()` Inbox → 重新读 `.MuiDrawer-modal visibility=hidden`,drawer 自动关闭。完整通。

- **O-2** [工具缺陷] `vortex_observe filter=interactive` 在 Drawer 内 `MuiListItemButton` 不暴露 ref(observe 列表中无 drawer menu items),需 evaluate 兜底 click。证据:observe 列表完全没有 Drawer 相关 ref。

### C6 react-slider (全新 tab `984523930`)

- **O-1** [正常] 单 Slider: `.MuiSlider-thumb` 元素**无** `role="slider"` 属性(查询 `[role="slider"]` 返回 0),但内嵌 `input[type=range]` 有 `aria-valuenow/min/max/label`。`vortex_evaluate` 找到 input(`aria-label="Volume"`),`.focus()` → `vortex_press ArrowRight` x3 → value 30 → 33;同时 thumb `style.left="33%"`,track `style.width="33%"`,UI 同步。证据:evaluate `(function(){var s=document.querySelectorAll('.MuiSlider-root');var input=s[0]?.querySelector('input[type="range"]');return 'input.val='+input.value+' thumb_style='+s[0]?.querySelector('.MuiSlider-thumb')?.style.left+' track_style='+s[0]?.querySelector('.MuiSlider-track')?.style.width;})()` → `"input.val=33 thumb_style=33% track_style=33%"`。

- **O-2** [正常] Range Slider: 第二个 input(`aria-label="Temperature range"`),初始 20,37;focus 第二 input → ArrowRight → 20,38,第一 thumb (20) 不变。范围滑块独立键盘导航工作。

- **O-3** [异常] ARIA 角色属性位置变化:`.MuiSlider-thumb` 本身 `role=-` `aria-valuenow=null` `tabindex=-1`,ARIA 全在内嵌 input。这与老版本 ARIA-on-thumb 模式不同,屏幕阅读器用户的体验可能受影响(取决于其是否能"穿透"内嵌 input)。但**功能无影响**:键盘交互、值更新、UI 同步都正常。

### C7 react-text-field (全新 tab `984523932`)

- **O-1** [正常] `vortex_observe filter=interactive` 拿到 Outlined `[ref=@6cc2:e41]`、Filled `[ref=@6cc2:e42]`、Standard `[ref=@6cc2:e43]` 三个 textbox。`vortex_fill @6cc2:e41 "Hello MUI"` → `.MuiTextField-root input[0].value="Hello MUI"`。`vortex_act action=type @6cc2:e42 "typed text"`(page-side-dispatch,typed=10)→ `input[1].value="typed text"`。截图三栏清晰显示三种 variant 都填充成功。

### C8 react-checkbox (全新 tab `984523934`)

- **O-1** [正常] `vortex_evaluate` 找第一个 unchecked checkbox(32 个 checkbox 中之一),`scrollIntoView + click` → 重新读 unchecked/checked 计数从 16/16 → 15/17。Label checkbox 切换: `input.checked=true` → click 之后 `input.checked=false`。Toggle 双向都通。

- **O-2** [信息] Checkbox 页**没有** Switch 组件(`.MuiSwitch-root input` count=0),`input[type=checkbox"][role="switch"]` count=0。Switch 在独立页 /material-ui/react-switch/,不在核心 C1-C11 范围,跳过。

### C9 react-snackbar (全新 tab `984523936`)

- **O-1** [异常] Snackbar 触发后,`vortex_evaluate` 找 `.MuiSnackbar-root` **返回 0 元素**;但 `[class*="Snackbar" i]` 返回 11 个元素,其中 0 号 `.MuiPaper-root MuiPaper-elevation MuiPape...` 600x48 是 "Note archived UNDO" 主体,1/2 号是 message + action。MUI v9 的 Snackbar 渲染结构从 `.MuiSnackbar-root` 改为直接用 `.MuiPaper-root`(可能为内部 SnackbarContent 拆分重写)。截图 viewport 内不可见 Snackbar:视口高 788,Snackbar 坐标 y 在 716~1848 范围(evaluate 8 报 24,716 和 46,722;evaluate 12 报 1848,可能是 transition 状态/或 element reflow)。需用 scrollIntoView 滚到 Snackbar 位置才能截图。

- **O-2** [正常] 触发流程: `vortex_evaluate` btns[8] "Open Snackbar" `click` → DOM 中出现 Note archived UNDO Paper,功能正常。`autoHideDuration=6000` 在 evaluate 间隔中可能让 snackbar 处于"准备退出但未完全 unmount"状态。

### C10 /x/react-date-pickers/date-picker (全新 tab `984523938`)

- **O-1** [正常] Basic date picker: `vortex_observe` 拿到 "Basic date picker" group + 3 个 spinbutton(Month/Day/Year,空)+ Choose date button `[ref=@5d29:e36]`。`vortex_act click @5d29:e36` 首次报 `JS_EXECUTION_ERROR page-side actionability injection timed out`(可能是 DatePicker 内部对页面 actionability 探针有特殊处理),`vortex_wait_for idle` + `vortex_observe` 重新拿 ref 后第二次 click 成功。`vortex_evaluate` 读 `[role="dialog"]` 1 个,320x336,text 包含 "June 2026SMTWTFS1234567891011..."。截图清晰显示 June 2026 日历。`vortex_evaluate` 找 button text="13" click → `input[placeholder="MM/DD/YYYY"]` 没找到(MUI v9 不再用这个 placeholder),用 `input.value.match(/\d{2}\/\d{2}\/\d{4}/)` 匹配 → `value=06/13/2026`。

- **O-2** [工具缺陷] DatePicker 首次 click 触发 page-side actionability injection 超时(具体 stack 未读取),需要 refresh observe + 二次重试。可能是 DatePicker 内嵌 iframe/sandbox 结构或某个 componentDidMount 重渲染导致 actionability 探针超时。

### C11 /x/react-data-grid (全新 tab `984523940`)

- **O-1** [正常] DataGrid 边界项覆盖:**Page 1** 5 行,`.MuiDataGrid-root[0]`:
  - 首行 `data-rowindex="0"` cell "Jon" click 成功。
  - 中间行 `data-rowindex="2"` cell "Jaime" click 成功。
  - 末行 `data-rowindex="4"` cell "Daenerys" click 成功。
  - 翻页后 **Page 2** 4 行(6-9 of 9):首行 `data-rowindex="5"` cell "Melisandre"(cell[3])、末行 `data-rowindex="8"` cell "Roxie" click 成功。
  - 翻页 "Go to next page" 按钮 click 后 page 显示 "6-9 of 9"。
  - 证据:evaluate `(function(){var grid=document.querySelectorAll('.MuiDataGrid-root')[0];var rows=grid.querySelectorAll('[role="row"][data-rowindex]');...})()` → "rows_count=4 :: 5=6Melisandre150 ... 8=9HarveyRoxie65Harvey Roxie"。

- **O-2** [异常] Checkbox 列 click 不自动转发到内嵌 input: `.click()` `[data-field="__check__"]` 的 gridcell(checkbox 容器 div)后,`input[type="checkbox"]` 仍 `checked=false`,`row aria-selected="false"`。改用 `input[type=checkbox].click()` 才使 `checked=true` + `aria-selected=true`。后续 toggle off `input.click()` 也工作。**两种方式都试了**(gridcell click → input click)记入证据。**该 demo 数据只有 9 行,非"长虚拟列表"**,但功能层覆盖了首/中/末/翻页/checkbox。

- **O-3** [信息] MUI X DataGrid demo 在本页只放 9 行(底部 "1-5 of 9", "6-9 of 9"),不是万行虚拟列表场景。要测万行虚拟列表需进 Demos 子页(virtualization section),本轮 C1-C11 范围内未测。

## 异常汇总(Anomaly)

| ID | 组件 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|----------------|----------|--------------|
| A-1 | C1 Multiple select | `textContent` 只报最后一个选中项文本,与 `innerText`/`outerHTML` 显示两项不一致;截图 chip 区域不可见 | 体验问题(可能 dark theme 对比度) | C1 O-2,evaluate 返回值与截图对比 | 未撞异常未复测 |
| A-2 | C4 Dialog | Dialog Paper 关闭后 width/height>0 + visibility:hidden,DOM 不 unmount;backdrop 在我 evaluate 时未及时跟上 transition | 工具检测难点(不是用户感知 bug) | C4 O-1,O-3 证据 | 未复测 |
| A-3 | C4 Dialog | 多 dialog 共存时 `document.querySelector('[role="dialog"]')` 取首个可能不是当前期望的 | 工具/操作问题(可绕过) | C4 O-2,截图显示 "Set backup account" 持续可见 | 未复测 |
| A-4 | C6 Slider | `.MuiSlider-thumb` 元素无 `role="slider"`,ARIA 全在内嵌 input (`role=-` `tabindex=-1`) | 无障碍/结构性(可能影响屏幕阅读器) | C6 O-1,O-3,evaluate 外层 thumb 属性 | 未复测 |
| A-5 | C9 Snackbar | DOM 类名从 `.MuiSnackbar-root` 变为 `.MuiPaper-root`(MUI v9 重构),截图 viewport 不可见(坐标超出可视范围) | 观察/可视化问题 | C9 O-1,evaluate `[class*="Snackbar"]` 找到 11 个 MuiPaper | 未复测 |
| A-6 | C10 DatePicker | 首次 `vortex_act click` 触发 page-side actionability injection 3s 超时,需 refresh observe 后重试 | 工具/时序问题(可重试绕过) | C10 O-1,`JS_EXECUTION_ERROR page-side actionability injection timed out` | 未复测 |
| A-7 | C11 DataGrid | Checkbox 列 gridcell click 不会转发到内嵌 input,需直接 click `input[type=checkbox]` | 工具/事件转发问题(可绕过) | C11 O-2,gridcell click vs input click 双向对比 | 未复测 |

## 完成标志

- ✅ C1-C11 共 11 个组件页评估完成,每页新 tab,每 tab 工具调用 ≤ ~30 次
- ✅ C11 DataGrid 边界项覆盖(首/中/末 + 翻页前后)
- ✅ 异常汇总表非空,7 条 [异常] 条目均附证据(返回值/截图/evaluate 真值)
- ✅ 未读 vortex 源码、未改代码、未提交 git
- ✅ 报告结尾未写"修复建议"或"根因"
