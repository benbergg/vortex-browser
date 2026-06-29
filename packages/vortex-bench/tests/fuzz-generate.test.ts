import { describe, it, expect } from "vitest";
import { generate, ALL_PRIMITIVE_KINDS } from "../src/runner/fuzz-generate.js";
import { collectPrimitives, renderHtml, deriveManifest } from "../src/runner/fuzz-ast.js";
import { FUZZ_RECALL_CONTAINERS, FUZZ_DECORATIVE_ROLES } from "../src/runner/fuzz-aria-roles.js";

describe("fuzz-generate", () => {
  it("same seed → structurally identical page (determinism)", () => {
    const a = generate(1234);
    const b = generate(1234);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("different seeds → different pages", () => {
    const a = JSON.stringify(generate(1));
    const b = JSON.stringify(generate(2));
    expect(a).not.toEqual(b);
  });

  it("plants 1..11 primitives (1..8 + 0..2 容器 + 0..1 装饰), all with unique ids", () => {
    for (let seed = 0; seed < 30; seed++) {
      const prims = collectPrimitives(generate(seed).root);
      // Task 7 之后总数 = 1..8 (原有) + 0..2 aria-container + 0..1 decorative-role
      expect(prims.length).toBeGreaterThanOrEqual(1);
      expect(prims.length).toBeLessThanOrEqual(11);
      const ids = prims.map((p) => p.id);
      expect(new Set(ids).size).toEqual(ids.length);
    }
  });

  it("generated html is non-empty and renders every primitive", () => {
    const page = generate(99);
    const html = renderHtml(page);
    for (const p of collectPrimitives(page.root)) {
      expect(html).toContain(`data-vtx-oracle="${p.id}"`);
    }
  });

  it("ALL_PRIMITIVE_KINDS covers the 11 starter primitives (9 + Task 7 容器/装饰)", () => {
    expect(ALL_PRIMITIVE_KINDS).toHaveLength(11);
  });

  it("srcdoc-button is never placed under a hidden ancestor (display:none would un-render the iframe)", () => {
    function srcdocUnderHidden(node: import("../src/fuzz-types.js").AstNode, hiddenAbove = false): boolean {
      if (node.type === "primitive") return node.kind === "srcdoc-button" && hiddenAbove;
      const next = hiddenAbove || node.hidden != null;
      return node.children.some((c) => srcdocUnderHidden(c, next));
    }
    for (let seed = 0; seed < 300; seed++) {
      expect(srcdocUnderHidden(generate(seed).root)).toBe(false);
    }
  });

  it("srcdoc-button names are globally unique on a page (no collision with any other primitive)", () => {
    for (let seed = 0; seed < 300; seed++) {
      const prims = collectPrimitives(generate(seed).root);
      const srcdocNames = prims.filter((p) => p.kind === "srcdoc-button").map((p) => p.name);
      const otherNames = new Set(prims.filter((p) => p.kind !== "srcdoc-button").map((p) => p.name));
      // srcdoc names unique among themselves
      expect(new Set(srcdocNames).size).toEqual(srcdocNames.length);
      // and disjoint from every other primitive's name
      for (const n of srcdocNames) expect(otherNames.has(n)).toBe(false);
    }
  });

  // --- Task 7: ARIA 容器/装饰角色种入 ---
  // 守卫:fuzz 覆盖「召回门应召容器」与「召回门不召装饰」两类结构性盲点,
  // 双向 oracle 在 fuzz-run.deriveManifest 里 interactive:true/false 联动。
  it("ALL_PRIMITIVE_KINDS 含 aria-container + decorative-role(Task 7)", () => {
    expect(ALL_PRIMITIVE_KINDS).toContain("aria-container");
    expect(ALL_PRIMITIVE_KINDS).toContain("decorative-role");
  });

  it("aria-container 渲染含显式 role ∈ FUZZ_RECALL_CONTAINERS", () => {
    for (let seed = 0; seed < 60; seed++) {
      const page = generate(seed);
      const html = renderHtml(page);
      const containers = collectPrimitives(page.root).filter((p) => p.kind === "aria-container");
      for (const c of containers) {
        expect(c.role, `seed=${seed} aria-container 必须带 role 字段`).toBeTruthy();
        expect(FUZZ_RECALL_CONTAINERS.has(c.role!), `seed=${seed} role=${c.role} 应在召回集`).toBe(true);
        // 渲染产物含 role="<role>";严禁 cursor:pointer / onclick(避免启发式误召入池)
        const re = new RegExp(`<div[^>]*role="${c.role}"[^>]*data-vtx-oracle="${c.id}"[^>]*>`);
        expect(html).toMatch(re);
      }
    }
  });

  it("decorative-role 渲染为 div role=presentation,不带 cursor:pointer/onclick/tabindex(plan line 659)", () => {
    for (let seed = 0; seed < 60; seed++) {
      const html = renderHtml(generate(seed));
      // 仅匹配 <div ... role="presentation" ...> 起始标签(开括号起,遇 > 止)
      const matches = html.match(/<div[^>]*role="presentation"[^>]*>/g) ?? [];
      for (const m of matches) {
        expect(m).not.toContain("cursor:pointer");
        expect(m).not.toContain("onclick");
        expect(m).not.toContain("tabindex");
      }
    }
  });

  it("aria-container 与 decorative-role 都进 collectPrimitives(种子大时两者皆有出现)", () => {
    let sawContainer = false;
    let sawDecorative = false;
    for (let seed = 0; seed < 200 && !(sawContainer && sawDecorative); seed++) {
      const prims = collectPrimitives(generate(seed).root);
      if (prims.some((p) => p.kind === "aria-container")) sawContainer = true;
      if (prims.some((p) => p.kind === "decorative-role")) sawDecorative = true;
    }
    expect(sawContainer).toBe(true);
    expect(sawDecorative).toBe(true);
  });

  it("deriveManifest:aria-container → interactive:true;decorative-role → interactive:false(双断言 oracle)", () => {
    const page: import("../src/fuzz-types.js").FuzzPage = {
      seed: 42,
      root: {
        type: "noise", tag: "div", className: "t7",
        children: [
          { type: "primitive", kind: "aria-container", id: "a1", name: "主区", role: "tablist" },
          { type: "primitive", kind: "decorative-role", id: "d1", name: "装饰块" },
        ],
      },
    };
    const m = deriveManifest(page, "fuzz-t7", "/synth/t7.html");
    expect(m.entries.find((e) => e.id === "a1")!.interactive).toBe(true);   // 容器:必召
    expect(m.entries.find((e) => e.id === "d1")!.interactive).toBe(false);  // 装饰:不召
  });

  it("装饰节点本身不带启发式交互属性:hidden 祖先也不参与(仅算 display:none/visibility-hidden)", () => {
    // 防止装饰节点被放进 hidden 包装后又出现 recall-miss(其实 oracle 不该期望)
    // 此用例断言:装饰节点直接放根,不进 hidden,deriveManifest 仍 interactive:false
    const page: import("../src/fuzz-types.js").FuzzPage = {
      seed: 7,
      root: {
        type: "noise", tag: "div", className: "r",
        children: [
          { type: "primitive", kind: "decorative-role", id: "x1", name: "z" },
        ],
      },
    };
    const html = renderHtml(page);
    expect(html).toContain('role="presentation"');
    const m = deriveManifest(page, "f", "/p");
    expect(m.entries[0]!.interactive).toBe(false);
  });
});
