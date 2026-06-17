# 感知层盲区信号 A 族 — 真站 spike 证据（2026-06-17）

> Phase 1 第一步：用 vortex MCP 真站 spike 验证 backlog A 族盲区是否真实存在 + observe 是否确实不给降级信号。
> 结论：**A1/A2/A3 真站实锤；A4/A5 读码确认。A 族是真实设计缺口。**

## A2 虚拟列表（🟢真站确认）
- 站点：`https://www.ag-grid.com/example/`（Performance Grid）
- 量化：`.ag-center-cols-container` 高 42000px / 行高 42px = **总 1000 行**；DOM 仅渲染 **32 行**；combobox 自标 "1,000 Rows, 22 Cols"。
- observe(scope=full,filter=all) 实际 surface：表头 + 筛选行 + 数据**行 1-8**（视口内）。
- **缺陷**：输出**零虚拟化/总数/盲区信号**。agent 看到 row 1..8 会把局部当全局，不知下方 992 行不在 DOM。
- 召回率 ≈ 0.8%（8/1000，视口可见）~3.2%（32/1000，DOM 渲染）。

## A1 canvas 画布（🟢真站确认）
- 站点：`https://excalidraw.com/`（2 个 canvas 2880x1576）
- 操作：press 'r' 选矩形工具 + mouse_drag 画一个矩形 → localStorage `excalidraw` 场景 **3 个元素**。
- observe(scope=full) 结果：30+ 工具栏按钮全召回，画布作**单个不透明元素** `Canvas "绘制 Canvas" [cursor=pointer][listener]`，**内部 3 个图形对象 0 召回**。
- **缺陷**：无「canvas 编辑器 / 内部 N 对象不可观察」信号。agent 只见「一个可点 canvas」，不知里面有可选/移/删的图形。

## A3 closed-shadow（🟢构造页确认）
- 页面：example.com 注入 closed-shadow host（button+input）+ open-shadow host（button，对照）。
- 外部读 `closed-host.shadowRoot === null`（闭合不可达），`open-host.shadowRoot` 可达。
- observe 结果：open shadow 按钮**正常召回**（对照组 OK）；closed shadow 的 button+input **0 召回**，连 `#closed-host` 空壳都不出现。
- **缺陷**：agent 对闭合 shadow 内可交互内容零感知 + 无盲区信号。

## A4 截断 / A5 iframe（🟡读码确认，P2）
- A4：observe.ts:2086 `truncated` 仅布尔，无 truncatedCount / candidateCount，agent 不知漏多少。
- A5：observe.ts:2376-2387 frame 级 `scanned:false`，但 CompactElement（observe-render.ts:64-72）无 per-element「来自未扫 frame」反向标记。

## 共性根因
observe 因技术限制（虚拟化窗口外 / canvas 像素 / 闭合 shadow / 预算截断 / 跨域 frame）扫不全时，**静默返回局部视图，不发任何「盲区/已降级/已截断」信号**。这是元瓶颈：让 agent 系统性把局部当全局。修复 = 为 observe 输出新增**盲区降级信号契约**（非改 bug，需设计 review）。
