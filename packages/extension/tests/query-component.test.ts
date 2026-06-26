// @vitest-environment jsdom
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

  it("超深度 → [MaxDepth] (MAX_DEPTH=3)", () => {
    mountWithData({ l1: { l2: { l3: { l4: { l5: "deep" } } } } });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    // depth: data(0)->l1(1)->l2(2)->l3(3=MaxDepth)
    expect(r.components[0].chain[0].data.l1.l2.l3).toBe("[MaxDepth]");
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

  it("数组超 40 项 → 截断 + [+N more] (ARRAY_CAP=40)", () => {
    mountWithData({ arr: Array.from({ length: 150 }, (_, i) => i) });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    const arr = r.components[0].chain[0].data.arr as any[];
    expect(arr.length).toBe(41); // 40 项 + 1 个 "[+110 more]"
    expect(arr[40]).toBe("[+110 more]");
  });

  it("剥 Vue 响应式键 __ob__", () => {
    mountWithData({ real: 1, __ob__: { dep: {} } });
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    expect(r.components[0].chain[0].data).toEqual({ real: 1 });
  });

  it("巨型宽对象 → 预算截断,输出有界(防输出爆炸)", () => {
    const wide: any = {};
    for (let i = 0; i < 5000; i++) wide["k" + i] = i;
    mountWithData(wide);
    const r = componentInspectFunc(".s", 4, 10) as Ok;
    const data = r.components[0].chain[0].data as Record<string, unknown>;
    // chain serializer per-call 400 → 远小于 5000 键,必命中预算 break + __vtxTruncated__ 标记
    expect(Object.keys(data).length).toBeLessThan(500);
    expect(data.__vtxTruncated__).toBe("[Budget]");
  });

  it("I-2: 多元素时靠后元素的 row 不被前面 chain 耗尽全局预算饿死", () => {
    // 10 个 el-table 单元格,各自 chain 序列化同一 ElTable 的大 _data(吃满全局预算 3000);
    // 两遍序列化保证所有 row(首要交付物)先于 chain 序列化 → 全部完整。
    const tableEl = document.createElement("div");
    const big: any = {};
    for (let i = 0; i < 500; i++) big["k" + i] = i; // 撑大 _data,让 chain 吃预算
    const data = Array.from({ length: 10 }, (_, i) => ({ id: i, name: "r" + i }));
    (tableEl as any).__vue__ = {
      $options: { name: "ElTable" }, _data: big, $props: { rowKey: "id" }, rowKey: "id",
      store: { states: { data } }, $parent: null,
    };
    const tbody = document.createElement("tbody");
    for (let i = 0; i < 10; i++) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.className = "budcell";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);
    document.body.appendChild(tableEl);

    const r = componentInspectFunc(".budcell", 4, 10) as Ok;
    expect(r.components).toHaveLength(10);
    // 全部 10 行完整(非 "[Budget]"),含最后一个
    for (let i = 0; i < 10; i++) {
      expect(r.components[i].row).toBeDefined();
      expect((r.components[i].row.row as any).id).toBe(i);
    }
    // 场景有效性自证:全局预算确被 chain 耗尽 → 靠后元素 chain 退化为 [Budget]
    expect(r.components[9].chain[0].data).toBe("[Budget]");
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

  it("Vue2 vxe-table: 命中单元格 → VxeTable.getRowById(tr[rowid]) 取行", () => {
    // 实机确认 ipaas 用 vxe-table:tr[rowid] + getRowById,不依赖 DOM 索引
    const tableEl = document.createElement("div");
    const rowData: Record<string, any> = { id: 99, code: "tagSceneList", name: "标签场景列表" };
    (tableEl as any).__vue__ = {
      $options: { name: "VxeTable" },
      _data: {}, $props: {},
      getRowById: (rid: string) => (rid === "row_5" ? rowData : null),
      getRowIndex: (r: any) => (r === rowData ? 2 : -1),
      $parent: null,
    };
    const tr = document.createElement("tr");
    tr.className = "vxe-body--row";
    tr.setAttribute("rowid", "row_5");
    const cell = document.createElement("td");
    cell.className = "vxe-cell";
    tr.appendChild(cell);
    tableEl.appendChild(tr);
    document.body.appendChild(tableEl);

    const r = componentInspectFunc(".vxe-cell", 4, 10) as Ok;
    expect(r.components[0].row).toBeDefined();
    expect(r.components[0].row.rowKey).toBe("row_5");
    expect(r.components[0].row.row).toEqual({ id: 99, code: "tagSceneList", name: "标签场景列表" });
    expect(r.components[0].row.index).toBe(2);
  });

  it("React antd Table: cell fiber 有 record(无 rowKey)→ rowKey 回退 record.key", () => {
    // 实机 antd(2026-06-26):record 在 cell fiber,rowKey 不在此 fiber,但 record 自带 key
    const el = document.createElement("td");
    el.className = "antd-cell";
    const cellFiber = { type: function Cell() {}, memoizedProps: { record: { key: "1", name: "John", age: 32 }, index: 0 }, memoizedState: null, return: null };
    (el as any)["__reactFiber$z"] = cellFiber;
    document.body.appendChild(el);

    const r = componentInspectFunc(".antd-cell", 4, 10) as Ok;
    expect(r.components[0].framework).toBe("react");
    expect(r.components[0].row).toBeDefined();
    expect(r.components[0].row.row).toEqual({ key: "1", name: "John", age: 32 });
    expect(r.components[0].row.index).toBe(0);
    expect(r.components[0].row.rowKey).toBe("1"); // 回退 record.key
  });

  it("React: fiber props 显式 rowKey 优先于 record.key", () => {
    const el = document.createElement("td");
    el.className = "antd-cell2";
    const cellFiber = { type: function Cell() {}, memoizedProps: { record: { key: "rk", id: 7 }, rowKey: "explicit", index: 2 }, memoizedState: null, return: null };
    (el as any)["__reactFiber$z"] = cellFiber;
    document.body.appendChild(el);

    const r = componentInspectFunc(".antd-cell2", 4, 10) as Ok;
    expect(r.components[0].row.rowKey).toBe("explicit");
    expect(r.components[0].row.index).toBe(2);
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
