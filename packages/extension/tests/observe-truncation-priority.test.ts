/**
 * Author: qingwa
 * Description: 截断优先级按 ARIA category — widget 必留,landmark/structure 先丢
 *
 * 背景:observe 召回后 maxElements 截断时(典型 max=120,真实 SPA 单帧 4000+ 候选),
 * 既有 overlay/main-content 两层正交排序是「区域优先级」。Task 6 在此基础上叠加
 * 「类内排序」:同桶内按 ARIA category rank 升序,token 压力下 widget 最先保留,
 * landmark/structure 最先丢。该函数本身是纯函数,由 observe.ts export 给单测与
 * inject 内联副本共用同一语义,改一处须同步另一处,源码锁测试守护。
 */
import { describe, it, expect } from "vitest";
import { truncationRank } from "../src/handlers/observe.js";

describe("截断优先级 truncationRank", () => {
  it("rank 越小越优先保留", () => {
    expect(truncationRank("button")).toBe(0);   // widget 最高
    expect(truncationRank("listbox")).toBe(1);  // composite
    expect(truncationRank("dialog")).toBe(2);   // window
    expect(truncationRank("status")).toBe(2);   // live
    expect(truncationRank("progressbar")).toBe(2); // range
    expect(truncationRank("toolbar")).toBe(3);  // structure
    expect(truncationRank("region")).toBe(4);   // landmark 最先丢
  });

  it("未知 role 返默认 rank 5", () => {
    expect(truncationRank("foobar")).toBe(5);
  });

  it("widget < composite < structure < landmark 严格递增", () => {
    expect(truncationRank("button")).toBeLessThan(truncationRank("listbox"));
    expect(truncationRank("listbox")).toBeLessThanOrEqual(truncationRank("dialog"));
    expect(truncationRank("toolbar")).toBeLessThan(truncationRank("region"));
  });
});
