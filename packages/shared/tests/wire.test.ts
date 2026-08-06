import { describe, expect, it } from "vitest";
import { classifyFromAgent, classifyFromClient, isLegacyRequest } from "../src/wire.js";

describe("classifyFromClient", () => {
  it("classifies an MCP hello", () => {
    const frame = { type: "hello", wireVersion: 2, role: "mcp" };
    expect(classifyFromClient(frame)).toBe(frame);
  });

  it("classifies a CLI hello", () => {
    const frame = { type: "hello", wireVersion: 2, role: "cli" };
    expect(classifyFromClient(frame)).toBe(frame);
  });

  it("classifies a heartbeat", () => {
    const frame = { type: "heartbeat", timestamp: 123 };
    expect(classifyFromClient(frame)).toBe(frame);
  });

  it("classifies a typed request", () => {
    const frame = { type: "request", action: "page.navigate", id: "mcp-1-123" };
    expect(classifyFromClient(frame)).toBe(frame);
  });

  it("classifies a legacy request without type", () => {
    const frame = { action: "page.navigate", id: "mcp-1-123" };
    expect(classifyFromClient(frame)).toBe(frame);
  });

  it("rejects an agent result from the client direction", () => {
    expect(classifyFromClient({ type: "agent-result", id: "agent-1" })).toBeNull();
  });

  it("rejects client-invalid legacy request shapes", () => {
    expect(classifyFromClient({ action: 123, id: "x" })).toBeNull();
    expect(classifyFromClient({ action: "x" })).toBeNull();
  });

  it.each([null, [], "request", {}])("rejects non-frame input %#", (raw) => {
    expect(classifyFromClient(raw)).toBeNull();
  });

  it("rejects unknown and outbound frame types", () => {
    expect(classifyFromClient({ type: "unknown" })).toBeNull();
    expect(classifyFromClient({ type: "welcome", wireVersion: 2, hubVersion: "1" })).toBeNull();
    expect(classifyFromClient({ type: "notice", notice: "browser-lost" })).toBeNull();
  });
});

describe("classifyFromAgent", () => {
  it("classifies a browser-agent hello", () => {
    const frame = { type: "hello", wireVersion: 2, role: "browser-agent", browserId: "browser-1" };
    expect(classifyFromAgent(frame)).toBe(frame);
  });

  it("classifies a heartbeat", () => {
    const frame = { type: "heartbeat", timestamp: 123, nmConnected: true };
    expect(classifyFromAgent(frame)).toBe(frame);
  });

  it("classifies a typed response", () => {
    const frame = { type: "response", action: "page.navigate", id: "hub-1", result: {} };
    expect(classifyFromAgent(frame)).toBe(frame);
  });

  it("classifies a typed event", () => {
    const frame = { type: "event", event: "page.navigated", data: {}, timestamp: 123 };
    expect(classifyFromAgent(frame)).toBe(frame);
  });

  it("classifies an agent result", () => {
    const frame = { type: "agent-result", id: "agent-1", result: true };
    expect(classifyFromAgent(frame)).toBe(frame);
  });

  it("rejects an MCP hello from the agent direction", () => {
    expect(classifyFromAgent({ type: "hello", wireVersion: 2, role: "mcp" })).toBeNull();
  });

  it("rejects a request from the agent direction", () => {
    expect(classifyFromAgent({ type: "request", action: "page.navigate", id: "mcp-1" })).toBeNull();
  });

  it.each([null, [], "event", {}, { type: "unknown" }])("rejects non-agent input %#", (raw) => {
    expect(classifyFromAgent(raw)).toBeNull();
  });
});

describe("isLegacyRequest", () => {
  it("accepts string action and id without type", () => {
    expect(isLegacyRequest({ action: "page.navigate", id: "mcp-1-123" })).toBe(true);
  });

  it("rejects typed and incomplete requests", () => {
    expect(isLegacyRequest({ type: "request", action: "page.navigate", id: "mcp-1-123" })).toBe(false);
    expect(isLegacyRequest({ action: 123, id: "x" })).toBe(false);
    expect(isLegacyRequest({ action: "x" })).toBe(false);
  });
});
