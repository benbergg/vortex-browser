# 设计:vortex_replay 序列重放(Phase 2)

- 状态:设计已确认,待写实现计划
- 日期:2026-06-18
- 依赖:Phase 1 effect fingerprint(PR #52,`feat/verifiable-replay-phase1`)。本特性分支 `feat/verifiable-replay-phase2` 基于 PR #52 HEAD `c6759c9`。
- 前序 spec:`docs/superpowers/specs/2026-06-18-verifiable-replay-design.md`

## 0. 背景与定位

竞品分析提案 A 的兑现处。Phase 1 把单个 act 的效果固化成可验证指纹(record/verify + 诚实 drift),是**安全基石**;Phase 2 把它升维成**序列重放**——录一条 N 步任务轨迹,重放时**跳过中间的 observe→LLM 决策往返**,每步用 effect fingerprint「自证轨迹没跑偏」,任一步 drift/定位失败则停步交回 LLM。这才是 **10–100× 成本杠杆**的真正兑现处(vortex 的 act 本就不耗 LLM,LLM 成本花在 observe→决策循环上,跳过它才省)。

延续第一性原理「诚实表征层」:别家的重放「快但可能静默失效」,vortex 的重放「快且自证有效」——停步时精确交代停在哪、为什么,不假装成功。

## 1. 范围、边界与复用

**做**:录制(会话包裹 + 自动捕获)→ 自主重放(跳过 observe→LLM)→ 每步 fingerprint 自证 → drift/定位失败停步交回 LLM → 跨 session 落盘 JSON。

**复用 Phase 1**(几乎是组装,非从零造):
- `lookupIdentity(snapshotId, frameId, index)` —— 录制时从 `@ref` 拿 `role::name::frameId`
- `normalizeClickFingerprint` / `compareFingerprint` / `EffectFingerprint` / `Drift` —— 重放每步 verify
- observe page-side scan —— 重放定位 + 算同源 `targetIdentity`
- `act` + effect 采集(ClickEffect)

**不做**(YAGNI):轨迹编辑/版本迁移、自动 URL 匹配选轨迹、轨迹间组合、并行重放、非 click 动作的指纹(沿用 Phase 1 现状:click 有完整指纹,fill/type/select/scroll 走 value/位置确定量,hover/drag weak)。

## 2. 数据结构

```ts
interface StepTarget {              // observe scan 同源身份 + 三层消歧
  role: string;
  name: string;
  frameId: number;
  ordinal?: number;                 // 同 role::name::frameId 的文档序第几个(消歧 L1)
  parentIdentity?: string;          // 父锚点 "role::name"(near 消歧 L2,来自 observe parentIndex)
  absoluteIndex?: number;           // 全页 scan 的文档序绝对位置(兜底消歧 L3,fingerprint verify 兜住错配)
}

interface TrajectoryStep {
  action: "click" | "fill" | "type" | "select" | "scroll" | "hover";
  target: StepTarget;
  value?: unknown;                  // fill/type/select 的值
  expectFingerprint: EffectFingerprint;  // Phase 1 指纹(weak 动作只含类别)
}

interface Trajectory {
  key: string;
  startUrl: string;                 // 重放前置校验
  createdAt: string;                // ISO 时间(MCP 层 stamp,不在 page-side)
  steps: TrajectoryStep[];
}
```

`StepTarget` 的 `ordinal` + `parentIdentity` 是两层消歧手段(`role::name::frameId` 在"多个提交按钮"时不唯一,而重放跨 snapshot 没有稳定 index)。

## 3. 录制(会话包裹 + 自动捕获)

工具:`vortex_replay_record({ action: "start" })` → vortex 进入捕获态(MCP 层维护 session 录制状态)。

期间 agent **正常跑任务**(observe → 选 `@ref` → act)。每个 act,vortex 自动:
1. 从 `@ref` 经 `lookupIdentity(activeSnapshotId, frameId, index)` 拿 `role::name::frameId`;从 observe 输出取该元素的 `ordinal` / `parentIdentity` → 构造 `StepTarget`
2. 强制 `fingerprint:{mode:"record"}` 拿 `expectFingerprint`(复用 Phase 1 record 路径)
3. 把 `{action, target, value, expectFingerprint}` 追加进当前录制轨迹

`vortex_replay_record({ action: "stop", saveAs: "<key>" })` → 落盘 `.vortex/replays/<key>.json`,退出捕获态。

**录制约束**:act 必须用 `@ref`(才有 `targetIdentity`)。CSS selector 步骤无稳定身份,拒录并诚实报告(复用 Phase 1 `fingerprintSkipped` 同源理由)。录制态下 observe 调用不入轨迹(重放时 vortex 自己 scan)。

## 4. 重放(自主循环)

`vortex_replay({ key, tabId? })`:加载 `.vortex/replays/<key>.json`,校验 `startUrl` 与当前 URL 匹配(不符 → 停步 `reason:"url_mismatch"`),然后对每步 k(从 0)循环:

1. 内部 observe page-side scan(无 LLM)
2. 按 `step.target` 匹配元素(§5 消歧)→ 失败 → **停步**
3. `act`(命中元素)+ 采集 effect
4. 算同源 `targetIdentity` + 归一化实际 fingerprint
5. `compareFingerprint(step.expectFingerprint, actual)` → drift 非 null → **停步**
6. 全部通过 → `{ completed: true, executedSteps: N }`

**停步返回**:
```ts
{
  completed: false,
  stoppedAt: k,                     // 第 k 步(0-based)
  reason: "locate_failed" | "ambiguous" | "drift" | "url_mismatch",
  drift?: Drift,                    // reason==="drift" 时
  executedSteps: k,                 // 已成功执行 0..k-1
  snapshot: <re-observe 新快照文本>  // agent 从此接管
}
```
agent 拿新快照 + 知道前 k 步已执行,用 LLM 从第 k 步接管。诚实表征:精确交代停在哪、为什么,不假装成功。

## 5. 元素重定位与消歧(observe scan 同源)

重放第 k 步定位:scan 后 filter `role === target.role && name === target.name && frameId === target.frameId`:
- **唯一命中** → 用它
- **多个命中** → 三层消歧依次:① `ordinal`(同 role::name::frameId 文档序第 n 个);② 仍歧义 → `parentIdentity` 匹配父锚点筛选;③ 仍歧义 → `absoluteIndex` 兜底(取全页 scan 该绝对位置元素,**仍校验 role/name 一致**,不符则放弃);三层都消不掉 → **停步** `reason:"ambiguous"`
- **零命中** → **停步** `reason:"locate_failed"`

**absoluteIndex 兜底为何安全(Phase 1↔2 闭环)**:绝对文档序 index 是最脆的(任何元素增减都移位),但它只是一个**最佳猜测**——命中后第 4 步的 `compareFingerprint` 是错配安全网:若 absoluteIndex 因结构变化选中了错元素,act 的实际效果与 `expectFingerprint` 不符 → drift 停步,绝不静默错配。所以「激进定位 + fingerprint 验证」既不轻易停步(有兜底猜测),又不静默走错(verify 兜住)。这正是复用 Phase 1 fingerprint 的深层价值:它不只验证「效果复现」,还兜住「定位猜错」。

**需对 observe 增强**:page-side scan 时为每个元素计算 `ordinal`(同 `role::name::frameId` 文档序计数器)+ `absoluteIndex`(全页 scan 顺序绝对序号)。`parentIdentity` 复用现有 `parentIndex`(解析父元素 `role::name`)。三字段录制时写入 `StepTarget`,重放时用于消歧。

## 6. 落盘

- 位置:`.vortex/replays/<key>.json`(项目 cwd 目录,可 git 版本化 + 团队共享)
- 读写在 **MCP 层**(Node `fs`);目录路径可经 env(如 `VORTEX_REPLAY_DIR`)覆盖,默认 `process.cwd()/.vortex/replays/`
- 格式:§2 的 `Trajectory` JSON(human-readable,可手工 review / 编辑)
- 加载校验:文件不存在 / JSON 损坏 / schema 不符 → 诚实报错(不静默)

## 7. 工具面(2 个新公开工具)

- `vortex_replay_record({ action: "start" | "stop", saveAs?: string })`
- `vortex_replay({ key: string, tabId?: number })`

不加 list/delete 工具 —— 用户可直接看 `.vortex/replays/` 目录(YAGNI)。两工具的 schema 加入 `schemas-public.ts`,注意 tools/list byte budget(I15,Phase 1 已到 82B buffer —— **本特性须先做 payload 瘦身或精简 description**,见 §10)。

## 8. 边界与错误处理

- **状态依赖**:重放假设从 `startUrl` 相同初始态开始;中途页面状态分叉由 fingerprint drift 自然捕获并停步(这正是 fingerprint 的价值)
- **弱效果动作**(hover/drag):`expectFingerprint.weak`,verify 只比类别(复用 Phase 1)
- **录制态未 stop 就重启 MCP**:录制状态在内存,丢失即丢(可接受;agent 重录)
- **空轨迹**:`steps:[]` → 重放直接 `completed:true`(no-op)
- **重放中 tab 导航**:每步 re-scan 自然适应;若导航到非预期页 → fingerprint urlChanged drift 捕获
- **两类信号正交**(承袭 Phase 1):定位失败(locate_failed/ambiguous)与 fingerprint drift 是不同 reason,响应可区分

## 9. 测试策略(TDD)

- **单测**(MCP 层 + shared):
  - Trajectory 序列化/反序列化往返
  - StepTarget 消歧:唯一命中 / ordinal 消歧 / parentIdentity 消歧 / absoluteIndex 兜底命中 / absoluteIndex 选错元素→fingerprint drift 停步(错配安全网)/ 三层都消不掉→歧义停步 / 零命中停步
  - 重放循环停步逻辑(mock 定位 + verify):drift 停在第 k 步、返回 executedSteps=k
  - startUrl 校验:不符 → url_mismatch 停步
  - 录制捕获:mock act 序列 → step 追加 + lookupIdentity 取身份 + CSS selector 拒录
  - 落盘:写/读/损坏 JSON 报错;VORTEX_REPLAY_DIR 覆盖
- **bench e2e**(playground 多步页面):录制一条 N 步轨迹 → 重放 `completed:true` → 人为改页面使第 k 步定位失败或 drift → 重放停在 k + 返回新 snapshot + executedSteps=k
- ratchet 锁回归

## 10. 已知前置依赖

- **tools/list payload 瘦身**:Phase 1 已把 I15 cap 推到 7800(82B buffer)。新增 2 个工具的 schema + description 会超 budget。本特性**必须先处理 payload 瘦身**(或把 record/replay 的 description 压到极简),作为第一个 task。否则 I15 失败。
- **消歧字段(ordinal/parentIdentity)需两处支持**:① **录制侧**——vortex 从 active snapshot 取这两个字段构造 `StepTarget`,需扩展 Phase 1 的 `renderSnapshotCache.identityByIndex`(`observe-render.ts`,当前 `Map<index, identityString>`)为存 `{identity, ordinal, parentIdentity, absoluteIndex}`,并扩展 `lookupIdentity` 返回结构(或加 `lookupTarget`);② **重放侧**——内部 scan 时为每个元素实时计算 `ordinal`(同 `role::name::frameId` 文档序计数器)+ `absoluteIndex`(全页 scan 绝对序号)用于匹配。`parentIdentity` 两侧都复用现有 `parentIndex` 解析父元素 `role::name`。这是计划的前置 task(先扩缓存/scan,再建录制/重放)。

## 11. 验收标准

1. 录制一条多步轨迹 → 落盘 JSON 结构正确(含每步 target/value/expectFingerprint)
2. 重放复现 → `completed:true`,全程无 observe→LLM 往返(可观测:重放期间 0 次外部 observe 工具调用,vortex 内部 scan 不算)
3. 中途 drift/定位失败 → 精确停在第 k 步,返回 reason + executedSteps + 新 snapshot
4. 消歧:多个同 role::name 元素时 ordinal/parent 正确命中;真歧义时停步不猜
5. startUrl 不符 → 拒绝重放
6. 单测 + bench e2e 全绿,ratchet 不回退
7. 零开销:未用 replay 功能时,act/observe 行为不变
