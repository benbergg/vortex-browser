# Spike 报告：act/fill 默认输入路径 —— 合成事件 vs CDP 真实输入

- 日期：2026-06-10
- Worktree：`spike-cdp-first-input`（基于 main `3c6d0d4`）
- 计划：`~/.claude/plans/vortex-observe-a11y-cryptic-scone.md`
- 背景：对标 playwright-mcp / chrome-devtools-mcp / Stagehand，三家 click/type/fill 全程 CDP Input（isTrusted=true）；vortex 默认合成事件，是调研确认的最大结构性偏差（白盒审计 9 根因族中 ≥4 族相关）。

## 实验设施（全部已提交）

| commit | 内容 |
|---|---|
| `c39e3b9` | dom.ts `cdpFill`/`cdpType` 实验分支 + bench `compare-cdp` 双模式子命令 |
| `ecb70ac` | `cdpClickElement` timings 拆分 + latency/infobar/fill-matrix 三 case + React 受控 fixture |
| `4fa3356`/`2b791ba` | `forceSynthetic` 开关（压过 server 无条件注入的 trustedMode，trusted Chrome 上还原合成对照） |

测试基线：ext 943 / bench 298 / mcp 400 / shared 222 / server 26 / migrate 52 全绿。

## 环境关键事实（影响数据解读）

本机 Chrome 带 `--silent-debugger-extension-api`：
1. server message-router 对 dom.click **无条件注入** trustedMode=true → **click 在本环境早已全程 CDP**（用户日常 dogfood 即 CDP-first click，无事故记录）——本身是支持翻转的强证据。
2. infobar 被 flag 静默 → 非 trusted 普通用户的 infobar 行为**本机不可测**（标 UNVERIFIED）。
3. 首轮延迟/对比数据被污染（两组均 CDP），`forceSynthetic` 修正后重测。

## 阶段 1：延迟 ✅ 非障碍

spike-cdp-latency（同一纯按钮，合成×100 vs CDP×100，`--repeats 3` 中位）：

| 指标 | 数值 |
|---|---|
| 合成 P50 / P90 | 42ms / 50ms |
| CDP warm P50 / P90 | 52ms / 92ms |
| **warm delta P50（中位）** | **+10ms**（单 run 区间 0~+40ms，环境噪声主导） |
| 冷 attach | 0-4ms（"attach 贵"假设被推翻） |
| CDP 内部拆分 | attach 0 + probe 1-2 + dispatch 4-17ms |
| 对照自检 syntheticWasCdp | 0（干净） |

判定：delta 中位 +10ms ≤ 30ms 无感锚点。历史"CDP 慢 3289ms"系 captureScreenshot 编码开销，与 Input dispatch 无关。

## 阶段 2：infobar / viewport ⚠️ 部分验证

- trusted 形态（本机）：attach 前后 `innerHeight` 1290 不变、锚点 bbox 0 偏移；attach 常驻下合成/CDP 双路 click 均正确命中（spike-infobar-viewport case PASS）。
- 非 trusted 形态：**UNVERIFIED**（需无 flag Chrome 实例）。注：press/evaluate/drag 已常驻 attach 多年，infobar 增量仅影响"纯 click/fill 轻 session"。

## 阶段 4：fill 矩阵 ✅ cdpFill 无回归且更保真

spike-cdp-fill-matrix（{React 受控, 中文, maxlength=5, number} × {value-setter, cdpFill}）：

| 维度 | default(value-setter) | cdpFill(insertText) |
|---|---|---|
| React 受控写入+state 同步 | ✓ | ✓ |
| 中文整串 | ✓ | ✓ |
| number | ✓ | ✓ |
| maxlength | **绕过**（写入 10 字符非法态） | **尊重**（截到 5，真实浏览器语义） |
| beforeinput 事件 | 不发 | ✓（富文本 pipeline 依赖） |
| input isTrusted | false | **true** |
| keydown/keyup | 不发 | 不发（insertText 已知限制，证实） |
| composition 序列 | 无 | 无（中文直插，证实） |
| error | 0 | 0 |

判定：cdpFill 全矩阵无回归 + 3 处保真度优势；限制（无 keydown/composition）与现状相同，非退化。

## 阶段 3：成功率双模式 bench —— 含一个 P0 生产 bug 发现

### 🔥 首轮（修复前）：pass A 大面积失败牵出 main 上的 P0

首轮 compare：total=90，both-pass=48，**cdp-fixes=35**，regression=1，both-fail=6。35 个"被 CDP 救活"触发真实性核查 → 确诊：

> **`5d8dbf4`（BUG-012）在合成 click 的 executeScript inline func 内裸引用模块级 `isTransient`（dom.ts:44）→ 注入丢模块作用域 → ReferenceError → 非 trusted Chrome 上每一次合成 click 100% 抛 `JS_EXECUTION_ERROR`。**

三层掩护使其从未被发现：① 开发机 Chrome 带 trusted flag → click 全走 CDP，合成分支不跑；② 既有单测对该 inline func 是 source-grep（不执行）；③ bench 历史全在 trusted 环境跑。修复 `885ce97`（内联副本 + `new Function` 剥作用域行为测试 + 效果级 listener 断言），**需 cherry-pick 回 main**。

### 修复后（真实对照）

| 归类 | 数量 | 明细 |
|---|---|---|
| both-pass | **83/90** | |
| cdp-fixes | 0 | 首轮 35 个全是 isTransient bug 产物 |
| cdp-regression | 2 | el-time-picker / spif-in-shadow（复跑稳定复现，已确诊，见下） |
| both-fail | 5 | oopif 族 + debug-read-network，与模式无关（env/既有缺口） |

**regression 确诊（均非阻塞）：**
- `el-time-picker`：`vortex_act fill+kind` 的 kind 是**静默死参**（dispatch 仅 vortex_fill 有 kind→dom.commit 路由），pass A 靠 plain value-setter 碰巧驱动 Element Plus 才绿；pass B 的 cdpFill insertText 与 widget 面板交互后落当前时间。处方：产品化时 insertText 仅替换 plain-fill **写入机制**，fill-reject/kind 分流照旧（本 case 即分流启发式仍必要的直接证据）。act+kind 死参另记 issue（dead-param 族）。
- `spif-in-shadow`：shadow 内 iframe 的 real-mouse offset 缺口；**修复已存在于 `feat/observe-a11y-tree` 未合入的 iframe-offset.ts CDP 兜底**，是 CDP-first 转正的前置依赖。

### 解读

修好合成路径后，合成 85/90 vs CDP-first 83/90 —— **成功率打平**（2 个 regression 均已确诊有界）。「启发式依赖 case 被裸 CDP 救活」的假设在 bench 面上未出现：launch 启发式（reactClickable/submit-intent/fill-reject）修过五批白盒审计后，合成路径在 fixture 面上已被修平。但**本轮最大的发现本身就是论据**：合成默认路径在开发环境里是"无人行走的路"——`5d8dbf4` 于 2026-06-08 合入，到 2026-06-10 spike 发现为止，非 trusted 用户的所有 click 已断 2 天无人知；CDP 路径才是所有 trusted 流量的真实承载。默认与主路径不一致 = 静默腐烂的结构性风险。

## 阶段 5：降级策略 ✅ DevTools 冲突不存在

实测（2026-06-10，本机 Chrome）：
- 扩展先 attach + DevTools 后开：CDP click 正常（attachMs=0 复用会话）。
- **DevTools 先开 + 扩展后 attach：attach 成功（冷 attach 3ms），CDP click 正常且效果真实**（aria-pressed 翻转核验）。

结论：现代 Chrome 多 CDP 客户端机制下 DevTools 与 chrome.debugger 共存，「DevTools 占用 → attach 失败」的历史担忧不成立。降级链仍保留（针对企业策略禁 debugger / 其他扩展独占等残余场景），但不再是高频路径。

产品化改动面（静态分析）：
- click CDP-first 路由：`dom.ts:400-414` 现有 `deferToCdp → catch → runSyntheticClick` 顺序倒置（~20 行），合成分支整体保留为 attach-failure fallback，不删。
- `detector.ts` `canUseCDP` 的「探测性 attach→立即 detach」模式改为 try-attach 留驻（避免 infobar 闪现）。
- fill/type：`cdpFill`/`cdpType` 实验分支转正 = **仅替换 plain-fill/type 的写入机制**（fill-reject / kind driver 分流照旧，el-time-picker regression 即分流必要性的直接证据），value-setter 留 fallback。

## 决策矩阵命中：**全翻转（分级实施）**

| 矩阵条件 | 实测 | 判定 |
|---|---|---|
| warm ≤ 合成+30ms | +10ms（×3 中位） | ✓ |
| bench 双模式无新增 fail | 2 个 regression，均有界：1=实验开关绕分流的 artifact（产品化形态不发生）、1=已有修复待合（iframe-offset @ feat/observe-a11y-tree） | ✓（带 1 前置依赖） |
| infobar 无/可补偿偏移 | trusted 形态 0 偏移；非 trusted **UNVERIFIED**（本机 flag 静默） | ⚠️ 残余验证项 |
| fill 矩阵全过 | 全过 + 3 处保真优势 | ✓ |
| （加权）DevTools 降级 | 共存成立，降级需求大减 | ✓ |
| （加权）结构性论据 | 合成默认路径已静默腐烂 2 天（isTransient P0），默认≠主路径=持续风险 | ✓✓ |

### 最终建议

1. **立即（独立于翻转）**：`885ce97` isTransient P0 修复 cherry-pick 回 main；`vortex_act fill+kind` 静默死参记 issue（dead-param 族）。
2. **click CDP-first 转正**：trusted 环境已是既成事实（本机全部 dogfood 流量）；非 trusted 同样翻转，合成留 attach-fail 降级。残余风险=非 trusted infobar 视觉/offset 未实测，作为转正 PR 的验证项（无 flag Chrome 实例跑 spike-infobar-viewport 即可）。
3. **fill/type 写入机制换 Input.insertText**：分流启发式照旧，仅换 plain 路径的写入；value-setter 留 fallback。
4. **前置依赖**：~~feat/observe-a11y-tree 的 iframe-offset CDP 兜底先合 main~~ **已满足**——该分支已于 2026-06-10 合入 main（`1c02b04`），转正 PR rebase 到新 main 后 spif-in-shadow 应消失（rebase 后复跑确认）。
5. **退役候选（翻转后数据驱动逐个验证）**：reactClickable 标记、framework-handlers 探测、submit-intent defer——CDP-first 下它们从「补救机制」降级为「死代码候选」。
6. 工作量级：中，约 1-2 周（含降级链测试 + baseline 重置 + 文档）。

### 对 observe 教训的回应

spike 的元发现与 observe 扁平化教训完全同构且更深一层：**偏离主流的默认路径不仅产生启发式补丁（打地鼠），还会因为「无人行走」而静默腐烂**。三层防线（trusted 开发环境 / source-grep 单测 / trusted bench）全部漏掉 isTransient P0，证明：让默认路径=主流路径=日常行走路径，是比加测试更根本的质量保障。
