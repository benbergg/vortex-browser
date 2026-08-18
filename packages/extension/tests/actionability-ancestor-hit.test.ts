/**
 * Author: qingwa
 * Description: 门在「中心点命中目标的非交互祖先」时必须判 OBSCURED。
 *   2026-08-15 spike:三种祖先命中场景在 realMouse 下全部 success:true 而页面零 click。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function probeWith(html: string, targetId: string, hitId: string | null) {
  vi.resetModules();
  const dom = setupActionabilityEnv({ html });
  const doc = dom.window.document;
  const target = doc.getElementById(targetId)!;
  // 非 0×0 rect,否则 isVisible 先拦 NOT_VISIBLE 而测不到 receivesEvents。
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    (el as any).getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
  }
  const hit = hitId ? doc.getElementById(hitId) : null;
  Object.defineProperty(doc, "elementFromPoint", { value: () => hit, configurable: true });
  await import("../src/page-side/actionability.js");
  const probe = (globalThis.window as any).__vortexActionability.probe;
  return probe("#" + targetId, false);
}

describe("actionability 祖先命中", () => {
  it("非交互祖先命中 → OBSCURED 且点名祖先", async () => {
    const r = await probeWith(`<div id="wrap" class="row"><button id="b">x</button></div>`, "b", "wrap");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("OBSCURED");
    expect(r.extras.blocker).toBe("div#wrap.row");
    expect(r.extras.hitKind).toBe("ancestor");
  });

  it("交互祖先命中 → 维持放行（回归保护）", async () => {
    const r = await probeWith(`<button id="b"><span id="s">x</span></button>`, "s", "b");
    expect(r.ok).toBe(true);
  });

  it("命中自己 → 放行（回归保护）", async () => {
    const r = await probeWith(`<button id="b">x</button>`, "b", "b");
    expect(r.ok).toBe(true);
  });

  it("兄弟覆盖层 → OBSCURED 且 kind=overlay（回归保护）", async () => {
    const r = await probeWith(`<button id="b">x</button><div id="ov">m</div>`, "b", "ov");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("OBSCURED");
    expect(r.extras.blocker).toBe("div#ov");
    expect(r.extras.hitKind).toBe("overlay");
  });
});
