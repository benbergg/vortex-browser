// packages/vortex-bench/tests/judge-screenshot-integration.test.ts
// 验证 judgePage 把 ScreenshotProfile 字段透传到 vortex_screenshot MCP 调用。
// 用 mcpCall mock 捕获实际请求参数,断言 format / quality / deviceScaleFactor 字段。

import { describe, it, expect, vi } from "vitest";
import { judgePage } from "../src/runner/judge.js";
import { resolveProfile } from "../src/runner/judge-screenshot-profile.js";

describe("judge.ts profile 透传到 vortex_screenshot 调用", () => {
  function mkMockCall() {
    const calls: Array<{ tool: string; args: any }> = [];
    const mockCall = vi.fn(async (tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === "vortex_observe") {
        return { content: [{ type: "text", text: "[]\n" }] };
      }
      if (tool === "vortex_screenshot") {
        // inline image block:extractImage 优先选 type=image 的块,不走 readFile
        return {
          content: [
            {
              type: "image",
              data: "AAAA",
              mimeType: args.format === "png" ? "image/png" : "image/jpeg",
            },
          ],
        };
      }
      // vortex_navigate, vortex_wait_for 等返回空 content
      return { content: [] };
    });
    return { mockCall, calls };
  }

  it("默认 profile=q70 → vortex_screenshot 调用带 format=jpeg, quality=70, 无 deviceScaleFactor", async () => {
    const { mockCall, calls } = mkMockCall();
    await judgePage(
      { page: "test", synthPath: "/test.html" },
      {
        playgroundUrl: "http://localhost:5173",
        model: "doubao",
        screenshotProfile: resolveProfile("q70"),
        mcpCall: mockCall,
      },
    );
    const sc = calls.find((c) => c.tool === "vortex_screenshot")!;
    expect(sc).toBeDefined();
    expect(sc.args.format).toBe("jpeg");
    expect(sc.args.quality).toBe(70);
    expect(sc.args.deviceScaleFactor).toBeUndefined();
  });

  it("profile=q85 → quality=85, 无 dpr", async () => {
    const { mockCall, calls } = mkMockCall();
    await judgePage(
      { page: "test", synthPath: "/test.html" },
      {
        playgroundUrl: "http://localhost:5173",
        model: "doubao",
        screenshotProfile: resolveProfile("q85"),
        mcpCall: mockCall,
      },
    );
    const sc = calls.find((c) => c.tool === "vortex_screenshot")!;
    expect(sc.args.quality).toBe(85);
    expect(sc.args.deviceScaleFactor).toBeUndefined();
  });

  it("profile=q85+dpr2 → deviceScaleFactor=2", async () => {
    const { mockCall, calls } = mkMockCall();
    await judgePage(
      { page: "test", synthPath: "/test.html" },
      {
        playgroundUrl: "http://localhost:5173",
        model: "doubao",
        screenshotProfile: resolveProfile("q85+dpr2"),
        mcpCall: mockCall,
      },
    );
    const sc = calls.find((c) => c.tool === "vortex_screenshot")!;
    expect(sc.args.deviceScaleFactor).toBe(2);
    expect(sc.args.quality).toBe(85);
  });

  it("profile=q85+dpr2+png → format=png, 无 quality, dpr=2", async () => {
    const { mockCall, calls } = mkMockCall();
    await judgePage(
      { page: "test", synthPath: "/test.html" },
      {
        playgroundUrl: "http://localhost:5173",
        model: "doubao",
        screenshotProfile: resolveProfile("q85+dpr2+png"),
        mcpCall: mockCall,
      },
    );
    const sc = calls.find((c) => c.tool === "vortex_screenshot")!;
    expect(sc.args.format).toBe("png");
    expect(sc.args.quality).toBeUndefined();
    expect(sc.args.deviceScaleFactor).toBe(2);
  });

  it("profile.name 写进 JudgePageResult.profile 字段", async () => {
    const { mockCall } = mkMockCall();
    const result = await judgePage(
      { page: "test", synthPath: "/test.html" },
      {
        playgroundUrl: "http://localhost:5173",
        model: "doubao",
        screenshotProfile: resolveProfile("q85+dpr2"),
        mcpCall: mockCall,
      },
    );
    expect(result.profile?.name).toBe("q85+dpr2");
    expect(result.profile?.format).toBe("jpeg");
    expect(result.profile?.quality).toBe(85);
    expect(result.profile?.deviceScaleFactor).toBe(2);
  });
});
