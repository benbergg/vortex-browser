# vortex_query mode=component + T1-2 网络残余收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `vortex_query` 加 `mode=component`，把 Vue2/3 + React 组件实例数据与表格行数据结构化吐出（解决 T1-3 闭包/行不可见），并收口 T1-2 两处网络残余。

**Architecture:** 复用 `vortex_query` 现有 page-side 注入模式——新增**自包含**导出函数 `componentInspectFunc`（内联 `queryAllDeep` + 内联 `safeSerialize` + 框架探测 + 组件链上溯 + el-table/antd 行探测），经 `chrome.scripting.executeScript({func, world:"MAIN"})` 注入。handler 增 `mode==="component"` 分支。网络残余两处一行级改 `network.ts`/`schemas-public.ts`。

**Tech Stack:** TypeScript、Vitest（jsdom）、chrome.scripting MV3、CDP（既有）。

## Global Constraints

- 注释语言中文（API/异常类名保留英文）；禁止 `Co-Authored-By`/`Created by` 署名。
- 提交用 Conventional Commits（`feat:`/`fix:`/`docs:`/`test:`），中文描述、动词开头、结尾无句号。
- **page-side 注入函数必须自包含**：经 `executeScript({func})` 注入丢失 TS 模块作用域，所有 helper（`queryAllDeep`/`safeSerialize`）必须内联在函数体内，不能引用模块级符号（见 `query.ts:13-16` 注释 + memory `vortex_page_side_func_inline_gotcha`）。
- page-side 导出函数在 jsdom 中**直接调用测试**（参考 `query-shadow-pierce.test.ts`），不依赖真浏览器。
- 穿 open shadow 用内联 `queryAllDeep`，`SHADOW_WALK_MAX_DEPTH = 8`，与 `cssQueryFunc` 一致。
- **不新增公开工具**：公开工具数保持 **20**；`componentDepth` 由 handler 读取但**不**写入公开 schema（省 I15 预算）。
- I15 不变量：tools/list 字节 ≤ cap（当前 7800B），单工具 description ≤ 180 char；"加能力调 cap 不压字符"。
- `maxResults` component 模式默认 10、硬上限 20（实例遍历较重）；`componentDepth` 默认 4。
- 序列化上限：深度 4 / 数组 100 项 / 全局 5000 节点。
- 行探测**硬保证** el-table(Vue2) + antd Table(React)，其余 best-effort（拿不到 `row` 缺省，不报错）。

---

### Task 1: `componentInspectFunc` 核心（框架探测 + 组件链 + 内联 safeSerialize）

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（在 `cssQueryFunc` 后、`registerQueryHandlers` 前新增导出 `componentInspectFunc`）
- Test: `packages/extension/tests/query-component.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  type CompEntry = {
    framework: "vue2" | "vue3" | "react" | "unknown";
    chain: Array<{ name: string; data: unknown; props: unknown }>;
    row?: { rowKey: string | number | null; row: unknown; index: number };
  };
  export const componentInspectFunc: (
    selector: string,
    componentDepth: number,
    maxResults: number,
  ) =>
    | { components: CompEntry[]; total: number; showing: number }
    | { error: string; components: never[]; total: number };
  ```
  本 Task 只产出 `framework` + `chain`（`row` 永远缺省，留 Task 2 填充）。

- [ ] **Step 1: 写失败测试**

新建 `packages/extension/tests/query-component.test.ts`：

```ts
// query-component.test.ts
// 测试 componentInspectFunc 页面函数(jsdom 直调,mock __vue__/__vueParentComponent/fiber)。
// 覆盖:框架探测三态 + 组件链上溯 + safeSerialize 边界(循环/深度/函数/DOM/getter抛错/数组截断)。
import { describe, it, expect, beforeEach } from "vitest";
import { componentInspectFunc } from "../src/handlers/query.js";

type Ok = { components: Array<{ framework: string; chain: Array<{ name: string; data: any; props: any }>; row?: any }>; total: number; showing: number };

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("componentInspectFunc — framework detection", () => {
  it("Vue2: el.__vue__ → framework=vue2 + chain name/data/props", () => {
    const el = document.createElement("div");
    el.className = "target";
    (el as any).__vue__ = {
      $options: { name: "MyComp" },
      _data: { count: 5 },
      $props: { id: "x1" },
      $parent: { $options: { name: "Parent" }, _data: { open: true }, $props: {}, $parent: null },
    };
    document.body.appendChild(el);

    const r = componentInspectFunc(".target", 4, 10) as Ok;
    expect(r.total).toBe(1);
    expect(r.components[0].framework).toBe("vue2");
    expect(r.components[0].chain[0].name).toBe("MyComp");
    expect(r.components[0].chain[0].data).toEqual({ count: 5 });
    expect(r.components[0].chain[0].props).toEqual({ id: "x1" });
    expect(r.components[0].chain[1].name).toBe("Parent");
  });

  it("Vue3: el.__vueParentComponent → framework=vue3", () => {
    const el = document.createElement("div");
    el.className = "v3";
    (el as any).__vueParentComponent = {
      type: { name: "V3Comp" },
      setupState: { msg: "hi" },
      props: { a: 1 },
      parent: null,
    };
    document.body.appendChild(el);

    const r = componentInspectFunc(".v3", 4, 10) as Ok;
    expect(r.components[0].framework).toBe("vue3");
    expect(r.components[0].chain[0].name).toBe("V3Comp");
    expect(r.components[0].chain[0].data).toEqual({ msg: "hi" });
    expect(r.components[0].chain[0].props).toEqual({ a: 1 });
  });

  it("React: __reactFiber$ key → framework=react, 跳过 host fiber 取组件名", () => {
    const el = document.createElement("div");
    el.className = "rt";
    const compFiber = { type: function Card() {}, memoizedProps: { title: "T" }, memoizedState: null, return: null };
    const hostFiber = { type: "div", memoizedProps: {}, memoizedState: null, return: compFiber };
    (el as any)["__reactFiber$abc"] = hostFiber;
    document.body.appendChild(el);

    const r = componentInspectFunc(".rt", 4, 10) as Ok;
    expect(r.components[0].framework).toBe("react");
    expect(r.components[0].chain[0].name).toBe("Card");
    expect(r.components[0].chain[0].props).toEqual({ title: "T" });
  });

  it("无框架实例 → framework=unknown + 空 chain(非 error)", () => {
    const el = document.createElement("div");
    el.className = "plain";
    document.body.appendChild(el);
    const r = componentInspectFunc(".plain", 4, 10) as Ok;
    expect(r.components[0].framework).toBe("unknown");
    expect(r.components[0].chain).toEqual([]);
  });

  it("0 命中 → 空数组", () => {
    const r = componentInspectFunc(".nope", 4, 10) as Ok;
    expect(r.total).toBe(0);
    expect(r.components).toEqual([]);
  });
});

describe("componentInspectFunc — safeSerialize 边界(经 vue2 _data 注入)", () => {
  function mountWithData(data: any) {
    const el = document.createElement("div");
    el.className = "s";
    (el as any).__vue__ = { $options: { name: "S" }, _data: data, $props: {}, $parent: null };
    document.body.appendChild(el);
  }

  it("循环引用 → [Circular]", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    mountWithData({ obj });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    expect(r.components[0].chain[0].data.obj.self).toBe("[Circular]");
  });

  it("超深度 → [MaxDepth]", () => {
    mountWithData({ l1: { l2: { l3: { l4: { l5: "deep" } } } } });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    // depth: data(0)->l1(1)->l2(2)->l3(3)->l4(4=MaxDepth)
    expect(r.components[0].chain[0].data.l1.l2.l3.l4).toBe("[MaxDepth]");
  });

  it("函数 → [Function]、DOM → [Element]", () => {
    const node = document.createElement("span");
    mountWithData({ fn: () => 1, node });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    expect(r.components[0].chain[0].data.fn).toBe("[Function]");
    expect(r.components[0].chain[0].data.node).toBe("[Element]");
  });

  it("getter 抛错 → [Unserializable]", () => {
    const data: any = {};
    Object.defineProperty(data, "boom", { enumerable: true, get() { throw new Error("x"); } });
    mountWithData(data);
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    expect(r.components[0].chain[0].data.boom).toBe("[Unserializable]");
  });

  it("数组超 100 项 → 截断 + [+N more]", () => {
    mountWithData({ arr: Array.from({ length: 150 }, (_, i) => i) });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    const arr = r.components[0].chain[0].data.arr as any[];
    expect(arr.length).toBe(101); // 100 项 + 1 个 "[+50 more]"
    expect(arr[100]).toBe("[+50 more]");
  });

  it("剥 Vue 响应式键 __ob__", () => {
    mountWithData({ real: 1, __ob__: { dep: {} } });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    expect(r.components[0].chain[0].data).toEqual({ real: 1 });
  });
});

describe("componentInspectFunc — 上溯起点与深度", () => {
  it("命中元素无 __vue__ 时向上找最近组件边界", () => {
    const host = document.createElement("div");
    (host as any).__vue__ = { $options: { name: "Boundary" }, _data: {}, $props: {}, $parent: null };
    const cell = document.createElement("span");
    cell.className = "cell";
    host.appendChild(cell);
    document.body.appendChild(host);
    const r = componentInspectFunc(".cell", 4, 10) as Ok;
    expect(r.components[0].framework).toBe("vue2");
    expect(r.components[0].chain[0].name).toBe("Boundary");
  });

  it("componentDepth 限制链长度", () => {
    const el = document.createElement("div");
    el.className = "depth";
    (el as any).__vue__ = {
      $options: { name: "L0" }, _data: {}, $props: {},
      $parent: { $options: { name: "L1" }, _data: {}, $props: {},
        $parent: { $options: { name: "L2" }, _data: {}, $props: {}, $parent: null } },
    };
    document.body.appendChild(el);
    const r = componentInspectFunc(".depth", 2, 10) as Ok;
    expect(r.components[0].chain.map(c => c.name)).toEqual(["L0", "L1"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/query-component.test.ts`
Expected: FAIL —— `componentInspectFunc is not exported` / `is not a function`。

- [ ] **Step 3: 实现 `componentInspectFunc`（最小实现，只到 chain）**

在 `packages/extension/src/handlers/query.ts` 中 `cssQueryFunc` 之后插入：

```ts
/**
 * page-side 组件探测函数体。mode=component 注入到 MAIN world。
 * 参数 args: [selector, componentDepth, maxResults]。
 * 返回 { components, total, showing } 或 { error, components: [], total: 0 }。
 *
 * ⚠ 自包含:注入丢模块作用域,queryAllDeep / safeSerialize 必须内联。
 * queryAllDeep 逻辑须与 cssQueryFunc / observe.ts 保持一致(改一处同步)。
 * 本 Task 只产出 framework + chain;row 探测见 Task 2(占位 detectRow 返 undefined)。
 */
export const componentInspectFunc = (
  selector: string,
  componentDepth: number,
  maxResults: number,
):
  | {
      components: Array<{
        framework: "vue2" | "vue3" | "react" | "unknown";
        chain: Array<{ name: string; data: unknown; props: unknown }>;
        row?: { rowKey: string | number | null; row: unknown; index: number };
      }>;
      total: number;
      showing: number;
    }
  | { error: string; components: never[]; total: number } => {
  try {
    const SHADOW_WALK_MAX_DEPTH = 8;
    const queryAllDeep = (sel: string, root: Document | ShadowRoot, depth: number): Element[] => {
      const acc: Element[] = Array.from(root.querySelectorAll(sel));
      if (depth >= SHADOW_WALK_MAX_DEPTH) return acc;
      for (const host of root.querySelectorAll("*")) {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) acc.push(...queryAllDeep(sel, sr, depth + 1));
      }
      return acc;
    };

    // 内联 safeSerialize:深度4 / 数组100 / 节点5000 / 剥响应式 / getter兜底。
    const MAX_DEPTH = 4;
    const ARRAY_CAP = 100;
    const NODE_CAP = 5000;
    const safeSerialize = (value: unknown, maxDepth: number): unknown => {
      const seen = new WeakSet<object>();
      let nodes = 0;
      const walk = (v: unknown, depth: number): unknown => {
        if (nodes > NODE_CAP) return "[MaxNodes]";
        nodes++;
        if (v === null || v === undefined) return null;
        const t = typeof v;
        if (t === "function") return "[Function]";
        if (t === "string" || t === "number" || t === "boolean") return v;
        if (t === "bigint") return String(v);
        if (t === "symbol") return "[Symbol]";
        if (typeof Node !== "undefined" && v instanceof Node) return "[Element]";
        if (depth >= maxDepth) return "[MaxDepth]";
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
        try {
          if (Array.isArray(v)) {
            const arr: unknown[] = [];
            const cap = Math.min(v.length, ARRAY_CAP);
            for (let i = 0; i < cap; i++) arr.push(walk(v[i], depth + 1));
            if (v.length > cap) arr.push("[+" + (v.length - cap) + " more]");
            return arr;
          }
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(v as object)) {
            if (key === "__ob__" || key.indexOf("__v_") === 0) continue;
            try {
              out[key] = walk((v as Record<string, unknown>)[key], depth + 1);
            } catch {
              out[key] = "[Unserializable]";
            }
          }
          return out;
        } finally {
          seen.delete(v as object);
        }
      };
      return walk(value, 0);
    };

    // 占位:行探测(Task 2 实现)。本 Task 恒返 undefined。
    const detectRow = (
      _startEl: Element,
      _framework: string,
      _startInstance: unknown,
    ): { rowKey: string | number | null; row: unknown; index: number } | undefined => undefined;

    const reactFiberKey = (el: Element): string | null => {
      for (const k of Object.keys(el)) {
        if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) return k;
      }
      return null;
    };

    // 从命中元素向上找最近的框架实例边界(最多 30 层)。
    const findBoundary = (
      el: Element,
    ): { framework: "vue2" | "vue3" | "react" | "unknown"; instance: unknown } => {
      let cur: Element | null = el;
      let hops = 0;
      while (cur && hops < 30) {
        const anyEl = cur as unknown as Record<string, unknown>;
        if (anyEl.__vue__) return { framework: "vue2", instance: anyEl.__vue__ };
        if (anyEl.__vueParentComponent) return { framework: "vue3", instance: anyEl.__vueParentComponent };
        const fk = reactFiberKey(cur);
        if (fk) return { framework: "react", instance: anyEl[fk] };
        cur = cur.parentElement;
        hops++;
      }
      return { framework: "unknown", instance: null };
    };

    const walkChain = (
      framework: string,
      instance: unknown,
      depth: number,
    ): Array<{ name: string; data: unknown; props: unknown }> => {
      const chain: Array<{ name: string; data: unknown; props: unknown }> = [];
      if (framework === "vue2") {
        let inst = instance as any;
        while (inst && chain.length < depth) {
          chain.push({
            name: (inst.$options && (inst.$options.name || inst.$options._componentTag)) || "(anonymous)",
            data: safeSerialize(inst._data, MAX_DEPTH),
            props: safeSerialize(inst.$props, MAX_DEPTH),
          });
          inst = inst.$parent;
        }
      } else if (framework === "vue3") {
        let vnode = instance as any;
        while (vnode && chain.length < depth) {
          chain.push({
            name: (vnode.type && (vnode.type.name || vnode.type.__name)) || "(anonymous)",
            data: safeSerialize(vnode.setupState, MAX_DEPTH),
            props: safeSerialize(vnode.props, MAX_DEPTH),
          });
          vnode = vnode.parent;
        }
      } else if (framework === "react") {
        let fiber = instance as any;
        while (fiber && chain.length < depth) {
          const ty = fiber.type;
          if (typeof ty === "function") {
            chain.push({
              name: ty.displayName || ty.name || "(anonymous)",
              data: safeSerialize(fiber.memoizedState, MAX_DEPTH),
              props: safeSerialize(fiber.memoizedProps, MAX_DEPTH),
            });
          }
          fiber = fiber.return;
        }
      }
      return chain;
    };

    let matched: Element[];
    try {
      matched = queryAllDeep(selector, document, 0);
    } catch (e) {
      return { error: "Invalid CSS selector: " + (e instanceof Error ? e.message : String(e)), components: [], total: 0 };
    }

    const total = matched.length;
    const limit = Math.min(total, maxResults);
    const components: Array<{
      framework: "vue2" | "vue3" | "react" | "unknown";
      chain: Array<{ name: string; data: unknown; props: unknown }>;
      row?: { rowKey: string | number | null; row: unknown; index: number };
    }> = [];

    for (let i = 0; i < limit; i++) {
      const el = matched[i];
      const { framework, instance } = findBoundary(el);
      const chain = walkChain(framework, instance, componentDepth);
      const entry: {
        framework: "vue2" | "vue3" | "react" | "unknown";
        chain: Array<{ name: string; data: unknown; props: unknown }>;
        row?: { rowKey: string | number | null; row: unknown; index: number };
      } = { framework, chain };
      const row = detectRow(el, framework, instance);
      if (row) entry.row = row;
      components.push(entry);
    }

    return { components, total, showing: limit };
  } catch (e) {
    return { error: "component inspect error: " + (e instanceof Error ? e.message : String(e)), components: [], total: 0 };
  }
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/query-component.test.ts`
Expected: PASS（全部用例绿；`row` 相关用例本 Task 无，不涉及）。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-component.test.ts
git commit -m "feat(query): componentInspectFunc 框架探测+组件链上溯+内联 safeSerialize

vue2(__vue__)/vue3(__vueParentComponent)/react(fiber) 三态探测,$parent/
parent/return 上溯取 name/data/props;内联 safeSerialize 深度4/数组100/
循环/函数/DOM/getter 兜底/剥响应式键。row 探测留 Task 2"
```

---

### Task 2: 行数据探测（el-table Vue2 + antd Table React）

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（替换 Task 1 的 `detectRow` 占位）
- Test: `packages/extension/tests/query-component.test.ts`（追加 row 用例）

**Interfaces:**
- Consumes: Task 1 的 `componentInspectFunc` / `safeSerialize` / `findBoundary`。
- Produces: `detectRow(startEl, framework, startInstance)` 返回 `{ rowKey, row, index } | undefined`；命中表格行时写入 `entry.row`。

- [ ] **Step 1: 追加失败测试**

在 `query-component.test.ts` 末尾追加：

```ts
describe("componentInspectFunc — 行探测", () => {
  it("Vue2 el-table: 命中单元格 → 从 store.states.data 取行 + rowKey", () => {
    // 构造 <table><tbody><tr>(0) <tr>(1, 内含 .cell)</tbody></table>
    const tableEl = document.createElement("div");
    (tableEl as any).__vue__ = {
      $options: { name: "ElTable" },
      _data: {}, $props: { rowKey: "id" },
      rowKey: "id",
      store: { states: { data: [{ id: 10, name: "a" }, { id: 20, name: "b" }] } },
      $parent: null,
    };
    const tbody = document.createElement("tbody");
    const tr0 = document.createElement("tr");
    const tr1 = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "cell";
    tr1.appendChild(cell);
    tbody.appendChild(tr0);
    tbody.appendChild(tr1);
    tableEl.appendChild(tbody);
    document.body.appendChild(tableEl);

    const r = componentInspectFunc(".cell", 4, 10) as Ok;
    expect(r.components[0].row).toBeDefined();
    expect(r.components[0].row.index).toBe(1);
    expect(r.components[0].row.row).toEqual({ id: 20, name: "b" });
    expect(r.components[0].row.rowKey).toBe(20);
  });

  it("React antd Table: fiber.memoizedProps.record → 行对象", () => {
    const el = document.createElement("td");
    el.className = "antd-cell";
    const rowFiber = { type: function BodyRow() {}, memoizedProps: { record: { id: 7, title: "x" }, rowKey: "id", index: 3 }, memoizedState: null, return: null };
    const cellFiber = { type: "td", memoizedProps: {}, memoizedState: null, return: rowFiber };
    (el as any)["__reactFiber$z"] = cellFiber;
    document.body.appendChild(el);

    const r = componentInspectFunc(".antd-cell", 4, 10) as Ok;
    expect(r.components[0].row).toBeDefined();
    expect(r.components[0].row.row).toEqual({ id: 7, title: "x" });
    expect(r.components[0].row.index).toBe(3);
  });

  it("非表格上下文 → row 缺省(不报错)", () => {
    const el = document.createElement("div");
    el.className = "norow";
    (el as any).__vue__ = { $options: { name: "Plain" }, _data: {}, $props: {}, $parent: null };
    document.body.appendChild(el);
    const r = componentInspectFunc(".norow", 4, 10) as Ok;
    expect(r.components[0].row).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/query-component.test.ts`
Expected: FAIL —— 三个 row 用例失败（`row` 为 undefined / 占位未实现）。

- [ ] **Step 3: 实现 `detectRow`（替换占位）**

把 Task 1 的占位 `detectRow` 替换为：

```ts
    // 行探测:el-table(Vue2 读 store.states.data + DOM tr 索引) / antd Table(React fiber memoizedProps.record)。
    // ⚠ store.states.data 路径与 rowKey 取法须实机 spike 确认(见计划「实机 spike」节);
    // el-table 固定列会复制 tr,DOM 索引法对带 fixed 列的表可能偏移 → spike 校准。
    const detectRow = (
      startEl: Element,
      framework: string,
      startInstance: unknown,
    ): { rowKey: string | number | null; row: unknown; index: number } | undefined => {
      try {
        if (framework === "vue2") {
          // 上溯实例链找 ElTable
          let inst = startInstance as any;
          let table: any = null;
          let guard = 0;
          while (inst && guard < 50) {
            const nm = inst.$options && (inst.$options.name || inst.$options._componentTag);
            if (nm === "ElTable") { table = inst; break; }
            inst = inst.$parent;
            guard++;
          }
          if (!table || !table.store || !table.store.states || !Array.isArray(table.store.states.data)) return undefined;
          const data = table.store.states.data as unknown[];
          const tr = (startEl as Element).closest ? (startEl as Element).closest("tr") : null;
          if (!tr || !tr.parentElement) return undefined;
          const rows = Array.prototype.filter.call(tr.parentElement.children, (c: Element) => c.tagName === "TR") as Element[];
          const index = rows.indexOf(tr);
          if (index < 0 || index >= data.length) return undefined;
          const rowObj = data[index];
          const rowKeyProp = (table.rowKey || (table.$props && table.$props.rowKey)) as string | undefined;
          let rowKey: string | number | null = null;
          if (typeof rowKeyProp === "string" && rowObj && typeof rowObj === "object") {
            const v = (rowObj as Record<string, unknown>)[rowKeyProp];
            if (typeof v === "string" || typeof v === "number") rowKey = v;
          }
          return { rowKey, row: safeSerialize(rowObj, MAX_DEPTH), index };
        }
        if (framework === "react") {
          let fiber = startInstance as any;
          let hops = 0;
          while (fiber && hops < 40) {
            const p = fiber.memoizedProps;
            if (p && typeof p === "object") {
              const rec = p.record !== undefined ? p.record : (p.row !== undefined ? p.row : p.rowData);
              if (rec !== undefined && rec !== null && typeof rec === "object") {
                let rowKey: string | number | null = null;
                if (typeof p.rowKey === "string" || typeof p.rowKey === "number") rowKey = p.rowKey;
                else if (typeof p["data-row-key"] === "string" || typeof p["data-row-key"] === "number") rowKey = p["data-row-key"];
                const index = typeof p.index === "number" ? p.index : -1;
                return { rowKey, row: safeSerialize(rec, MAX_DEPTH), index };
              }
            }
            fiber = fiber.return;
            hops++;
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/query-component.test.ts`
Expected: PASS（含 3 个 row 用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-component.test.ts
git commit -m "feat(query): 行数据探测 el-table(store.states.data)+antd(fiber record)

el-table 上溯 ElTable 实例读响应式行数组,DOM tr 索引定位行+rowKey;
antd Table React fiber 上溯 memoizedProps.record;非表格上下文 row 缺省"
```

---

### Task 3: handler 接入 `mode=component`

**Files:**
- Modify: `packages/extension/src/handlers/query.ts:225-309`（`registerQueryHandlers` 内 `QUERY_PAGE`）
- Test: `packages/extension/tests/query-handler.test.ts`（追加 component 分支用例）

**Interfaces:**
- Consumes: `componentInspectFunc`。
- Produces: `mode==="component"` 经 `executeScript` 调 `componentInspectFunc`，返回其结果。

- [ ] **Step 1: 追加失败测试**

在 `query-handler.test.ts` 新增 describe：

```ts
describe("query.queryPage — component mode", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerQueryHandlers(router);
  });

  it("component 命中 → 返回 components 数组,executeScript 收到 componentInspectFunc + [selector,depth,max]", async () => {
    executeScript.mockResolvedValueOnce([{ result: { components: [{ framework: "vue2", chain: [{ name: "C", data: {}, props: {} }] }], total: 1, showing: 1 } }]);
    const res = await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".cell" }));
    expect(res.error).toBeUndefined();
    const result = res.result as { components: unknown[]; total: number };
    expect(result.total).toBe(1);
    const call = executeScript.mock.calls[0][0];
    expect(call.world).toBe("MAIN");
    expect(call.args[0]).toBe(".cell");
    expect(call.args[1]).toBe(4);   // componentDepth 默认
    expect(call.args[2]).toBe(10);  // maxResults 默认
  });

  it("component maxResults 硬上限 20", async () => {
    executeScript.mockResolvedValueOnce([{ result: { components: [], total: 0, showing: 0 } }]);
    await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".x", maxResults: 999 }));
    expect(executeScript.mock.calls[0][0].args[2]).toBe(20);
  });

  it("component componentDepth 可覆盖", async () => {
    executeScript.mockResolvedValueOnce([{ result: { components: [], total: 0, showing: 0 } }]);
    await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".x", componentDepth: 2 }));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(2);
  });

  it("component page-side error → JS_EXECUTION_ERROR", async () => {
    executeScript.mockResolvedValueOnce([{ result: { error: "boom", components: [], total: 0 } }]);
    const res = await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".x" }));
    expect(res.error).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/query-handler.test.ts`
Expected: FAIL —— component mode 当前被 `mode must be 'text' or 'css'` 拒绝。

- [ ] **Step 3: 改 handler**

`query.ts` 内，把 mode 校验改为允许 component，并新增分支。

校验改（`query.ts:232`）：

```ts
      if (!mode || (mode !== "text" && mode !== "css" && mode !== "component")) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `vortex_query: mode must be 'text', 'css' or 'component', got ${String(mode)}`,
        );
      }
```

在 `mode === "text"` / `else(css)` 分支之间（即把末尾 `} else {` 的 css 分支改为 `else if (mode === "css")`，再加 component 分支）。具体：将现有 `} else {`（`query.ts:275`）改为 `} else if (mode === "css") {`，并在其闭合 `}` 后追加：

```ts
      } else {
        // component 模式:注入 componentInspectFunc 取 Vue/React 组件链 + 行数据。
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 10, 20);
        const componentDepth = Math.min(Math.max((args.componentDepth as number | undefined) ?? 4, 1), 12);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: componentInspectFunc,
          args: [pattern, componentDepth, maxResults],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { components: unknown[]; total: number; showing: number }
          | { error: string; components: never[]; total: number }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage component: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage component error: ${res.error}`);
        }
        return res;
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/query-handler.test.ts tests/query-component.test.ts`
Expected: PASS（全部，含既有 text/css 不回归）。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-handler.test.ts
git commit -m "feat(query): handler 接入 mode=component(注入 componentInspectFunc)

mode 校验放行 component;maxResults 默认10上限20,componentDepth 默认4
钳[1,12];page-side error→JS_EXECUTION_ERROR。text/css 路径不回归"
```

---

### Task 4: 公开 schema 暴露 component + I15 预算

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:405-422`（`vortex_query` def）
- Modify: `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`（cap）

**Interfaces:**
- Consumes: 无（描述与枚举变更）。
- Produces: `vortex_query` schema `mode` enum 含 `component`，description 提及 component 用途。

- [ ] **Step 1: 改 schema**

`schemas-public.ts` 的 `vortex_query`：

```ts
    name: "vortex_query",
    action: "query.queryPage",
    description: "Zero-LLM page probe: mode=text greps visible text; mode=css finds elements (attr for attributes); mode=component reads Vue/React instance data + table row objects.",
    schema: {
      type: "object",
      properties: {
        mode: { enum: ["text", "css", "component"] },
        pattern: { type: "string" },
        isRegex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        contextChars: { type: "number" },
        attr: { type: "string" },
        includeText: { type: "boolean" },
        maxResults: { type: "number" },
        ...tabFields,
      },
      required: ["mode", "pattern"],
    },
  },
```

（`componentDepth` 不入 schema：handler 已读取，省 I15 预算；description 须 ≤180 char——上面 168 char。）

- [ ] **Step 2: 跑 I15 看失败 + 测实际字节**

Run: `cd packages/mcp && pnpm vitest run tests/invariants/I15.tools-list-budget.test.ts`
Expected: FAIL —— payload 超 7800 cap（component enum + description 增量）。失败信息含实测 payload 长度。

- [ ] **Step 3: 调 I15 cap（按实测 + ~80B buffer）**

读 Step 2 失败信息里的实测字节数 `N`，把 cap 设为 `ceil((N+80)/100)*100`（沿用历史百位对齐）。修改 `I15.tools-list-budget.test.ts`：

注释追加一段（紧接现有「可验证确定性重放」段后）：

```ts
//
// vortex_query mode=component: 7800 → <NEW_CAP> B。vortex_query mode 枚举新增
// component(读 Vue/React 实例数据 + 表行对象),description 同步说明。componentDepth
// 不入 schema(handler 读取,省预算)。payload 实测 <N>B,cap +<delta> 留 ~80B 余量。
// 沿用"加能力调 cap 不压字符"惯例。
```

断言改：

```ts
    expect(toolsListPayload.length).toBeLessThanOrEqual(<NEW_CAP>);
```

并把该 it 标题里的字节数同步为 `<NEW_CAP>`（标题字符串，不影响逻辑）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/mcp && pnpm vitest run tests/invariants/I15.tools-list-budget.test.ts`
Expected: PASS（字节 ≤ 新 cap；count 仍 20；description ≤180；names 列表不变）。

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/tools/schemas-public.ts packages/mcp/tests/invariants/I15.tools-list-budget.test.ts
git commit -m "feat(query): 公开 schema 暴露 mode=component + I15 cap 同步

mode 枚举加 component,description 说明读 Vue/React 实例数据+表行对象;
componentDepth 不入 schema 省预算;cap 按实测 +~80B buffer 微调"
```

---

### Task 5: 块 B1 — `GET_REQUEST_DETAIL` 返回补 `requestBody`

**Files:**
- Modify: `packages/extension/src/handlers/network.ts:469-539`（`GET_REQUEST_DETAIL` 返回对象）
- Test: `packages/extension/tests/network-request-detail.test.ts`（追加 requestBody 用例）

**Interfaces:**
- Consumes: 既有 `NetworkEntry.requestBody`（`network.ts:175` 已采集 `params.request.postData`）。
- Produces: `source=request` 返回对象新增 `requestBody: string | null`。

- [ ] **Step 1: 追加失败测试**

参考该测试既有 mock 工具（`makeDebuggerMock` / `mkReq`），追加用例。先 `network.subscribe`，再触发 `requestWillBeSent`(带 postData)→`responseReceived`→`loadingFinished`，最后 `getRequestDetail`：

```ts
it("source=request 返回 requestBody(POST body)", async () => {
  vi.resetModules();
  ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
  const router = new ActionRouter();
  let onEventCb: (tabId: number, method: string, params: any) => void = () => {};
  const debuggerMgr = {
    onEvent: (cb: any) => { onEventCb = cb; },
    enableDomain: vi.fn().mockResolvedValue(undefined),
    isAttached: () => true,
    sendCommand: vi.fn().mockResolvedValue({ body: '{"ok":true}', base64Encoded: false }),
  } as any;
  const nm = { send: vi.fn() } as any;
  const dispatcher = { emit: vi.fn() } as any;
  registerNetworkHandlers(router, debuggerMgr, nm, dispatcher);

  await router.dispatch(mkReq("network.subscribe", {}, 42));
  onEventCb(42, "Network.requestWillBeSent", { requestId: "req-1", request: { url: "https://api/x", method: "POST", headers: {}, postData: '{"q":1}' }, type: "XHR" });
  onEventCb(42, "Network.responseReceived", { requestId: "req-1", response: { status: 200, statusText: "OK", mimeType: "application/json", headers: {} } });

  const res = await router.dispatch(mkReq("network.getRequestDetail", { requestId: "req-1" }, 42));
  const detail = res.result as { requestBody: string | null };
  expect(detail.requestBody).toBe('{"q":1}');
});

it("source=request 无 postData 时 requestBody=null", async () => {
  vi.resetModules();
  ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
  const router = new ActionRouter();
  let onEventCb: (tabId: number, method: string, params: any) => void = () => {};
  const debuggerMgr = {
    onEvent: (cb: any) => { onEventCb = cb; },
    enableDomain: vi.fn().mockResolvedValue(undefined),
    isAttached: () => true,
    sendCommand: vi.fn().mockResolvedValue({ body: "", base64Encoded: false }),
  } as any;
  registerNetworkHandlers(router, debuggerMgr, { send: vi.fn() } as any, { emit: vi.fn() } as any);

  await router.dispatch(mkReq("network.subscribe", {}, 42));
  onEventCb(42, "Network.requestWillBeSent", { requestId: "req-2", request: { url: "https://api/y", method: "GET", headers: {} }, type: "XHR" });
  onEventCb(42, "Network.responseReceived", { requestId: "req-2", response: { status: 200, statusText: "OK", mimeType: "application/json", headers: {} } });

  const res = await router.dispatch(mkReq("network.getRequestDetail", { requestId: "req-2" }, 42));
  expect((res.result as { requestBody: string | null }).requestBody).toBeNull();
});
```

（若文件内已有等价 `debuggerMgr` 构造 helper，复用之，勿重复造；以上为自包含写法保证可独立运行。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/network-request-detail.test.ts`
Expected: FAIL —— 返回对象无 `requestBody` 字段（`undefined` ≠ `'{"q":1}'`）。

- [ ] **Step 3: 改返回对象**

`network.ts` `GET_REQUEST_DETAIL` 的 `return { ... }`（`:528`）追加一行：

```ts
      return {
        requestId,
        url: entry.url,
        method: entry.method,
        status: entry.status ?? null,
        statusText: entry.statusText ?? null,
        headers: entry.responseHeaders ?? {},
        requestBody: entry.requestBody ?? null,
        body,
        encoding,
        truncated,
      };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/network-request-detail.test.ts`
Expected: PASS（含新 2 用例 + 既有不回归）。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/network.ts packages/extension/tests/network-request-detail.test.ts
git commit -m "fix(network): getRequestDetail 返回补 requestBody(POST body)

requestWillBeSent 已采集 postData(network.ts:175)但 detail 返回漏吐,
agent 读 POST 接口时拿不到请求体。补 requestBody:entry.requestBody??null"
```

---

### Task 6: 块 B2 — `vortex_debug_read` 描述强化 + I15

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:215-237`（`vortex_debug_read` description）
- Modify: `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`（cap，若需）

**Interfaces:**
- Consumes: 无。
- Produces: `vortex_debug_read` description 点明 network/request 捕获 POST 请求/响应体、无需手装 fetch hook。

- [ ] **Step 1: 改 description**

`schemas-public.ts` 的 `vortex_debug_read`：

```ts
    name: "vortex_debug_read",
    action: "L4.debug_read",
    description: "Read console/network. source=network lists XHR/Fetch (auto-captures POST req+resp bodies, no fetch hook needed); source=request reqid→status+headers+reqBody+respBody.",
```

（须 ≤180 char——上面 176 char。验证：`description 长度 ≤ 180 char` 用例须仍 PASS。）

- [ ] **Step 2: 跑 I15 看结果 + 测字节**

Run: `cd packages/mcp && pnpm vitest run tests/invariants/I15.tools-list-budget.test.ts`
Expected: 可能 FAIL（字节超 Task 4 设的 cap）或 description-length 用例边界。读失败信息拿实测字节。

- [ ] **Step 3: 调 I15 cap（若 Step 2 字节超限）**

若字节超限，按实测 `N` 把 cap 提到 `ceil((N+80)/100)*100`，并追加注释段：

```ts
//
// T1-2 残余收口 debug_read 描述强化: <OLD_CAP> → <NEW_CAP> B。description 点明
// source=network/request 自动捕获 POST 请求/响应体(无需手装 fetch hook),消除
// 评测员误搓 fetch hook 的根因。payload 实测 <N>B,cap +<delta> 留 ~80B 余量。
```

并同步断言上限与 it 标题字节数。
（若 Step 2 未超限，跳过本 Step——description 增量被既有 buffer 吸收。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/mcp && pnpm vitest run tests/invariants/I15.tools-list-budget.test.ts`
Expected: PASS（字节 ≤ cap；description ≤180；count 20；names 不变）。

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/tools/schemas-public.ts packages/mcp/tests/invariants/I15.tools-list-budget.test.ts
git commit -m "fix(debug_read): 描述点明 network 已捕获 POST 请求/响应体

消除评测员误搓 fetch hook 根因(能力早已存在,LLM 不知)。source=network
列 XHR/Fetch 自动捕获 req+resp body,source=request reqid→status+body+reqBody"
```

---

## 实机 spike（实现期强制，控制器执行；按历史教训:承重墙改动必活浏览器验证）

单测用 mock 实例锁逻辑，但 `store.states.data` 路径、rowKey 取法、el-table 固定列 DOM 索引、antd `memoizedProps.record` 层级**必须真站确认**，否则 row 探测在真实虚拟表格上可能偏移/空：

1. **ipaas-pre el-table(Vue2)**：`vortex_navigate` 到 `ipaas-pre.bytenew.com/#/apiGatewayManage/apiDefine` → `vortex_query({mode:"component", pattern:".el-table__row td"})` → 核对 `row.row` 是否 = 该行真实数据、`row.index`/`rowKey` 是否对；带 fixed 列时验证索引不偏。偏移则用 `tr[data-*]` 或 `table.store.states.data` 配合行内可见文本校准（在 Task 2 detectRow 内补真站确认的路径）。
2. **antd React 表格站**（任一 antd Table demo，如 ant.design 官网组件示例）：`vortex_query({mode:"component", pattern:".ant-table-row td"})` → 核对 `row.row` = 行 record。
3. 偏差超出 best-effort 容忍（硬保证目标拿不到 row）→ 回 Task 2 修 detectRow 并补对应单测，再回归。

---

## 收尾验证（全部 Task 完成后）

- `cd packages/extension && pnpm vitest run` 全绿；`cd packages/mcp && pnpm vitest run` 全绿。
- `pnpm -r build`（shared/extension/mcp）成功。
- I15：count=20、字节 ≤ cap、description ≤180、names 列表不变。
- bench：本改动不碰 observe-scan（A 层召回不应变）；reload 扩展后跑一次 `eval` 确认无回归（控制器执行，参考上一分支收尾）。

---

## Self-Review

**1. Spec coverage:**
- 块 A mode=component：Task 1（框架探测+链+safeSerialize）+ Task 2（行数据）+ Task 3（handler）+ Task 4（schema/I15）✓
- safeSerialize 全部上限（深度4/数组100/节点5000/循环/函数/DOM/getter/剥响应式）：Task 1 Step 1 用例逐条覆盖 ✓
- 框架 Vue2/3+React：Task 1 三态用例 ✓
- 行探测硬保证 el-table+antd：Task 2 ✓；best-effort 降级：Task 2「非表格 row 缺省」用例 ✓
- 块 B1 requestBody：Task 5 ✓；块 B2 debug_read 描述：Task 6 ✓
- I15：Task 4/6 ✓；实机 spike：专节 ✓；bench：收尾节 ✓
- 不新增工具(count=20)、componentDepth 不入 schema：Task 4 已落实 ✓

**2. Placeholder scan:** 无 TBD/TODO；`<NEW_CAP>`/`<N>` 是 Step 明确要求「读实测值代入」的实测占位（非内容缺失），已给出计算式 `ceil((N+80)/100)*100`。spike 节的路径校准是实现期真站动作，非代码占位。

**3. Type consistency:** `componentInspectFunc(selector, componentDepth, maxResults)` 签名在 Task 1/3 一致；返回 `{components,total,showing}` 在 Task 1/3 一致；`detectRow(startEl, framework, startInstance)` 在 Task 1 占位与 Task 2 实现签名一致；`CompEntry.row = {rowKey,row,index}` 在 Task 1/2/spike 一致；`requestBody` 字段名在 Task 5 测试与实现一致。
