// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
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
    expect(r.elements[0].wcagAA).toBeNull();
    expect(r.elements[0].wcagAAA).toBeNull();
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
    expect(r.elements[0].wcagAA).toBeNull();
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
    expect(r.elements[0].wcagAA).toBeNull();
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

  it("groups 含 typography → 给 fontFamily/lineHeight/letterSpacing", () => {
    const el = document.createElement("h1");
    el.className = "g1";
    el.style.fontFamily = "ESBuild, sans-serif";
    el.style.lineHeight = "60px";
    el.style.letterSpacing = "-1.2px";
    document.body.appendChild(el);
    const r = styleProbeFunc(".g1", 10, ["typography"]) as any;
    expect(r.elements[0].typography.fontFamily).toBe("ESBuild, sans-serif");
    expect(r.elements[0].typography.lineHeight).toBe("60px");
    expect(r.elements[0].typography.letterSpacing).toBe("-1.2px");
    expect(r.elements[0].box).toBeUndefined();
    expect(r.elements[0].motion).toBeUndefined();
  });

  it("groups 含 box → 键齐全,且按短横线属性名去问 computed style", () => {
    // jsdom 不解析 border-radius 这类简写的 computed 值,断言解析结果会锁不住真实行为;
    // 这里锁的是"驼峰转短横线后拿去问 getComputedStyle"这条契约(真值由 Task 6 真站验收)。
    const el = document.createElement("a");
    el.className = "g2";
    document.body.appendChild(el);

    const asked: string[] = [];
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((e: Element) => {
      const cs = real(e as Element);
      return new Proxy(cs, {
        get(t, k) {
          if (k === "getPropertyValue") {
            return (prop: string) => {
              asked.push(prop);
              return cs.getPropertyValue(prop);
            };
          }
          const v = (t as never as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as never);

    const r = styleProbeFunc(".g2", 10, ["box"]) as any;
    spy.mockRestore();

    expect(Object.keys(r.elements[0].box)).toEqual([
      "display", "padding", "margin", "borderRadius", "borderWidth",
      "borderStyle", "borderColor", "width", "height",
      "flexDirection", "flexWrap", "justifyContent", "alignItems", "gap",
      "gridTemplateColumns", "gridTemplateRows",
    ]);
    // 探针原样给,初始值由 handler 侧 dropInitialLayoutValues 裁 —— 判定不放注入代码里
    expect(asked).toContain("grid-template-columns");
    expect(asked).not.toContain("gridTemplateColumns");
    // 驼峰必须转成 CSS 的短横线写法,否则真浏览器一律返回空串
    expect(asked).toContain("border-radius");
    expect(asked).toContain("padding");
    expect(asked).not.toContain("borderRadius");
  });

  it("paint 组问的是 background-image 而非 backgroundImage", () => {
    const el = document.createElement("div");
    el.className = "g2b";
    document.body.appendChild(el);
    const asked: string[] = [];
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((e: Element) => {
      const cs = real(e as Element);
      return new Proxy(cs, {
        get(t, k) {
          if (k === "getPropertyValue") {
            return (prop: string) => { asked.push(prop); return cs.getPropertyValue(prop); };
          }
          const v = (t as never as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as never);
    styleProbeFunc(".g2b", 10, ["paint"]);
    spy.mockRestore();
    expect(asked).toContain("background-image");
    expect(asked).toContain("box-shadow");
  });

  it("groups 含 motion → 给 transition", () => {
    const el = document.createElement("div");
    el.className = "g3";
    el.style.transition = "background-color 0.2s ease-out";
    document.body.appendChild(el);
    const r = styleProbeFunc(".g3", 10, ["motion"]) as any;
    expect(r.elements[0].motion.transition).toContain("background-color");
  });

  it("四组全开 → 四个字段都在", () => {
    const el = document.createElement("div");
    el.className = "g4";
    document.body.appendChild(el);
    const r = styleProbeFunc(".g4", 10, ["typography", "box", "paint", "motion"]) as any;
    for (const g of ["typography", "box", "paint", "motion"]) {
      expect(r.elements[0][g], `缺分组 ${g}`).toBeTypeOf("object");
    }
  });

  it("注入自包含:剥离模块作用域后仍可运行", () => {
    const detached = new Function("return " + styleProbeFunc.toString())();
    const el = document.createElement("div");
    el.className = "iso";
    document.body.appendChild(el);
    expect(() => detached(".iso", 1, ["typography", "box", "paint", "motion"])).not.toThrow();
  });

  it("注入自包含:六组全开(含 pseudo/font)剥离模块作用域后仍可运行", () => {
    // 四组那条覆盖不到 collectFontFaces 与伪元素读取,这两段引用模块标识符会真站崩
    const detached = new Function("return " + styleProbeFunc.toString())();
    const st = document.createElement("style");
    st.textContent = '@font-face{font-family:"X";src:url(x.woff2)}';
    document.head.appendChild(st);
    const el = document.createElement("div");
    el.className = "iso6";
    document.body.appendChild(el);
    let out: unknown;
    expect(() => {
      out = detached(".iso6", 1, ["typography", "box", "paint", "motion", "pseudo", "font"]);
    }).not.toThrow();
    expect((out as { error?: string }).error).toBeUndefined();
    expect((out as { fontFaces?: unknown[] }).fontFaces).toBeDefined();
  });

  it("groups 缺省(不传)也要能剥离作用域跑 —— 缺省是六组全开", () => {
    const detached = new Function("return " + styleProbeFunc.toString())();
    const el = document.createElement("div");
    el.className = "iso7";
    document.body.appendChild(el);
    const out = detached(".iso7", 1) as { error?: string; elements: Array<{ declaredFont?: string }> };
    expect(out.error).toBeUndefined();
    expect(out.elements[0].declaredFont).toBeDefined();
  });

  it("背景色带 alpha → 不拿原始色硬算,状态为 translucent", () => {
    const el = document.createElement("div");
    el.className = "alpha";
    el.style.color = "rgb(0, 0, 0)";
    el.style.backgroundColor = "rgba(255, 255, 255, 0.5)";
    document.body.appendChild(el);
    const r = styleProbeFunc(".alpha", 10, []) as any;
    // 按纯白算会报 21:1,真实观感取决于更底层
    expect(r.elements[0].contrastStatus).toBe("translucent");
    expect(r.elements[0].contrastRatio).toBeNull();
    expect(r.elements[0].wcagAA).toBeNull();
  });

  it("元素自身 opacity<1 → translucent", () => {
    const el = document.createElement("div");
    el.className = "op";
    el.style.color = "rgb(0, 0, 0)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    el.style.opacity = "0.5";
    document.body.appendChild(el);
    const r = styleProbeFunc(".op", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("translucent");
    expect(r.elements[0].contrastRatio).toBeNull();
  });

  it("认不出的颜色格式(oklch) → unsupported-color,不抓数字硬算", () => {
    const el = document.createElement("div");
    el.className = "p3";
    document.body.appendChild(el);
    // jsdom 不解析 oklch,直接喂 computed 替身覆盖 color/background-color
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((e: Element) => {
      const cs = real(e as Element);
      return new Proxy(cs, {
        get(t, k) {
          if (k === "color") return "oklch(0.7 0.1 200)";
          if (k === "backgroundColor") return "rgb(255, 255, 255)";
          const v = (t as never as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as never);
    const r = styleProbeFunc(".p3", 10, []) as any;
    spy.mockRestore();
    expect(r.elements[0].contrastStatus).toBe("unsupported-color");
    expect(r.elements[0].wcagAAA).toBeNull();
  });

  it("wcag 判定是 null 而不是字符串(JSON 里字符串 truthy 会被误读成通过)", () => {
    const el = document.createElement("div");
    el.className = "ser";
    el.style.color = "rgb(0, 0, 0)";
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    document.body.appendChild(el);
    const r = styleProbeFunc(".ser", 10, []) as any;
    const round = JSON.parse(JSON.stringify(r.elements[0]));
    expect(round.wcagAA).toBeNull();
    expect(Boolean(round.wcagAA)).toBe(false);
    expect(round.contrastStatus).toBe("no-painted-background");
  });

  it("32 个属性逐项按短横线名去问 computed style(拼错/漏项都转红)", () => {
    const el = document.createElement("div");
    el.className = "all32";
    document.body.appendChild(el);
    const asked: string[] = [];
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((e: Element) => {
      const cs = real(e as Element);
      return new Proxy(cs, {
        get(t, k) {
          if (k === "getPropertyValue") {
            return (prop: string) => { asked.push(prop); return cs.getPropertyValue(prop); };
          }
          const v = (t as never as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as never);
    styleProbeFunc(".all32", 10, ["typography", "box", "paint", "motion"]);
    spy.mockRestore();

    expect(asked).toEqual([
      "font-family", "font-size", "font-weight", "line-height",
      "letter-spacing", "text-align", "text-transform",
      "display", "padding", "margin", "border-radius", "border-width",
      "border-style", "border-color", "width", "height",
      "flex-direction", "flex-wrap", "justify-content", "align-items", "gap",
      "grid-template-columns", "grid-template-rows",
      "background-color", "background-image", "box-shadow", "opacity", "outline", "filter",
      "transition", "transform", "animation",
    ]);
  });

  it("groups 缺省 = 四组全开;空数组 = 一组都不要", () => {
    const el = document.createElement("div");
    el.className = "defg";
    document.body.appendChild(el);
    const withDefault = (styleProbeFunc(".defg", 10) as any).elements[0];
    const withEmpty = (styleProbeFunc(".defg", 10, []) as any).elements[0];
    for (const g of ["typography", "box", "paint", "motion"]) {
      expect(withDefault[g], `缺省应含 ${g}`).toBeTypeOf("object");
      expect(withEmpty[g], `空数组不应含 ${g}`).toBeUndefined();
    }
  });

  it("自身同时有背景图与 opacity<1 → 报 translucent(合成优先于图)", () => {
    const el = document.createElement("div");
    el.className = "imgop";
    el.style.color = "rgb(0, 0, 0)";
    el.style.backgroundImage = "linear-gradient(90deg, #000, #fff)";
    el.style.opacity = "0.5";
    document.body.appendChild(el);
    const r = styleProbeFunc(".imgop", 10, []) as any;
    // 旧实现里 background-image 会把 opacity 这个原因整个盖掉
    expect(r.elements[0].contrastStatus).toBe("translucent");
    expect(r.elements[0].wcagAA).toBeNull();
  });

  it("祖先同时有 opacity<1 与背景图 → 仍报 translucent", () => {
    const anc = document.createElement("div");
    anc.style.opacity = "0.5";
    anc.style.backgroundImage = "linear-gradient(90deg, #000, #fff)";
    const el = document.createElement("span");
    el.className = "ancimgop";
    el.style.color = "rgb(0, 0, 0)";
    anc.appendChild(el);
    document.body.appendChild(anc);
    const r = styleProbeFunc(".ancimgop", 10, []) as any;
    expect(r.elements[0].contrastStatus).toBe("translucent");
  });

  it("前景色认不出 + 背景是纯色 → unsupported-color(不被 no-painted 掩盖)", () => {
    const el = document.createElement("div");
    el.className = "fgbad";
    document.body.appendChild(el);
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((e: Element) => {
      const cs = real(e as Element);
      return new Proxy(cs, {
        get(t, k) {
          if (k === "color") return "color(display-p3 1 0 0)";
          if (k === "backgroundColor") return "rgb(255, 255, 255)";
          const v = (t as never as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as never);
    const r = styleProbeFunc(".fgbad", 10, []) as any;
    spy.mockRestore();
    expect(r.elements[0].contrastStatus).toBe("unsupported-color");
  });

  it("百分比 rgb 不按 0-255 硬算 → unsupported-color", () => {
    const el = document.createElement("div");
    el.className = "pct";
    document.body.appendChild(el);
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((e: Element) => {
      const cs = real(e as Element);
      return new Proxy(cs, {
        get(t, k) {
          if (k === "color") return "rgb(100% 0% 0%)";
          if (k === "backgroundColor") return "rgb(255, 255, 255)";
          const v = (t as never as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as never);
    const r = styleProbeFunc(".pct", 10, []) as any;
    spy.mockRestore();
    // 旧 parse 会读成 [100,0,0],按 100/255 算出错误亮度
    expect(r.elements[0].contrastStatus).toBe("unsupported-color");
    expect(r.elements[0].contrastRatio).toBeNull();
  });

  it("alpha 越界(rgba(...,1.5)) → unsupported-color,不按不透明算", () => {
    const el = document.createElement("div");
    el.className = "abad";
    document.body.appendChild(el);
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((e: Element) => {
      const cs = real(e as Element);
      return new Proxy(cs, {
        get(t, k) {
          if (k === "color") return "rgba(0, 0, 0, 1.5)";
          if (k === "backgroundColor") return "rgb(255, 255, 255)";
          const v = (t as never as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as never);
    const r = styleProbeFunc(".abad", 10, []) as any;
    spy.mockRestore();
    expect(r.elements[0].contrastStatus).toBe("unsupported-color");
    expect(r.elements[0].contrastRatio).toBeNull();
  });

  it("无命中 → total=0", () => {
    const r = styleProbeFunc(".none", 10, []) as any;
    expect(r.total).toBe(0);
    expect(r.elements).toEqual([]);
  });
});

describe("styleProbeFunc 的 @font-face 收集", () => {
  const faces = (css: string): Array<Record<string, string>> => {
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    const el = document.createElement("div");
    el.className = "ff";
    document.body.appendChild(el);
    return (styleProbeFunc(".ff", 1, ["font"]) as any).fontFaces;
  };

  it("顶层 @font-face 收得到", () => {
    expect(faces('@font-face{font-family:"A";src:url(a.woff2)}')
      .some((f) => f["font-family"] === '"A"')).toBe(true);
  });

  it("@media 里的 @font-face 也要收 —— 不递归就会漏,还照样报 partial=false", () => {
    expect(faces('@media screen{@font-face{font-family:"InMedia";src:url(m.woff2)}}')
      .some((f) => f["font-family"] === '"InMedia"')).toBe(true);
  });

  it("@supports 里的也要收", () => {
    expect(faces('@supports (display:grid){@font-face{font-family:"InSupports";src:url(s.woff2)}}')
      .some((f) => f["font-family"] === '"InSupports"')).toBe(true);
  });
});

describe("styleProbeFunc 的伪元素粗筛", () => {
  // jsdom 的伪元素 content 恒为 normal,真实形态只能靠替身喂进去;
  // 替身转发真实实现,只接管带第二参的调用
  const withPseudo = (before: Record<string, string>): unknown => {
    const real = window.getComputedStyle.bind(window);
    vi.stubGlobal("getComputedStyle", (el: Element, which?: string | null) => {
      if (!which) return real(el);
      return {
        getPropertyValue: (p: string) => (which === "::before" ? (before[p] ?? "") : "none"),
      } as unknown as CSSStyleDeclaration;
    });
    const el = document.createElement("i");
    el.className = "pe";
    document.body.appendChild(el);
    const r = styleProbeFunc(".pe", 1, ["pseudo"]) as any;
    vi.unstubAllGlobals();
    return r.elements[0].pseudoRaw;
  };

  it("空 content + 背景图 → 粗筛不能丢,渲染判定归 isPseudoRendered 一处管", () => {
    const raw = withPseudo({
      content: '""', "background-image": 'url("i.png")', width: "20px", height: "20px",
      display: "inline-block", visibility: "visible", opacity: "1",
    }) as Record<string, Record<string, string>>;
    expect(raw?.before).toBeDefined();
    expect(raw.before["background-image"]).toContain("i.png");
  });

  it("content 是 none → 粗筛就跳过,不白传数据", () => {
    expect(withPseudo({ content: "none" })).toBeUndefined();
  });

  it("content 是 normal → 同样跳过(伪元素上 normal 等价 none)", () => {
    expect(withPseudo({ content: "normal" })).toBeUndefined();
  });

  it("content 读回空串(拿不到) → 仍然带上来,由判定层决定,不在注入侧提前定生死", () => {
    const raw = withPseudo({
      content: "", "background-image": 'url("i.png")', width: "9px", height: "9px",
    }) as Record<string, Record<string, string>> | undefined;
    expect(raw?.before).toBeDefined();
  });
});
