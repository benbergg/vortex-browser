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
