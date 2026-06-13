# MUI dogfood 校验结论 (Opus)

日期: 2026-06-13 | 站点: mui.com / mui.com/x | 校验者: Opus(白盒 + live 复现)
评估者原始观察: `eval-observations.md` (M3, C1-C11, 7 条 anomaly + 多处 [工具缺陷] O-4 标记)

## 校验方法

铁律:M3 措辞不可信,每条异常都用 vortex 工具在**清洁新 tab** live 复现 + 必要时白盒。
区分「vortex 工具失败」与「M3 旁路 evaluate 读 DOM 遇到的 MUI 实现细节」。

## 逐条结论

| ID | M3 现象 | 校验动作 | 结论 |
|----|---------|----------|------|
| A-1 | Multiple select `textContent` 只报最后项、chip 区不可见 | 亲手复刻:选 Oliver+Van,evaluate 读 combobox | **非 vortex 缺陷**。`textContent` 只返回 "Van Henry" 是 MUI multiple select 的 chip DOM 序列化特性(我亲手用 evaluate 也卡同样结果);chip 不可见 = 本环境 dark theme(`color: rgb(255,255,255)`)。**全程无 vortex 工具失败**——M3 是旁路 evaluate 读 textContent,vortex_observe 走 a11y tree(M3 自承 `aria-selected` 两项都 true)。 |
| A-2 | Dialog 关闭后 `visibility:hidden` 但 width>0,DOM 不 unmount | 给 hidden dialog 内 Cancel 按钮加标记,`vortex_act click` | **vortex 行为正确**。actionability 返回 `NOT_VISIBLE` 正确拒绝点击 visibility:hidden 元素。M3 用 width>0 判断 open 是其 evaluate 读法局限,与 vortex 无关。 |
| A-3 | 多 dialog 共存时 `querySelector('[role=dialog]')` 取首个 | — | **纯 M3 操作问题**,无 vortex 工具面。M3 自己用原生 querySelector 取首个,与 vortex 无关。 |
| A-4 | `.MuiSlider-thumb` 无 `role=slider`,ARIA 全在内嵌 input | M3 报告 C6 O-1 已记录 vortex_press ArrowRight 调值 30→33 成功 | **MUI 设计**(Slider 用 `input[type=range]` 承载 ARIA),非缺陷。vortex 通过 input 识别 + press 调值已成功(M3 自证)。 |
| A-5 | Snackbar 类名 `.MuiSnackbar-root`→`.MuiPaper-root`(v9),截图视口外不可见 | `vortex_act click observeEffect` 触发 snackbar | **vortex 行为正确**。observeEffect 捕获 `userFeedback: "toast"`,`toastHit: ["[role='alert']"]`。vortex TOAST_SELECTORS 走语义选择器 `[role='alert']` 不依赖类名,MUI v9 重构无影响。 |
| A-6 | 首次 `vortex_act click` 报 `JS_EXECUTION_ERROR page-side actionability injection timed out`(3s) | 清洁 tab,observe → act click DatePicker,Escape 重开再 click | **未复现(瞬态)**。两次首次 click 均成功(realMouse)。M3 那次极可能在页面未完全加载/冷启动时撞上 actionability 注入 3s cap。watch-item:重型 React 页冷启动注入偶发超时,非稳定缺陷。 |
| A-7 | DataGrid checkbox 列 gridcell click 不转发到内嵌 input | 给 gridcell 容器加标记,`vortex_act click` 走容器 | **非 vortex 缺陷,vortex 正常路径成功**。vortex_act realMouse 点 gridcell 容器 → `checked=true rowSelected=true`,物理坐标点击命中内嵌 input。M3 失败因其用 evaluate 合成 `.click()` 点容器 div 不携带真实事件路径——正是 vortex 用 realMouse 的价值。 |
| O-4 | observe 在 portal menu/listbox expanded 时不暴露 option/menuitem 的 ref(C1/C2/C3/C5 反复标 [工具缺陷]) | 清洁 tab,act click 打开 basic select,observe interactive | **observe 实际正常暴露,M3 误判**。下拉打开后 observe 列出 `option "Ten"/"Twenty"/"Thirty"` 三个 ref。M3 是没在下拉打开后二次 observe 就用 evaluate 兜底了。 |

## 总结论

**0009 MUI cycle:零 vortex 缺陷。**

7 条 anomaly + O-4 标记全部为:① vortex 行为正确(A-2/A-5/A-7/O-4 直接 live 证)② MUI 实现细节/设计(A-1/A-4)③ M3 旁路操作问题(A-3)④ 瞬态未复现(A-6)。

MUI(react-select / autocomplete / menu / dialog / drawer / slider / text-field / checkbox / snackbar / datepicker / datagrid)主流复杂组件库全套被 vortex 正确处理。印证 act 原语白盒审计(批次1-5)后已达产品标准——连 MUI 这种 Portal/虚拟列表/受控组件密集的库都零缺陷。

无代码改动,无需 commit 代码。

## watch-item(非缺陷,留观察)

- **A-6 冷启动注入超时**:重型 React docs 页首次 act 偶发 `actionability injection timed out` 3s cap。清洁态不复现。若后续多站复现可考虑首次注入冷启动重试或 cap 调整,本轮证据不足以判定缺陷。
