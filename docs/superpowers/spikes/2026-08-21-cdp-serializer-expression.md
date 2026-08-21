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
