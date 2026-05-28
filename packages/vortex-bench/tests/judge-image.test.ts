// packages/vortex-bench/tests/judge-image.test.ts
// H1 回归测试:pickSavedToPath 纯逻辑,验证 file 模式下 withEvents() 追加块不干扰取图路径。
import { describe, it, expect } from "vitest";
import { pickSavedToPath } from "../src/runner/judge.js";

describe("pickSavedToPath", () => {
  it("content=[{savedTo:...}, {vortex-events block}] → 返回 savedTo 路径", () => {
    const content = [
      { type: "text", text: JSON.stringify({ savedTo: "/tmp/screenshot.jpg", width: 1280, height: 800, bytes: 12345 }) },
      { type: "text", text: "[vortex-events] {\"type\":\"navigate\",\"url\":\"http://localhost:5173\"}" },
    ];
    expect(pickSavedToPath(content)).toBe("/tmp/screenshot.jpg");
  });

  it("无任何 savedTo 字段 → null", () => {
    const content = [
      { type: "text", text: "[vortex-events] some event data" },
      { type: "text", text: "not json at all" },
    ];
    expect(pickSavedToPath(content)).toBeNull();
  });

  it("image block 不在此函数职责内 — image type 不含 savedTo 故跳过", () => {
    const content = [
      { type: "image", data: "base64data==", mimeType: "image/jpeg" },
    ];
    // image block 没有 text 字段,pickSavedToPath 只处理 text/file 路径
    expect(pickSavedToPath(content)).toBeNull();
  });

  it("第一个 text block 是 JSON 但无 savedTo,第二个有 → 返回第二个", () => {
    const content = [
      { type: "text", text: JSON.stringify({ status: "ok" }) },
      { type: "text", text: JSON.stringify({ savedTo: "/a.jpg" }) },
    ];
    expect(pickSavedToPath(content)).toBe("/a.jpg");
  });

  it("空 content 数组 → null", () => {
    expect(pickSavedToPath([])).toBeNull();
  });
});
