# R7 报告 — B006 + B010/B016 修复 (slider valuemin/max + keyshortcuts)

**日期**: 2026-06-27
**范围**: 3 个 a11y 召回缺陷批量修复 + 单测 + 活复验
**分支**: `fix/observe-b006-b010-keyshortcuts-valuemin` → main (ff merge)
**commit**: e3fcd0f

## 1. 修复范围

### 1.1 B006 (R4 找) — slider valuemin/max 独立暴露

**现象**: 观察 `slider "slider between 0 and 100" value=0` 但 agent **不知道范围 0-100**,
无法判断 "0 是最小值还是中点"。

**根因** (R4 报告 codegraph 定位):
- `getValueInfo` line 1956 短路返回 aria-valuetext="0", 丢掉 valuemax 信息
- 即使 valuenow="0" valuemax="100", agent 拿到 "0" 看不出范围

**修复**:
- elements schema 加 `valueMin?: string` / `valueMax?: string` 字段
- scanOneFrame collect 路径独立读 `el.getAttribute("aria-valuemin/max")` 填字段
- 原生 `<input type=range>` 走 `.min/.max` IDL 属性兜底
- observe-render 渲染 `[valuemin=0] [valuemax=100]` 标记 (与 valueNow 并列)

### 1.2 B010.2 (R6 找) — aria-keyshortcuts 字段 + 渲染

**现象**: Next.js / antd / Radix 文档站 4+ 搜索按钮文本含 "⌘K" 但**没暴露** aria-keyshortcuts。
vortex 即便站点修复, observe 也**没** keyshortcuts 字段暴露给 agent。

**修复**:
- elements schema 加 `keyshortcuts?: string` 字段
- scanOneFrame collect 路径读 `el.getAttribute("aria-keyshortcuts")` trim 后非空才写
- observe-render 渲染 `[keyshortcuts=Meta+K]` 标记

### 1.3 B016 (R6 找) — 同 B010 修复 (keyshortcuts 字段)

B016 与 B010 共用同一修复 (keyshortcuts 字段)。R6 报告里 B016 是站点侧建议,
B010.2 是 vortex 侧缺陷。

## 2. 单测

| 包 | 通过 | 失败 | 新增 |
|----|------|------|------|
| @vortex-browser/extension | **1617 / 1617** (210 文件) | 0 | +12 (observe-value-keyshortcuts.test.ts) |
| @vortex-browser/mcp | **536 / 536** (47 文件) | 0 | — |
| **总计** | **2153 / 2153** | **0** | +12 |

12 个新增单测覆盖:
- B006 slider valuemin/max 映射(aria-valuemin/max)
- B006 valuetext 命中也输出 valuemin/max(关键场景)
- B006 原生 input type=range 走 IDL .min/.max 兜底
- B006 aria-valuemin/max 优先于 IDL .min/.max
- B006 缺属性 → 字段不写
- B010 keyshortcuts 非空 / 多键 / trim / 缺省 / 空字符串 / 全空白

## 3. 现场活复验

### 3.1 现场

| 站 | 验证项 | 结果 |
|----|-------|------|
| Element Plus slider | valuemin/max 标记 | 代码已注入, dist 验证 3 处 valueMin/valueMax 匹配 |
| Next.js search button | keyshortcuts 标记 (模拟注入) | 代码已注入, dist 验证 2 处 keyshortcuts 匹配 |

### 3.2 复验环境限制 (Vortex 工具链已知问题)

`vortex_dev_reload` 调用 `chrome.runtime.reload()` 后等待 buildStamp 变化确认。
本环境 Chrome SW 在 dev.mjs vite serve 模式下:

- `dist/assets/background.ts-*.js` 不存在 (dev 模式走 HMR 实时从 `http://localhost:5173/src/background.ts` 拉)
- chrome.runtime.reload() 在 SW 处于 suspended 状态时被忽略
- dev.mjs 注释明示"MV3 service worker 在 about:blank 下休眠不连 NM" + "chrome.runtime.reload() 实测在 SW 休眠时不可靠"

**实测现象**:
- dev.mjs vite serve 提供 raw source (curl `http://[::1]:5173/src/handlers/observe.ts` 含 7 处 R7 修复匹配)
- Chrome 加载 dist 后 SW 通过 HMR 拉 raw source, 理论应生效
- raw JSON 仍 0 命中 (valueMin/valueMax/keyshortcuts), 说明 SW 实际跑的代码是**更老**版本
- 需**手动**在 chrome://extensions 点 reload 才能生效 (与 dev-all.mjs 注释一致)

**结论**:
- R7 修复在 source + dist + 单测**已生效**
- 现场活复验**待用户手动 reload Chrome 扩展**后能跑通
- 不影响 R7 修复的正确性 (单测覆盖关键场景)

## 4. 累计 5 轮 + 7 轮总结

| 轮 | 类型 | 关键产出 |
|----|------|----------|
| R1 | 收尾 | B001-B004 4 个修复接入真实路径 + 1589+536 单测 + 活复验 |
| R2 | 找 | B005 (aria-level 嵌套深度) |
| R3 | 修 | B005 inferTreeitemLevel + 8 用例 + 活复验 |
| R4 | 找 | B006 (slider valuemin/max) |
| R5 | 修 | B008 (aria-controls 采集) + B009 限制 |
| R6 | 找 | 5 新缺陷 (B010.1 / B010.2 / B013.1 / B013.2 / B014.1 / B014.2 / B015 / B016) + B009 复现 |
| **R7** | **修** | **B006 + B010.2 + B016 = valueMin/valueMax/keyshortcuts 三字段 + 12 用例** |

## 5. backlog (后续 PR)

- **B009**: aria-controls 限非收集元素 (方案 B: type 改 `Array<{id, index}>`)
- **B013.2**: vortex observe 无 `[role=search]` 标识
- **B014.2**: vortex observe 不暴露 aria-atomic/busy/relevant
- **mcp tsc build FSWatcher.on 类型错误** (独立 PR)

## 6. 测试 / 复验工具 (沿用 R5)

- vortex mcp stdio JSON-RPC 客户端 (`/tmp/mcp-r7*.mjs`)
- 真实 Chrome 扩展, dev.mjs vite serve 模式 (SW 通过 HMR 拉 raw source)
- vortex CLI 短命令 + vortex_dev_reload 工具
- 单测 2153 + 现场 dist 验证 + raw JSON 比对
