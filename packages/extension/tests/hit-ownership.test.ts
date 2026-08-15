/**
 * Author: qingwa
 * Description: 命中归属判定的单一真源。2026-08-15 spike 实测:realMouse 路径下
 *   pointer-events:none / 祖先 ::after 覆盖 / 祖先 overflow:hidden 裁剪
 *   三种「命中祖先」场景全部 success:true 而页面零 click。
 */
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { classifyHit, describeElement, isWidgetContainer, isClickTargetAncestor } from "../src/page-side/hit-ownership.js";

const mk = (html: string) => new JSDOM(`<body>${html}</body>`).window.document;

describe("classifyHit", () => {
  it("hit 就是目标 → ok", () => {
    const d = mk(`<button id="b">x</button>`);
    const el = d.getElementById("b")!;
    expect(classifyHit(el, el)).toEqual({ ok: true });
  });

  it("hit 是目标的后代（点在自己的子节点上）→ ok", () => {
    const d = mk(`<button id="b"><span id="s">x</span></button>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("s")!)).toEqual({ ok: true });
  });

  it("hit 是非交互祖先（裁剪 / pointer-events:none）→ ancestor，点名该祖先", () => {
    const d = mk(`<div id="wrap" class="row deep"><button id="b">x</button></div>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("wrap")!)).toEqual({
      ok: false,
      blocker: "div#wrap.row.deep",
      kind: "ancestor",
    });
  });

  it("hit 是交互祖先 → 维持放行（button 包 pointer-events:none 的 span）", () => {
    const d = mk(`<button id="b"><span id="s">x</span></button>`);
    expect(classifyHit(d.getElementById("s")!, d.getElementById("b")!)).toEqual({ ok: true });
  });

  it("hit 是 label 祖先且关联目标 → 放行（点 label 会激活控件）", () => {
    const d = mk(`<label id="l"><input id="i" type="radio">选项</label>`);
    expect(classifyHit(d.getElementById("i")!, d.getElementById("l")!)).toEqual({ ok: true });
  });

  it("swiper 轨道 role=group 祖先 → 仍判 ancestor（不因有 role 就放行）", () => {
    const d = mk(`<div id="track" role="group" class="swiper-wrapper"><button id="b">题3</button></div>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("track")!)).toEqual({
      ok: false, blocker: "div#track.swiper-wrapper", kind: "ancestor",
    });
  });

  it("role=presentation 祖先 → 仍判 ancestor", () => {
    const d = mk(`<div id="p" role="presentation"><button id="b">x</button></div>`);
    expect((classifyHit(d.getElementById("b")!, d.getElementById("p")!) as any).kind).toBe("ancestor");
  });

  it("tabindex=-1 祖先 → 仍判 ancestor（programmatic focus 不等于可点）", () => {
    const d = mk(`<div id="t" tabindex="-1"><button id="b">x</button></div>`);
    expect((classifyHit(d.getElementById("b")!, d.getElementById("t")!) as any).kind).toBe("ancestor");
  });

  it("role=link 祖先 → 放行（白名单内的交互 role）", () => {
    const d = mk(`<div id="lk" role="link"><span id="s">x</span></div>`);
    expect(classifyHit(d.getElementById("s")!, d.getElementById("lk")!)).toEqual({ ok: true });
  });

  it("shadow 内目标 + light DOM 祖先命中 → ancestor（contains 不穿 shadow，须用 composed 上溯）", () => {
    const d = mk(`<div id="host" class="wrap"></div>`);
    const host = d.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button id="inner">x</button>`;
    const inner = sr.getElementById("inner")!;
    expect(classifyHit(inner, host)).toEqual({ ok: false, blocker: "div#host.wrap", kind: "ancestor" });
  });

  it("hit 是无关兄弟覆盖层 → overlay", () => {
    const d = mk(`<button id="b">x</button><div id="ov">mask</div>`);
    expect(classifyHit(d.getElementById("b")!, d.getElementById("ov")!)).toEqual({
      ok: false,
      blocker: "div#ov",
      kind: "overlay",
    });
  });

  it("hit=null → 保留 elementFromPoint=null 签名（auto-wait 对该串单独分流）", () => {
    const d = mk(`<button id="b">x</button>`);
    expect(classifyHit(d.getElementById("b")!, null)).toEqual({
      ok: false,
      blocker: "elementFromPoint=null",
      kind: "overlay",
    });
  });

  it("同 widget 装饰层：hit 非交互且与目标同处一个交互容器 → ok（el-select carve-out）", () => {
    const d = mk(`<div id="w" role="combobox"><input id="i"><span id="disp">占位</span></div>`);
    expect(classifyHit(d.getElementById("i")!, d.getElementById("disp")!)).toEqual({ ok: true });
  });

  it("backdrop carve-out：目标在 el-select-dropdown 内、hit 是 backdrop → ok", () => {
    const d = mk(`<div class="el-select-dropdown"><li id="opt">选项</li></div><div id="mask" class="modal-backdrop"></div>`);
    expect(classifyHit(d.getElementById("opt")!, d.getElementById("mask")!)).toEqual({ ok: true });
  });

  it("describeElement 取前两个 class", () => {
    const d = mk(`<div id="x" class="a b c">y</div>`);
    expect(describeElement(d.getElementById("x")!)).toBe("div#x.a.b");
  });

  it("isWidgetContainer 保持宽松（装饰层 carve-out 依赖它）", () => {
    const d = mk(`<div id="g" role="group"></div><div id="t" tabindex="-1"></div><div id="p"></div>`);
    expect(isWidgetContainer(d.getElementById("g")!)).toBe(true);
    expect(isWidgetContainer(d.getElementById("t")!)).toBe(true);
    expect(isWidgetContainer(d.getElementById("p")!)).toBe(false);
  });

  it("isClickTargetAncestor 严格白名单：group/presentation/tabindex=-1 都不算", () => {
    const d = mk(`<div id="g" role="group"><i id="x"></i></div><div id="btn" role="button"></div><a id="na"></a><a id="ha" href="#"></a>`);
    const x = d.getElementById("x")!;
    expect(isClickTargetAncestor(x, d.getElementById("g")!)).toBe(false);
    expect(isClickTargetAncestor(x, d.getElementById("btn")!)).toBe(true);
    expect(isClickTargetAncestor(x, d.getElementById("na")!)).toBe(false); // 无 href 的 <a> 不可点
    expect(isClickTargetAncestor(x, d.getElementById("ha")!)).toBe(true);
  });

  it("label 祖先但关联的是别的控件 → 不放行", () => {
    const d = mk(`<label id="l" for="other"><input id="i" type="radio"></label><input id="other">`);
    expect(isClickTargetAncestor(d.getElementById("i")!, d.getElementById("l")!)).toBe(false);
  });

  it("label 祖先无任何关联控件 → 不放行（点 label 不会激活任意后代 div）", () => {
    const d = mk(`<label id="l"><div id="t">纯文本</div></label>`);
    expect(isClickTargetAncestor(d.getElementById("t")!, d.getElementById("l")!)).toBe(false);
    expect((classifyHit(d.getElementById("t")!, d.getElementById("l")!) as any).kind).toBe("ancestor");
  });

  it("summary / area[href] 祖先 → 放行；role=gridcell 容器 → 不放行", () => {
    const d = mk(`<details><summary id="s"><i id="x"></i></summary></details><div id="gc" role="gridcell"><i id="y"></i></div>`);
    expect(isClickTargetAncestor(d.getElementById("x")!, d.getElementById("s")!)).toBe(true);
    expect(isClickTargetAncestor(d.getElementById("y")!, d.getElementById("gc")!)).toBe(false);
  });

  it("装饰层 carve-out 穿 shadow：shadow 内 widget 容器 contains 命中层 → ok", () => {
    const d = mk(`<div id="host"></div>`);
    const sr = d.getElementById("host")!.attachShadow({ mode: "open" });
    sr.innerHTML = `<div id="w" role="combobox"><input id="i"><span id="disp">占位</span></div>`;
    expect(classifyHit(sr.getElementById("i")!, sr.getElementById("disp")!)).toEqual({ ok: true });
  });
});
