// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { styleProbeFunc } from "../src/handlers/query.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("styleProbeFunc", () => {
  it("自身有色+背景 → 取 color/background + WCAG 对比度(黑底白≈21)", () => {
    const el = document.createElement("div");
    el.className = "t";
    el.style.color = "rgb(0, 0, 0)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    el.textContent = "x";
    document.body.appendChild(el);
    const r = styleProbeFunc(".t", 10, []) as any;
    expect(r.elements[0].color).toBe("rgb(0, 0, 0)");
    expect(r.elements[0].background).toBe("rgb(255, 255, 255)");
    expect(r.elements[0].contrastRatio).toBeCloseTo(21, 0);
    expect(r.elements[0].wcagAA).toBe(true);
  });

  it("自身背景透明 → 上溯祖先 painted bg(⑦ 徽章背景在祖先)", () => {
    const wrap = document.createElement("div");
    wrap.style.backgroundColor = "rgb(255, 255, 255)";
    const el = document.createElement("span");
    el.className = "t2";
    el.style.color = "rgb(0, 0, 0)";
    // 自身背景不设(透明)
    wrap.appendChild(el);
    document.body.appendChild(wrap);
    const r = styleProbeFunc(".t2", 10, []) as any;
    expect(r.elements[0].background).toBe("rgb(255, 255, 255)");
    expect(r.elements[0].bgFromAncestor).toBe(true);
  });

  it("低对比(浅灰字白底) → wcagAA=false", () => {
    const el = document.createElement("div");
    el.className = "t3";
    el.style.color = "rgb(200, 200, 200)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.appendChild(el);
    const r = styleProbeFunc(".t3", 10, []) as any;
    expect(r.elements[0].wcagAA).toBe(false);
  });

  it("含字重/字号字段", () => {
    const el = document.createElement("div");
    el.className = "t4";
    el.style.color = "rgb(0, 0, 0)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    el.style.fontWeight = "700";
    document.body.appendChild(el);
    const r = styleProbeFunc(".t4", 10, []) as any;
    expect(r.elements[0].fontWeight).toBe("700");
  });

  it("painted 背景在第 10 层祖先 → 仍能上溯到（不再写死 8 层）", () => {
    let cur: HTMLElement = document.body;
    for (let i = 0; i < 10; i++) {
      const d = document.createElement("div");
      cur.appendChild(d);
      cur = d;
    }
    (document.body.firstElementChild as HTMLElement).style.backgroundColor = "rgb(255, 255, 255)";
    const el = document.createElement("h1");
    el.className = "deep";
    el.style.color = "rgb(0, 0, 0)";
    cur.appendChild(el);

    const r = styleProbeFunc(".deep", 10, []) as any;
    expect(r.elements[0].background).toBe("rgb(255, 255, 255)");
    expect(r.elements[0].bgFromAncestor).toBe(true);
    expect(r.elements[0].contrastStatus).toBe("ok");
    expect(r.elements[0].contrastRatio).toBeCloseTo(21, 0);
  });

  it("完全找不到 painted 背景 → wcag 三项为 unknown,不谎报 false", () => {
    const el = document.createElement("div");
    el.className = "nobg";
    el.style.color = "rgb(0, 0, 0)";
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    document.body.appendChild(el);

    const r = styleProbeFunc(".nobg", 10, []) as any;
    expect(r.elements[0].contrastRatio).toBeNull();
    expect(r.elements[0].contrastStatus).toBe("no-painted-background");
    expect(r.elements[0].wcagAA).toBe("unknown");
    expect(r.elements[0].wcagAAA).toBe("unknown");
  });

  it("背景是渐变 → 对比度不可判定,不拿 backgroundColor 硬算", () => {
    const wrap = document.createElement("div");
    wrap.style.backgroundColor = "rgb(255, 255, 255)";
    wrap.style.backgroundImage = "linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))";
    const el = document.createElement("span");
    el.className = "grad";
    el.style.color = "rgb(0, 0, 0)";
    wrap.appendChild(el);
    document.body.appendChild(wrap);

    const r = styleProbeFunc(".grad", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("background-image");
    expect(r.elements[0].contrastRatio).toBeNull();
    expect(r.elements[0].wcagAA).toBe("unknown");
  });

  it("近祖先渐变 + 远祖先纯白 → 背景取渐变那层,不能穿过去拿远处的白", () => {
    const far = document.createElement("div");
    far.style.backgroundColor = "rgb(255, 255, 255)";
    const near = document.createElement("div");
    near.style.backgroundImage = "linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))";
    const el = document.createElement("span");
    el.className = "layered";
    el.style.color = "rgb(0, 0, 0)";
    near.appendChild(el);
    far.appendChild(near);
    document.body.appendChild(far);

    const r = styleProbeFunc(".layered", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("background-image");
    expect(r.elements[0].contrastRatio).toBeNull();
    expect(r.elements[0].background).not.toBe("rgb(255, 255, 255)");
  });

  it("元素自身带图 → 不上溯,状态与背景来源自洽", () => {
    const wrap = document.createElement("div");
    wrap.style.backgroundColor = "rgb(255, 255, 255)";
    const el = document.createElement("div");
    el.className = "selfimg";
    el.style.backgroundImage = "linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))";
    el.style.color = "rgb(0, 0, 0)";
    wrap.appendChild(el);
    document.body.appendChild(wrap);

    const r = styleProbeFunc(".selfimg", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("background-image");
    expect(r.elements[0].bgFromAncestor).toBe(false);
    expect(r.elements[0].wcagAA).toBe("unknown");
  });

  it("真低对比仍然判 false（不能因为改三态就一律 unknown）", () => {
    const el = document.createElement("div");
    el.className = "low2";
    el.style.color = "rgb(200, 200, 200)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.appendChild(el);
    const r = styleProbeFunc(".low2", 10, []) as any;
    expect(r.elements[0].wcagAA).toBe(false);
    expect(r.elements[0].contrastStatus).toBe("ok");
  });

  it("无命中 → total=0", () => {
    const r = styleProbeFunc(".none", 10, []) as any;
    expect(r.total).toBe(0);
    expect(r.elements).toEqual([]);
  });
});
