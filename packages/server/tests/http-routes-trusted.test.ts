import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/trusted-mode.js", () => ({ detectTrustedMode: vi.fn() }));
vi.mock("../src/relauncher.js", () => ({ relaunchTrusted: vi.fn() }));

import { detectTrustedMode } from "../src/trusted-mode.js";
import { relaunchTrusted } from "../src/relauncher.js";
import { trustedModeHandler, relaunchHandler } from "../src/http-routes.js";

function mkRes() {
  const res = { status: vi.fn(), json: vi.fn() } as Record<string, ReturnType<typeof vi.fn>>;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("http-routes trusted endpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /trusted-mode 回 detectTrustedMode 结果", () => {
    vi.mocked(detectTrustedMode).mockReturnValue(true);
    const res = mkRes();
    trustedModeHandler({} as never, res as never);
    expect(res.json).toHaveBeenCalledWith({ trustedMode: true });
  });

  it("POST /relaunch-trusted 调 relaunchTrusted 并回 ok", () => {
    const res = mkRes();
    relaunchHandler({} as never, res as never);
    expect(relaunchTrusted).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
