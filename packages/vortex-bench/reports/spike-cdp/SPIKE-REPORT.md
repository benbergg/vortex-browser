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

## 阶段 3：成功率双模式 bench

<!-- TODO: compare-cdp --all 结果填这里 -->

## 阶段 5：降级策略

<!-- TODO: DevTools 占用 attach 冲突实测 + 改动面 -->

产品化改动面（静态分析）：
- CDP-first 路由反转：`dom.ts:400-414` 现有 `deferToCdp → catch → runSyntheticClick` 顺序倒置（~20 行），合成分支整体保留为 attach-failure fallback，不删。
- `detector.ts` `canUseCDP` 的「探测性 attach→立即 detach」模式需改为 try-attach 留驻（避免 infobar 闪现）。
- fill/type：实验分支转正 = 把 `cdpFill`/`cdpType` 分支条件改为默认 + 保留 value-setter 为 fallback。

## 决策矩阵命中

<!-- TODO: 汇总后填 -->
