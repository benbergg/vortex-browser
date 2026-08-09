import { describe, expect, it } from "vitest";
import { detectBrowserLabel } from "../src/lib/browser-label.js";

const CHROME_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
const EDGE_UA = `${CHROME_UA} Edg/140.0.0.0`;

describe("detectBrowserLabel", () => {
  it("takes the first real brand from userAgentData", () => {
    const label = detectBrowserLabel({
      brands: [
        { brand: "Not_A Brand", version: "24" },
        { brand: "Chromium", version: "140" },
        { brand: "Microsoft Edge", version: "140" },
      ],
      userAgent: EDGE_UA,
    });
    expect(label).toBe("Microsoft Edge");
  });

  it("keeps Google Chrome when it is the only real brand", () => {
    const label = detectBrowserLabel({
      brands: [
        { brand: "Chromium", version: "140" },
        { brand: "Google Chrome", version: "140" },
        { brand: "Not?A_Brand", version: "24" },
      ],
      userAgent: CHROME_UA,
    });
    expect(label).toBe("Google Chrome");
  });

  it("falls back to the user agent when brands are absent", () => {
    expect(detectBrowserLabel({ userAgent: EDGE_UA })).toBe("Microsoft Edge");
    expect(detectBrowserLabel({ userAgent: CHROME_UA })).toBe("Google Chrome");
  });

  it("falls back to Chromium when nothing is recognizable", () => {
    expect(detectBrowserLabel({ brands: [{ brand: "Chromium" }], userAgent: "Mozilla/5.0" }))
      .toBe("Chromium");
  });
});
