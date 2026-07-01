// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectBlindspot, detectImageBlindspot } from "../src/page-side/blindspot-detect.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("scan func 内联 detectBlindspot 与纯函数一致", () => {
  it("observe.ts 内联副本存在(防漏内联)", () => {
    const src = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
    expect(src).toContain("[inline detectBlindspot]");
    // 透传链:scan push + 两处 compact/full 映射
    expect(src).toContain("blindspot: __vtxBlind");
    expect(src).toContain("blindspot: e.blindspot");
    // candidateCount 透传到 frame summary
    expect(src).toContain("candidateCount: s.page.candidateCount");
    // A2-fb 非 ARIA 虚拟化回退内联
    expect(src).toContain("[inline detectVirtualByScroll]");
    // 误报闸:祖先 DOM 行数 >> 本列表渲染数 → 跳过(MDN 侧栏实证),须与 canonical 同步
    expect(src).toContain("__scrollerRows");
    expect(src).toContain("__scrollerRows > __rendered * 2");
    // A2-fb-div 纯 div 虚拟列表(react-window/virtuoso/PrimeReact VirtualScroller)内联
    expect(src).toContain("[inline detectDivVirtualScroller]");
    // 页面级滚动容器排除内联(防 <main>/body 等整页滚动区误报全渲染表为虚拟,
    // 2026-06-22 react-aria FP):scroller 为 main/body/scrollingElement/近视口高 → 跳过。
    expect(src).toMatch(/__pageLevel/);
    expect(src).toMatch(/__scroller\.tagName\s*===\s*"MAIN"/);
  });
  it("纯函数对 grid aria-rowcount=1000/rendered=10 → virtual(行为基线)", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="1000">${"<div role='row'></div>".repeat(10)}</div>`;
    expect(detectBlindspot(document.querySelector("[role=grid]") as HTMLElement, 10))
      .toEqual({ kind: "virtual", total: 1000, rendered: 10 });
  });

  // canvas readback 三态 parity:内联副本须与真源 detectBlindspot 行为逐字等价
  it("observe.ts 内联副本 canvas 分支包含 readback 分类字符串(结构同步)", () => {
    const src = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
    // canvas readback 三态
    expect(src).toContain('readback: "chart"');
    expect(src).toContain('readback: "component"');
    expect(src).toContain('readback: "screenshot"');
    expect(src).toContain('chartLib: "echarts"');
    // zrender 属性名
    expect(src).toContain('"data-zr-dom-id"');
    // React fiber 键前缀(两种)
    expect(src).toContain('"__reactFiber$"');
    expect(src).toContain('"__reactInternalInstance$"');
    // Vue 实例属性(直接属性访问,非字符串字面量)
    expect(src).toContain('.__vue__');
    expect(src).toContain('.__vue_app__');
    // 祖先遍历上界与真源一致
    expect(src).toContain('__i < 6');
    // G2/G2Plot 祖先信号 + Chart.js 全局判定(图表库扩展,内联与真源同步)
    expect(src).toContain('"data-chart-source-type"');
    expect(src).toContain('.getChart');
    expect(src).toContain('chartLib: "chartjs"');
    // canvas 面积门与真源一致
    expect(src).toContain('200 * 150');
    // 类型声明同步(ScannedElement.blindspot + __vtxBlind)
    expect(src).toContain('readback?: "component" | "screenshot" | "chart"');
    expect(src).toContain('chartLib?: string');
  });

  it("纯函数 canvas: zrender(data-zr-dom-id) → chart/echarts", () => {
    document.body.innerHTML = '<canvas data-zr-dom-id="0"></canvas>';
    const el = document.querySelector("canvas") as HTMLElement;
    el.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(detectBlindspot(el, 0)).toEqual({ kind: "canvas", readback: "chart", chartLib: "echarts" });
  });

  it("纯函数 canvas: React fiber 祖先 → component", () => {
    document.body.innerHTML = '<div id="host"><canvas></canvas></div>';
    const host = document.getElementById("host")!;
    const el = document.querySelector("canvas") as HTMLElement;
    (host as any)["__reactFiber$abc"] = {};
    el.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(detectBlindspot(el, 0)).toEqual({ kind: "canvas", readback: "component" });
  });

  it("纯函数 canvas: 普通大 canvas → screenshot", () => {
    document.body.innerHTML = '<canvas></canvas>';
    const el = document.querySelector("canvas") as HTMLElement;
    el.getBoundingClientRect = () =>
      ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(detectBlindspot(el, 0)).toEqual({ kind: "canvas", readback: "screenshot" });
  });

  // Task 3: 页级 chart canvas 扫描 parity 断言
  it("[inline detectChartCanvas] 标记存在 + zrender 属性判定内联", () => {
    const src = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
    expect(src).toContain("[inline detectChartCanvas]");
    expect(src).toContain("data-zr-dom-id");
    // 页级扫描同样支持 G2/Chart.js(chartLib 按 canvas 计算,非硬编码 echarts)
    expect(src).toContain('"data-chart-source-type"');
    expect(src).toContain("chartLib: __clib");
  });
  it("页级 canvas 扫描有尺寸门 + dedup(collectedEls)", () => {
    const src = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
    expect(src).toContain("200 * 150");
    expect(src).toContain("collectedEls.indexOf");
  });
  it("[inline detectImageBlindspot] 无 alt 图页级扫描标记 + 门判定内联(parity)", () => {
    const src = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
    expect(src).toContain("[inline detectImageBlindspot]");
    expect(src).toContain('hasAttribute("alt")'); // alt="" 装饰排除
    expect(src).toContain('kind: "image"');
    expect(src).toContain("__ir.width < 80"); // 内容尺寸门与真源一致
  });
});

describe("detectImageBlindspot 纯函数 parity", () => {
  it("无 alt 大图 → {src};alt='' 装饰 → null", () => {
    const big = document.createElement("img");
    Object.defineProperty(big, "src", { value: "https://x/p.jpg", configurable: true });
    big.getBoundingClientRect = () =>
      ({ width: 320, height: 240, left: 0, top: 0, right: 320, bottom: 240, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(detectImageBlindspot(big)).toEqual({ src: "https://x/p.jpg" });
    big.setAttribute("alt", "");
    expect(detectImageBlindspot(big)).toBeNull();
  });
});

describe("blankShell inline↔真源 parity", () => {
  const observeSrc = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
  it("observe.ts 含 [inline detectBlankShell] 标记", () => {
    expect(observeSrc).toContain("[inline detectBlankShell]");
  });
  it("inline 副本含五门关键判据(与真源一致)", () => {
    expect(observeSrc).toContain('__nonStructural === 0 && document.readyState === "complete"'); // ④⑤
    expect(observeSrc).toMatch(/__e\.tag !== "html" && __e\.tag !== "body"/); // ④ 排除结构性 html/body(g2 空态实证)
    expect(observeSrc).toMatch(/umi\|react\|vue\|angular\|svelte\|next\|nuxt/); // ① framework 正则(F4 收紧:去泛匹配 chunk/hash)
    expect(observeSrc).toContain('"#root", "#app", "#__next", "[data-reactroot]"'); // ② 挂载点
    expect(observeSrc).toContain("__len < 64"); // ③ 近空阈值
  });
  it("framesOut 管道镜像 blankShell(与 modal 同形)", () => {
    expect(observeSrc).toContain("s.page.blankShell ? { blankShell: s.page.blankShell }");
  });
});
