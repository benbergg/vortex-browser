/**
 * Author: qingwa
 * Description: Verifies strict tab routing rejects missing tab targets only when enabled.
 */
import { describe, expect, it, vi } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";

function request(tool: string, strictTab?: boolean): NmRequest {
  return {
    type: "tool_request",
    tool,
    args: {},
    requestId: `request-${tool}`,
    ...(strictTab === undefined ? {} : { strictTab }),
  };
}

describe("strict tab guard", () => {
  it("rejects a tab-scoped request without tabId and includes a diagnostic hint", async () => {
    const router = new ActionRouter();
    const handler = vi.fn(async () => ({ ok: true }));
    router.register("page.navigate", handler);

    const response = await router.dispatch(request("page.navigate", true));

    expect(response.error?.code).toBe(VtxErrorCode.TAB_NOT_FOUND);
    expect(response.error?.hint).toMatch(/strictTab|tabId/);
    expect(response.error?.context?.extras).toMatchObject({ action: "page.navigate" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps missing-tab behavior unchanged when strictTab is disabled", async () => {
    const router = new ActionRouter();
    const handler = vi.fn(async (_args: Record<string, unknown>, tabId?: number) => ({ tabId }));
    router.register("page.navigate", handler);

    const response = await router.dispatch(request("page.navigate", false));

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ tabId: undefined });
    expect(handler).toHaveBeenCalledWith({}, undefined);
  });
});
