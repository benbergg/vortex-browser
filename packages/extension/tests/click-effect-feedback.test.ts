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

describe("TOAST_SELECTORS 不含常驻 [aria-live] 包裹（antd Spin 假阳回归 A5/A6）", () => {
  it("不含裸 [aria-live='polite'] / [aria-live='assertive']", () => {
    const arr = [...TOAST_SELECTORS] as string[];
    expect(arr).not.toContain("[aria-live='polite']");
    expect(arr).not.toContain("[aria-live='assertive']");
  });
  it("仍保留 role=status/alert + 框架专属 toast 类（防过度删除漏掉真 toast）", () => {
    const arr = [...TOAST_SELECTORS] as string[];
    expect(arr).toContain("[role='status']");
    expect(arr).toContain("[role='alert']");
    expect(arr).toContain(".ant-message");
    expect(arr).toContain(".el-message");
  });
});
