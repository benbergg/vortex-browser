// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { elementsProbeFunc } from "../src/handlers/query.js";
import { shapeGeometryResult } from "../src/lib/element-shaping.js";

// 本地薄封装,不是导出的探针 —— 老 geometryProbeFunc 已删除,这里走统一探针+整形层
function geometryQuery(selector: string, maxResults: number): unknown {
  return shapeGeometryResult(elementsProbeFunc(selector, maxResults, ["geometry"], null, false) as never);
}

/** stub getBoundingClientRect。 */
function rect(el: Element, x: number, y: number, w: number, h: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, toJSON() {} }),
    configurable: true,
  });
  return el as HTMLElement;
}
/** stub scrollWidth/clientWidth(文字 ellipsis 检测)。 */
function scrollDims(el: Element, scrollW: number, clientW: number) {
  Object.defineProperty(el, "scrollWidth", { value: scrollW, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientW, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});
afterEach(() => {
  // 还原 elementFromPoint
  (document as any).elementFromPoint = undefined;
});

describe("geometry 维度采集", () => {
  it("元素完整在视口内 → inViewport=true,未遮挡", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "card";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => el; // 中心点命中自身
    const r = geometryQuery(".card", 10) as any;
    expect(r.elements[0].inViewport).toBe(true);
    expect(r.elements[0].occluded).toBe(false);
    expect(r.elements[0].bbox).toEqual([100, 100, 200, 50]);
  });

  it("元素超出视口右下 → inViewport=false", () => {
    const el = rect(document.createElement("div"), 900, 100, 200, 50); // right=1100>1000
    el.className = "wide";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => el;
    const r = geometryQuery(".wide", 10) as any;
    expect(r.elements[0].inViewport).toBe(false);
  });

  it("中心点被浮层遮挡 → occluded=true", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "target";
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    document.body.append(el, overlay);
    (document as any).elementFromPoint = () => overlay; // 中心点命中 overlay(非自身/后代)
    const r = geometryQuery(".target", 10) as any;
    expect(r.elements[0].occluded).toBe(true);
    expect(r.elements[0].occludedBy).toContain("overlay");
  });

  it("中心点命中自身后代 → 不算遮挡(occluded=false)", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "target";
    const child = document.createElement("span");
    el.appendChild(child);
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => child; // 后代,非遮挡
    const r = geometryQuery(".target", 10) as any;
    expect(r.elements[0].occluded).toBe(false);
  });

  it("文字 ellipsis 截断(scrollWidth>clientWidth)但未被祖先裁剪 → textClipped=true / clippedByAncestor=false", () => {
    const el = rect(document.createElement("div"), 100, 100, 120, 30);
    el.className = "cell";
    scrollDims(el, 300, 120); // 内容 300 > 可视 120 → ellipsis
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => el;
    const r = geometryQuery(".cell", 10) as any;
    expect(r.elements[0].textClipped).toBe(true);
    expect(r.elements[0].clippedByAncestor).toBe(false);
  });

  it("两元素重叠 + a 在 b 上方判定", () => {
    const a = rect(document.createElement("div"), 100, 100, 200, 50); // bottom=150
    a.className = "g";
    const b = rect(document.createElement("div"), 100, 100, 200, 50); // 完全重叠
    b.className = "g";
    document.body.append(a, b);
    (document as any).elementFromPoint = () => a;
    const r = geometryQuery(".g", 10) as any;
    expect(r.pair.overlap).toBe(true);
    expect(r.pair.sameLeft).toBe(true);
    expect(r.pair.sameTop).toBe(true);
  });

  it("两元素左对齐 + a 在 b 正上方(不重叠)", () => {
    const a = rect(document.createElement("div"), 100, 100, 200, 40); // bottom=140
    a.className = "h";
    const b = rect(document.createElement("div"), 100, 200, 200, 40); // top=200 > a.bottom
    b.className = "h";
    document.body.append(a, b);
    (document as any).elementFromPoint = () => a;
    const r = geometryQuery(".h", 10) as any;
    expect(r.pair.overlap).toBe(false);
    expect(r.pair.aAboveB).toBe(true);
    expect(r.pair.sameLeft).toBe(true);
  });

  it("选择器无命中 → total=0,无 pair", () => {
    const r = geometryQuery(".none", 10) as any;
    expect(r.total).toBe(0);
    expect(r.pair).toBeUndefined();
  });
});

// 命中测试拿不到有意义结果时,occluded 必须是 null 而不是 false ——
// 老实现一个 `!!` 把"没测"和"测了没遮挡"压成同一个值,真站上 github.com
// 前 50 个元素有 26% 落进来,全部被报成"被左上角那个加载条遮挡"。
describe("occluded 三态:测不了不得伪装成确定值", () => {
  const hitSelf = (el: Element) => { (document as any).elementFromPoint = () => el; };

  it.each([
    ["零宽", 0, 50],
    ["零高", 200, 0],
    ["display:none 式全零 bbox", 0, 0],
  ])("%s 元素无可命中面积 → occluded=null / inViewport=false / 无 occludedBy", (_n, w, h) => {
    const el = rect(document.createElement("div"), 0, 0, w, h);
    el.className = "z";
    const topleft = document.createElement("div");
    topleft.className = "topleft";
    document.body.append(topleft, el);
    // 中心点落在页面左上角,命中的是别的元素 —— 老实现据此报"被 topleft 遮挡"
    (document as any).elementFromPoint = () => topleft;
    const r = geometryQuery(".z", 10) as any;
    expect(r.elements[0].occluded).toBeNull();
    expect(r.elements[0].inViewport).toBe(false);
    expect("occludedBy" in r.elements[0]).toBe(false);
    expect(r.elements[0].bbox).toEqual([0, 0, w, h]);
  });

  // 代码里没有"中心点在不在视口"的判断:视口外浏览器自己返回 null(Chrome 151 实测
  // 30/30),再加一道守卫改它也不会有测试转红 —— 那就是死条件,不留。
  it("中心点在视口外 → occluded=null,但 bbox 仍是真实值", () => {
    const el = rect(document.createElement("div"), 100, 2000, 200, 50); // cy=2025 > 800
    el.className = "below";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => null;
    const r = geometryQuery(".below", 10) as any;
    expect(r.elements[0].occluded).toBeNull();
    expect(r.elements[0].inViewport).toBe(false);
    expect(r.elements[0].bbox).toEqual([100, 2000, 200, 50]);
  });

  it("elementFromPoint 不存在(能力缺失) → occluded=null 而非 false", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "noapi";
    document.body.appendChild(el);
    (document as any).elementFromPoint = undefined;
    const r = geometryQuery(".noapi", 10) as any;
    expect(r.elements[0].occluded).toBeNull();
  });

  it("elementFromPoint 抛异常 → occluded=null,且不连坐 geometry 其余字段", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "boom";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => { throw new Error("hit test failed"); };
    const r = geometryQuery(".boom", 10) as any;
    expect(r.elements[0].occluded).toBeNull();
    expect(r.elements[0].bbox).toEqual([100, 100, 200, 50]); // 同维其余字段仍在
    expect(r.elements[0].textClipped).toBe(false);
  });

  // 命中资格是"有面积 + 中心点在视口内",与 inViewport 的"整体在视口内"不是一回事。
  // 拿 inViewport 当判据会把跨视口边缘、但中心点可测的元素错误降级成 null。
  it("跨视口边缘但中心点在视口内 → inViewport=false,occluded 仍给真实结论", () => {
    const el = rect(document.createElement("div"), 850, 100, 200, 50); // right=1050>1000, cx=950
    el.className = "straddle";
    document.body.appendChild(el);
    hitSelf(el);
    const r = geometryQuery(".straddle", 10) as any;
    expect(r.elements[0].inViewport).toBe(false);
    expect(r.elements[0].occluded).toBe(false); // 不是 null —— 这一条测得了
  });

  it("命中测试返回 null → 仍是 null,不得当成未遮挡", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "nohit";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => null;
    const r = geometryQuery(".nohit", 10) as any;
    expect(r.elements[0].occluded).toBeNull();
  });

  // 整形层的 pick 用 `!== undefined`,理论上 null 会保留 —— 但 errors 曾经被剥过,
  // 这条锁最终返回体,不接受"读代码得出的结论"。
  it("null 透传到整形后的返回体,键不得消失", () => {
    const el = rect(document.createElement("div"), 0, 0, 0, 0);
    el.className = "out";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => null;
    const r = geometryQuery(".out", 10) as any;
    expect("occluded" in r.elements[0]).toBe(true);
    expect(r.elements[0].occluded).toBeNull();
  });
});

// elementFromPoint 把 shadow-internal 的命中重定向到 host。不下钻就会把「命中自己
// shadow 里的叶子」判成被 host 遮挡 —— 真站上 Web Components 站点会得到"全部被遮挡"。
// 全仓其它路径(observe/act/hit-probe/cdp)都下钻,只有 query 不,本组锁住对齐。
describe("遮挡判定穿 open shadow", () => {
  /** 造 host + open shadow,并按 composed 路径 stub 两级 elementFromPoint */
  function mkShadow(hostRect: [number, number, number, number], innerHtml: string) {
    const host = rect(document.createElement("div"), ...hostRect) as HTMLElement;
    host.className = "host";
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = innerHtml;
    return { host, sr };
  }
  /** 外层永远先命中 host —— 这正是真实浏览器的行为 */
  const hitHostThen = (host: Element, sr: ShadowRoot, inner: Element | null) => {
    (document as any).elementFromPoint = () => host;
    (sr as any).elementFromPoint = () => inner;
  };

  it("shadow 内元素命中自身 → 不算被 host 遮挡", () => {
    const { host, sr } = mkShadow([100, 100, 200, 50], '<button class="target">ok</button>');
    const btn = rect(sr.querySelector(".target")!, 100, 100, 200, 50);
    hitHostThen(host, sr, btn);
    const r = geometryQuery(".target", 10) as any;
    expect(r.total).toBe(1); // queryAllDeep 能穿 shadow 找到它
    expect(r.elements[0].occluded).toBe(false);
    expect("occludedBy" in r.elements[0]).toBe(false);
  });

  it("shadow 内元素被同一 shadow 里的浮层遮挡 → 照常报 true", () => {
    const { host, sr } = mkShadow(
      [100, 100, 200, 50],
      '<button class="target">ok</button><div class="veil"></div>',
    );
    rect(sr.querySelector(".target")!, 100, 100, 200, 50);
    hitHostThen(host, sr, sr.querySelector(".veil"));
    const r = geometryQuery(".target", 10) as any;
    expect(r.elements[0].occluded).toBe(true);
    expect(r.elements[0].occludedBy).toContain("veil");
  });

  it("host 作为查询目标,命中落进它自己的 shadow → 不算遮挡", () => {
    const { host, sr } = mkShadow([100, 100, 200, 50], '<span class="leaf">x</span>');
    host.classList.add("probe");
    hitHostThen(host, sr, sr.querySelector(".leaf"));
    const r = geometryQuery(".probe", 10) as any;
    expect(r.elements[0].occluded).toBe(false);
  });

  it("closed shadow 不下钻,host 当作真实遮挡者报出来", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "target";
    const closedHost = document.createElement("div");
    closedHost.className = "closedhost";
    closedHost.attachShadow({ mode: "closed" }).innerHTML = "<span>hidden</span>";
    document.body.append(el, closedHost);
    (document as any).elementFromPoint = () => closedHost;
    const r = geometryQuery(".target", 10) as any;
    expect(r.elements[0].occluded).toBe(true);
    expect(r.elements[0].occludedBy).toContain("closedhost");
  });

  // 命中落在目标的 composed 祖先上仍算遮挡 —— 与点击路径 classifyHit 的 "ancestor"
  // 分支一致(hit-ownership.ts:136)。这里锁的是"不要顺手把祖先也放行"。
  it("命中落在 composed 祖先上 → 仍算遮挡,不因为穿了 shadow 就放行", () => {
    const { host, sr } = mkShadow([100, 100, 200, 50], '<div class="wrap"><b class="target">t</b></div>');
    rect(sr.querySelector(".target")!, 100, 100, 200, 50);
    hitHostThen(host, sr, sr.querySelector(".wrap"));
    const r = geometryQuery(".target", 10) as any;
    expect(r.elements[0].occluded).toBe(true);
    expect(r.elements[0].occludedBy).toContain("wrap");
  });

  // 真 Chrome 实测:点落在 host 上但 shadow 里没有子元素覆盖时,
  // shadowRoot.elementFromPoint 返回 host 自己。不 break 就会对同一个点重复
  // 命中测试到撞上限 —— 大 DOM 上一次命中测试 ~0.85ms,白烧 8 倍。
  it("下钻遇到自环立即停,不把同一个点重测到撞上限", () => {
    const { host, sr } = mkShadow([100, 100, 200, 50], '<span class="leaf">x</span>');
    host.classList.add("probe");
    let docCalls = 0;
    let srCalls = 0;
    (document as any).elementFromPoint = () => { docCalls++; return host; };
    (sr as any).elementFromPoint = () => { srCalls++; return host; }; // 自环
    const r = geometryQuery(".probe", 10) as any;
    expect(docCalls).toBe(1);
    expect(srCalls).toBe(1); // 不是 SHADOW_WALK_MAX_DEPTH 次
    expect(r.elements[0].occluded).toBe(false); // 停在 host,而 host 就是目标自身
  });

  it("下钻深度用与 queryAllDeep 同一个上限,超出即停在当层", () => {
    // 造 9 层嵌套 open shadow,上限 8 → 第 9 层的叶子够不到
    let cur: Element = document.body;
    const roots: ShadowRoot[] = [];
    for (let i = 0; i < 9; i++) {
      const h = document.createElement("div");
      h.className = `h${i}`;
      cur.appendChild(h);
      const sr = h.attachShadow({ mode: "open" });
      roots.push(sr);
      (sr as any).elementFromPoint = () => sr.firstElementChild;
      cur = sr as unknown as Element;
    }
    const leaf = document.createElement("span");
    leaf.className = "deepleaf";
    roots[8].appendChild(leaf);
    const probe = rect(document.createElement("div"), 100, 100, 200, 50);
    probe.className = "target";
    document.body.appendChild(probe);
    (document as any).elementFromPoint = () => roots[0].host;
    const r = geometryQuery(".target", 10) as any;
    // 停在第 8 跳所在的 host,而不是一路走到 deepleaf
    expect(r.elements[0].occludedBy).not.toContain("deepleaf");
    expect(r.elements[0].occluded).toBe(true);
  });
});
