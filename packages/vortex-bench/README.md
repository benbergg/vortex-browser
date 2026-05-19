# @bytenew/vortex-bench

vortex 工具链的 **mechanical bench** —— 通过 Element Plus playground + TypeScript 断言脚本，零 LLM 成本地回归测试 vortex MCP 工具。

## 为什么推倒旧 bench 重建

v0.5.0 之前是 LLM-driven agent bench（ReAct loop + MiniMax/Claude），单场景 L2 $3、L3 $8，且 express 静态 fixture 跟真实 SPA 踩坑（Element Plus teleport popper / fill kind=select）完全错位。v0.6.0 换成：

- **Playground**：Vite + Vue3 + Element Plus，真 SPA，真组件库
- **Case**：TypeScript 脚本直接 call MCP 工具 + 断言，不走 LLM
- **指标**：`callCount` / `fallbackToEvaluate` / `observeMissedPopperItems` / `durationMs`
- **基线**：`baseline.json`，diff 超阈值退 non-zero

v0.5.x 的 VB_Index 打分体系归档在 git 历史里（tag `v0.5.0`），不再维护。

## 目录

```
packages/vortex-bench/
├── playground/              # Vite dev server，跑在 localhost:5173
│   ├── src/pages/           # 每个 widget 一个 .vue
│   └── vite.config.ts
├── cases/                   # 每个 case 一个 .case.ts（tsx 直接跑）
├── src/
│   ├── index.ts             # CLI 入口
│   └── runner/
│       ├── mcp-client.ts    # MCP stdio（保留自旧 bench）
│       ├── trace.ts         # 工具调用记录（保留自旧 bench）
│       ├── run-case.ts      # 跑一个 case 收集指标
│       └── diff.ts          # baseline 对比
├── reports/baseline.json    # 基准指标
└── package.json
```

## 前置

- 真实 Chrome + vortex extension 已加载激活
- vortex-server 已起在 ws 6800

## 使用

```bash
# 1. 起 playground（独立终端长跑）
pnpm -F @bytenew/vortex-bench playground        # localhost:5173

# 2. 跑 case（另一终端）
pnpm -F @bytenew/vortex-bench bench run el-dropdown
pnpm -F @bytenew/vortex-bench bench run --all
pnpm -F @bytenew/vortex-bench bench run --all --repeats 3  # median + majority-pass
pnpm -F @bytenew/vortex-bench bench diff        # 和 baseline.json 比
pnpm -F @bytenew/vortex-bench bench baseline    # 把当前结果写成新 baseline
```

`--repeats N` 让每个 case 跑 N 次后聚合：numeric 字段取 median，`passed` 走 majority-pass（`passRate ≥ 0.5`，平票算 pass），report 多出 `n=N pass=X.XX` 列暴露 flakiness。N=1（默认）保持向后兼容的单跑行为，输出字节不变。

## 覆盖矩阵

> Baseline 状态：v0.5 时代的 26-case baseline 已归档到 `reports/archive/baseline-v0.5-26cases-2026-04-22.json`，当前 case 总数 **38**。`reports/baseline.json` 待用 `pnpm bench:baseline` 重新生成（见 [`reports/README.md`](reports/README.md)）。

| case | widget | 状态 | 信号 |
|------|--------|------|------|
| el-dropdown | teleport menu | ✓ | observe 抓 popper |
| el-select-single | 单选 | ✓ | fill kind=select |
| el-select-multiple | 多选 tag | ✓ | fill kind=select value=[...] |
| el-cascader | 级联 3 级 | ✓ | CDP 打开 panel + page-side 逐级 click |
| el-date-picker-daterange | 日期段 | ✓ | CDP 真鼠标 + 年箭头跨年加速 |
| el-date-picker-datetimerange | 日期时间段 | ✓ | 同上 + time input 预设 + OK 轮询 |
| el-form-composite | 组合表单 | ✓ | label 匹配，checkbox-group driver |
| el-tree | 树形节点 | ✓ | observe 收 `[role=treeitem]` |
| el-table | 多选 + 展开行 + 行内按钮 | ✓ | `:nth-child + .el-button` 链式定位 |
| el-dialog-nested | dialog 内套 select | ✓ | dialog + 嵌套 select 完整走通 |
| el-upload | 文件上传 | ✓ | `vortex_file_upload` |
| **el-radio-group** | radio 选项 | ✓ | observe 收 `label:has(input[type=radio])` 替代隐藏 input |
| **el-time-picker** | 单独 time | ✓ | 新 `element-plus-time` driver：CDP 打开 panel → 三列 spinner 滚动 + click → 确定 |
| **el-message-box** | 命令式弹窗 | ✓ | 弹窗 teleport 到 body，observe 抓"确定"按钮 |
| **el-drawer** | 抽屉 + 内嵌 input | ✓ | drawer 滑出后内部 input 走 vortex_type |
| **el-input-number** | 数字输入 + step | ✓ | type + Tab 触发 blur commit |
| **el-autocomplete** | 异步建议 | ✓ | type + wait_idle 等 debounce popper + observe click |
| **el-tabs** | 标签页 + 内嵌 widget | ✓ | `[role=tab]` observe 直接命中 |
| **el-pagination** | 页码 + size | ✓ | aria-label="page N" 作 accessibleName |
| **el-tree-select** | tree 作 select 选项 | ✓ | trigger click 开 + treeitem observe 逐级展开 |
| **el-slider** | 滑块 + show-input | ✓ | focus input（click 自动 focus） + Backspace 清空 + 键入 + Enter |
| **el-transfer** | 穿梭框 | ✓ | observe 收 label-wrapped checkbox，点"向右"按钮 |
| **el-color-picker** | 颜色 panel | ✓ | trigger click 开 panel → hex input type → 确定 |
| **el-select-v2** | 虚拟滚动 select（1000 项）| ✓ | fill kind=select 直接命中前几条 |
| **el-select-v2-virtual** | 跨屏选（Option 500）| ✓ | filterable + type 过滤让 virtual list 剩匹配项 |
| **el-slider-drag** | CDP 真拖拽（20 → 80） | ✓ | 新 `vortex_mouse_drag` 工具：N 步 move + mouse down/up |

### 复杂网页 / dogfood fixture cases

灵感来自真站，但实际跑在本地 `playground/public/*.html` fixture 上（避免反爬 / 网络抖动 / ToS 风险）。

| case | 模式 | 模拟的真站特征 |
|------|------|----------------|
| `jd-review-rm-01-open` | 弹窗触发 | JD 评价：`div + cursor:pointer` 触发，弹窗 portal 渲染 |
| `jd-review-rm-02-switch-tab` | 同 class 多 tag 切换 | 多个相同 class 的标签 tab，依赖 vortex ref 精确点击 |
| `jd-review-rm-03-scroll-load` | 内部 container 滚动加载 | 评价区滚动触发懒加载，`vortex_act(action='scroll')` 命中内部容器 |
| `jd-review-rm-04-close` | div close icon | 无 role 无 aria-label 的关闭 div + Escape 兜底 |
| `jd-review-rm-05-photo-tag` | keyword tag 切换 | "图/视频5000+" 异文本嵌套（P1 ancestor-text fix 验证点）|
| `jd-review-rm-06-sort-toggle` | active 状态切换 | `is-active` class 互斥切换的 sort label |
| `iframe-nested-with-content` | 3 层嵌套 iframe | 跨 frame 元素可被 `vortex_observe(frames=all-permitted)` 捕捉 |
| `aria-cursor-nested-no-dup` | ARIA + cursor:pointer 嵌套去重 | 防 dual-instance：`<li role=menuitem>` 内层 `<div cursor:pointer>` 不重复输出 |
| `icon-name-priority` | icon 命名优先级 | svg `<title>` > alt > aria-label > className（denylist for `el-`/`ant-`/`iconfont`）|
| `cross-observe-ref-stale` | hashed ref 跨 observe | 第二次 observe 后用旧 ref 抛 `STALE_SNAPSHOT`（v0.8 sub-A 防回归）|
| `shadow-dom-counter` | open shadow root + custom element | observe 透过 `attachShadow({mode:'open'})` 抓到内层 button + act/click 通；invariant I22 mock-CDP 路径的真 Chrome 镜像 |
| `async-loading-spinner` | spinner → content 异步转场（~800ms `setTimeout`）| `vortex_wait_for(mode=idle, value=dom)` 必须阻塞到内容渲染；retry-disabled 的 `readResult` 立刻读到完成态才算 pass，验证 wait_for 不被 spinner 阶段错误地放行 |
| `spa-route-residue` | Vue hash router 跨路由 unmount | `/el-radio-group` 设状态 → 跨路由跳 `/el-dropdown` → 跳回 `/el-radio-group`，断言 Vue router 正常 unmount，状态归零；防 `<KeepAlive>` / vortex_navigate no-op 类回归 |

> 想加新真站灵感 case：把 fixture HTML 落在 `playground/public/<name>.html`，case 文件用 `playgroundPath: "/<name>.html"`（注意不走 SPA hash router，是 vite static serve），开头加 `// Fixture-based: ...` 注释。

## v0.6.0 → (latest) 修复记录

**本轮 vortex 修复（3 case 从 ✗ 变 ✓ + 1 case fallback 降 0）**

| commit 目标 | 改动 | 影响 case |
|------------|------|-----------|
| 注册 `element-plus-select` driver | `COMMIT_DRIVERS` 加 spec + page-side 实现（open trigger → match label → click → close for multi）| select-single fb 2→0、select-multiple ✗→✓、dialog-nested ✗→✓ |
| `readHeaderYM` 兼容英文月名 | 加英文全月名字典 + 中文"年月"并存 | datetimerange/daterange driver 翻月正确 |
| `closestSelector` 放宽：自身/祖先 / 子孙 | `target.closest(sel) ?? target.querySelector(sel)` | select driver 支持外层 `[data-testid]` 作 target |
| 错误消息动态生成 | `Known: ${COMMIT_DRIVERS.map(d => d.kind).join(", ")}` 替换硬编码 | 消除"声称支持却拒绝"自相矛盾 |
| diff classifier 改 priority | 真改进（passed/fallback/missed 降）优先于 warning；duration 波动不判 regressed | 让 improve 能被看见 |

## 下一批 vortex 待优化点

| 优先级 | 问题 | 信号 |
|--------|------|------|
| ✅ done | driver click 从 `dispatchEvent(MouseEvent)` 改为 CDP 真鼠标 `Input.dispatchMouseEvent`（isTrusted=true） | daterange ✓ 修好 |
| 🔴 P0 | **datetimerange 需要 time picker 子流程**：day click 后 Start/End Time inputs 仍空，OK button disabled；需 driver 额外实现"点开 time popper → 选 HH/MM/SS → 确定"整条链 | datetimerange 仍 ✗（但 driver 现在明确报告 "OK button still disabled" 作为可定位的 failure）|
| 🟠 P1 | `kind=cascader` 未注册 + cascader trigger 对 JS `.click()` 不响应 | el-cascader 完全 fail |
| 🟠 P1 | `kind=checkbox-group` spec 需要 `.el-checkbox-group` 作 root，但 form 里是 `[data-testid="form-tags"] > .el-checkbox-group`。closestSelector 已改宽松，但 driver 接受 `{values:[]}` 格式，case 传 `value=[...]` 失败 | form-composite 里 checkbox 空 |
| 🟠 P1 | `vortex_fill` plain 模式对 Vue `<el-input>` 不 dispatch 'input' 事件 → v-model 不响应（当前 workaround 用 `vortex_type` 逐字符输入）| form-composite 的 name |
| 🟡 P2 | el-tree 点 label 后 `expand-on-click-node` 没生效，或 observe 刷新跟不上，子节点看不到 | el-tree missed=2 |
| 🟡 P2 | observe 对主 frame 的 teleport popper 偶尔捕捉不到（flaky）| el-dropdown fb/missed 跳动 |

> **最高 ROI**：P0 用 CDP 真鼠标重写 driver 的 click。一次改动能同时救活 daterange / datetimerange / 以及未来所有基于动画/picker 的 Element Plus 组件。

> 性能问题（每 case 30s）已在 v0.6.0 通过"navigate 前先 about:blank"解决，基线下每 case ~5-10s。

## 使用流程

```bash
# 开发流：改 vortex → 跑 bench → 看 diff
pnpm -F @bytenew/vortex-bench playground   # 独立终端
pnpm bench run --all                       # 跑全部 case → latest.json
pnpm bench diff                            # 和 baseline.json 比

# 修 vortex 验证改进：
# 若 diff 出现 improved，说明修复生效，再：
pnpm bench baseline                        # 把 latest 当新 baseline
```
