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
  it("S1: INTERACTIVE_SELECTORS 收录 details > summary disclosure 触发器", () => {
    const block = OBSERVE_SRC.match(
      /const INTERACTIVE_SELECTORS = \[([\s\S]*?)\]\.join/,
    );
    expect(block).not.toBeNull();
    expect(block?.[1]).toMatch(/"details > summary"/);
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
