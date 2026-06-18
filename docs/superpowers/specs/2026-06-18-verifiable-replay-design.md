# 设计:可验证确定性重放(Verifiable Replay)— Phase 1 单动作指纹

- 状态:设计已确认,待写实现计划
- 日期:2026-06-18
- 来源:2026-06 竞品分析提案 A(见 memory `vortex_competitive_analysis_2026_06`)

## 0. 背景与定位

竞品分析(三路深调研)得出:确定性重放 / act-cache(Stagehand/HyperAgent/Skyvern 均有,10–100× 成本杠杆)是 vortex **最大的能力缺口**;而盲区信号、actionability + silent-false-success 防护是 vortex **全行业领先**的护城河。

第一性原理重定位:vortex 是「**诚实表征层**」——竞品全追 recall(看更多),vortex 独追 calibration(知道自己没看到什么、动作是否真生效)。本特性把这条哲学贯彻到重放:**别家是"快但可能静默失效的重放",vortex 做"快且自证有效的重放"**。

### vortex 现有的三块原料(本特性是组装升维,非从零造)

1. **ref 协议**(`packages/mcp/src/lib/ref-parser.ts` + `packages/extension/src/reasoning/ref-store.ts`):snapshot-bound `@<hash>:fNeM`,带 tab 维度 + hash 严判的 stale 防护;RefStore 已有 descriptor 重定位能力。
2. **effect 采集**(`observeEffect:true` → `ClickEffect{domMutations, networkRequests, networkSample, urlChanged, focusChanged, ariaChanged, observed, windowMs}`,GAP-G/N0062 产出,见 `packages/vortex-bench/cases/click-effect-signal.case.ts`):这是「效果指纹」的现成原料。
3. **micro-verify**(`packages/extension/src/action/micro-verify.ts`):per-action 回读(click 1-RAF DOM diff / fill·type·select value 回读 / scroll 位置 ±5px),区分强效果(value 精确)与弱效果(hover/drag `effects:null`)。

### 关键洞察(影响范围定位)

vortex 的 `act(@hash:e5)` 本就是确定性的、不耗 LLM——LLM 成本花在 **observe→喂页面→决策** 循环上。因此 vortex 版"重放"真正省的是 observe→LLM 往返(尤其 Phase 2 序列阶段)。**Phase 1 单动作阶段不直接省 LLM,其产出是把效果指纹机制做实**,作为 Phase 2 序列重放"自证轨迹没跑偏"的安全基石。

## 1. 范围与边界

**Phase 1 做**:把 act 的效果固化成可序列化的 `EffectFingerprint`,提供 record(采集)/ verify(比对)两种模式,verify 时诚实报告 drift。这是序列重放的原子单元和安全基石。

**Phase 1 不做**(留 Phase 2 独立 spec→plan 循环):
- 多步轨迹录制
- 跨 session 落盘缓存
- `vortex_replay` 工具
- 跳过 observe 的成本杠杆

YAGNI:先把指纹机制证实为真,再谈规模。

**零开销契约**:不传 `fingerprint` 选项时,`vortex_act` 行为字节级不变(继承 `observeEffect` 现有的零开销契约——见 `click-effect-signal.case.ts` 第 4 断言)。

## 2. EffectFingerprint 结构 + 归一化

```ts
interface EffectFingerprint {
  // —— 确定量(精确 / 容差比对)——
  action: "click" | "fill" | "type" | "select" | "scroll";
  targetIdentity: string;        // role::name::frameId(语义身份,NOT ref)
  urlChanged: boolean;
  urlAfter?: string;             // urlChanged 时记录
  valueAfter?: string;           // fill/type/select 的 micro-verify 回读值,精确
  scrollAfter?: { top: number; left: number };  // scroll,±5px 容差(复用 verifyScroll)
  // —— 类别签名(波动量 → 布尔,抗漂移)——
  causedDomMutation: boolean;    // ClickEffect.domMutations > 0
  causedNetwork: boolean;        // ClickEffect.networkRequests > 0
  focusChanged: boolean;         // ClickEffect.focusChanged
  ariaChanged: boolean;          // ClickEffect.ariaChanged
  // —— 元数据 ——
  weak?: true;                   // 弱效果动作(hover/drag):无确定量,verify 只比类别
}
```

### 归一化规则

- `domMutations` / `networkRequests`(每次执行波动)→ 折成 `causedDomMutation` / `causedNetwork` 布尔。这是「类别签名 + 确定量精确」决策的落地:**波动量只记"是否发生",不记数量**。
- `targetIdentity` 用 `role::name::frameId`,直接对齐 observe 的 `buildElementKey`(`packages/mcp/src/lib/observe-render.ts` 第 125 行)——**故意不用 ref**:重放时 snapshot 变了 ref 必不同,但元素语义身份应稳定;含 `frameId` 以区分多 frame 下的同名元素。
- 确定量(`valueAfter` / `scrollAfter` / `urlChanged`)原样保留,精确或 ±5px 容差比对。

## 3. 工具面契约

`vortex_act` 的纯增量选项,**零新增工具**:

```ts
vortex_act({
  action, target,
  options: {
    fingerprint:
      | { mode: "record" }
      | { mode: "verify"; expect: EffectFingerprint; autoRecover?: boolean }
  }
})
```

- **record 模式**:强制开 `observeEffect`(沿用其现有默认 `windowMs`,可经 `options.windowMs` 覆盖——网络副作用慢的站点可调大以稳定 `causedNetwork`),正常执行动作,返回 `{ success, effect, fingerprint }`。把"这个动作的预期效果"固化成可序列化的 fp,供调用方 / 上层框架存储。
- **verify 模式**:正常执行 + 采集 fp + 与 `expect` 比对 → 返回 `{ success, fingerprint, drift }`。`autoRecover:true` 且 drift 时附带一次 re-observe 的新快照。

## 4. 比对规则 + drift 报告

```ts
type DriftClass = "target" | "url" | "value" | "scroll" | "dom" | "network" | "focus" | "aria";

interface Drift {
  classes: DriftClass[];
  details: Array<{ field: string; expected: unknown; actual: unknown }>;
}
// verify 响应:{ success, fingerprint, drift: Drift | null }
// matched = (drift === null)
```

比对规则:
- 确定量(`action` / `targetIdentity` / `urlChanged` / `valueAfter` / `scrollAfter` ±5px)**必须全等**。
- 类别签名(`causedDomMutation` / `causedNetwork` / `focusChanged` / `ariaChanged`)**必须全等**。
- 任一不符 → drift 列出**具体哪类 + 期望 vs 实际**(诚实表征:不只说"失败",说"哪里变了")。
- 弱效果 fp(`weak:true`)→ verify 跳过确定量,只比类别签名。

## 5. 降级 / autoRecover + 边界

- **诚实优先**:verify 永远返回结构化 drift,默认把决策交回调用方(不抢 agent 决策,符合诚实表征层定位)。
- `autoRecover:true`:drift 时 vortex 自动 re-observe,新快照随响应返回(便利但可选)。
- **弱效果动作**(hover/drag,micro-verify `effects:null`):指纹只含类别签名 + `weak:true`;verify 放宽为只比类别。
- **stale ref 正交**:verify 前 ref 解析失败 → 走**现有** STALE_SNAPSHOT / RefStore descriptor 重定位,与指纹机制**不耦合**。ref 失效 ≠ 效果 drift,两类信号必须分开(呼应感知层"截断信号 vs 结构盲区信号必须分开"的教训)。

## 6. 架构落点(方案 1:MCP 编排 + extension 采集)

符合现有分层职责(MCP = 状态 / 协议 / 编排,extension = DOM / 采集):

- **extension**(`packages/extension`):复用 `ClickEffect` 采集;新增 **page-side 指纹归一化**——把 `domMutations`/`networkRequests` 折布尔、保留确定量、拼 `targetIdentity`。归一化必须在 page-side,因为 `targetIdentity`/`ariaChanged` 等确定量只有 page-side 拿得准(否决了纯 MCP 重算方案)。
- **MCP**(`packages/mcp`):指纹存储(Phase 1 = session 内,Phase 2 = 落盘)、drift 比对、autoRecover 编排——天然在 MCP,因为编排要用 ref-parser / snapshot 状态,且 Phase 2 落盘需要 Node fs。
- **数据流**:`act 执行 → 采集 effect → page-side 归一化 fp → record: 返回 fp / verify: 比对 expect → 返回 {matched, drift}`。

## 6.1 实现现实(写计划阶段确认,据此细化)

写实现计划时核查代码,确认两条实现现实,据此细化设计——不缩 spec 意图,反而更贴合现有代码:

1. **effect 采集是 click 专属**:`observeEffect` → `ClickEffect`(`packages/extension/src/page-side/click-effect.ts`,字段 = domMutations / networkRequests / networkSample / urlChanged / focusChanged / ariaChanged / userFeedback / toastHit / dialogHit / observed / windowMs / clamped)仅在 dom.ts CLICK handler 与 cdp.ts `cdpClickElement` 路径采集。fill/type/select/scroll 走 `micro-verify` 的 value / 位置回读,**无副作用采集管道**。

2. **每个 action 用它已有的最强信号**(关键细化):click **没有回读值**(点按钮无 value 可读),只能靠副作用判生效 → 用类别签名;fill/type/select/scroll **有确定的回读值** → value / 位置回读本身就是最强成功信号,无需强加类别采集。因此:
   - `click` 的 fingerprint = 类别签名(ClickEffect 副作用)+ `urlChanged` + `targetIdentity`
   - `fill`/`type`/`select` 的 fingerprint = `valueAfter`(micro-verify 回读)+ `targetIdentity`
   - `scroll` 的 fingerprint = `scrollAfter`(±5px)+ `targetIdentity`
   - `hover`/`drag` = 弱(`weak:true`),只 `targetIdentity`(+ 若有类别)

3. **targetIdentity 来源**:click 路径返回 `element:{tag,text}`,**不含 role::name**。observe 的 `renderSnapshotCache`(`observe-render.ts`)只存 `buildElementKey` 的 `Set`,不按 index 索引。→ 需扩展该缓存按 ref index 存 `role::name::frameId`,供 record 时取 `targetIdentity`(计划 Task)。

4. **范围分层**:Phase 1 **核心闭环聚焦 `click`**(silent-false-success 唯一重灾区,见 §0;唯一无回读值的动作),fill/type/select/scroll 的确定量 fingerprint 列为 Phase 1 **后段可延后 task**(它们 value 回读已是强校验,fingerprint 价值边际)。

## 7. 测试策略(TDD)

- **单测**:
  - 归一化:`domMutations:14` → `causedDomMutation:true`;`domMutations:0` → `false`。
  - 比对:确定量全等 → matched;value 不符 → drift `["value"]`;类别不符 → drift 对应类。
  - 弱效果动作:`weak:true` fp verify 只比类别。
  - 零开销契约:无 `fingerprint` 选项时 act 响应不含 fingerprint 字段。
- **bench case**(复用 `click-effect-signal` 的 synth 页 `/synth/click-effect-signal.html`):
  - record `#eff` 的 click fp → 同页 verify → `matched`(drift null)。
  - 人为改页面状态后 verify → `drift`,类别正确。
  - `autoRecover:true` 时 drift 响应附带新快照。
- **ratchet** 锁回归。

## 8. 验收标准

1. record 模式返回稳定可序列化的 `EffectFingerprint`,同一动作两次 record 的指纹相等(证明归一化抗波动)。
2. verify 模式:效果复现 → `matched`;效果变化 → `drift` 且类别 / 字段精确。
3. 弱效果动作不产生确定量误判。
4. 零开销契约:无选项时 act 行为不变(现有 bench 全绿)。
5. stale ref 与 drift 两类信号在响应中可区分,不混淆。
6. 单测 + 新 bench case 全绿,ratchet 不回退。

## 9. Phase 2 方向(非本 spec 范围,仅留指针)

`vortex_replay` 工具 / batch 扩展:按顺序对一串动作跑 verify 模式 + **跳过 observe**,任一步 drift 从该步降级 re-observe。跨 session 落盘 JSON(类似 Stagehand cacheDir)。这才是 10–100× 成本杠杆的兑现处。Phase 1 的指纹 = Phase 2 每步的"自证轨迹没跑偏"断言。
