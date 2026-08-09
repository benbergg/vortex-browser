import { describe, expect, it } from "vitest";
import { noBrowserMessage } from "../src/browser-match.js";
import { browserMap, makeBrowser } from "./browser-fixture.js";

describe("noBrowserMessage", () => {
  it("lists online browsers when the preference misses", () => {
    const edge = makeBrowser("uuid-edge", { label: "Microsoft Edge" });
    expect(noBrowserMessage("chrome", browserMap(edge)))
      .toBe('No browser matching "chrome"; online: Microsoft Edge');
  });

  it("says nothing is connected when the preference misses an empty hub", () => {
    expect(noBrowserMessage("chrome", browserMap()))
      .toBe('No browser matching "chrome"; no browser is connected to the hub');
  });

  it("omits the preference clause when none is set", () => {
    expect(noBrowserMessage(null, browserMap()))
      .toBe("No browser is connected to the hub");
  });

  // online 只算 NM 在线的，grace 期里断流的不列出来误导用户
  it("skips browsers whose native messaging dropped", () => {
    const sleeping = makeBrowser("uuid-edge", { label: "Microsoft Edge", nmConnected: false });
    expect(noBrowserMessage("chrome", browserMap(sleeping)))
      .toBe('No browser matching "chrome"; no browser is connected to the hub');
  });

  it("de-duplicates identical labels", () => {
    const a = makeBrowser("uuid-a", { label: "Google Chrome" });
    const b = makeBrowser("uuid-b", { label: "Google Chrome" });
    expect(noBrowserMessage("edge", browserMap(a, b)))
      .toBe('No browser matching "edge"; online: Google Chrome');
  });
});
