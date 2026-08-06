/**
 * Author: qingwa
 * Description: Verifies hub tableless actions use the shared set by identity and membership.
 */
import { describe, expect, it } from "vitest";
import {
  DiagnosticsActions,
  EventsActions,
  TABLESS_ACTIONS as SHARED_TABLESS_ACTIONS,
  TabActions,
} from "@vortex-browser/shared";
import { GLOBAL_ACTIONS } from "../src/tab-ownership.js";

const EXPECTED_TABLESS_ACTIONS = [
  TabActions.LIST,
  TabActions.CREATE,
  DiagnosticsActions.VERSION,
  EventsActions.DRAIN,
] as const;

describe("hub tableless actions", () => {
  it("uses the shared set identity and contains every tableless action", () => {
    expect(GLOBAL_ACTIONS).toBe(SHARED_TABLESS_ACTIONS);
    expect(GLOBAL_ACTIONS.size).toBe(EXPECTED_TABLESS_ACTIONS.length);
    expect([...GLOBAL_ACTIONS]).toEqual(EXPECTED_TABLESS_ACTIONS);
  });
});
