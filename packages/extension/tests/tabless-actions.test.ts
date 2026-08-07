/**
 * Author: qingwa
 * Description: Verifies extension tableless actions use the shared set by identity and membership.
 */
import { describe, expect, it } from "vitest";
import {
  DiagnosticsActions,
  EventsActions,
  TABLESS_ACTIONS as SHARED_TABLESS_ACTIONS,
  TabActions,
} from "@vortex-browser/shared";
import { TABLESS_ACTIONS as EXTENSION_TABLESS_ACTIONS } from "../src/lib/router.js";

const EXPECTED_TABLESS_ACTIONS = [
  TabActions.LIST,
  TabActions.CREATE,
  DiagnosticsActions.VERSION,
  EventsActions.DRAIN,
] as const;

describe("extension tableless actions", () => {
  it("uses the shared set identity and contains every tableless action", () => {
    expect(EXTENSION_TABLESS_ACTIONS).toBe(SHARED_TABLESS_ACTIONS);
    expect(EXTENSION_TABLESS_ACTIONS.size).toBe(EXPECTED_TABLESS_ACTIONS.length);
    expect([...EXTENSION_TABLESS_ACTIONS]).toEqual(EXPECTED_TABLESS_ACTIONS);
  });
});
