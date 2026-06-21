import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveTargetFrames } from "../src/handlers/observe.js";

/**
 * Regression coverage for https://github.com/benbergg/vortex/issues/15 #1
 *
 * `all-same-origin` previously filtered frames by
 * `safeOrigin(frame.url) === mainOrigin`. For a `<iframe srcdoc>` the
 * URL is `about:srcdoc` → `new URL().origin === "null"`, so the
 * comparison failed and the srcdoc body was silently excluded from the
 * frame set. The fix walks the parent chain past opaque (`"null"`)
 * origins to the first concrete one — matching the HTML spec which
 * says srcdoc inherits its parent document's origin (recursively).
 */
describe("resolveTargetFrames — srcdoc inheritance (issue #15-1)", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      webNavigation: {
        getAllFrames: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFrames(frames: { frameId: number; parentFrameId: number; url: string }[]): void {
    (chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>).mockResolvedValue(frames);
  }

  it("all-same-origin includes a direct srcdoc child of the main frame", async () => {
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/page" },
      { frameId: 1, parentFrameId: 0, url: "about:srcdoc" },
      { frameId: 2, parentFrameId: 0, url: "https://other.com/widget" }, // cross-origin
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-same-origin");
    const ids = out.map((f) => f.frameId).sort();
    expect(ids).toEqual([0, 1]);
  });

  it("all-same-origin includes a srcdoc nested inside a srcdoc", async () => {
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
      { frameId: 1, parentFrameId: 0, url: "about:srcdoc" },
      { frameId: 2, parentFrameId: 1, url: "about:srcdoc" }, // nested srcdoc inside srcdoc
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-same-origin");
    expect(out.map((f) => f.frameId).sort()).toEqual([0, 1, 2]);
  });

  it("all-same-origin excludes srcdoc whose ancestor chain ends on cross-origin", async () => {
    // Cross-origin iframe contains a srcdoc — the srcdoc inherits the
    // cross-origin parent's origin, NOT the main page's, so it stays out.
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
      { frameId: 1, parentFrameId: 0, url: "https://other.com/widget" },
      { frameId: 2, parentFrameId: 1, url: "about:srcdoc" },
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-same-origin");
    expect(out.map((f) => f.frameId).sort()).toEqual([0]);
  });

  it("all-same-origin with no main frame degrades gracefully", async () => {
    mockFrames([
      { frameId: 5, parentFrameId: -1, url: "https://orphan.com/" },
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-same-origin");
    expect(out).toEqual([]);
  });

  it("explicit frameId still narrows to just that frame", async () => {
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
      { frameId: 1, parentFrameId: 0, url: "about:srcdoc" },
    ]);
    const out = await resolveTargetFrames(99, 1, "all-same-origin");
    expect(out).toEqual([{ frameId: 1, url: "about:srcdoc", parentFrameId: 0 }]);
  });

});

/**
 * all-permitted 之前按 raw frame.url 判权限(isFrameInPermissions),about:srcdoc 的
 * protocol 是 "about:" 直接被拒,导致 all-permitted **不是** all-same-origin 的超集——
 * 同源 srcdoc 编辑器(TinyMCE 把 contenteditable 体放在 about:srcdoc iframe)被漏扫。
 * 修复:对 about:srcdoc 子框按 HTML spec 继承父源(inheritedOrigin)判权限,与
 * all-same-origin 的 srcdoc 处理对齐(2026-06-22 tiny.cloud TinyMCE dogfood)。
 */
describe("resolveTargetFrames — all-permitted srcdoc inheritance (TinyMCE 富文本编辑器)", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      webNavigation: { getAllFrames: vi.fn() },
      runtime: { getManifest: () => ({ host_permissions: ["<all_urls>"] }) },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function mockFrames(frames: { frameId: number; parentFrameId: number; url: string }[]): void {
    (chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>).mockResolvedValue(frames);
  }

  it("all-permitted includes a srcdoc child of the main frame (inherited origin permitted)", async () => {
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
      { frameId: 1, parentFrameId: 0, url: "about:srcdoc" },
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-permitted");
    expect(out.map((f) => f.frameId).sort()).toEqual([0, 1]);
  });

  it("all-permitted includes a srcdoc nested inside a srcdoc (recursive inheritance)", async () => {
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
      { frameId: 1, parentFrameId: 0, url: "about:srcdoc" },
      { frameId: 2, parentFrameId: 1, url: "about:srcdoc" },
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-permitted");
    expect(out.map((f) => f.frameId).sort()).toEqual([0, 1, 2]);
  });

  it("all-permitted excludes srcdoc whose inherited origin is not in host_permissions", async () => {
    (chrome.runtime.getManifest as ReturnType<typeof vi.fn>) = (() => ({
      host_permissions: ["https://example.com/*"],
    })) as unknown as ReturnType<typeof vi.fn>;
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
      { frameId: 1, parentFrameId: 0, url: "https://other.com/widget" },
      { frameId: 2, parentFrameId: 1, url: "about:srcdoc" }, // inherits other.com (blocked)
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-permitted");
    const ids = out.map((f) => f.frameId).sort();
    expect(ids).toContain(0);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
  });

  it("all-permitted still skips about:blank (deliberate contract, not intentional content)", async () => {
    mockFrames([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
      { frameId: 1, parentFrameId: 0, url: "about:blank" },
    ]);
    const out = await resolveTargetFrames(99, undefined, "all-permitted");
    expect(out.map((f) => f.frameId).sort()).toEqual([0]);
  });
});
