import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";

vi.mock("../src/ext-dist.js", () => ({
  resolveExtensionDist: vi.fn(() => "/fake/ext/dist"),
  readBuildStamp: vi.fn(() => "abc123"),
}));

import { resolveExtensionDist, readBuildStamp } from "../src/ext-dist.js";
import { devReloadHandler } from "../src/http-routes.js";

function mkRes() {
  const res = { status: vi.fn(), json: vi.fn() } as Record<string, ReturnType<typeof vi.fn>>;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function mkRouter(connected: boolean) {
  return {
    isNmConnected: vi.fn(() => connected),
    pushReloadExtension: vi.fn(() => connected),
  };
}

describe("POST /dev/reload-extension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SW 在线:触发 reload 并回 targetStamp(本 server 服务的 dist 构建戳)", () => {
    const router = mkRouter(true);
    const res = mkRes();
    devReloadHandler(router as never)({} as never, res as never);
    expect(router.pushReloadExtension).toHaveBeenCalledWith("dev_reload");
    expect(res.status).not.toHaveBeenCalled(); // 默认 200
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, triggered: true, targetStamp: "abc123" }),
    );
  });

  it("SW 离线:503 EXTENSION_NOT_CONNECTED,不触发 reload", () => {
    const router = mkRouter(false);
    const res = mkRes();
    devReloadHandler(router as never)({} as never, res as never);
    expect(router.pushReloadExtension).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: VtxErrorCode.EXTENSION_NOT_CONNECTED }),
      }),
    );
  });

  it("build-stamp.txt 缺失(旧构建):targetStamp 为 null 但仍触发", () => {
    vi.mocked(readBuildStamp).mockReturnValueOnce(null);
    const router = mkRouter(true);
    const res = mkRes();
    devReloadHandler(router as never)({} as never, res as never);
    expect(resolveExtensionDist).toHaveBeenCalled();
    expect(router.pushReloadExtension).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, targetStamp: null }),
    );
  });
});
