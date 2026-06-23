import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { COMMIT_DRIVERS, findDriver } from "../src/patterns/index.js";

// PR #2 (commit 0e62721) split commit drivers into two execution paths:
// daterange / datetimerange / cascader / time go through dedicated CDP helpers,
// while checkbox-group / select load a page-side bundle and then dispatch via
// nativePageQuery. The legacy executeScript-shape contract tests below now
// target the bundle path (via kind="checkbox-group"); stub the loader so the
// only executeScript call we observe is the page-query one we assert on.
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

function makeDebuggerMock() {
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    isAttached: vi.fn().mockReturnValue(true),
    enableDomain: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("commit-drivers registry", () => {
  it("has datetime-range + date-range drivers for Element Plus", () => {
    const ids = COMMIT_DRIVERS.map((d) => d.id);
    expect(ids).toContain("element-plus-datetimerange");
    expect(ids).toContain("element-plus-daterange");
  });

  it("findDriver(kind) returns first matching driver", () => {
    const d = findDriver("datetimerange");
    expect(d?.id).toBe("element-plus-datetimerange");
  });

  it("findDriver unknown kind returns undefined", () => {
    // `cascader` / `select` were unregistered when this test was written; PR #2
    // (commit 1de81e6) added them to COMMIT_DRIVERS. Use kinds that remain
    // unregistered to keep the contract assertion meaningful.
    expect(findDriver("radio-group")).toBeUndefined();
    expect(findDriver("slider")).toBeUndefined();
  });

  it("every driver has id/kind/closestSelector/summary", () => {
    for (const d of COMMIT_DRIVERS) {
      expect(d.id).toBeTruthy();
      expect(d.kind).toBeTruthy();
      expect(d.closestSelector).toBeTruthy();
      expect(d.summary.length).toBeGreaterThan(10);
    }
  });
});

describe("dom.commit handler (@since 0.4.0)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: { executeScript },
    });
    registerDomHandlers(router, makeDebuggerMock());
  });

  it("returns INVALID_PARAMS when kind missing", async () => {
    const resp = await router.dispatch(
      mkReq(
        "dom.commit",
        { value: { start: "2026-01-01", end: "2026-03-31" }, selector: ".el-date-editor" },
        42,
      ),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(resp.error?.message).toContain("kind");
  });

  it("returns INVALID_PARAMS when value missing", async () => {
    const resp = await router.dispatch(
      mkReq("dom.commit", { kind: "datetimerange", selector: ".el-date-editor" }, 42),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(resp.error?.message).toContain("value");
  });

  it("returns INVALID_PARAMS when kind has no driver", async () => {
    const resp = await router.dispatch(
      mkReq(
        "dom.commit",
        {
          kind: "radio-group",
          value: "option-a",
          selector: ".el-radio-group",
        },
        42,
      ),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(resp.error?.message).toContain("No commit driver");
  });

  it("passes selector + closestSelector + ariaClosest + value + timeout + driverId into executeScript args", async () => {
    executeScript.mockResolvedValue([
      {
        result: {
          result: {
            success: true,
            driver: "element-plus-checkbox-group",
            checkedAfter: ["a", "b"],
          },
        },
      },
    ]);
    const resp = await router.dispatch(
      mkReq(
        "dom.commit",
        {
          kind: "checkbox-group",
          value: ["a", "b"],
          selector: ".roles",
          timeout: 5000,
        },
        42,
      ),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({
      success: true,
      driver: "element-plus-checkbox-group",
    });
    const call = executeScript.mock.calls[0][0];
    expect(call.args[0]).toBe(".roles");                       // selector
    expect(call.args[1]).toBe(".el-checkbox-group");           // closestSelector
    // args[2] 是 kind="select" 二段路由用的 aria closestSelector(DEF-006),
    // checkbox-group 不读它但所有 commit 注入统一携带,故 value 后移到 args[3]。
    expect(call.args[2]).toMatch(/role="combobox"/);           // ariaClosest
    expect(call.args[3]).toEqual(["a", "b"]);                  // value
    expect(call.args[4]).toBe(5000);                           // timeoutMs
    expect(call.args[5]).toBe("element-plus-checkbox-group");  // driverId
  });

  it("maps page-side COMMIT_FAILED result to COMMIT_FAILED error with stage in context", async () => {
    executeScript.mockResolvedValue([
      {
        result: {
          error: "Toggle did not converge",
          errorCode: "COMMIT_FAILED",
          stage: "toggle",
        },
      },
    ]);
    const resp = await router.dispatch(
      mkReq(
        "dom.commit",
        {
          kind: "checkbox-group",
          value: ["a", "b"],
          selector: ".roles",
        },
        42,
      ),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.COMMIT_FAILED);
    expect(resp.error?.context?.extras).toMatchObject({
      driverId: "element-plus-checkbox-group",
      stage: "toggle",
    });
  });

  it("maps page-side UNSUPPORTED_TARGET (closest mismatch) to UNSUPPORTED_TARGET", async () => {
    executeScript.mockResolvedValue([
      {
        result: {
          error: 'Target does not match driver closestSelector ".el-checkbox-group"',
          errorCode: "UNSUPPORTED_TARGET",
          extras: { driverId: "element-plus-checkbox-group" },
        },
      },
    ]);
    const resp = await router.dispatch(
      mkReq(
        "dom.commit",
        {
          kind: "checkbox-group",
          value: ["a"],
          selector: "button.unrelated",
        },
        42,
      ),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.UNSUPPORTED_TARGET);
  });

  it("maps ELEMENT_NOT_FOUND correctly", async () => {
    executeScript.mockResolvedValue([
      {
        result: {
          error: "Element not found: .missing",
          errorCode: "ELEMENT_NOT_FOUND",
        },
      },
    ]);
    const resp = await router.dispatch(
      mkReq(
        "dom.commit",
        {
          kind: "checkbox-group",
          value: ["a"],
          selector: ".missing",
        },
        42,
      ),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.ELEMENT_NOT_FOUND);
  });
});
