// @vitest-environment jsdom
/**
 * Description: N0002 B008 — aria-controls / aria-owns 关联采集。
 *   collapse / accordion / tab / menu 触发器在 DOM 上写 aria-controls="region-id"
 *   (或 aria-owns 同语义, 常见 popover / listbox 父级) 关联到目标 region。
 *   observe 真实路径(scanOneFrame elements.push)未填充 controls 字段,
 *   渲染层 type + 输出都齐了, 只差采集。
 *   本测试直测: 元素有 aria-controls="id" → elements.controls 数组含目标下标。
 *   (集成测试走 vortex_observe, 本测试聚焦 controls 关联算法。)
 */
import { describe, it, expect } from "vitest";
import { buildSelector } from "../src/handlers/observe.js";

/**
 * 模拟 scanOneFrame 收集后第二轮 controls pass 的算法(与 observe.ts 内联副本同步)。
 * 接受 elements + collectedEls, 写入 elements[i].controls。
 * 注:实际生产代码在 observe.ts:3080+;本函数为算法独立版本供单测, 与内联副本必须同步。
 */
function computeControls(
  elements: Array<{ controls?: number[] }>,
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
    const idxList: number[] = [];
    const seen = new Set<number>();
    for (const id of allIds) {
      for (let j = 0; j < collectedEls.length; j++) {
        if (collectedEls[j].id === id && !seen.has(j)) {
          idxList.push(j);
          seen.add(j);
          break;
        }
      }
    }
    if (idxList.length > 0) elements[i].controls = idxList;
  }
}

describe("observe-aria-controls: computeControls (N0002 B008)", () => {
  it("button aria-controls=region-id → controls 数组含 region 下标", () => {
    document.body.innerHTML = `
      <button id="trigger" aria-controls="region">Click</button>
      <div id="region">Content</div>
    `;
    const trigger = document.querySelector("#trigger")!;
    const region = document.querySelector("#region")!;
    const collectedEls: Element[] = [trigger, region];
    const elements: Array<{ controls?: number[] }> = [{}, {}];
    computeControls(elements, collectedEls);
    expect(elements[0].controls).toEqual([1]);
    expect(elements[1].controls).toBeUndefined();
  });

  it("无 aria-controls → controls 字段不写(undefined)", () => {
    document.body.innerHTML = `<button id="t">Click</button><div id="r">C</div>`;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: number[] }> = els.map(() => ({}));
    computeControls(elements, els);
    expect(elements.every((e) => e.controls === undefined)).toBe(true);
  });

  it("aria-controls 多 id (space-separated) → 全部映射, 按 id 顺序", () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="r1 r2 r3">X</button>
      <div id="r1">A</div><div id="r2">B</div><div id="r3">C</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: number[] }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    expect(elements[tIdx].controls).toEqual([
      els.indexOf(document.querySelector("#r1")!),
      els.indexOf(document.querySelector("#r2")!),
      els.indexOf(document.querySelector("#r3")!),
    ]);
  });

  it("aria-controls 指向不在 collectedEls 的 id → 静默忽略", () => {
    document.body.innerHTML = `<button id="t" aria-controls="ghost">X</button>`;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: number[] }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    expect(elements[tIdx].controls).toBeUndefined(); // 找不到, 不写字段
  });

  it("aria-owns 同样支持(popover / listbox 父级)", () => {
    document.body.innerHTML = `
      <div id="listbox" role="listbox" aria-owns="opt1 opt2"></div>
      <div id="opt1">A</div><div id="opt2">B</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: number[] }> = els.map(() => ({}));
    computeControls(elements, els);
    const lbIdx = els.indexOf(document.querySelector("#listbox")!);
    expect(elements[lbIdx].controls).toEqual([
      els.indexOf(document.querySelector("#opt1")!),
      els.indexOf(document.querySelector("#opt2")!),
    ]);
  });

  it("aria-controls + aria-owns 同元素 → 合并去重, 按出现顺序", () => {
    document.body.innerHTML = `
      <div id="t" aria-controls="a" aria-owns="b a"></div>
      <div id="a">A</div><div id="b">B</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: number[] }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    // aria-controls 顺序: [aIdx], aria-owns 加 [bIdx, aIdx(去重)]
    expect(elements[tIdx].controls).toEqual([
      els.indexOf(document.querySelector("#a")!),
      els.indexOf(document.querySelector("#b")!),
    ]);
  });

  it("id 重复(应罕见,id-uniqueness 守卫)→ 取第一个匹配", () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="dup">X</button>
      <div id="dup">First</div>
      <div id="dup">Second</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: number[] }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    const firstDup = document.querySelectorAll("#dup")[0];
    expect(elements[tIdx].controls).toEqual([els.indexOf(firstDup)]);
  });

  it("空格多余/tab 分隔: split(/\\s+/) 正确处理", () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="  a   b  ">X</button>
      <div id="a">A</div><div id="b">B</div>
    `;
    const els = Array.from(document.querySelectorAll("*"));
    const elements: Array<{ controls?: number[] }> = els.map(() => ({}));
    computeControls(elements, els);
    const tIdx = els.indexOf(document.querySelector("#t")!);
    expect(elements[tIdx].controls).toEqual([
      els.indexOf(document.querySelector("#a")!),
      els.indexOf(document.querySelector("#b")!),
    ]);
  });
});
