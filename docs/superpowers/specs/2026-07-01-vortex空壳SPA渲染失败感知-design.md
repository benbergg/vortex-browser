# vortex 空壳 SPA / 渲染失败感知 affordance 设计

> 上游:[[2026-06-30-vortex硬视觉感知评测与迭代-design]] campaign 的 P2 衍生项。
> 缺口谱 `Knowledge-Library/07-Tech/20260630-vortex硬视觉感知评测-能力缺口谱.md`。

## Context

硬视觉感知 campaign 排查 P2(g2.antv umi/yuyan SPA 不渲染)时确诊:该站 examples 页服务端返回**空 `#root`**(纯客户端渲染),客户端 bootstrap 硬依赖 `yuyan/mdap.alipay.com` 做 auth store init,而这些内部端点从本机网络不可达 → auth 抛 `ERR_NETWORK` + React #418 水合失配 → 客户端渲染中止 → `#root` 永久空。这是**站点+网络环境问题,非 vortex 缺陷**:vortex 的 Chrome 完整执行 JS、observe/evaluate/screenshot/debug 全正常。

但暴露出一个真实的**感知盲区**:当页面因自身 JS/网络失败而 `#root` 空时,`observe` 返回一棵近乎空的树,**没有任何信号说明"为什么空"**。模型会把空树误读成"这页没有控件",而非"这页渲染失败/尚未渲染"。这是比截图退化更糟的**静默空白**——模型拿到的是**零信号**,可能据此做出错误决策(以为任务无元素可操作而放弃/瞎猜)。

本设计给 observe 增加一个 **framework-pushed 空壳信号**,与已 ship 的 canvas/virtual/image 盲区信号同族:把静默空树转为可行动提示,让模型知道"这是个未填充的 SPA 外壳,应 wait/retry 或查 console/network"。

## Goal / Non-Goals

**Goal**:observe 在检测到"framework 在场但根容器近空、零交互元素、文档已 complete"时,输出 frame 级 `blankShell` 信号 + 顶部 `#blank-shell` meta,渲染成一行可行动提示。

**Non-Goals**:
- 不断言"render **failed**"(需确定性,易误报)——语义降为"可能仍在渲染或渲染失败"的**可能性提示**,在"加载中"与"真失败"两种情况下都是正确建议,从根上消除误报危害。
- 不做 console/network 交叉引用(YAGNI,留 follow-up):MVP 纯 DOM,不跨 SW、不耦合 console 捕获。
- 不改任何渲染/网络行为——纯感知信号,零副作用。
- 不覆盖"有 spinner/骨架屏的加载态"(那有可见内容,非空壳,`interactive===0`+近空 root 门自然排除)。

## 判据(spike 实测收紧)

spike 对 4 类样本实测两套判据的 TP/FP(证据表附后)。结论:**纯 DOM 松阈值会误报**(慢加载 CSR SPA 的加载窗口 / 小内容合法页),**双采样稳定性检查救不了**(慢加载跨 600ms 仍空)。故收紧为"真·空壳"门:

触发全部满足:
1. **framework 在场**:`window.React/Vue/__NEXT_DATA__ !== undefined` 或 umi `window.g_history`/`window.g` 或 `<script src>` 匹配 `umi|react|vue|next|runtime|chunk|.<hash>.js`。
2. **根容器存在**:`querySelector('#root,#app,#__next,[data-reactroot]')` 命中(有公认 SPA 挂载点,才敢称"SPA 外壳";无挂载点的普通空页不触发)。
3. **根容器近空**:`root.innerHTML.trim().length < 64`。
4. **零交互元素**:该 frame 收集到的可操作元素数 `=== 0`(**不是 `<3`**——修掉 spike S4c 小内容页 FP)。
5. **文档 complete**:`document.readyState === 'complete'`(排除明显仍在加载的 DOM 阶段)。

只有这五条同时成立才触发。spike 验证:对 SSR 页(root 预填)/静态稀疏页(无 framework)/富渲染 SPA(交互多)/小内容已渲染页(interactive≥1)**全不误报**;唯一触发是"真·空壳"(0 交互+空 root+framework+complete)=要么真失败、要么仍空白加载,提示"wait/retry 或查 console/network"对两者都正确。

## 信号形状与渲染

空壳是**整 frame 级**状态(非 per-element、非 per-container 盲区),形状对齐既有 `CompactFrame.modal`:

- 扩展侧 observe 输出 frame 对象加可选字段:
  `blankShell?: { root: string; rootLen: number; framework: string }`
  (`root`=命中的挂载点选择器如 `#root`;`framework`=检出依据如 `react`/`umi`/`script-chunk`)。
- MCP `observe-render.ts` 的 `CompactFrame` 加同字段;`#blank-shell` 汇总进顶部 meta(与 `#blindspots`/`#truncated` 并列)。
- 渲染成一行提示(主 frame 命中时置于树顶,醒目):
  `⚠ #blank-shell: <framework> 应用的 <root> 近空且 0 交互元素(文档已 complete)——页面可能仍在渲染或渲染失败,请 wait/retry(idle=net)或查 vortex_debug_read(console/network)`

## Architecture

沿用 blindspot 族的**真源 + inline parity**铁律(page-side 注入函数丢模块作用域,必须内联;结构性单测防漂移):

- **真源**:`packages/extension/src/page-side/blindspot-detect.ts` 加 `detectBlankShell(doc, win, interactiveCount): BlankShellSignal | null` 纯分类器(接 document/window/该 frame 交互计数,返回信号或 null)。
- **inline**:`packages/extension/src/handlers/observe.ts` page-side 扫描在**统计出该 frame 交互元素数之后**内联同逻辑(每 frame 一次,非扫描循环),命中则挂到 `framesOut[i].blankShell`。
- **parity 门**:`observe-blindspot-scan.test.ts`(或新 `observe-blankshell.test.ts`)结构性断言 inline 副本与真源关键判据一致(framework 检测串、rootLen<64、interactive===0、readyState complete 四断言),防两处漂移。
- **渲染**:`packages/mcp/src/lib/observe-render.ts` `CompactFrame` 加字段 + meta 汇总 + 提示行;`schemas-public.ts` **无需改**(observe 无新入参,零 tools/list 预算影响)。

框架检测复用:优先用 observe 已有的 framework 判定能力(`reactClickable`/`hasFrameworkClick` 走 fiber/cursor,是 per-element 的);本信号需 **page-level "framework 在场"**(globals+script src),为新增页级 helper,不与 per-element 逻辑冲突。

## 误报分析(spike 证据)

| 样本 | framework | readyState | rootLen | interactive | 收紧门是否触发 | 真相/判定 |
|---|---|---|---|---|---|---|
| S1 g2 失败 CSR | ✓ | complete | 0 | 0 | **触发** | 真失败(TP)·console 有 #418/ERR_NETWORK |
| S2 g2 已渲染 SSR | ✓ | complete | 41755 | 97 | 不触发 | 正常(TN,root 有内容) |
| S3 example.com 静态稀疏 | ✗ | complete | 无 root | 1 | 不触发 | 正常(TN,framework+root 门挡住) |
| S4a 慢 CSR 加载态 | ✓ | complete | 0 | 0 | **触发** | 加载中→提示"wait/retry"正确(非有害 FP) |
| S4b 加载态+600ms | ✓ | complete | 0 | 0 | **触发** | 双采样救不了→佐证软提示语义的必要性 |
| S4c 小内容已渲染 | ✓ | complete | 55 | 2 | **不触发** | 已渲染(`interactive===0` 门修掉此 FP) |

净效果:只对"真·空壳"触发;对加载中给正确的"等待"建议(软语义故无 FP 危害);SSR/静态/富渲染/小内容页零误报。

## Testing

- **单测**(真源纯分类器,jsdom):构造 fixture 覆盖五门各自的边界——失败空壳(触发)/root 有内容(不触发)/无 framework(不触发)/interactive≥1(不触发)/readyState=loading(不触发)/无挂载点(不触发)。
- **parity 结构性单测**:断言 observe.ts inline 副本与真源判据一致。
- **渲染单测**:`observe-render.test.ts` 断言 `blankShell` frame 渲染出 `#blank-shell` 提示行 + meta 汇总;无 `blankShell` 时零输出(向后兼容)。
- **活浏览器 spike**(承重墙):真站 g2.antv examples(失败 CSR)→ observe 顶部出 `#blank-shell`;g2 落地页(SSR)/example.com(静态)→ 无信号;合成慢 CSR 页加载态→出信号(验"wait"建议),渲染后→信号消失。
- 全量 `pnpm -C packages/extension test` + `pnpm -C packages/mcp test` 无回归。

## Out of Scope(follow-up backlog)

- **console/network 增强**:若 observe handler 侧能廉价读 SW console buffer,可把提示升格"console 有 N 个 error(如 React #418/ERR_NETWORK)→很可能是渲染失败而非加载中",提高置信度。需评估 handler↔console-store 耦合,MVP 不做。
- **per-frame 多挂载点 / 非常规 mount(自定义 root id)**:MVP 只认 `#root/#app/#__next/[data-reactroot]` 主流挂载点。
