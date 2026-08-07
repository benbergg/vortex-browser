/**
 * Author: qingwa
 * Description: Verifies CLI session-name resolution and Commander defaults.
 */
import { describe, expect, it } from "vitest";
import { createProgram, resolveSessionName } from "../src/index.js";

describe("resolveSessionName", () => {
  it.each([
    ["explicit option", "explicit", { VORTEX_SESSION_NAME: "env", USER: "user" }, "explicit"],
    ["environment option", undefined, { VORTEX_SESSION_NAME: "env", USER: "user" }, "env"],
    ["user default", undefined, { USER: "user" }, "cli-user"],
    ["missing user fallback", undefined, {}, "cli-default"],
  ] as const)("uses the %s precedence level", (_name, explicit, env, expected) => {
    expect(resolveSessionName(explicit, env)).toBe(expected);
  });

  it("uses the resolved session as the Commander default", () => {
    const program = createProgram();

    expect(program.opts().session).toBe(resolveSessionName(undefined, process.env));
  });
});
