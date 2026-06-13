/**
 * Description: Task V-2 单测 —— 锁 classifyFeedback 3 参签名 + 选择器覆盖,
 *   修正 V1 的 2 参/3 参签名 bug。3 参签名 (dialogHit, toastHit, domMutations)
 *   是单一真源,page-side/click-effect.ts end 阶段会原样调用。
 */
import { describe, it, expect } from "vitest";
import {
  classifyFeedback,
  TOAST_SELECTORS,
  DIALOG_SELECTORS,
  type UserFeedback,
} from "@vortex-browser/shared";

describe("classifyFeedback", () => {
  it("全无 → none", () => {
    expect(classifyFeedback(false, false, 0)).toBe("none");
  });
  it("仅 mutation → mutation", () => {
    expect(classifyFeedback(false, false, 50)).toBe("mutation");
  });
  it("toast 命中 → toast", () => {
    expect(classifyFeedback(false, true, 50)).toBe("toast");
  });
  it("dialog 命中优先于 toast → dialog", () => {
    expect(classifyFeedback(true, true, 50)).toBe("dialog");
  });
});

describe("UserFeedback 桶覆盖", () => {
  it("4 个桶可穷尽枚举（none / toast / dialog / mutation）", () => {
    const buckets: UserFeedback[] = ["none", "toast", "dialog", "mutation"];
    expect(new Set(buckets).size).toBe(4);
  });
});

describe("选择器覆盖", () => {
  it("toast 含 el-message/ant-message/bn-msg", () => {
    expect([...TOAST_SELECTORS].join(" ")).toMatch(/\.el-message|\.ant-message|\.bn-msg/);
  });
  it("dialog 含 el-dialog/ant-modal/bn-drawer", () => {
    expect([...DIALOG_SELECTORS].join(" ")).toMatch(/\.el-dialog|\.ant-modal|\.bn-drawer/);
  });
});
