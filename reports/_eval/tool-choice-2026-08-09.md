## 结论
本轮盲选没有观察到总体偏向 Playwright：本地靶场 6 个任务全选 Vortex，公开站点 4 个任务全选 Playwright；按任务类型分流，而不是总能力偏好。
Vortex-only 完成 8/10，两个失败在 Playwright 中也无法完成，说明本轮没有实证的 Vortex 能力缺口。
更明确的原因是描述和可发现性：Vortex 的 `vortex_fill` 值形状需要靠错误反馈推断，`vortex_query` 的 `sheet` 描述还把我引向了不适合 DOM 表格的路径；Playwright 的完整动作句和网页调试入口让我在公开站点更快做出选择。

## 轮 A：盲选结果
| 任务号 | 主要用了谁 | 完整工具调用序列 | 选择理由 | 是否完成 |
|---|---|---|---|---|
| 1 | Vortex | `vortex_vortex_navigate`（大写路由空内容）→ `vortex_vortex_observe` → `vortex_vortex_extract`（空 main）→ `vortex_vortex_navigate`（小写路由）→ `vortex_vortex_observe` → `vortex_vortex_act`（打开）→ `vortex_vortex_observe` → `vortex_vortex_act`（华东）→ `vortex_vortex_observe` → `vortex_vortex_act`（上海）→ `vortex_vortex_observe` → `vortex_vortex_act`（浦东）→ `vortex_vortex_extract` | 本地组件有清晰的 a11y menu/ref；`vortex_observe` 能把级联层级直接展开，`vortex_act` 适合逐层点击。 | 是，`华东/上海/浦东` |
| 2 | Vortex | `vortex_vortex_navigate` → `vortex_vortex_observe` → `vortex_vortex_act`（打开）→ `vortex_vortex_observe` → `vortex_vortex_act`（展开华东）→ `vortex_vortex_observe` → `vortex_vortex_act`（上海）→ `vortex_vortex_observe` → `vortex_vortex_act`（杭州）→ `vortex_vortex_extract`（错误 ref）→ `vortex_vortex_observe` → `vortex_vortex_query`（checkbox CSS）→ `vortex_vortex_query`（component 选择器错误）→ `vortex_vortex_query`（`.el-tree`） | 仍先选 Vortex，因为 `observe` 能表达树层级；失败后用 `query component` 查状态，实际得到 `showCheckbox=false`。 | 否；页面没有 checkbox，且是单值选择 |
| 3 | Vortex | `vortex_vortex_navigate` → `vortex_vortex_observe` → `vortex_vortex_act`（Item 1）→ `vortex_vortex_act`（Item 2）→ `vortex_vortex_act`（Item 3）→ `vortex_vortex_observe` → `vortex_vortex_act`（右移）→ `vortex_vortex_extract`（旧 ref 失败）→ `vortex_vortex_observe` → `vortex_vortex_extract` | `observe` 明确给出 checkbox-group 和右移按钮，`act` 的点击效果也能确认勾选/移动。 | 是，右侧 `Item 1、Item 2、Item 3` |
| 4 | Vortex | `vortex_vortex_navigate` → `vortex_vortex_query`（sheet，失败）→ `vortex_vortex_observe` → `vortex_vortex_extract` | 看到表格任务时先被 `vortex_query` 的 `sheet=Lake Sheet→md/csv/json` 描述吸引；报“no lake-sheet”后改用 `observe/extract`。 | 是，3 行；第二行 `2 / Bob / 25 / 编辑 2` |
| 5 | Vortex | `vortex_vortex_navigate` → `vortex_vortex_observe` → `vortex_vortex_fill`（数组值，失败）→ `vortex_vortex_fill`（对象值）→ `vortex_vortex_extract` | `vortex_fill` 的 `widget=daterange` 看起来是专门为这个任务准备的；值结构不清楚，先按常见数组写法尝试。 | 是，`2026-08-01` 至 `2026-08-10` |
| 6 | Vortex | `vortex_vortex_navigate` → `vortex_vortex_observe` → `vortex_vortex_act`（打开）→ `vortex_vortex_observe` → `vortex_vortex_act`（打开 select）→ `vortex_vortex_observe` → `vortex_vortex_act`（选 X）→ `vortex_vortex_wait_for` → `vortex_vortex_extract` → `vortex_vortex_query`（确认文本）→ `vortex_vortex_query`（dialog component） | 本地 teleport/dialog 任务自然选择 Vortex，因为 `observe` 明确标记了 modal 和 behind-modal；选项后没有第二个 dialog 或确认按钮。 | 否；页面只有一层 dialog |
| 7 | Playwright | `playwright_browser_navigate` → `playwright_browser_snapshot` → `playwright_browser_wait_for` → `playwright_browser_snapshot` → `playwright_browser_find` → `playwright_browser_fill_form` → `playwright_browser_press_key` → `playwright_browser_snapshot` → `playwright_browser_evaluate` | 公开站点搜索入口的描述是完整的“combobox 搜索”，Playwright 的 `fill_form`/键盘提交路径一眼可用；Vortex 的公开站点导航和结果页语义不如 Playwright 直观。 | 是，第一条 `Web performance | web.dev` |
| 8 | Playwright | `playwright_browser_navigate` → `playwright_browser_snapshot` | 页面本身是长文档，Playwright snapshot 已直接列出 “There are five types...” 和五个类型。 | 是：Elevated、Filled、Filled tonal、Outlined、Text |
| 9 | Playwright | `playwright_browser_navigate` → `playwright_browser_snapshot` → `playwright_browser_take_screenshot`（标题区域元素） | `browser_take_screenshot` 明确支持 element target；Playwright snapshot 直接给出主标题 ref，选择成本最低。 | 是，截取标题区域元素 |
| 10 | Playwright | `playwright_browser_navigate` → `playwright_browser_console_messages` → `playwright_browser_network_requests`（非 static）→ `playwright_browser_network_requests`（static） | 任务明确要求 console/network，Playwright 有直接同名 DevTools 工具，且 `console_messages` 与 `network_requests` 的结果格式无需猜。 | 是，0 个 console error；1 个 CSS color warning；34 个静态请求全部 200，无失败请求 |

统计：10 个任务里 Vortex 主导 6 个，Playwright 主导 4 个，混用 0 个。

## 轮 B：vortex-only
| 任务号 | 完成 | 工具调用次数 | 失败原因（如有） | 靠猜的参数 |
|---|---|---:|---|---|
| 1 | 是 | 4 |  | `widget=cascader` 与路径数组 `[华东,上海,浦东]`；数组形状是经验，不是参数说明提供的。 |
| 2 | 否 | 4 | `vortex_vortex_query` 返回组件 `ElTree` 的 `showCheckbox=false`；页面只能选一个叶子节点。 | `.el-tree` 是为查 Vue 状态临时猜的 CSS 选择器；component 返回结构没有说明。 |
| 3 | 是 | 8 |  | 无关键猜测；checkbox 和右移按钮由 observe 给出。 |
| 4 | 是 | 2 |  | 无；先尝试了 `vortex_vortex_query` 的 `mode=sheet`，其 `pattern=table` 是根据页面类型猜的。该调用报 `no lake-sheet on page`，随后用 extract 完成。 |
| 5 | 是 | 4 |  | `widget=daterange` 来自工具枚举；`value={start,end}` 没有说明，轮 A 先猜数组失败后才知道。轮 B 复用了这个形状。 |
| 6 | 否 | 8 | 选 X 后 `vortex_vortex_query` 查到 `[role="dialog"] total=1`，没有第二层 dialog，也没有确认控件。 | `vortex_vortex_wait_for mode=info` 的 value 是任意文字，语义没有说明；这里只能猜。 |
| 7 | 是 | 10 |  | `vortex_vortex_wait_for` 的 `mode=info` 和自由文本 value 是猜的；Enter 没提交时改点了 observe 给出的“所有结果” option。 |
| 8 | 是 | 2 |  | `vortex_vortex_extract maxLength=8000` 是任意取值；页面正文较长，结果被工具截断但所需 variants 已在前段。 |
| 9 | 是 | 8 |  | `vortex_vortex_screenshot` 的 target 格式没说明；先用 `vortex_vortex_query` geometry 定位标题，再猜 `[id="..."]` CSS selector，最终截图成功。 |
| 10 | 是 | 3 |  | `vortex_vortex_debug_read` 的 network filter 需要 pattern，使用 `.*`；`statusMin=400,statusMax=599` 是按 HTTP 习惯猜的。返回 console error `[]`、network failure `[]`。 |

## 轮 C：对照
| 任务号 | 轮 B 失败 | Playwright-only 结果 |
|---|---|---|
| 2 | TreeSelect 无 checkbox，无法同时勾选两个子节点。 | Playwright 也只能展开并选择一个叶子：页面标题说明是“选叶子节点”，先选 `浦东` 后 value=`浦东`，再选 `徐汇` 后 value=`徐汇`。最初直接点 combobox ref 还因 placeholder 拦截超时，改点 `.el-select__wrapper` 后可操作；仍不能满足“两项”。 |
| 6 | Dialog 只有一层，无确认控件。 | Playwright 打开 dialog、打开 select、选择 `X` 后最终状态是 `dialogOpen=true inside=X`；DOM 只有一个 dialog，没有第二层和确认按钮。 |

## 能力缺口
本轮没有被实际证实的“Playwright 能做而 Vortex 做不到”的能力缺口。

- TreeSelect 的失败由靶场状态决定：Vortex 组件查询明确 `showCheckbox=false`，Playwright 最终也只能得到单值 `浦东`/`徐汇`。
- Dialog 的失败由靶场状态决定：Vortex 查询 `[role="dialog"]` 只有 1 个，Playwright 选择 X 后也只有 `dialogOpen=true inside=X`。
- Vortex-only 的任务 7、8、9、10 全部完成，包含跨站导航、搜索、长文档读取、元素截图、console 和网络失败查询；因此没有公开站点能力缺口证据。
- Playwright 在 Task 10 看到 1 条 CSS color warning，但任务问的是 console error；Vortex 返回 0 error 并不构成任务失败。

## 描述问题清单
- `vortex_vortex_fill` 的 `widget=daterange` 只告诉我 widget 名，没有说明 `value` 必须是 `{ start, end }`。我在轮 A 先传 `[...]`，实际收到 `value must be { start, end }`，只能依靠错误消息修正。
- `vortex_vortex_query` 的 `mode=sheet` 描述是 `sheet=Lake Sheet→md/csv/json`，没有说明它只识别 Lake Sheet、不负责普通 DOM table。我因此在 ElTable 任务先选了它，得到 `no lake-sheet on page`。
- `vortex_vortex_query` 的 `mode=component` 没有说明返回的是 Vue 组件实例/props，也没有说明 selector 仍是 CSS；我没有一开始把它当作读组件状态的工具，只有 UI 操作受阻后才试 `.el-tree`。
- `vortex_vortex_wait_for` 的 `mode=info` 没有说明 value 应该填什么、会等待什么；我填了多个自由文本，工具只是返回当前 tab 状态，参数含义靠试。
- `vortex_vortex_screenshot` 的 target 描述没有说明可传 CSS selector、ref 还是元素；任务 9 中我先通过 geometry 得到标题 id，再试出 `[id="..."]` 才成功截图。
- `vortex_vortex_debug_read` 明确 network 需要 pattern，但没有把 `statusMin/statusMax` 的筛选用途说清楚；任务 10 中 `.*` 和 `400-599` 是我按习惯补出的参数。
- `vortex_vortex_extract` 的描述写“Extract visible text”，但没有提醒长页面会被截断；Task 8 结果实际出现 `[VORTEX_TRUNCATED ...]`，虽然所需内容恰好在前段。
- 路由入口不是工具能力问题，但准备阶段用户给出的 `/#/ElCascader` 大写路径只显示空 main；我从导航发现实际路径是 `/#/el-cascader`，这也增加了第一次调用成本。
