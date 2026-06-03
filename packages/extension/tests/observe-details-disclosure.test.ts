import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:原生 <details>/<summary> disclosure 的两个 observe 缺陷
 * (2026-06-02 第五轮真实站结构空间 dogfood)。
 *
 * S1(漏报):observe 不识别 <summary> 这个 disclosure 开合触发器。
 *   <summary> 不在 INTERACTIVE_SELECTORS 白名单,且无 role/tag 映射 →
 *   GitHub 菜单 / MDN / 文档站 FAQ 折叠的入口控件整类对 observe 隐身。
 *   修复:把 `details > summary` 加入白名单,getRole 映射为 button。
 *
 * S2(误报):关闭态 <details> 的内部内容用 content-visibility:hidden 隐藏
 *   (施加在 ::details-content 伪元素上),子元素保留非 0 rect、自身
 *   getComputedStyle 的 visibility 仍报 "visible",故既有的 visibility 门和
 *   elementFromPoint 遮挡判定都漏掉,不可达的隐藏控件被误报为可交互。
 *   修复:加 checkVisibility() 默认门(对 cv:hidden 链返回 false,对 cv:auto
 *   离屏可达内容和可见元素返回 true,只挡 cv:hidden)。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe native <details>/<summary> disclosure (2026-06-02 dogfood)", () => {
  it("S1: INTERACTIVE_SELECTORS 收录 details > summary disclosure 触发器(限首个)", () => {
    const block = OBSERVE_SRC.match(
      /const INTERACTIVE_SELECTORS = \[([\s\S]*?)\]\.join/,
    );
    expect(block).not.toBeNull();
    // :first-of-type 限定——仅首个 <summary> 是 disclosure 控件(评审 #1 LOW)。
    expect(block?.[1]).toMatch(/"details > summary:first-of-type"/);
  });

  it("S1: getRole 把 summary 映射为 button(交互模型等同按钮)", () => {
    expect(OBSERVE_SRC).toMatch(
      /tag === "summary"\)\s*return "button";/,
    );
  });

  it("S2: 可见性过滤加入 checkVisibility() 门挡 content-visibility:hidden", () => {
    // 必须 typeof 守卫(jsdom / 老环境无此方法)+ 取反 continue 剔除 candidate。
    expect(OBSERVE_SRC).toMatch(
      /typeof htmlEl\.checkVisibility === "function"\s*&&\s*!htmlEl\.checkVisibility\(\)/,
    );
  });

  it("S2: checkVisibility 门用默认(无参)调用,以免误伤 content-visibility:auto", () => {
    // 默认 checkVisibility() 对 cv:auto 离屏可达内容(R1,滚动即渲染)返回 true,
    // 只对 cv:hidden 返回 false。若传 {contentVisibilityAuto:true} 会连 cv:auto
    // 一起挡掉 → 回归 R1。锁住「门后紧跟 continue」且不带 contentVisibilityAuto 参数。
    const gate = OBSERVE_SRC.match(
      /!htmlEl\.checkVisibility\(([^)]*)\)\s*\)\s*\{\s*continue;/,
    );
    expect(gate).not.toBeNull();
    expect(gate?.[1]?.trim()).toBe("");
  });
});

/**
 * AL(漏报):原生 <details>/<summary> disclosure 的「展开/折叠」态对 observe 隐身
 * (2026-06-03 第十三轮 MDN 真实站 dogfood)。
 *
 * 现象:getUiState 的 expanded 判定只读 aria-expanded 属性(712 行),但原生
 *   <details> 的开合态在 details.open IDL 属性上、无 aria-expanded。MDN CSS 侧栏
 *   108 个属性分组、文档站 FAQ 折叠面板均用原生 details → 开着的分组与折叠的分组
 *   在 observe 输出中完全相同(都是无标记的 [button]),agent 无法判断 disclosure
 *   是否已展开(会重复点开 / 开着却去别处找内容)。这是 aria-expanded→[expanded]
 *   那条(T2)的原生 disclosure 对应盲区。
 *
 * 修复:expanded 判定补一条——<summary> 的宿主 <details> open 时发 [expanded],
 *   与 aria-expanded 同语义、同「collapsed 不发避免噪声」策略。
 */
describe("observe native <details> 展开态(AL,2026-06-03 dogfood)", () => {
  it("AL: <summary> 宿主 <details> open 时置 expanded(读 details.open IDL 非 aria-expanded)", () => {
    // 元素是 <summary>、其 parentElement 是 <details>、且 .open === true 时置 expanded。
    expect(OBSERVE_SRC).toMatch(/el\.tagName === "SUMMARY"/);
    expect(OBSERVE_SRC).toMatch(
      /el\.parentElement\?\.tagName === "DETAILS"/,
    );
    expect(OBSERVE_SRC).toMatch(/\)\.open === true/);
  });

  it("AL: 原生 details 分支挂在 aria-expanded 判定之后(同一 expanded 语义、collapsed 不发)", () => {
    // 顺序锁:aria-expanded==="true" 判定在前,原生 details 分支作 else-if 补充,
    // 二者都只在「展开」时置 s.expanded(折叠态不发,与既有策略一致)。
    const ariaIdx = OBSERVE_SRC.indexOf('el.getAttribute("aria-expanded") === "true"');
    const nativeIdx = OBSERVE_SRC.indexOf('el.tagName === "SUMMARY"');
    expect(ariaIdx).toBeGreaterThan(0);
    expect(nativeIdx).toBeGreaterThan(ariaIdx);
  });
});

describe("observe inert 子树排除(V,2026-06-02 dogfood)", () => {
  it("V: 用 closest(\"[inert]\") 排除 inert 子树内元素", () => {
    // inert 让子树非交互(浏览器禁止点击/聚焦),但 checkVisibility 仍 true、
    // 也非 :disabled → 既有两门漏掉。closest("[inert]") 命中即 continue 跳过。
    expect(OBSERVE_SRC).toMatch(
      /htmlEl\.closest\("\[inert\]"\)\s*\)\s*\{\s*continue;/,
    );
  });

  it("V: inert 门带 typeof 守卫(jsdom / 老环境无 closest)", () => {
    expect(OBSERVE_SRC).toMatch(
      /typeof htmlEl\.closest === "function" && htmlEl\.closest\("\[inert\]"\)/,
    );
  });
});
