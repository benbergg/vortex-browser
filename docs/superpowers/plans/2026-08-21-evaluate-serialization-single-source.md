# evaluate 序列化单一真源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `vortex_evaluate` 的三条执行路径共用同一份序列化真源，使返回结果与执行路径、与目标站 CSP 无关。

**Architecture:** 序列化逻辑收敛为**一份源码字符串常量** `SERIALIZER_SOURCE`。CDP 路径把它文本拼进 `Runtime.evaluate` 的 expression；两条 page-side 路径把它作为 `args` 传入注入函数、在页面内 `new Function` 还原；单测同样用 `new Function` 从这份字符串还原后断言。三处消费同一份文本，因此不存在"两份实现同错则全绿"。序列化一律在**跨边界之前**于页面内完成——CDP 的 `returnByValue` 会先把 host object 压成 `{}`，事后归一化无法恢复。

**Tech Stack:** TypeScript / Chrome MV3 (`chrome.scripting.executeScript`, `chrome.debugger` + CDP `Runtime.evaluate`) / vitest

**Spec:** `docs/evaluate-serialization-approach.md`（路线 1，2026-08-21 关卡确认）

## Global Constraints

- **一次只做一个 Task**，做完停下汇报，等评审通过再接下一个。
- **TDD 顺序不可颠倒**：先写测试 → **真跑出 RED** → 再改实现 → 跑出 GREEN。没跑出 RED 就写实现的，本 Task 作废重来。
- 只碰该 Task 的 **Files** 段列出的文件，要动别的**先问**。
- 跑测试**必须**限并发：`npx vitest run <file> --maxWorkers=2 --minWorkers=1`，工作目录 `packages/extension`。禁止裸跑 `pnpm -r test`。
- 构建扩展**必须**用 `pnpm build`（`vite build && node scripts/build-page-side.mjs`）。**禁止**单跑 `build:main`——它会清掉 `dist/page-side`。
- 提交遵循 Conventional Commits，中文描述，动词开头、结尾无句号，**禁止** `Co-Authored-By` 等署名。
- 代码注释用中文；方法体内一律单行 `//`，每条 ≤1 行、≤60 字，同一方法体内 ≤3 条；只写"为什么"，不复述代码在做什么。
- **marker 契约**（全计划统一，逐字使用）：
  - `Promise` → `{ __vortexUnserializable: "Promise", hint: "await it in your code, e.g. return await expr" }`
  - `WeakMap` / `WeakSet` / `WeakRef` / `FinalizationRegistry` / `SharedArrayBuffer` → `{ __vortexUnserializable: "<Brand>" }`
  - `ArrayBuffer` / `DataView` → `{ __vortexUnserializable: "<Brand>", byteLength: N }`；读 `byteLength` 抛错（detached）时**省略该字段**，不得抛出
  - `RegExp` → `{ __vortexUnserializable: "RegExp", source: "ab+c", flags: "gi" }`
  - `BigInt` → `{ __vortexUnserializable: "BigInt", value: "<十进制字符串>" }`
- **品牌认定规则**（全计划统一）：`Object.prototype.toString` 命中不可序列化品牌后，**还须** `Object.keys(v).length === 0` 才认定为该品牌；否则按普通对象走 `for...in`。这条防 `Symbol.toStringTag` 伪造丢字段。
- **hint 禁令**：任何 hint **不得**指引调用方改用 `async: true` 来取嵌套 Promise。`async` 只 await 顶层，该指引已被实测证伪（见 spec §6）。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/extension/src/lib/evaluate-serializer.ts` | **新建**。序列化真源：导出 `SERIALIZER_SOURCE`（源码字符串）、`SERIALIZER_FN_NAME`、`buildSerializedExpression()`（CDP 表达式包装）。不含任何执行逻辑。 |
| `packages/extension/src/handlers/js.ts` | 三个适配器：sync page-side、async page-side、CDP。只负责"执行用户代码 → 调真源 → 返回"。删除内联 `expandHost` 与零调用的 `normalizeEvaluateResult`。 |
| `packages/extension/tests/evaluate-serializer.test.ts` | **新建**。真源契约测试（用 `new Function` 从 `SERIALIZER_SOURCE` 还原后断言）。 |
| `packages/extension/tests/js-evaluate-adapter-wiring.test.ts` | **新建**。接线测试：断言三个适配器确实把真源送进了执行通道（防死代码假绿）。 |
| `packages/extension/tests/js-evaluate-host-object-serialize.test.ts` | 既有。Task 6 迁移其断言到新真源，删除对 `normalizeEvaluateResult` 的引用。 |
| `docs/superpowers/spikes/2026-08-21-cdp-serializer-expression.md` | **新建**（Task 1）。真实浏览器 spike 记录。 |

---

## Task 1: 真实浏览器 spike —— 验证 CDP 表达式拼接可行

**为什么先做这个：** 整个 Slice 1 建立在"能把序列化源码拼进 CDP expression 并在 CSP 严格站执行"之上。spec §7 把它标为**推测**。此前本项目多轮"日志/静态分析得出的根因"被真站 spike 推翻，这里不重蹈覆辙。本 Task **不改产品代码**。

**Files:**
- Create: `docs/superpowers/spikes/2026-08-21-cdp-serializer-expression.md`

**Interfaces:**
- Consumes: 无
- Produces: spike 结论，Task 2 的表达式包装形态以此为准

- [ ] **Step 1: 用 vortex 在 CSP 严格站上取得现状基线**

在 `https://github.com` 开一个标签页，调用 `vortex_evaluate`（不传 `async`）：

```
return { m: new Map([[1,"a"]]), s: new Set([1,2]), d: new Date(0), p: Promise.resolve(42) }
```

记录实际返回。**预期基线**（缺陷现状）：`m`/`s`/`d` 均为 `{}`。把原文抄进 spike 文档。

- [ ] **Step 2: 手工验证拼接后的表达式在同一站可执行**

同一标签页，用 `vortex_evaluate` 执行下面这段——它模拟 Task 2 将要生成的表达式形态（序列化函数以文本形式与用户代码拼在一起）：

```
return (function(){ function S(v,d){ d=d||0; if(d>5) return null; if(v===null||v===undefined) return v; var t=typeof v; if(t==="string"||t==="number"||t==="boolean") return v; if(Array.isArray(v)) return v.map(function(x){return S(x,d+1);}); if(t!=="object") return v; var tag=Object.prototype.toString.call(v).slice(8,-1); if(tag==="Date") return v.toJSON(); if(tag==="Map"||tag==="Set") return Array.from(v).map(function(x){return S(x,d+1);}); if(tag==="Promise"&&Object.keys(v).length===0) return {__vortexUnserializable:"Promise"}; var o={}; for(var k in v){ try{ var vv=v[k]; if(typeof vv==="function") continue; o[k]=S(vv,d+1);}catch(e){} } return o; } var r={ m:new Map([[1,"a"]]), s:new Set([1,2]), d:new Date(0), p:Promise.resolve(42) }; return S(r); })()
```

**预期**：`m` 为 `[[1,"a"]]`、`s` 为 `[1,2]`、`d` 为 ISO 字符串、`p` 为 marker。抄录实际返回。

> 注意：这一步走的仍是产品现有的 CDP 回退（因为 github.com 触发 CSP 分支），所以它同时验证了"表达式可执行"和"该站确实走 CDP"。

- [ ] **Step 3: 验证顶层 `return` 与纯表达式两种输入都能包装**

同站分别执行下面两种形态，确认都不报语法错：

```
纯表达式形态：({a:1})
含 return 形态：return {a:1}
```

抄录两者的实际返回，记录当前 auto-IIFE 回退是否被触发。

- [ ] **Step 4: 量表达式长度与超时行为**

把 Step 2 的表达式重复拼接到约 20KB，执行一次，记录是否成功、耗时。目的是确认拼接后的长度不会踩到 CDP 的限制。抄录结果。

- [ ] **Step 5: 写 spike 文档**

`docs/superpowers/spikes/2026-08-21-cdp-serializer-expression.md` 必须包含：
1. 每步的**实际返回原文**（不是"符合预期"这类转述）；
2. 结论：拼接可行 / 不可行；
3. 若不可行，写清卡在哪一步、错误原文——**此时停止本计划，回到 spec 重新选路线**；
4. 对 Task 2 表达式包装形态的约束（是否需要 auto-IIFE、长度上限、是否需显式传 `allowUnsafeEvalBlockedByCSP`）。

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/spikes/2026-08-21-cdp-serializer-expression.md
git commit -m "docs: 记录 CDP 表达式拼接序列化的真站 spike 结论"
```

---

## Task 2: 建立序列化真源模块

**Files:**
- Create: `packages/extension/src/lib/evaluate-serializer.ts`
- Test: `packages/extension/tests/evaluate-serializer.test.ts`

**Interfaces:**
- Consumes: Task 1 的 spike 结论（表达式形态约束）
- Produces:
  - `export const SERIALIZER_FN_NAME = "__vtxSerialize"`
  - `export const SERIALIZER_SOURCE: string` —— 一个完整函数声明的源码文本，函数名即 `SERIALIZER_FN_NAME`，签名 `(v: unknown, d?: number) => unknown`
  - `export function loadSerializer(): (v: unknown, d?: number) => unknown` —— 用 `new Function` 从 `SERIALIZER_SOURCE` 还原，**仅供测试与 CDP 之外的消费方**

- [ ] **Step 1: 写失败的测试**

创建 `packages/extension/tests/evaluate-serializer.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { SERIALIZER_SOURCE, SERIALIZER_FN_NAME, loadSerializer } from "../src/lib/evaluate-serializer.js";

// 真源是一份源码字符串:测试用 new Function 还原它,注入与 CDP 也消费同一份文本。
// 三处同源,因此不存在"两份实现同错则全绿"。
const S = loadSerializer();

describe("SERIALIZER_SOURCE 自包含性", () => {
  it("源码里定义了约定的函数名", () => {
    expect(SERIALIZER_SOURCE).toContain(`function ${SERIALIZER_FN_NAME}`);
  });

  it("不引用任何模块作用域标识符(注入后会 is not defined)", () => {
    const src = SERIALIZER_SOURCE.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/\bimport\b|\brequire\(|\bexports\b/);
  });
});

describe("直通值", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["字符串", "x", "x"],
    ["数字", 42, 42],
    ["布尔", true, true],
    ["null", null, null],
    ["undefined", undefined, undefined],
    ["普通对象", { a: 1 }, { a: 1 }],
    ["数组", [1, 2], [1, 2]],
    ["嵌套普通对象", { a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }],
    ["空对象仍是空对象", {}, {}],
    ["嵌套空对象仍是空对象", { a: {} }, { a: {} }],
  ];
  for (const [label, input, expected] of cases) {
    it(label, () => expect(S(input)).toEqual(expected));
  }
});

describe("已支持品牌", () => {
  it("Date → ISO 字符串", () => expect(S(new Date(0))).toBe("1970-01-01T00:00:00.000Z"));
  it("Map → 键值对数组", () => expect(S(new Map([[1, "a"]]))).toEqual([[1, "a"]]));
  it("Set → 数组", () => expect(S(new Set([1, 2]))).toEqual([1, 2]));
  it("Uint8Array → 数组", () => expect(S(new Uint8Array([1, 2]))).toEqual([1, 2]));
  it("Error → 平铺对象", () => {
    const e = Object.assign(new TypeError("boom"), { stack: "st" });
    expect(S(e)).toEqual({ name: "TypeError", message: "boom", stack: "st" });
  });
});

describe("不可序列化品牌 → 自陈 marker", () => {
  it("Promise", () => {
    expect(S(Promise.resolve(1))).toEqual({
      __vortexUnserializable: "Promise",
      hint: "await it in your code, e.g. return await expr",
    });
  });
  it("嵌套 Promise 只影响该字段", () => {
    expect(S({ name: "x", data: Promise.resolve(1) })).toEqual({
      name: "x",
      data: { __vortexUnserializable: "Promise", hint: "await it in your code, e.g. return await expr" },
    });
  });
  it("WeakMap / WeakSet", () => {
    expect(S(new WeakMap())).toEqual({ __vortexUnserializable: "WeakMap" });
    expect(S(new WeakSet())).toEqual({ __vortexUnserializable: "WeakSet" });
  });
  it("WeakRef / FinalizationRegistry", () => {
    expect(S(new WeakRef({}))).toEqual({ __vortexUnserializable: "WeakRef" });
    expect(S(new FinalizationRegistry(() => {}))).toEqual({ __vortexUnserializable: "FinalizationRegistry" });
  });
  it("ArrayBuffer 带 byteLength", () => {
    expect(S(new ArrayBuffer(8))).toEqual({ __vortexUnserializable: "ArrayBuffer", byteLength: 8 });
  });
  it("DataView 带 byteLength", () => {
    expect(S(new DataView(new ArrayBuffer(4)))).toEqual({ __vortexUnserializable: "DataView", byteLength: 4 });
  });
  it("RegExp 保留 source 与 flags,不退化成字符串", () => {
    expect(S(/ab+c/gi)).toEqual({ __vortexUnserializable: "RegExp", source: "ab+c", flags: "gi" });
  });
  it("BigInt 转十进制字符串", () => {
    expect(S(BigInt("9007199254740993"))).toEqual({
      __vortexUnserializable: "BigInt",
      value: "9007199254740993",
    });
  });
});

describe("边界", () => {
  // detached buffer 上读 byteLength 会抛 TypeError;marker 生成过程本身不许抛
  it("detached DataView 不抛错,省略 byteLength", () => {
    const ab = new ArrayBuffer(8);
    const dv = new DataView(ab);
    structuredClone(ab, { transfer: [ab] });
    expect(() => S(dv)).not.toThrow();
    expect(S(dv)).toEqual({ __vortexUnserializable: "DataView" });
  });

  it("嵌套 detached DataView 不吞掉该字段", () => {
    const ab = new ArrayBuffer(8);
    const dv = new DataView(ab);
    structuredClone(ab, { transfer: [ab] });
    expect(S({ v: dv })).toEqual({ v: { __vortexUnserializable: "DataView" } });
  });

  // Symbol.toStringTag 可被页面伪造;带数据字段的伪造对象必须保住字段
  it("伪造 toStringTag 的普通对象不丢字段", () => {
    const fake = { foo: 1, [Symbol.toStringTag]: "Promise" };
    expect(S(fake)).toEqual({ foo: 1 });
  });

  it("伪造 toStringTag 且无自有字段时按 marker(本来就是空对象)", () => {
    const fake = Object.defineProperty({}, Symbol.toStringTag, { value: "WeakMap" });
    expect(S(fake)).toEqual({ __vortexUnserializable: "WeakMap" });
  });

  it("循环引用不栈溢出,自引用位置置 null", () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(() => S(a)).not.toThrow();
    expect(S(a)).toEqual({ n: 1, self: null });
  });

  it("超过深度上限的层级置 null", () => {
    expect(S({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }))
      .toEqual({ a: { b: { c: { d: { e: { f: null } } } } } });
  });

  it("函数与 symbol 值被丢弃", () => {
    expect(S({ f: () => 1, s: Symbol("x"), keep: 1 })).toEqual({ keep: 1 });
  });

  it("构造器被页面重命名仍按品牌路由", () => {
    class Renamed extends Map {}
    Object.defineProperty(Renamed, "name", { value: "e" });
    expect(S(new Renamed([[1, "a"]]))).toEqual([[1, "a"]]);
  });
});
```

- [ ] **Step 2: 跑测试,确认 RED**

```bash
cd packages/extension && npx vitest run tests/evaluate-serializer.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL —— `Cannot find module '../src/lib/evaluate-serializer.js'`

- [ ] **Step 3: 写实现**

创建 `packages/extension/src/lib/evaluate-serializer.ts`：

```ts
/**
 * evaluate 返回值序列化的**唯一真源**。
 *
 * 为什么是源码字符串而不是函数:序列化必须在页面内、跨边界之前完成。
 * CDP 的 returnByValue 会先把 host object 压成 `{}`,事后归一化无法恢复
 * (真站实测:github.com 上 Date/Map/Set 全部丢失);而 executeScript 注入时
 * 丢模块作用域,函数引用会 is not defined。一份文本被三条路径共同消费,
 * 测试也从同一文本还原,才不会出现"两份实现同错则全绿"。
 */

export const SERIALIZER_FN_NAME = "__vtxSerialize";

export const SERIALIZER_SOURCE = `function ${SERIALIZER_FN_NAME}(v, d, seen) {
  d = d || 0;
  seen = seen || [];
  if (d > 5) return null;
  if (v === null || v === undefined) return v;
  var t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "bigint") return { __vortexUnserializable: "BigInt", value: String(v) };
  if (t === "function" || t === "symbol") return undefined;
  if (t !== "object") return v;
  if (seen.indexOf(v) !== -1) return null;
  seen = seen.concat([v]);
  if (Array.isArray(v)) {
    return v.map(function (x) { return ${SERIALIZER_FN_NAME}(x, d + 1, seen); });
  }
  var tag = Object.prototype.toString.call(v).slice(8, -1);
  if (tag === "Date") {
    try { return v.toJSON(); } catch (e) { return { __vortexUnserializable: "Date" }; }
  }
  if (tag === "Error" || (v.name && String(v.name).slice(-5) === "Error")) {
    var eo = { name: v.name, message: v.message };
    if (v.stack) eo.stack = v.stack;
    return eo;
  }
  if (tag === "Map" || tag === "Set" || tag === "NodeList") {
    return Array.from(v).map(function (x) { return ${SERIALIZER_FN_NAME}(x, d + 1, seen); });
  }
  if (/^(Ui|I)nt(8|16|32)(Clamped)?Array$|^Float(32|64)Array$|^Big(Ui|I)nt64Array$/.test(tag)) {
    return Array.from(v).map(function (x) { return ${SERIALIZER_FN_NAME}(x, d + 1, seen); });
  }
  // 品牌命中还须无可枚举自有字段才认:防页面用 Symbol.toStringTag 伪造导致丢字段
  var bare = Object.keys(v).length === 0;
  if (bare) {
    if (tag === "Promise") {
      return { __vortexUnserializable: "Promise", hint: "await it in your code, e.g. return await expr" };
    }
    if (tag === "WeakMap" || tag === "WeakSet" || tag === "WeakRef" ||
        tag === "FinalizationRegistry" || tag === "SharedArrayBuffer") {
      return { __vortexUnserializable: tag };
    }
    if (tag === "ArrayBuffer" || tag === "DataView") {
      var m = { __vortexUnserializable: tag };
      // detached buffer 上读 byteLength 抛 TypeError,生成 marker 本身不许抛
      try { m.byteLength = v.byteLength; } catch (e) {}
      return m;
    }
    if (tag === "RegExp") {
      return { __vortexUnserializable: "RegExp", source: v.source, flags: v.flags };
    }
  }
  var o = {};
  for (var k in v) {
    if (Object.prototype.hasOwnProperty.call(Object.prototype, k)) continue;
    try {
      var vv = v[k];
      if (typeof vv === "function" || typeof vv === "symbol") continue;
      o[k] = ${SERIALIZER_FN_NAME}(vv, d + 1, seen);
    } catch (e) { /* 取不到的字段跳过 */ }
  }
  return o;
}`;

/** 从真源文本还原出可调用的函数。测试与非注入场景用,注入路径直接消费文本。 */
export function loadSerializer(): (v: unknown, d?: number) => unknown {
  return new Function(`${SERIALIZER_SOURCE}; return ${SERIALIZER_FN_NAME};`)() as (
    v: unknown,
    d?: number,
  ) => unknown;
}
```

- [ ] **Step 4: 跑测试,确认 GREEN**

```bash
cd packages/extension && npx vitest run tests/evaluate-serializer.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS，全部用例通过。

- [ ] **Step 5: 变异验证 —— 证明测试锁得住**

依次做下面三处改动，每次跑一遍测试，确认**都转红**，然后改回：

1. 把 `var bare = Object.keys(v).length === 0;` 改成 `var bare = true;` → 伪造 toStringTag 用例必须红
2. 删掉 `try { m.byteLength = v.byteLength; } catch (e) {}` 的 try 包裹 → detached DataView 用例必须红
3. 把 RegExp 分支改成 `return String(v);` → RegExp 用例必须红

三处有任何一处仍绿，说明该用例没锁住行为，**修测试再继续**。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/lib/evaluate-serializer.ts packages/extension/tests/evaluate-serializer.test.ts
git commit -m "feat: 新增 evaluate 序列化真源模块"
```

---

## Task 3: CDP 适配器接入真源，并按模式决定是否等待顶层

**这是最小可发布片。** 合并后 CSP 严格站点不再丢失 host object，且 sync 语义与 page-side 对齐。

**Files:**
- Modify: `packages/extension/src/lib/evaluate-serializer.ts`（新增表达式包装函数）
- Modify: `packages/extension/src/handlers/js.ts:116-169`（`cdpEvaluate`）、`js.ts:432-447`、`js.ts:530-559`（两处 CDP 回退调用点）
- Test: `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`（新建）

**Interfaces:**
- Consumes: `SERIALIZER_SOURCE`、`SERIALIZER_FN_NAME`（Task 2）
- Produces:
  - `export function buildSerializedExpression(userCode: string, opts: { awaitTop: boolean; asStatement: boolean }): string`
  - `cdpEvaluate(debuggerMgr, tabId, expression, timeoutMs, awaitTop: boolean)` —— 新增第 5 个参数

- [ ] **Step 1: 写失败的测试**

创建 `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerJsHandlers } from "../src/handlers/js.js";
import { SERIALIZER_FN_NAME } from "../src/lib/evaluate-serializer.js";

interface NmRequest {
  type: "tool_request"; tool: string; args: Record<string, unknown>; requestId: string; tabId: number;
}
function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

/**
 * 接线测试:证明适配器确实把真源送进了执行通道。
 * 只断言"最终结果对"是不够的——page-side 可能意外成功,让 CDP 分支的缺陷假绿。
 */
describe("CDP 适配器接线", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let sendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    sendCommand = vi.fn().mockResolvedValue({ result: { value: 1 } });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand } as never;
    registerJsHandlers(router, debuggerMgr);
  });
  afterEach(() => vi.unstubAllGlobals());

  // page-side 先报 CSP 拒绝,逼出 CDP 回退
  function forceCspFallback() {
    executeScript.mockResolvedValue([{ result: { error: "EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script" } }]);
  }

  it("sync:CDP 表达式必须包含序列化真源", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluate", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call, "Runtime.evaluate 未被调用").toBeTruthy();
    expect(call![2].expression).toContain(SERIALIZER_FN_NAME);
  });

  it("sync:CDP 不得等待顶层 Promise(与 page-side sync 语义对齐)", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluate", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].awaitPromise).toBe(false);
  });

  it("async:CDP 等待顶层 Promise", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].awaitPromise).toBe(true);
  });

  it("async:CDP 表达式同样包含序列化真源", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].expression).toContain(SERIALIZER_FN_NAME);
  });

  it("显式传 allowUnsafeEvalBlockedByCSP,不依赖实验性默认值", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluate", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].allowUnsafeEvalBlockedByCSP).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试,确认 RED**

```bash
cd packages/extension && npx vitest run tests/js-evaluate-adapter-wiring.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL —— expression 不含 `__vtxSerialize`；`awaitPromise` 为 `true` 而非 `false`；`allowUnsafeEvalBlockedByCSP` 为 `undefined`。

- [ ] **Step 3: 在真源模块新增表达式包装**

追加到 `packages/extension/src/lib/evaluate-serializer.ts` 末尾：

```ts
/**
 * 把用户代码包成"页面内先求值、再序列化"的 CDP 表达式。
 * 序列化必须发生在 returnByValue 之前,否则 host object 已被压成 `{}`。
 */
export function buildSerializedExpression(
  userCode: string,
  opts: { awaitTop: boolean; asStatement: boolean },
): string {
  const body = opts.asStatement ? `(function(){ ${userCode} })()` : `(${userCode})`;
  const value = opts.awaitTop ? `await (${body})` : body;
  const wrapper = opts.awaitTop ? "async function" : "function";
  return `(${wrapper} (){ ${SERIALIZER_SOURCE}; var __r = ${value}; return ${SERIALIZER_FN_NAME}(__r); })()`;
}
```

- [ ] **Step 4: 改 cdpEvaluate 接收 awaitTop 并显式传参**

修改 `packages/extension/src/handlers/js.ts` 的 `cdpEvaluate`：签名追加第 5 个参数 `awaitTop: boolean`；`sendCommand` 的参数对象里把 `awaitPromise: true` 改为 `awaitPromise: awaitTop`，并新增 `allowUnsafeEvalBlockedByCSP: true`。

同时把 `js.ts:107` 那句已经过期的注释——"returnByValue 与 executeScript 序列化语义一致"——改为：

```ts
 * returnByValue 会把 host object 压成 `{}`,故序列化必须在页面内先完成(见
 * evaluate-serializer.ts);awaitPromise 由调用方按 sync/async 显式指定。
```

- [ ] **Step 5: 两处 CDP 回退调用点改用包装表达式**

`js.evaluate` 的 CSP 回退分支（`js.ts:432-447` 一带）：把原先传 `code` 与手工 `(function(){...})()` 重试的两次调用，改为一次调用
`cdpEvaluate(debuggerMgr, tid, buildSerializedExpression(code, { awaitTop: false, asStatement: false }), timeout, false)`；
捕获到 `/SyntaxError|Unexpected|Illegal return/` 时改用 `asStatement: true` 重试一次。

`js.evaluateAsync` 的 CSP 回退分支（`js.ts:530-559` 一带）同理，但 `awaitTop: true`。

- [ ] **Step 6: 跑测试,确认 GREEN**

```bash
cd packages/extension && npx vitest run tests/js-evaluate-adapter-wiring.test.ts tests/js-evaluate-csp-cdp-fallback.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS。若 `js-evaluate-csp-cdp-fallback.test.ts` 有用例因 `awaitPromise` 期望值变化而红，**先停下汇报**——那是既有测试锁住了旧契约，需要确认是改测试还是改设计。

- [ ] **Step 7: 真实浏览器验收**

```bash
cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension build
```

然后 `vortex_dev_reload`，在 `https://github.com` 上调 `vortex_evaluate`：

| 输入 | 期望 |
|---|---|
| `return { m: new Map([[1,"a"]]), d: new Date(0) }` | `m` 为 `[[1,"a"]]`，`d` 为 ISO 字符串 |
| `return Promise.resolve(42)`（不传 async） | Promise marker（**不是** `42`） |
| `return Promise.resolve(42)` + `async:true` | `42` |
| `return { name:"x", data: Promise.resolve(1) }` + `async:true` | `data` 为 marker |

把实际返回抄进提交说明。任一条不符**停下汇报**。

- [ ] **Step 8: 提交**

```bash
git add packages/extension/src/lib/evaluate-serializer.ts packages/extension/src/handlers/js.ts packages/extension/tests/js-evaluate-adapter-wiring.test.ts
git commit -m "fix: CDP 路径在页面内完成序列化并按模式决定是否等待顶层"
```

---

## Task 4: page-side sync 适配器切到真源

**Files:**
- Modify: `packages/extension/src/handlers/js.ts:289-450`（`JsActions.EVALUATE` 分支，删除内联 `expandHost`）
- Test: `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`（追加）

**Interfaces:**
- Consumes: `SERIALIZER_SOURCE`、`SERIALIZER_FN_NAME`（Task 2）
- Produces: 无新导出

- [ ] **Step 1: 写失败的测试**

追加到 `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`：

```ts
describe("page-side sync 适配器接线", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn().mockResolvedValue([{ result: { result: null } }]);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerJsHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("真源以 args 形式送进注入函数,而非在 func 里另写一份", async () => {
    await router.dispatch(mkReq("js.evaluate", { code: "1+1" }, 42));
    const args = executeScript.mock.calls[0][0].args as string[];
    expect(args.some((a) => typeof a === "string" && a.includes(SERIALIZER_FN_NAME))).toBe(true);
  });

  it("注入函数源码里不再存在第二份品牌路由表", async () => {
    await router.dispatch(mkReq("js.evaluate", { code: "1+1" }, 42));
    const src = (executeScript.mock.calls[0][0].func as (...a: unknown[]) => unknown).toString();
    expect(src).not.toMatch(/expandHost/);
  });

  it("剥离模块作用域后仍能跑通并按真源序列化", async () => {
    await router.dispatch(mkReq("js.evaluate", { code: "1+1" }, 42));
    const call = executeScript.mock.calls[0][0];
    const src = (call.func as (...a: unknown[]) => unknown).toString();
    // new Function 在全局作用域重建,看不到模块级标识符——与页面 MAIN world 等价
    const detached = new Function(`return (${src});`)() as (...a: unknown[]) => { result?: unknown };
    const out = detached("new Map([[1,'a']])", ...(call.args as unknown[]).slice(1));
    expect(out.result).toEqual([[1, "a"]]);
  });
});
```

- [ ] **Step 2: 跑测试,确认 RED**

```bash
cd packages/extension && npx vitest run tests/js-evaluate-adapter-wiring.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL —— `args` 里没有真源；func 源码仍含 `expandHost`。

- [ ] **Step 3: 改实现**

`JsActions.EVALUATE` 分支：
1. `executeScript` 的 `args` 从 `[code]` 改为 `[code, SERIALIZER_SOURCE]`；
2. 注入函数签名改为 `(c: string, serSrc: string) => {...}`；
3. **删除**整段内联 `expandHost` 定义，改为在函数开头还原真源：
   ```ts
   const S = new Function(`${serSrc}; return ${SERIALIZER_FN_NAME};`)() as (x: unknown) => unknown;
   ```
   —— 函数名不能写死字符串，需把 `SERIALIZER_FN_NAME` 一并放进 `args` 或直接内联进 `serSrc` 的尾部；本计划采用后者：让 `serSrc` 传入时就是 `${SERIALIZER_SOURCE}; return ${SERIALIZER_FN_NAME};`，注入函数里写 `const S = new Function(serSrc)() as (x: unknown) => unknown;`。据此把 Step 3.1 的 `args` 改为
   `[code, \`${SERIALIZER_SOURCE}; return ${SERIALIZER_FN_NAME};\`]`。
4. 把原先四处 `expandHost(...)` 调用改为 `S(...)`。

TT policy 与 auto-IIFE 逻辑**保持不变**，只替换序列化部分。

- [ ] **Step 4: 跑测试,确认 GREEN**

```bash
cd packages/extension && npx vitest run tests/js-evaluate-adapter-wiring.test.ts tests/js-evaluate-host-object-serialize.test.ts tests/js-evaluate-trusted-types.test.ts tests/js-evaluate-auto-iife.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS。

- [ ] **Step 5: 变异验证**

把 `args` 里的真源换成一个只会返回 `{}` 的假 serializer，跑测试，确认 Step 1 的第三条用例转红；改回。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/js.ts packages/extension/tests/js-evaluate-adapter-wiring.test.ts
git commit -m "refactor: page-side 同步路径改用序列化真源"
```

---

## Task 5: page-side async 适配器接入真源

**这条路径此前完全没有序列化**——`return { result: await promise }` 直接跨边界。

**Files:**
- Modify: `packages/extension/src/handlers/js.ts:452-528`（`JsActions.EVALUATE_ASYNC` 分支）
- Test: `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`（追加）
- Test: `packages/extension/tests/js-evaluate-async-expression.test.ts`（既有用例补传 `serSrc` 参数；**从生产 `args[1]` 取，不得自写字面量**）

**Interfaces:**
- Consumes: `SERIALIZER_SOURCE`、`SERIALIZER_FN_NAME`（Task 2）
- Produces: 无新导出

- [ ] **Step 1: 写失败的测试**

追加到 `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`：

```ts
describe("page-side async 适配器接线", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn().mockResolvedValue([{ result: { result: null } }]);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerJsHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("真源以 args 形式送进 async 注入函数", async () => {
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const args = executeScript.mock.calls[0][0].args as string[];
    expect(args.some((a) => typeof a === "string" && a.includes(SERIALIZER_FN_NAME))).toBe(true);
  });

  it("剥离作用域后:await 顶层再序列化,host object 不再丢失", async () => {
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const call = executeScript.mock.calls[0][0];
    const src = (call.func as (...a: unknown[]) => unknown).toString();
    const detached = new Function(`return (${src});`)() as (...a: unknown[]) => Promise<{ result?: unknown }>;
    const rest = (call.args as unknown[]).slice(1);
    expect((await detached("return new Map([[1,'a']])", ...rest)).result).toEqual([[1, "a"]]);
    expect((await detached("return Promise.resolve(7)", ...rest)).result).toBe(7);
    const nested = await detached("return {name:'x', data: Promise.resolve(1)}", ...rest);
    expect(nested.result).toEqual({
      name: "x",
      data: { __vortexUnserializable: "Promise", hint: "await it in your code, e.g. return await expr" },
    });
  });
});
```

- [ ] **Step 2: 跑测试,确认 RED**

```bash
cd packages/extension && npx vitest run tests/js-evaluate-adapter-wiring.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL —— `args` 无真源；Map 返回 `{}`；嵌套 Promise 返回 `{}`。

- [ ] **Step 3: 改实现**

`JsActions.EVALUATE_ASYNC` 分支：
1. `args` 从 `[code]` 改为 `` [code, `${SERIALIZER_SOURCE}; return ${SERIALIZER_FN_NAME};`] ``；
2. 注入函数签名改为 `async (c: string, serSrc: string) => {...}`；
3. 把 `return { result: await promise };` 改为先还原真源再序列化。
   **还原必须用 `eval` 而非 `new Function`**——`new Function` 不接受 `TrustedScript`，
   在 Trusted Types 页会崩，这条有 live 复现记录（`js-evaluate-trusted-types.test.ts:176-178`，
   youtube 2026-06-17，当年出事的正是 async 这条路径）。照 Task 4 已验证的写法：
   `args` 传表达式形态 `(function(){ SOURCE; return FN; })()`，注入函数内 `eval(serSrc)` 还原，
   放在 try 内，TT 错走 policy 重试，非 TT 失败 `return { error: m }` 交给 handler 回退 CDP。
   然后 `return { result: S(await promise) };`

- [ ] **Step 4: 跑测试,确认 GREEN**

```bash
cd packages/extension && npx vitest run tests/js-evaluate-adapter-wiring.test.ts tests/js-evaluate-async-expression.test.ts tests/js-evaluate-timeout.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: PASS。

- [ ] **Step 5: 真实浏览器验收 —— 四种组合必须一致**

`pnpm --filter @vortex-browser/extension build` 后 `vortex_dev_reload`，对
`return new Map([[1,"a"],[2,"b"]])` 跑四种组合，抄录实际返回：

| 站点 | 模式 | 期望 |
|---|---|---|
| example.com | sync | `[[1,"a"],[2,"b"]]` |
| example.com | async | `[[1,"a"],[2,"b"]]` |
| github.com | sync | `[[1,"a"],[2,"b"]]` |
| github.com | async | `[[1,"a"],[2,"b"]]` |

四格必须完全一致。任一格不同**停下汇报**。

**额外一格（审核追加）**：`https://www.youtube.com`（真实 Trusted Types 站）上以 `async: true` 调用
同一段代码，同样期望 `[[1,"a"],[2,"b"]]`。async 正是 2026-06-17 TT 崩溃的那条路径，
必须在真 TT 站确认没有回归——单测 mock 不出真实 TT。

做真站验收前先 `pnpm --filter @vortex-browser/extension build`，然后用 buildStamp
核对运行中的扩展确实是新构建，**不要只凭构建成功就断言新逻辑生效**。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/handlers/js.ts packages/extension/tests/js-evaluate-adapter-wiring.test.ts
git commit -m "fix: page-side 异步路径补上序列化,与同步路径对齐"
```

---

## Task 6: 清理死代码与遗留实现，加静态守卫

**Files:**
- Modify: `packages/extension/src/handlers/js.ts:210-282`（删除 `normalizeEvaluateResult`）
- Modify: `packages/extension/tests/js-evaluate-host-object-serialize.test.ts`（迁移断言到真源）
- Modify: `packages/extension/src/content.ts`、`packages/extension/src/lib/script-injector.ts`（明确归属）
- Test: `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`（追加静态守卫）

**Interfaces:**
- Consumes: Task 2-5 的全部产出
- Produces: 无新导出

- [ ] **Step 1: 写守卫测试**

追加到 `packages/extension/tests/js-evaluate-adapter-wiring.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 防复发守卫。本次缺陷的成因就是"三条路径各写各的、其中一份还是死代码",
 * 上一轮的变异验证只证明了两份实现各自被测试锁住,证明不了两份都被生产调用。
 */
describe("单一真源静态守卫", () => {
  const jsSrc = readFileSync(resolve(__dirname, "../src/handlers/js.ts"), "utf-8");

  it("handlers/js.ts 里不存在第二份品牌路由表", () => {
    expect(jsSrc).not.toMatch(/normalizeEvaluateResult|expandHost/);
  });

  it("序列化只从真源模块引入", () => {
    expect(jsSrc).toMatch(/from "\.\.\/lib\/evaluate-serializer\.js"/);
  });

  it("遗留 content.ts 不得再出现裸 eval 实现", () => {
    const contentSrc = readFileSync(resolve(__dirname, "../src/content.ts"), "utf-8");
    expect(contentSrc).not.toMatch(/new Function\(/);
  });
});
```

- [ ] **Step 2: 跑测试,确认 RED**

```bash
cd packages/extension && npx vitest run tests/js-evaluate-adapter-wiring.test.ts --maxWorkers=2 --minWorkers=1
```

Expected: FAIL —— `js.ts` 仍含 `normalizeEvaluateResult`；`content.ts` 仍含 `new Function(`。

- [ ] **Step 3: 删除死代码**

1. 删除 `packages/extension/src/handlers/js.ts` 的 `normalizeEvaluateResult` 整个函数及其 JSDoc（该 JSDoc 声称"handler 侧调它处理 CDP 回退的 result"，而该调用从不存在）。
2. `packages/extension/tests/js-evaluate-host-object-serialize.test.ts`：删除对 `normalizeEvaluateResult` 的 import 与其纯函数用例段（这些断言已由 `tests/evaluate-serializer.test.ts` 覆盖）；保留 page-side 真注入用例段，把其中对品牌的断言对齐到新契约。
3. `packages/extension/src/content.ts`：删除 `evalInPage` / `evalAsyncInPage` 两个函数与它们的 `case` 分支，改为在文件顶部写明该模块不承担 JS 求值、求值统一走 `handlers/js.ts`。若删除后 `content.ts` 已无内容，连同 `packages/extension/src/lib/script-injector.ts` 的 `sendToContentScript`（**零调用方**）一并删除。

- [ ] **Step 4: 跑全量测试,确认 GREEN**

```bash
cd packages/extension && npx vitest run --maxWorkers=2 --minWorkers=1
```

Expected: 全部通过。有红的**停下汇报**，不要自行改设计。

- [ ] **Step 5: 全链路变异验证**

依次做下面四处改动，每次跑一遍**全量测试**，确认都转红，然后改回：

1. Task 3 的 CDP 表达式改回直接传 `code`（不包装）→ 接线测试必须红
2. Task 4 的 sync `args` 去掉真源 → 接线测试必须红
3. Task 5 的 async 去掉 `S(...)` 包裹 → 接线测试必须红
4. `cdpEvaluate` 的 `awaitPromise` 改回硬编码 `true` → sync 语义用例必须红

任一处仍绿，说明该条接线没有被锁住，**补测试再继续**。

- [ ] **Step 6: 更新 CHANGELOG**

在 `CHANGELOG.md` 的 `## [Unreleased]` → `### Changed` 下，**替换**此前那条关于 `vortex_evaluate` 品牌自陈的条目（它描述的实现已被本计划取代），写明：
1. 三条路径统一到同一序列化契约；
2. **行为变更**：CSP 严格站点上 `async=false` 遇顶层 Promise，由返回解析值改为返回 marker；
3. **行为变更**：CSP 严格站点上 host object 由 `{}` 改为正确序列化；
4. marker 契约的完整形状（照抄 Global Constraints 段）；
5. 调用方注意：`Object.keys(v).length === 0` 一类判空会改变分支走向。

- [ ] **Step 7: 提交**

```bash
git add packages/extension/src packages/extension/tests CHANGELOG.md
git commit -m "refactor: 删除零调用的归一化函数与遗留求值实现"
```

---

## 自检记录

**1. Spec 覆盖检查**

| spec 要求 | 落在哪个 Task |
|---|---|
| §1.1 三条路径结果一致 | Task 5 Step 5 四格对照 |
| §1.2 sync/async 嵌套 Promise 同样自陈 | Task 2 用例 + Task 5 Step 1 |
| §1.3 真实空对象仍是空对象（反向判据） | Task 2「空对象仍是空对象」用例 |
| §1.4 验收须证明路径被执行到 | Task 3/4/5 的接线测试 + Task 6 Step 5 |
| §1.5 hint 须指向真正可行的做法 | Global Constraints「hint 禁令」+ Task 2 marker 契约 |
| §5 改动地图四个位置 | Task 3（CDP）、Task 4（sync）、Task 5（async）、Task 2（真源） |
| §5 遗留 content.ts 归属 | Task 6 Step 3.3 |
| §7 CDP 表达式拼接待验证 | Task 1 整个 |
| §4 复发守卫（三条） | Task 6 Step 1 静态守卫 + Step 5 变异验证 |

**2. 占位符扫描**：无 TBD / TODO / "类似 Task N" / "适当处理错误"。每个代码步骤都给了逐字代码。

**3. 类型一致性**：`SERIALIZER_FN_NAME`、`SERIALIZER_SOURCE`、`loadSerializer`、`buildSerializedExpression` 四个导出名在 Task 2 定义，Task 3/4/5/6 引用一致；marker 字段名 `__vortexUnserializable` / `hint` / `byteLength` / `source` / `flags` / `value` 全计划统一；`cdpEvaluate` 第 5 参数 `awaitTop: boolean` 在 Task 3 定义后不再变更。

**4. 实现代码已实跑验证（2026-08-21）**：Task 2 的 `SERIALIZER_SOURCE` 已从本文档原文抽出，
在 Node v22.22.0（与 vitest 默认 `node` environment 一致）下对 30 条用例实跑，全部通过——
含全部品牌、detached DataView、`Symbol.toStringTag` 伪造、循环引用、深度上限。
执行者可以直接照抄，不必怀疑这段代码本身。

同时实测确认了本计划依赖的环境事实：`WeakRef` / `FinalizationRegistry` / `SharedArrayBuffer`
的 `Object.prototype.toString` 品牌名如计划所写；`RegExp` / `Promise` / `WeakMap` / `ArrayBuffer`
的 `Object.keys().length` 均为 0（品牌认定规则成立）；伪造对象 `{foo:1,[Symbol.toStringTag]:"Promise"}`
的品牌为 `Promise` 但 `keys` 为 1（防护规则会正确放它走 `for...in`）；detached `DataView`
读 `byteLength` 抛 `TypeError` 且品牌仍为 `DataView`。

**5. 已知风险**：Task 1 若证明 CDP 表达式拼接不可行，Task 2-6 全部作废，须回 spec 重选路线——这是把最大不确定性放在第一个 Task 的原因。
