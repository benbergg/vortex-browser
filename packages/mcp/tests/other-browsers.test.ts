import { describe, expect, it } from "vitest";
import { pickOtherBrowsers } from "../src/lib/other-browsers.js";

const health = {
  browsers: [
    { label: "Google Chrome", browserId: "uuid-chrome", nmConnected: true },
    { label: "Microsoft Edge", browserId: "uuid-edge", nmConnected: true },
  ],
};

describe("pickOtherBrowsers", () => {
  it("剔除当前绑定的浏览器", () => {
    expect(pickOtherBrowsers(health, "uuid-edge")).toEqual(["Google Chrome"]);
  });

  it("单浏览器时返回空数组", () => {
    expect(pickOtherBrowsers({ browsers: [health.browsers[0]] }, "uuid-chrome")).toEqual([]);
  });

  it("跳过 nmConnected 为 false 的", () => {
    const sleeping = { browsers: [health.browsers[0], { ...health.browsers[1], nmConnected: false }] };
    expect(pickOtherBrowsers(sleeping, "uuid-chrome")).toEqual([]);
  });

  it("同 label 多实例去重", () => {
    const twin = { browsers: [
      { label: "Google Chrome", browserId: "uuid-a", nmConnected: true },
      { label: "Google Chrome", browserId: "uuid-b", nmConnected: true },
    ] };
    expect(pickOtherBrowsers(twin, "uuid-a")).toEqual(["Google Chrome"]);
  });

  it("health 缺字段时不炸", () => {
    expect(pickOtherBrowsers({}, "uuid-a")).toEqual([]);
  });
});
