// Pin failureClass mapping so the four-bucket promise on CaseMetrics
// (assertion / env / tool_error / timeout, plus unknown fallback) stays
// stable as the runner evolves. Reporter / CI logic now branches on this
// field — silent drift would re-hide the env_failure vs regression
// distinction that the field was introduced to surface.

import { describe, it, expect } from "vitest";
import { classifyFailure, AssertionError } from "../src/runner/run-case.js";

describe("classifyFailure", () => {
  it("AssertionError instance → assertion_failure", () => {
    expect(classifyFailure(new AssertionError("result should contain X"))).toBe("assertion_failure");
  });

  it("PERMISSION_DENIED → env_failure", () => {
    expect(classifyFailure(new Error(
      `Error [PERMISSION_DENIED]: Cannot access contents of url "chrome-extension://abc/". Extension manifest must request permission to access this host.`,
    ))).toBe("env_failure");
  });

  it("EXTENSION_NOT_CONNECTED → env_failure", () => {
    expect(classifyFailure(new Error("Error [EXTENSION_NOT_CONNECTED]: Extension is not connected"))).toBe("env_failure");
  });

  it("vortex-server unreachable → env_failure", () => {
    expect(classifyFailure(new Error("vortex-server unreachable at localhost:6800."))).toBe("env_failure");
  });

  it("Failed to connect to vortex-server → env_failure", () => {
    expect(classifyFailure(new Error("Failed to connect to vortex-server at localhost:6800 (timeout)"))).toBe("env_failure");
  });

  it("ECONNREFUSED → env_failure", () => {
    expect(classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1:6800"))).toBe("env_failure");
  });

  it("timed out → timeout", () => {
    expect(classifyFailure(new Error("Timeout: no response for vortex_act after 30000ms"))).toBe("timeout");
  });

  it("TIMEOUT error code → timeout (env patterns don't shadow)", () => {
    expect(classifyFailure(new Error("Error [TIMEOUT]: Request vortex_observe timed out after 30000ms"))).toBe("timeout");
  });

  it("STALE_SNAPSHOT vortex error → tool_error", () => {
    expect(classifyFailure(new Error("Error [STALE_SNAPSHOT]: Page has changed since the snapshot. Call vortex_observe..."))).toBe("tool_error");
  });

  it("INVALID_PARAMS vortex error → tool_error", () => {
    expect(classifyFailure(new Error("Error [INVALID_PARAMS]: target is required"))).toBe("tool_error");
  });

  it("unknown shape → unknown", () => {
    expect(classifyFailure(new Error("something exploded in case fixture"))).toBe("unknown");
    expect(classifyFailure("plain string")).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
  });

  it("assertion priority dominates env-like text inside assertion message", () => {
    // a case author could legitimately assert *against* an env error string,
    // so AssertionError must win even if the message mentions PERMISSION_DENIED.
    expect(classifyFailure(new AssertionError("expected snapshot to not say PERMISSION_DENIED"))).toBe("assertion_failure");
  });
});
