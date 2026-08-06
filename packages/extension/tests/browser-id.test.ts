/**
 * Author: qingwa
 * Description: Verifies persistent browser identity generation and concurrent deduplication.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("browserId persistence", () => {
  beforeEach(() => vi.resetModules());

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates once and writes storage once for concurrent callers", async () => {
    let releaseGet!: (value: Record<string, unknown>) => void;
    const get = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      releaseGet = resolve;
    }));
    const set = vi.fn().mockResolvedValue(undefined);
    const randomUUID = vi.fn(() => "browser-generated");
    vi.stubGlobal("chrome", { storage: { local: { get, set } } });
    vi.stubGlobal("crypto", { randomUUID });

    const { getBrowserId } = await import("../src/lib/browser-id.js");
    const calls = [
      getBrowserId(),
      getBrowserId(),
      getBrowserId(),
      getBrowserId(),
      getBrowserId(),
    ];

    expect(get).toHaveBeenCalledTimes(1);
    releaseGet({});
    const ids = await Promise.all(calls);

    expect(ids).toEqual([
      "browser-generated",
      "browser-generated",
      "browser-generated",
      "browser-generated",
      "browser-generated",
    ]);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ vortexBrowserId: "browser-generated" });
  });
});
