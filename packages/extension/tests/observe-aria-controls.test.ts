// @vitest-environment jsdom
/**
 * Description: N0002 B008 + B009 — aria-controls / aria-owns 关联采集。
 *   B008: aria-controls 拆 id list, 在 collectedEls 找下标, 填 elements.controls。
 *   B009: 找不到下标时, 用 {id:"ghost"} 字符串 fallback, agent 至少看到关联 id
 *     (目标 region/tabpanel/listbox 非 interactive 不在 collectedEls)。
 *   本测试直测内联副本 collect 路径算法, 与 observe.ts 内联副本必须同步。
 */
import { describe, it, expect } from "vitest";

/** 与 observe.ts 内联副本同步的 collect 路径算法。 */
function computeControls(
  elements: Array<{ controls?: Array<{ id?: string; index?: number }> }>,
  collectedEls: Element[],
): void {
  for (let i = 0; i < collectedEls.length; i++) {
    const el = collectedEls[i];
    const ctrlAttr = el.getAttribute("aria-controls");
    const ownsAttr = el.getAttribute("aria-owns");
    const allIds: string[] = [];
    if (ctrlAttr) allIds.push(...ctrlAttr.split(/\s+/).filter(Boolean));
    if (ownsAttr) allIds.push(...ownsAttr.split(/\s+/).filter(Boolean));
    if (allIds.length === 0) continue;
    const ctrlList: Array<{ id?: string; index?: number }> = [];
    const seenIdx = new Set<number>();
    const seenId = new Set<string>();
    for (const id of allIds) {
      if (seenId.has(id)) continue;
      let found = -1;
      for (let j = 0; j < collectedEls.length; j++) {
        if (collectedEls[j].id === id) { found = j; break; }
      }
      if (found >= 0 && !seenIdx.has(found)) {
        ctrlList.push({ index: found });
        seenIdx.add(found);
      } else if (found < 0) {
        ctrlList.push({ id });
      }
      seenId.add(id);
    }
    if (ctrlList.length > 0) elements[i].controls = ctrlList;
  }
}

describe("observe-aria-controls: B008 + B009 (N0002)", () => {
  it("B008: button aria-controls=region-id → [{index:1}]", () => {
    document.body.innerHTML = `
      <button id="trigger" aria-controls="region">Click</button>
      <div id="region">Content</div>
    `;
    const trigger = document.querySelector("#trigger")!;
    const region = document.querySelector("#region")!;
    const collectedEls: Element[] = [trigger, region];
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = [{}, {}];
    computeControls(elements, collectedEls);
    expect(elements[0].controls).toEqual([{ index: 1 }]);
    expect(elements[1].controls).toBeUndefined();
  });

  it("B009: aria-controls 指向非 collectedEls 元素 → [{id:'ghost'}] fallback", () => {
    // B009 关键场景: 目标元素(region/tabpanel)非 interactive, 不在 collectedEls。
    // 旧 B008 修复: 静默丢关联。修复后: 记 {id:"ghost"}, agent 至少看到关联。
    document.body.innerHTML = `<button id="trigger" aria-controls="tabpanel-1">Click</button>`;
    const trigger = document.querySelector("#trigger")!;
    const collectedEls: Element[] = [trigger];
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = [{}];
    computeControls(elements, collectedEls);
    expect(elements[0].controls).toEqual([{ id: "tabpanel-1" }]);
  });

  it("B008+B009 混合: 一部分已收集 + 一部分 ghost", () => {
    document.body.innerHTML = `
      <button id="trigger" aria-controls="region1 tabpanel-1 region2">Click</button>
      <div id="region1">A</div>
    `;
    const trigger = document.querySelector("#trigger")!;
    const region1 = document.querySelector("#region1")!;
    const collectedEls: Element[] = [trigger, region1];
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = [{}, {}];
    computeControls(elements, collectedEls);
    // region1 在 collectedEls (index=1), tabpanel-1 + region2 不在 → ghost
    expect(elements[0].controls).toEqual([{ index: 1 }, { id: "tabpanel-1" }, { id: "region2" }]);
  });

  it("无 aria-controls → controls 字段不写(undefined)", () => {
    document.body.innerHTML = `<button id="t">Click</button><div id="r">C</div>`;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = els.map(() => ({}));
    computeControls(elements, els);
    expect(elements.every((e) => e.controls === undefined)).toBe(true);
  });

  it("aria-controls 多 id (space-separated) → 按 id 顺序", () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="r1 r2 r3">X</button>
      <div id="r1">A</div><div id="r2">B</div><div id="r3">C</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    expect(elements[tIdx].controls).toEqual([
      { index: els.indexOf(document.querySelector("#r1")!) },
      { index: els.indexOf(document.querySelector("#r2")!) },
      { index: els.indexOf(document.querySelector("#r3")!) },
    ]);
  });

  it("aria-owns 同样支持(popover / listbox 父级)", () => {
    document.body.innerHTML = `
      <div id="listbox" role="listbox" aria-owns="opt1 opt2"></div>
      <div id="opt1">A</div><div id="opt2">B</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = els.map(() => ({}));
    computeControls(elements, els);
    const lbIdx = els.indexOf(document.querySelector("#listbox")!);
    expect(elements[lbIdx].controls).toEqual([
      { index: els.indexOf(document.querySelector("#opt1")!) },
      { index: els.indexOf(document.querySelector("#opt2")!) },
    ]);
  });

  it("aria-controls + aria-owns 同元素 → 合并去重, 按出现顺序", () => {
    document.body.innerHTML = `
      <div id="t" aria-controls="a" aria-owns="b a"></div>
      <div id="a">A</div><div id="b">B</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    expect(elements[tIdx].controls).toEqual([
      { index: els.indexOf(document.querySelector("#a")!) },
      { index: els.indexOf(document.querySelector("#b")!) },
    ]);
  });

  it("id 重复(应罕见,id-uniqueness 守卫)→ 取第一个匹配", () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="dup">X</button>
      <div id="dup">First</div>
      <div id="dup">Second</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    const firstDup = document.querySelectorAll("#dup")[0];
    expect(elements[tIdx].controls).toEqual([{ index: els.indexOf(firstDup) }]);
  });

  it("空格多余/tab 分隔: split(/\\s+/) 正确处理", () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="  a   b  ">X</button>
      <div id="a">A</div><div id="b">B</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: Array<{ id?: string; index?: number }> }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    expect(elements[tIdx].controls).toEqual([
      { index: els.indexOf(document.querySelector("#a")!) },
      { index: els.indexOf(document.querySelector("#b")!) },
    ]);
  });
});
