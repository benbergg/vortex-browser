# 语雀 Lake Sheet 结构化 readback 设计（`vortex_query mode=sheet`）

> **状态**：设计已确认待评审（2026-07-01）。下一步 → writing-plans。
> **范围**：仅语雀 Lake Sheet 专用适配器（非通用 canvas 表格框架）。

## 1. 背景与目标

vortex 是 text-first 的浏览器感知层。语雀（yuque.com）数据表文档用**单块 canvas** 渲染电子表格，cell 数据完全不在 DOM 里——observe/extract 对着一张几百上千行的表只能返回 0 个 cell，模型据此会误判"页面无内容"。

**目标**：让 vortex 能把语雀 Lake Sheet 的表格数据以**结构化文本**（默认 Markdown）读出，并让模型能**发现**这条读取路径。哲学对齐已有的图表 Kaizen（`echarts.getOption()` / `Chart.getChart().data`）：**调 app 已解析好的内存模型，不自己解析原始格式**。

## 2. 问题实测画像（`banniu.yuque.com` 数据表，2026-07-01 实机）

| 维度 | 实测 |
|---|---|
| 渲染 | 单 `<canvas>`（1050×533）在 `.lake-sheet-canvas-container`；format=`lakesheet` v3.5.5 |
| DOM 表格 | **0** 个 `<table>` / `role=grid` / `gridcell`；可见文本仅 17 字符 |
| observe 现状 | 报 `# blindspots: list virtual(~2591/17)`——**只报警不给读法**，且 `~2591` 是 DOM 启发式粗估（真值见下） |
| 官方 API | `GET /api/docs/{slug}?book_id=…` 返回 `content`（16 万字符），但 `sheet` 字段是 **zlib 压缩的私有 lakesheet 格式**（自解压+逆向 schema 很重）→ 不走此路 |
| 内存模型 | React fiber 可达、app 已解压解析、含**全量行**（不受虚拟化限制）→ **采用此路** |

**同行业共识**：canvas 电子表格的 cell 数据永远从数据模型/API 取，绝不从像素抠；截图+VLM 是低保真、仅视口的最后兜底。Playwright/Selenium 无 canvas 读取能力；browser-use/Stagehand 退化到截图。所有 canvas 表格库（Luckysheet/Univer/AntV S2/SpreadJS）都暴露 JS 模型 API。

## 3. 非目标（YAGNI）

- **不**做飞书/Google Sheets/Luckysheet/Univer/S2 等其他库的适配器（用户明确锁定仅语雀）。
- **不**自己解压/解析 lakesheet 原始压缩格式（用内存模型）。
- **不**做 cell 编辑/act（纯读；用户约束"只读不改"）。
- **不**做任意中段 range 窗口读取（v1 用行数上限 + 总行数标注；任意 range 入 backlog）。

## 4. 架构总览

新增 `vortex_query` 的 `mode=sheet`。实现为一个**自包含 page-side probe 函数** `sheetProbeFunc`（与现有 `geometryProbeFunc` / `styleProbeFunc` 同构，注入 MAIN world 执行）。数据流：

```
vortex_query({mode:"sheet", pattern, attr, maxResults})
  → dispatch 到 sheetProbeFunc（注入页面）
    → 定位 LakeSheet 内核（fiber 走访，见 §5）
    → 读 model.data（维度/合并/筛选）+ model.table（2D cells）
    → 选 worksheet（pattern）
    → serializeSheet(model, {format, maxRows})  ← 纯函数，核心逻辑
  → 返回 Markdown（默认）/ CSV / JSON 文本
```

两个明确边界的单元：

- **kernel-locate**（承重墙，browser-only）：fiber 走访拿内核模型。依赖真实页面结构，只能真站 spike 验。
- **serializeSheet**（纯函数，可离线单测）：`(归一化模型, 选项) → 文本`。承载合并策略/转义/行数裁剪/格式分派，是 load-bearing 逻辑，单测打透。

## 5. 读取机制（已实测坐实的路径）

```js
// 1) 定位内核：从 canvas 容器 fiber 向上走 return 链，找 memoizedState.sheet（sig: doc+model）
const container = document.querySelector('.lake-sheet-canvas-container')
              || document.querySelector('.lake-sheet-editor');
const fk = Object.keys(container).find(k =>
  k.startsWith('__reactInternalInstance') || k.startsWith('__reactFiber'));
let fiber = container[fk], kernel = null, depth = 0;
while (fiber && depth < 40) {
  const st = fiber.memoizedState;
  if (st && st.sheet && (st.sheet.doc || st.sheet.model)) { kernel = st.sheet; break; }
  fiber = fiber.return; depth++;
}

// 2) 读当前 worksheet 模型
const m = kernel.model;
// m.data  = { name, rowCount, colCount, rows, columns, mergeCells, filter, index, id }
// m.table = 2D 数组 cell[row][col]，cell = { value }
// 合并格式 m.data.mergeCells: { "21:0": { row:21, col:0, rowCount:3, colCount:1 } }
```

**实测样本**（当前活动 sheet「历史宝洁反馈评价情感不准案例」）：`rowCount=199, colCount=27, mergeCount=25`；表头 `[订单号, 评价内容, 平台评价情感, 班牛评价情感, 纠正后, 班牛回评内容]`；数据为真实订单号+评价文本。**cell 对象极简 = `{value}`**。

**多 worksheet**：一个 workbook 含多个 sheet（observe 里的页签 好评 / 4.15宝洁回评问题 / … 即各 sheet）。`kernel.model` 只暴露 currentSheet；切换/枚举其他 sheet 走 workbook 级集合（实现期定位：`kernel.model.value.sheet` 解析后的 sheet 列表 / 或内核的 sheet 切换 API）。v1 `pattern` 选 sheet；定位不到目标 sheet 时回当前活动 sheet 并在输出标注。

**cell 取值**：`cellText(cell) = cell?.value ?? ''`，非字符串 `String()` 化。

## 6. 工具接口（复用 query 现有字段，不新增 schema 字段守 I15 ≤8000 预算）

`vortex_query` 现有字段：`mode, pattern, attr, caseSensitive, contextChars, includeText, isRegex, maxResults`。mode=sheet 复用：

| 参数 | mode=sheet 语义 | 默认 |
|---|---|---|
| `mode` | `"sheet"` | — |
| `pattern` | worksheet 选择器：名字子串 / 索引数字 / `*`=当前活动 sheet | `*` |
| `attr` | 输出格式：`markdown` / `csv` / `json` | `markdown` |
| `maxResults` | 返回行数上限（超出截断 + 标注总行数） | `200` |

description 增量控制在最小（复用既有字段名，仅在 mode 说明里加一句 `sheet=lake-sheet 表格读取`），确保 tools/list ≤8000 不破。

## 7. 输出格式

### 7.1 Markdown（默认）

标准 GFM 表格：表头行 + 分隔行 + 数据行；末尾一行统计 `> 199 行 × 27 列，显示 1–199（sheet: 历史宝洁反馈评价情感不准案例）`。超 `maxResults` 时 `> …显示 1–200 / 共 2591 行，提高 maxResults 取更多`。

### 7.2 合并单元格：混合策略（关键）

GFM 无 colspan/rowspan，每行必须等列数矩形。按合并方向分治：

- **纵向合并**（`rowCount>1 && colCount===1`）→ **fill-down**：把锚值填进该列每一个被覆盖行。分类列自包含、最利下游处理。
- **含横向合并**（`colCount>1`，含块状 `rowCount>1&&colCount>1`）→ **锚点+空**：值放左上锚点，其余被覆盖格留空（标题 banner 不跨列重复刷）。

实现：先由 `mergeCells` 构建覆盖映射 `covered:Set<"r:c">` 与 `fillValue:Map<"r:c", string>`，序列化每格时先查 fillValue（纵向合并的填充值），否则查 covered（横向被覆盖→空），否则取 `cellText`。

### 7.3 语法安全（独立必修，所有格式生效）

Markdown/CSV 输出前对 cell 文本转义：`|` → `\|`（markdown）、`\r?\n` → 空格、首尾裁空白。CSV 按 RFC 4180 包引号转义。**此项非可选**——未转义的 `|`/换行会撑破表格。

### 7.4 CSV / JSON

- `attr=csv`：RFC 4180；合并同 markdown 混合策略（纵向 fill-down、横向空）。
- `attr=json`：`{ sheet, rowCount, colCount, rows: string[][], merges: {row,col,rowCount,colCount}[], truncated }`——**保留精确 merge span**（供需要保真的下游），rows 用锚点+空的原始形态（不 fill-down，因为 merges 已显式给出）。

## 8. observe 闭环（blindspot 指路）

当前 observe 把 lake-sheet 误分类为 `list virtual(~2591/17)`。改为**识别 lake-sheet 专类**并给精确读法指针：

```
# blindspots: sheet lakesheet(199×27) → vortex_query mode=sheet
```

- **真源** `blindspot-detect.ts`：加 lake-sheet 识别（`.lake-sheet-canvas-container` 存在 + 能定位内核 → 读 `model.data.rowCount/colCount` 出维度）。产 `{kind:"sheet", lib:"lakesheet", rows, cols}`。
- **inline** `observe.ts` 页级扫描镜像（parity 断言同步，遵循既有"改一处须改两处"）。
- **渲染** observe-render：`sheet lakesheet(RxC) → vortex_query mode=sheet`，镜像 chartReadback 指针。
- **成本**：仅当页面存在 `.lake-sheet-canvas-container` 时才做一次有界 fiber 走访（depth≤40），不影响普通页 observe。
- lake-sheet 识别应**优先于**通用 virtual-list 分类，给出精确 per-sheet 维度（当前 sheet `199×27`）取代粗略的 DOM 虚拟估算 `~2591`（后者非模型真值，是 DOM 滚动启发式）。

## 9. 错误与兜底

- 页面无 lake-sheet / 内核未加载完（fiber 走访失败）→ 返回干净错误信息，指向 `vortex_screenshot`（Route C 视觉兜底）。
- 内核在但 sheet 为空 → 返回空表 + 维度标注，不报错。
- `pattern` 指定 sheet 未命中 → 回当前活动 sheet + 标注"未找到 sheet X，返回活动 sheet Y"。

## 10. 只读安全

`sheetProbeFunc` 全程纯读（读 fiber/model 属性、调 `getRowSize` 等 getter），**不调用任何写命令**（不碰 `kernel.command`/`history`/`ot`）。满足用户"只读不改"约束。若需构造测试数据，另建新表，不动被测表。

## 11. 组件边界与文件

| 文件 | 责任 | 类型 |
|---|---|---|
| `packages/extension/src/page-side/sheet-readback.ts`（新）| `serializeSheet(model, opts)` 纯序列化器（md/csv/json + 合并混合 + 转义 + 裁剪）；`locateLakeSheetKernel(doc)` fiber 走访 | 真源 |
| `packages/extension/src/handlers/query.ts`（改）| `mode=sheet` 分派：注入 `sheetProbeFunc`（内联 serializeSheet + locate）→ 收集 → 返回 | 承重墙 inline |
| `packages/extension/src/page-side/blindspot-detect.ts`（改）| 加 lake-sheet 识别 → `{kind:"sheet",lib,rows,cols}` | 真源 |
| `packages/extension/src/handlers/observe.ts`（改）| blindspot 页级扫描内联 lake-sheet 识别（parity）| 承重墙 inline |
| observe-render（改）| `sheet lakesheet(RxC) → vortex_query mode=sheet` 指针 | 渲染 |
| `packages/mcp/src/tools/schemas-public.ts`（改）| `vortex_query` mode enum 加 `sheet` + mode 说明加一句 | schema |
| `packages/extension/tests/sheet-readback.test.ts`（新）| serializeSheet 纯函数单测（合并三态/转义/裁剪/格式） | 测试 |
| `packages/extension/tests/query-sheet-parity.test.ts`（新）| inline↔真源 parity 断言 | 测试 |

## 12. 测试策略

- **纯序列化器单测**（离线，合成模型，无浏览器）——load-bearing，打透：
  - 纵向合并 fill-down（值填每行）；横向合并锚点+空（不重复）；块状合并；
  - 转义（cell 含 `|`/换行）；
  - 行数裁剪（rowCount>maxResults → 截断 + 总数标注）；
  - 三格式（markdown/csv/json）分派；json 保留精确 merge span；
  - 空 sheet / 单行 / 宽表。
- **parity 断言**：observe.ts / query.ts 内联副本含真源关键判据字符串（遵循既有 `[inline …]` 标记模式）。
- **承重墙真站 live 验收**（用现开的 `banniu.yuque.com` 表）：`vortex_query mode=sheet` 返回「历史宝洁反馈评价情感不准案例」，维度 199×27，表头 订单号/评价内容/…，合并折叠正确；observe 出 `sheet lakesheet(199×27) → …` 指针。
- ext / mcp 全量单测回归；tools/list ≤8000 断言不破。

## 13. 分工（opencode-m3 SOP，见 [[vortex_opencode_m3_tmux_sop]]）

- **派 M3**：`serializeSheet` 纯序列化器 + 其单测（自包含、判据明确、可离线单测、逐字 SDD brief）。
- **orchestrator 自留**：`locateLakeSheetKernel` fiber 走访、query/observe inline 承重墙、blindspot 识别、真站 live 验收、parity。
- **并发铁律**：M3 与 orchestrator 不同时编辑同一文件；serialize 真源先由 M3 提交 → orchestrator 接手 inline。

## 14. 验收标准

1. `vortex_query mode=sheet` 对语雀 Lake Sheet 返回结构化 Markdown，维度/表头/数据与页面一致（真站验）。
2. 合并单元格按混合策略正确渲染（纵向 fill-down、横向锚点+空），无 `|`/换行破格。
3. `attr=csv`/`json` 正确；json 保留精确 merge span。
4. observe 对 lake-sheet 出精确 `sheet lakesheet(RxC) → vortex_query mode=sheet` 指针，纠正 virtual 误分类。
5. 非 sheet 页 / 未加载 → 干净兜底指向 screenshot。
6. 纯读、不改被测表；全量单测 + tools/list 预算回归通过。

## 15. 风险

- **私有内存 schema 易变**：`memoizedState.sheet.model.table/data` 是语雀内部结构，版本升级可能改（当前 lakesheet v3.5.5）。缓解：locate 用宽松签名探测（`doc||model` + `data.table` 存在性）而非硬编码深路径；失败干净降级到 screenshot。
- **多 sheet 枚举**：workbook 级 sheet 集合的确切访问路径待实现期在真站确认（v1 至少保证活动 sheet；跨 sheet 定位不到则回活动 sheet + 标注）。
- **超大表 token**：maxResults 默认 200 兜底；任意中段 range 入 backlog。
- **fiber 走访成本**：仅在 lake-sheet 存在时触发，有界 depth，可接受。

## 16. Backlog（本期不做）

- 任意行区间 range 窗口读取（当前仅"前 N 行 + 总数"）。
- 公式/条件格式/单元格样式保真（v1 只取显示值）。
- 其他 canvas 表格库适配器（飞书/Google/Univer/S2）——若未来需要再起通用框架子项目。
