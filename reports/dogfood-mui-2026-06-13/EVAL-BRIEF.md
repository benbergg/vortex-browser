# M3 评估简报 — MUI(Material UI)官网 dogfood

> 你(MiniMax-M3)是本轮评估的**执行者+记录者**。唯一职责:用 vortex MCP 工具操作 MUI 官网组件演示页,**如实记录"我做了什么 / 工具返回了什么 / 看到了什么"+证据**。

## 🔴 防缓存漂移协议(硬性,必须遵守)

1. **每个组件页用全新 tab**:`vortex_tab_create({url, active:true})` 打开 → 在该 tab 内完成评估 → `vortex_tab_close`。**不要**在同一 tab 内 `vortex_navigate` 连续切到下一个组件页(上轮单 tab 连续切页触发 page-side 缓存漂移、污染观察)。
2. **每个 tab 工具调用控制在 ~30 次内**;一页评估完就关 tab、开新 tab 评估下一页。
3. **撞到异常时立刻在全新 tab 里复测一遍最小序列**:标注「旧 tab 出现/新 tab 是否复现」。这一对照是关键证据。

## 铁律

1. **只记观察,不做根因诊断**。禁止写"根因是 xxx 代码"。不读 vortex 源码、不猜实现。只写现象+证据。根因判定由 Opus 负责。
2. **每条异常带证据**:工具原始返回值(截关键字段)、`vortex_screenshot`、`vortex_evaluate` 读到的 DOM 真值。
3. **区分"工具缺陷"与"我操作失误"**:同一操作至少试 2 种合理方式(act 文本失败就 observe 拿 ref 再 act;或 evaluate 兜底),都失败才记异常,两种尝试都写进证据。
4. **虚拟列表/长列表(如 DataGrid)必须覆盖边界项**:首项 / 末项 / 滚动后的中间项都试 act,不要只测一个就下结论(上轮虚拟列表的缓冲项边界是关键)。
5. **不改任何代码,不提交 git**。只产出报告文件。

## 目标站

MUI 官方组件演示站:`https://mui.com/material-ui/react-<组件>/`,日期选择器/数据网格在 `https://mui.com/x/react-<...>/`。演示 demo 内联在各组件页。

## 工具(仅用 vortex MCP)

`vortex_tab_create`/`vortex_tab_close` / `vortex_observe`(filter=interactive 优先) / `vortex_act` / `vortex_fill` / `vortex_press` / `vortex_evaluate`(读 DOM 真值) / `vortex_screenshot` / `vortex_wait_for`

## 评估范围(每页新 tab;重点选择类/浮层/Portal/虚拟列表)

| # | 组件页 URL | 核心交互(逐个试) |
|---|-----------|------------------|
| C1 | /material-ui/react-select/ | Select 下拉(Portal Menu):打开→选项;multiple 多选 |
| C2 | /material-ui/react-autocomplete/ | Autocomplete:聚焦→输入筛选→选建议项(combobox+Popper) |
| C3 | /material-ui/react-menu/ | Menu(Portal):点按钮开→点 menuitem |
| C4 | /material-ui/react-dialog/ | Dialog:开→内部操作→关 |
| C5 | /material-ui/react-drawer/ | Drawer:开→内部→关 |
| C6 | /material-ui/react-slider/ | Slider:点聚焦→方向键调值;范围滑块 |
| C7 | /material-ui/react-text-field/ | TextField:fill 文本;type 文本;读 value |
| C8 | /material-ui/react-checkbox/ | Checkbox/Radio/Switch:点勾选→读 checked |
| C9 | /material-ui/react-snackbar/ | Snackbar(toast):触发→观察提示出现(注意 act 的 userFeedback) |
| C10 | /x/react-date-pickers/date-picker/ | DatePicker:开面板→选日期→读 value |
| C11 | /x/react-data-grid/ | **DataGrid(虚拟滚动)**:滚动→点首/末/中间行的单元格或复选框(覆盖边界项) |
| C12 | /material-ui/react-rating/ | Rating:点第 N 颗星→读 value |
| C13 | /material-ui/react-tooltip/ 或 react-popover/ | Tooltip/Popover:hover/点触发→读浮层内容 |
| C14 | /material-ui/react-tabs/ | Tabs:点不同 tab→读激活态 |
| C15 | /material-ui/react-transfer-list/ | Transfer List:选项→移动按钮 |

(优先 C1-C11;C12-C15 行有余力再做。每页都新 tab。)

## 输出格式

写到 `reports/dogfood-mui-2026-06-13/eval-observations.md`,结构:

```markdown
# MUI 评估观察 (M3)

日期: 2026-06-13 | 站点: mui.com | 工具: vortex MCP | 协议: 每页新 tab

## 观察记录

### C1 react-select (全新 tab <id>)
- **O-1** [正常] observe 抓到 ... act click ... evaluate 读 ...(证据)
- **O-2** [异常] ...(现象)。证据:返回值/截图/evaluate 真值。**旧tab出现/新tab复测结果**。
...

## 异常汇总(Anomaly)
| ID | 组件 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|----------------|----------|--------------|
```

- 每条观察标 `[正常]`/`[异常]`;异常严重度是主观感受(疑似阻断/体验问题/存疑),非判定。
- 报告结尾**不要**写"修复建议"/"根因"。

## 完成标志

eval-observations.md 写完,异常汇总表非空(若真无异常,明确写"未发现异常"并说明试了哪些)。
