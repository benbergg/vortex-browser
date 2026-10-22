---
created: 2026-10-22
updated: 2026-10-22
status: draft
tags: [spec, vortex, hover, actionability]
---

# Hover 隐藏元素的识别与点击 —— 设计与根因

## 1. 问题陈述

Vortex 操作 iPaaS「集成方案」流程画布时，无法识别并点击「触发」「HTTP节点」行
**Hover 后才出现**的 ⊕「新增」按钮。

目标是**通用**修复：让 Vortex 具备「主动 Hover 发现隐藏元素并可靠点击」的能力，
不做任何针对 iPaaS 的硬编码。

## 2. 现场取证

复现页：`https://ipaas-pre.bytenew.com/#/processSetting?id=1115`（预发，Edge）。
流程画布上「触发」「HTTP节点」行的 ⊕ 按钮，DOM 结构（实测）：

```html
<div class="flow-start">
  <span class="wicon ipaas-chufaqi-chufarenwu"></span>
  <span style="margin-left:10px;color:#006eff">触发</span>
  <div><span>
    <div role="tooltip" class="el-popover popover-process-nodes" style="display:none">…节点类型…</div>
    <span class="el-popover__reference-wrapper">
      <span class="wicon ipaas-gengduo ipaas-nodes-name-icon el-popover__reference"
            aria-describedby="el-popover-9240" tabindex="0"></span>   <!-- ← ⊕ 新增按钮 -->
    </span>
  </span></div>
</div>
```

控制该按钮显隐的 CSS（实测，取自页面样式表）：

```css
.processSetting .flow-start .ipaas-nodes-name-icon { display: none; }
.processSetting .flow-start:hover .ipaas-nodes-name-icon { display: inline-block; }
.ipaas-nodes-name .ipaas-nodes-name-icon { display: none; }
.ipaas-nodes-name:hover .ipaas-nodes-copy-icon,
.ipaas-nodes-name:hover .ipaas-nodes-del-icon,
.ipaas-nodes-name:hover .ipaas-nodes-name-icon { display: block; }
```

即：**按钮常驻 DOM，但被父级 `:hover` 规则置为 `display:none`；父级被 hover 时才显示。**
按钮自身**无文本、无 `title`、无 `aria-label`**（仅 `aria-describedby` 指向其 popover）。

### 2.1 实测行为（vortex 工具，Edge 真实页）

| # | 操作 | 结果 |
|---|---|---|
| E1 | `vortex_query mode=text pattern=新增`（未 hover） | `total: 0`，诊断明说「Out of scope: hidden text」 |
| E2 | `vortex_act click .ipaas-nodes-name-icon`（未 hover） | `Error [TIMEOUT]: Actionability timeout after 2000ms; last reason: NOT_VISIBLE` |
| E3 | `vortex_act hover <父节点>` | 成功；按钮 `computed display` 由 `none` 变 `inline-block` |
| E4 | `vortex_observe`（hover 之后） | 树中出现该 span（有 ref、有 `desc`），但**可及名为空** |
| E5 | `vortex_act click .ipaas-nodes-name-icon`（hover 之后） | `success: true`，popover 打开 |
| E6 | 鼠标移开后再 `vortex_act click` 同选择器 | 回到 E2：`NOT_VISIBLE` 超时 |

### 2.2 源码链路

- `packages/extension/src/handlers/observe.ts` —— 可见性过滤：只收当前可见元素，
  `display:none` 的控件不产出 ref。
- `packages/extension/src/handlers/query.ts` —— `mode=text` 明确排除 hidden 文本。
- `packages/extension/src/action/auto-wait.ts` —— `waitActionable` 遇到 `NOT_VISIBLE`
  只按 50ms 间隔重试，**从不尝试「先 hover 把它揭示出来」**，2s 后抛 TIMEOUT。
- `packages/extension/src/page-side/actionability.ts` —— `isVisible` 用
  `checkVisibility({visibilityProperty:true})` + 非零 rect；`display:none` ⇒ 不可见。

## 3. 根因

Vortex 的可见性模型是**「快照时刻的真相」**：一个控件能否被识别/操作，取决于
*扫描或动作发生的那一刻*它是否可见。

对「父级 `:hover` 才显示」的控件，这条模型给出两个必然失败：

1. **发现失败**：控件在扫描瞬间 `display:none` ⇒ observe/query 都不产出它，
   agent 无从知道它的存在（更谈不上可及名——它本来就没有名字）。
2. **动作失败**：即使 agent 凭 CSS 选择器直接命中，actionability 门判 `NOT_VISIBLE`
   并空转到超时；整个 act 链路**没有任何一步会想到「先 hover 父级把它揭示出来」**。

**结论**：根因不是 iPaaS 的实现细节，而是 vortex 缺少「hover 揭示」这一原语：
既不会主动 hover 去发现隐藏控件，也不会在目标被隐藏时自动 hover 祖先再操作。

## 4. 业界对照（方案调研）

| 方案 | 是否有「自动发现 hover 隐藏控件」 | 对 hover 隐藏控件的动作策略 | 维护成本 | 结论 |
|---|---|---|---|---|
| **Playwright** | 无。`click` 的 actionability 明确要求元素 Visible，hover-only 元素直接超时（官方 actionability 文档） | 人工两段式：`locator.hover()` 父级 → 再 `click()` 子级 | 低 | 业界标准是「显式 hover + 再动作」，不是自动发现 |
| **Chrome DevTools MCP** | 无。只有 `hover(uid)` 工具，靠 snapshot 的 uid 定位 | 同上，uid 来自可见快照 | 低 | 同上 |
| **Browser Use** | 无。`hover_element` 动作 2025-09 才合入（PR #3095），hover-reveal 仍是 open issue（#4964）；另有「hidden element 误选」issue（#2609） | 显式 hover | 中 | 同上，且暴露了「误选隐藏元素」的同类痛点 |
| **vortex 拟议** | **有**：`observe` 报告 hover 揭示控件（frame 级信号）+ act 侧自动 hover 祖先揭示 | act 目标被隐藏时**自动** hover 祖先再动作 | 中 | 与业界一致（显式 hover 可用）并补上「自动揭示」 |

**取舍**：不引入「自动遍历 hover 猜测」的魔法（业界均无，且代价/误报不可控）；
把「显式 hover 可用」做到**可靠**（自动揭示 + 失败可执行诊断），
再补一层**只读的被动发现**（告诉 agent「hover 触发元素 X 会揭示控件 Y」）。

## 5. 设计

### 5.1 Slice 1 —— 动作侧「自动 hover 揭示」（默认开启，通用）

`act`（click/fill/type/select）解析出目标后，若 actionability 判 `NOT_VISIBLE`，
则**自动**沿目标祖先链由近及远地寻找「可见且有盒」的候选，用 CDP 真鼠标
（`Input.dispatchMouseEvent mouseMoved`）依次 hover，每次 hover 后复查目标可见性；
一旦可见即继续原动作。

- 通用性：只要「父级 `:hover` 揭示」成立，**最近的那个可见祖先**必然是触发
  容器的后代 ⇒ hover 它即触发容器的 `:hover` ⇒ 控件显现。故不依赖任何站点知识。
- 代价：仅在失败路径触发；候选上限 6、每次 1 次 mouseMoved + 1 次可见性复查。
- 证据：动作结果回传 `revealed: {via:"hover", trigger:{tag,cls,text}}`。
- 失败诊断：`NOT_VISIBLE` 的报错文案改为可执行指引（先 hover 触发元素 / `force` /
  用 observe 的 hover 揭示报告定位），不再只说「调大 timeout」。

### 5.2 Slice 2 —— 发现侧「hover 揭示控件报告」（只读、被动、默认开启）

`observe` 增补 frame 级信号 `hoverControls`：扫描同源样式表里的 `:hover` 规则，
解析出（触发选择器, 被揭示选择器），筛出**当前被隐藏**的被揭示控件，报告：

```
trigger: {selector, text:"触发"}  control: {selector, tag:"span", classes:[...], name?}
```

纯只读：不移动鼠标、不改页面；对 agent 的价值是「我知道该 hover 谁、点了什么」。
渲染成 `# hover-revealed:` meta 行（与既有 `# blindspots:` 同级风格）。

### 5.3 Slice 3（可选增强）—— `observe` 主动 hover 探测，把揭示控件纳入元素树

在 Slice 2 的候选上真鼠标 hover，确认控件显现后，把它作为**带 ref 的一等元素**
并入 observe 树。默认关闭（`hoverProbe` 显式开启），避免给常规 observe 增加
鼠标移动副作用与性能开销。

## 6. 非目标

- 不针对 iPaaS / 任何具体站点硬编码选择器、类名或文案。
- 不改「可见性判定」本身（`display:none` 就是不可见，这一语义必须保持）。
- 不把 Slice 3 的主动探测设为默认（性能与副作用，见 §5.3）。

## 7. 验收标准

1. iPaaS「触发」「HTTP节点」行的 ⊕「新增」按钮：能被 vortex 识别（发现信号），
   并能被成功点击（真实页验证，popover 打开）。
2. 通用性：单测覆盖「父级 `:hover` 揭示」这一通用模式（非 iPaaS 专有）。
3. 无回归：extension / mcp 既有测试全绿；observe/act 既有行为不变。
4. 性能：失败路径新增成本有界（候选上限 6，单次动作增量 < 200ms），
   成功路径零开销（仅在 `NOT_VISIBLE` 时触发）。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| hover 祖先可能误触发别的浮层/tooltip | 只在 `NOT_VISIBLE` 且目标已定位时触发；候选由近及远，逐个复查可见性，未显现即换下一个 |
| 揭示后鼠标停在触发元素上，影响后续动作 | 后续任何真实鼠标动作都会覆盖指针位置；合成 click 不移动指针，控件仍处于可见态 |
| Slice 2 的 CSSOM 解析对跨源样式表抛错 | `cssRules` 访问包 try/catch，跨源表直接跳过 |
| 性能回退 | Slice 2 只读 CSSOM，规则数与产出条数均有上限；Slice 3 默认关闭 |
