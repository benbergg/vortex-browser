// I16: dispatch routing — 11 public tools 各自映射到正确的 v0.5 handler action.
// spec: vortex重构-L4-spec.md §2 + §3

import { describe, it, expect } from "vitest";
import { dispatchNewTool } from "../../src/tools/dispatch.js";

describe("I16: dispatch routing for 11 public tools", () => {
  describe("vortex_act → 6 actions", () => {
    const cases: Array<[string, string]> = [
      ["click", "dom.click"],
      ["fill", "dom.fill"],
      ["type", "dom.type"],
      ["select", "dom.select"],
      ["scroll", "dom.scroll"],
      ["hover", "dom.hover"],
    ];
    for (const [actionEnum, expectedAction] of cases) {
      it(`action=${actionEnum} → ${expectedAction}`, () => {
        const r = dispatchNewTool("vortex_act", { target: "@e0", action: actionEnum, value: "foo" });
        expect(r?.action).toBe(expectedAction);
        expect(r?.params.target).toBe("@e0");
      });
    }

    it("drag 已从 act enum 移除（v0.6.x follow-up），unknown action throws UNSUPPORTED_ACTION", () => {
      expect(() => dispatchNewTool("vortex_act", { target: "@e0", action: "drag" }))
        .toThrowError(/UNSUPPORTED_ACTION|action must be one of/);
    });

    it("unknown action throws UNSUPPORTED_ACTION", () => {
      expect(() => dispatchNewTool("vortex_act", { target: "@e0", action: "destroy" }))
        .toThrowError(/UNSUPPORTED_ACTION|action must be one of/);
    });

    it("options.timeout / options.force 透传到 params", () => {
      const r = dispatchNewTool("vortex_act", {
        target: "@e0",
        action: "click",
        options: { timeout: 8000, force: true },
      });
      expect(r?.params.timeout).toBe(8000);
      expect(r?.params.force).toBe(true);
    });
  });

  describe("vortex_observe is NOT routed via dispatchNewTool", () => {
    // Regression: an earlier draft reshape lived in dispatch.ts case
    // "vortex_observe", but server.ts intercepts the tool earlier in the
    // request handler (compact rendering + activeSnapshotId tracking live
    // there). PR #4 renamed toolDef.action to "L4.observe", which silently
    // skipped the server.ts branch and exposed activeSnapshotId tracking
    // as the v0.6 dogfood STALE_SNAPSHOT bug. Lock the contract: dispatch
    // must return null for vortex_observe so the dead code can't grow back.
    it("dispatchNewTool returns null (handled by server.ts special path)", () => {
      expect(dispatchNewTool("vortex_observe", { scope: "viewport", filter: "interactive" })).toBeNull();
      expect(dispatchNewTool("vortex_observe", { scope: "full" })).toBeNull();
      expect(dispatchNewTool("vortex_observe", { filter: "all" })).toBeNull();
    });
  });

  describe("vortex_extract → content.getText (selector / 全页 only — @ref a11y subtree v0.6.x)", () => {
    it("selector 形式（server.ts target 翻译后）→ depth + include 透传", () => {
      // server.ts 翻译普通 selector → params.selector，删 params.target
      const r = dispatchNewTool("vortex_extract", {
        selector: "#main",
        depth: 5,
        include: ["text", "value"],
      });
      expect(r?.action).toBe("content.getText");
      expect(r?.params.selector).toBe("#main");
      expect(r?.params.maxDepth).toBe(5);
      expect(r?.params.include).toEqual(["text", "value"]);
      expect(r?.params.target).toBeUndefined();
    });

    it("target=null 全页文本 → 不 set target/selector/index", () => {
      const r = dispatchNewTool("vortex_extract", { target: null });
      expect(r?.action).toBe("content.getText");
      expect(r?.params.target).toBeUndefined();
      expect(r?.params.selector).toBeUndefined();
      expect(r?.params.index).toBeUndefined();
    });

    it("@ref 形式（server.ts 翻译后 params.index）透传 → content.getText（v0.8.1 起支持，handler 反查 snapshot store）", () => {
      // server.ts 把 @e3 翻译成 { index, snapshotId }，删 params.target。
      // v0.8.1 前 dispatch 显式 throw "a11y subtree pending"；现在 snapshot
      // store 已存 selector，extension handler 通过 resolveTargetOptional
      // 反查并走与 selector 一致的 querySelector 路径（P0-6, 2026-05-21）。
      const r = dispatchNewTool("vortex_extract", { index: 3, snapshotId: "abc", depth: 2 });
      expect(r?.action).toBe("content.getText");
      expect(r?.params.index).toBe(3);
      expect(r?.params.snapshotId).toBe("abc");
      expect(r?.params.maxDepth).toBe(2);
      expect(r?.params.target).toBeUndefined();
    });
  });

  describe("vortex_wait_for → mode 分发（element / idle / info；url 移除待 page.waitForUrl 实现）", () => {
    it("mode=element + selector → page.wait + selector 字段", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "element", value: "#submit" });
      expect(r?.action).toBe("page.wait");
      expect(r?.params.selector).toBe("#submit");
    });

    it("mode=element + @ref throws INVALID_PARAMS（value 不经 server.ts target 翻译）", () => {
      expect(() => dispatchNewTool("vortex_wait_for", { mode: "element", value: "@e3" }))
        .toThrowError(/INVALID_PARAMS|@ref form not supported/);
    });

    it("mode=idle value=network → page.waitForNetworkIdle", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "idle", value: "network" });
      expect(r?.action).toBe("page.waitForNetworkIdle");
    });

    it("mode=idle value=dom → dom.waitSettled", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "idle", value: "dom" });
      expect(r?.action).toBe("dom.waitSettled");
    });

    it("mode=idle value=xhr (默认) → page.waitForXhrIdle", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "idle", value: "xhr" });
      expect(r?.action).toBe("page.waitForXhrIdle");
    });

    it("mode=info → page.info", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "info" });
      expect(r?.action).toBe("page.info");
    });

    it("mode=info defaults includeAllTabs=true so agents see sibling tabs", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "info" });
      expect(r?.params.includeAllTabs).toBe(true);
    });

    it("mode=info respects explicit includeAllTabs=false opt-out", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "info", includeAllTabs: false });
      expect(r?.params.includeAllTabs).toBe(false);
    });

    it("timeout 透传", () => {
      const r = dispatchNewTool("vortex_wait_for", { mode: "info", timeout: 12000 });
      expect(r?.params.timeout).toBe(12000);
    });

    it("非法 mode throws INVALID_PARAMS（不再静默回退 page.info）", () => {
      expect(() => dispatchNewTool("vortex_wait_for", { mode: "ready" }))
        .toThrowError(/INVALID_PARAMS|mode must be one of/);
    });

    it("mode=url 已移除（page.waitForUrl 待 v0.6.x）", () => {
      expect(() => dispatchNewTool("vortex_wait_for", { mode: "url", value: "https://x" }))
        .toThrowError(/INVALID_PARAMS|mode must be one of/);
    });
  });

  describe("vortex_debug_read → source 分发", () => {
    it("source=console → console.getLogs", () => {
      const r = dispatchNewTool("vortex_debug_read", { source: "console", filter: { level: "error" }, tail: 50 });
      expect(r?.action).toBe("console.getLogs");
      expect(r?.params.level).toBe("error");
      expect(r?.params.limit).toBe(50);
    });

    it("source=network → network.getLogs", () => {
      const r = dispatchNewTool("vortex_debug_read", { source: "network" });
      expect(r?.action).toBe("network.getLogs");
    });
  });

  describe("vortex_storage → op 分发", () => {
    const cases: Array<[string, string]> = [
      ["get", "storage.getLocalStorage"],
      ["set", "storage.setLocalStorage"],
      ["session-get", "storage.getSessionStorage"],
      ["session-set", "storage.setSessionStorage"],
      ["cookies-get", "storage.getCookies"],
    ];
    for (const [op, expectedAction] of cases) {
      it(`op=${op} → ${expectedAction}`, () => {
        const r = dispatchNewTool("vortex_storage", { op, key: "k", value: "v" });
        expect(r?.action).toBe(expectedAction);
        expect(r?.params.key).toBe("k");
      });
    }

    it("op=list 已 rename → cookies-get（避免 description 与实际不符）", () => {
      expect(() => dispatchNewTool("vortex_storage", { op: "list" }))
        .toThrowError(/INVALID_PARAMS|op must be one of/);
    });

    it("unknown op throws INVALID_PARAMS", () => {
      expect(() => dispatchNewTool("vortex_storage", { op: "unknown" }))
        .toThrowError(/INVALID_PARAMS|op must be one of/);
    });
  });

  describe("8 atom（直接路由 / 通过 toolDef.action）", () => {
    it("vortex_navigate（已有遗留 dispatch reload→page.reload）", () => {
      const r = dispatchNewTool("vortex_navigate", { url: "https://x", reload: true });
      expect(r?.action).toBe("page.reload");
    });
    it("vortex_press 走 toolDef.action=keyboard.press（schema field=key 与 handler args.key 一致，无需 reshape）", () => {
      const r = dispatchNewTool("vortex_press", { key: "Ctrl+S" });
      expect(r).toBeNull();
    });
    it("vortex_tab_create 不在 dispatch（直接用 toolDef.action=tab.create）", () => {
      const r = dispatchNewTool("vortex_tab_create", { url: "https://x" });
      expect(r).toBeNull();
    });
    it("vortex_tab_close 不在 dispatch", () => {
      const r = dispatchNewTool("vortex_tab_close", { tabId: 1 });
      expect(r).toBeNull();
    });
  });
});
