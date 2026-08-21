# CDP 表达式拼接序列化真站 Spike

日期：2026-08-21

浏览器：Google Chrome

目标标签页：`https://github.com/`，tabId `984534289`

执行前通过 `vortex_tab_list` 确认该标签页的 `browserLabel` 为 `Google Chrome`。

## Step 1：CSP 严格站现状基线

调用：

```js
return { m: new Map([[1,"a"]]), s: new Set([1,2]), d: new Date(0), p: Promise.resolve(42) }
```

`vortex_evaluate` 实际返回原文：

```json
{
  "d": {},
  "m": {},
  "p": {},
  "s": {}
}
```

## Step 2：拼接序列化函数的表达式

在同一标签页调用计划中给出的完整拼接表达式。`vortex_evaluate` 实际返回原文：

```json
{
  "d": "1970-01-01T00:00:00.000Z",
  "m": [
    [
      1,
      "a"
    ]
  ],
  "p": {
    "__vortexUnserializable": "Promise"
  },
  "s": [
    1,
    2
  ]
}
```

该调用仍通过 `vortex_evaluate` 的 GitHub CSP 回退路径执行；实际返回不是现状基线中的空对象。

## Step 3：纯表达式与顶层 return

纯表达式输入：

```js
({a:1})
```

实际返回原文：

```json
{
  "a": 1
}
```

含 `return` 输入：

```js
return {a:1}
```

实际返回原文：

```json
{
  "a": 1
}
```

两种输入均未向调用方报告语法错误；含 `return` 的输入由现有 CDP 回退逻辑完成顶层包装后返回上述结果。

## Step 4：约 20KB 表达式

将 Step 2 的表达式文本重复拼接到注释中，保持整体表达式可执行。实际发送代码长度为 `21396` 字符；从发起 `vortex_evaluate` 到收到结果的本地测量耗时为 `71ms`。

实际返回原文：

```json
{
  "d": "1970-01-01T00:00:00.000Z",
  "m": [
    [
      1,
      "a"
    ]
  ],
  "p": {
    "__vortexUnserializable": "Promise"
  },
  "s": [
    1,
    2
  ]
}
```

## Step 5：结论

在本次真实 Chrome / GitHub CSP 页面上，序列化函数以文本形式与用户代码拼接后，可以经现有 `vortex_evaluate` CDP 回退路径执行，并在跨边界前把 `Map`、`Set`、`Date` 和 `Promise` 转成预期结构。

因此本 spike 结论为：**拼接可行**。

## Task 2 约束

1. CDP expression 必须在页面内先执行用户代码，再调用序列化函数；不能等 `returnByValue` 返回后再归一化。
2. 纯表达式和含顶层 `return` 的输入都需要支持；含 `return` 的输入需要保留现有 auto-IIFE 包装能力。
3. 本次实测的 `21396` 字符表达式成功，但没有测出上限；Task 2 不应把 `20KB` 当作已证明的 CDP 最大长度，只能把它作为已验证可工作的长度。
4. 本次现有回退调用成功，但未单独对比“显式传入 `allowUnsafeEvalBlockedByCSP: true`”与省略该字段的差异；Task 2 应显式传入该开关并在测试中锁定。

---

## 审核补验（Claude Code，2026-08-21）

独立复跑与补充验证。**浏览器换用 Microsoft Edge**（原 spike 在 Google Chrome 上执行），
目的是确认结论不依赖特定浏览器。

### 复跑 Step 1 基线 —— 数据一致

同一段代码，Edge 上 `vortex_evaluate` 实际返回原文：

```json
{
  "d": {},
  "m": {},
  "p": {},
  "s": {}
}
```

与原 spike 在 Chrome 上记录的完全一致。基线数据可信。

### 补验一：拼接 + 顶层 `return` 的组合（原 Step 3 未覆盖）

原 Step 3 验证的是**不含序列化拼接**的普通输入（`({a:1})` 与 `return {a:1}`），
而 Task 3 的 `asStatement: true` 分支要生成的是"序列化函数 + 含顶层 `return` 的用户代码"，
这个组合原 spike 没测过。补验形态：

```text
(function(){ <序列化函数>; var __r = (function(){ return { m: new Map([[1,"a"]]), d: new Date(0) } })(); return __vtxSerialize(__r); })()
```

实际返回原文：

```json
{
  "d": "1970-01-01T00:00:00.000Z",
  "m": [
    [
      1,
      "a"
    ]
  ]
}
```

**结论**：内层 IIFE 包住含 `return` 的用户代码后，序列化正常工作。
`buildSerializedExpression` 的 `asStatement: true` 分支形态可行。

### 补验二：async 形态（原 spike 完全未覆盖）

Task 3 要同时改 sync 与 async 两个 CDP 分支，原 spike 只覆盖了 sync。补验形态
（顶层 `await` 后再序列化，且内含一个嵌套 Promise）：

```text
(async function(){ <序列化函数>; var __r = await ((function(){ return Promise.resolve({ m: new Map([[1,"a"]]), nested: Promise.resolve(9) }) })()); return __vtxSerialize(__r); })()
```

以 `async: true` 调用，实际返回原文：

```json
{
  "m": [
    [
      1,
      "a"
    ]
  ],
  "nested": {
    "__vortexUnserializable": "Promise"
  }
}
```

**结论**：`awaitTop: true` 形态可行，且顶层 await 之后嵌套 Promise 仍被正确标记——
这正是计划 §Global Constraints 要求的 async 契约（只 await 顶层，嵌套给 marker）。

### 对计划的修正

上述两个组合原本应当属于 Task 1，是计划 Step 3 写得不够精确（只写了"纯表达式与含 return 两种输入"，
未要求与序列化拼接组合，也未要求覆盖 async 形态）。现已补验通过，Task 3 可以据此实施，
**不需要退回重做 Task 1**。

原 spike 提出的两条 Task 2 约束（21396 字符不是已证明上限、`allowUnsafeEvalBlockedByCSP`
未做省略对比）依然有效，Task 3 须按其执行。
