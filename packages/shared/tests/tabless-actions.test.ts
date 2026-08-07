/**
 * Author: qingwa
 * Description: Verifies the shared tableless action set and its complete membership.
 */
import { describe, expect, it } from "vitest";
import {
  DiagnosticsActions,
  EventsActions,
  TABLESS_ACTIONS,
  TabActions,
} from "../src/index.js";

const EXPECTED_TABLESS_ACTIONS = [
  TabActions.LIST,
  TabActions.CREATE,
  DiagnosticsActions.VERSION,
  EventsActions.DRAIN,
] as const;

describe("shared TABLESS_ACTIONS", () => {
  it("contains every tableless action exactly once", () => {
    expect(TABLESS_ACTIONS.size).toBe(EXPECTED_TABLESS_ACTIONS.length);
    expect([...TABLESS_ACTIONS]).toEqual(EXPECTED_TABLESS_ACTIONS);
  });
});
