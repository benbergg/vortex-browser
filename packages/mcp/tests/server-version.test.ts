import { describe, it, expect } from "vitest";
import { SERVER_INFO, MCP_VERSION } from "../src/server.js";

// 2.0.0 曾把 serverInfo.version 写死成 "0.1.0"，MCP 客户端看到的版本长期错误
describe("MCP serverInfo 版本", () => {
  it("与运行时读取的包版本同源，不得写死", () => {
    expect(SERVER_INFO.version).toBe(MCP_VERSION);
  });

  it("名字保持 vortex", () => {
    expect(SERVER_INFO.name).toBe("vortex");
  });
});
