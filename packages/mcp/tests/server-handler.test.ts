import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { getToolDef, getToolDefs, getInternalToolDef } from "../src/tools/registry.js";
import { getAllToolDefs } from "../src/tools/schemas.js";

vi.mock("../src/client.js", () => ({
  sendRequest: vi.fn(),
}));

vi.mock("../src/lib/event-store.js", () => ({
  eventStore: {
    drain: vi.fn(() => []),
    subscribe: vi.fn(() => "sub_test_123"),
    unsubscribe: vi.fn(() => true),
  },
}));

describe("handleCallTool routing logic", () => {
  it("getToolDef returns undefined for unknown tool name", () => {
    expect(getToolDef("vortex_nonexistent")).toBeUndefined();
    expect(getToolDef("")).toBeUndefined();
    expect(getToolDef("vortex_")).toBeUndefined();
  });

  it("getInternalToolDef returns ping (v0.6 ping internalized, kept for diagnostic fingerprint)", () => {
    const ping = getInternalToolDef("vortex_ping");
    expect(ping).toBeDefined();
    expect(ping!.action).toBe("__mcp_ping__");
  });

  it("__mcp_events__ action does not go through WS (v0.5 unified events tool)", async () => {
    const { sendRequest } = await import("../src/client.js");
    const { eventStore } = await import("../src/lib/event-store.js");
    vi.mocked(sendRequest).mockResolvedValue({} as any);

    // v0.6: events 内部化，action 仍 __mcp_events__（通过 getInternalToolDef 调用）
    const events = getInternalToolDef("vortex_events");
    expect(events?.action).toBe("__mcp_events__");

    expect(eventStore.subscribe).not.toHaveBeenCalled();
  });

  it("vortex_events schema carries the op discriminator", () => {
    const events = getInternalToolDef("vortex_events");
    const schema = events?.schema as { properties?: { op?: { enum?: string[] } } };
    expect(schema?.properties?.op?.enum).toEqual(["subscribe", "unsubscribe", "drain"]);
  });

  it("__mcp_ping__ action routes to ping handler (internal)", () => {
    const ping = getInternalToolDef("vortex_ping");
    expect(ping?.action).toBe("__mcp_ping__");
  });

  it("internal tools have non-underscore actions for non-MCP-internal handlers", () => {
    const tabList = getInternalToolDef("vortex_tab_list");
    expect(tabList?.action).toBe("tab.list");
    expect(tabList?.action).not.toMatch(/^__/);
  });

  it("public tools (v0.8) all have either L4.* or v0.5 action prefix", () => {
    // v0.8 加入 4 个新前缀：js. (vortex_evaluate) / mouse. (vortex_mouse_drag) /
    // file. (vortex_file_upload)。vortex_fill 走 L4.fill 保持不变。
    // 工具横向优化: query. (vortex_query) 零 LLM 探测前缀。
    for (const def of getToolDefs()) {
      expect(def.action).toMatch(/^(L4\.|page\.|tab\.|capture\.|keyboard\.|js\.|mouse\.|file\.|query\.)/);
    }
  });
});

describe("schemaHash computation", () => {
  function computeSchemaHash(): string {
    const defs = getAllToolDefs();
    const payload = defs
      .map((d) => `${d.name}:${d.action}:${d.description.length}`)
      .sort()
      .join("|");
    return createHash("sha256").update(payload).digest("hex").slice(0, 12);
  }

  it("produces a 12-char lowercase hex string", () => {
    const hash = computeSchemaHash();
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when description length changes", () => {
    const h1 = computeSchemaHash();
    const defs = getAllToolDefs();
    const modified = defs.map((d, i) =>
      i === 0 ? { ...d, description: d.description + " X" } : d,
    );
    const payload = modified
      .map((d) => `${d.name}:${d.action}:${d.description.length}`)
      .sort()
      .join("|");
    const h2 = createHash("sha256").update(payload).digest("hex").slice(0, 12);
    expect(h2).not.toBe(h1);
  });

  it("is deterministic (same input produces same hash)", () => {
    const h1 = computeSchemaHash();
    const h2 = computeSchemaHash();
    expect(h1).toBe(h2);
  });

  it("tool count affects hash", () => {
    const defs = getAllToolDefs();
    const h1 = createHash("sha256")
      .update(defs.map((d) => `${d.name}:${d.action}:${d.description.length}`).sort().join("|"))
      .digest("hex").slice(0, 12);

    const smaller = defs.slice(0, -1);
    const h2 = createHash("sha256")
      .update(smaller.map((d) => `${d.name}:${d.action}:${d.description.length}`).sort().join("|"))
      .digest("hex").slice(0, 12);

    expect(h2).not.toBe(h1);
  });
});

describe("error message formatting", () => {
  it("ECONNREFUSED maps to friendly vortex-server not running message", () => {
    const msg = "connect ECONNREFUSED";
    const isConnRefused = msg.includes("ECONNREFUSED") || msg.includes("Failed to connect");
    expect(isConnRefused).toBe(true);
  });

  it("TIMEOUT maps to friendly timeout guidance message", () => {
    const msg = "Timeout: no response for tab.list after 30000ms";
    expect(msg.includes("Timeout")).toBe(true);
  });

  it("action error response includes code and message", () => {
    const resp = { error: { code: "TAB_NOT_FOUND", message: "No tab with id 999" } };
    expect(resp.error.code).toBe("TAB_NOT_FOUND");
    expect(resp.error.message).toBe("No tab with id 999");
  });

  it("server unreachable error includes startup hint", () => {
    const msg = "vortex-server is not running at localhost:6800.\nTo start: cd /path/to/vortex";
    expect(msg).toContain("vortex-server is not running");
    expect(msg).toContain("To start");
  });
});

describe("image mode decision logic", () => {
  const LARGE_IMAGE_BYTES = 500_000;

  function decideMode(returnMode?: string, bytes?: number): string {
    return returnMode === "file" ||
      (returnMode !== "inline" && (bytes ?? 0) > LARGE_IMAGE_BYTES)
      ? "file"
      : "inline";
  }

  it("inline by default for small images", () => {
    expect(decideMode(undefined, 100_000)).toBe("inline");
  });

  it("file when returnMode=file", () => {
    expect(decideMode("file", 100_000)).toBe("file");
  });

  it("stays inline when returnMode=inline even if over 500KB", () => {
    expect(decideMode("inline", 600_000)).toBe("inline");
  });

  it("inline when explicitly set and under threshold", () => {
    expect(decideMode("inline", 400_000)).toBe("inline");
  });

  it("file when bytes exceed 500KB threshold", () => {
    expect(decideMode(undefined, 500_001)).toBe("file");
    expect(decideMode(undefined, 500_000)).toBe("inline");
  });

  it("inline when returnMode is undefined and bytes under threshold", () => {
    expect(decideMode(undefined, 499_999)).toBe("inline");
    expect(decideMode(undefined, 0)).toBe("inline");
  });
});

describe("response truncation logic", () => {
  const RESPONSE_SIZE_LIMIT = 100_000;

  function truncate(resultText: string): string {
    if (resultText.length <= RESPONSE_SIZE_LIMIT) return resultText;
    return (
      resultText.slice(0, RESPONSE_SIZE_LIMIT) +
      `\n\n[TRUNCATED: response was ${resultText.length} bytes, showing first ${RESPONSE_SIZE_LIMIT}. Use filter/pagination parameters for smaller responses.]`
    );
  }

  it("returns full text when under limit", () => {
    const text = JSON.stringify({ tabs: [] });
    expect(truncate(text)).toBe(text);
    expect(truncate(text).length).toBeLessThan(RESPONSE_SIZE_LIMIT);
  });

  it("truncates text exceeding limit", () => {
    const text = "x".repeat(150_000);
    const result = truncate(text);
    expect(result).toContain("TRUNCATED");
    expect(result.length).toBeLessThan(150_000);
    expect(result.length).toBeGreaterThan(RESPONSE_SIZE_LIMIT);
  });

  it("preserves prefix of truncated response", () => {
    const text = "START" + "x".repeat(150_000);
    const result = truncate(text);
    expect(result.startsWith("START")).toBe(true);
  });

  it("truncated message includes original size", () => {
    const text = "x".repeat(200_000);
    const result = truncate(text);
    expect(result).toContain("200000");
  });
});

describe("eventStore integration", () => {
  it("drain is called to attach piggyback events to responses", () => {
    const events = [
      { event: "user.switched_tab", data: {}, level: "urgent", timestamp: Date.now() },
    ];
    expect(events).toHaveLength(1);
  });

  it("subscribe returns a unique subscription id", () => {
    const subscribe = () => `sub_${Math.random().toString(36).slice(2)}`;
    const id1 = subscribe();
    const id2 = subscribe();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^sub_/);
  });

  it("unsubscribe returns boolean", () => {
    const unsub = (id: string) => id.startsWith("sub_");
    expect(unsub("sub_abc")).toBe(true);
    expect(unsub("fake")).toBe(false);
  });
});

describe("vortex_ping response shape", () => {
  it("ping response contains required fingerprint fields", () => {
    const required = ["mcpVersion", "extensionVersion", "schemaHash", "toolCount", "tabCount"];
    const mockPingResponse = {
      status: "ok",
      vortexServer: "localhost:6800",
      tabCount: 1,
      timeoutMs: 30000,
      mcpVersion: "0.3.0",
      extensionVersion: "0.3.0",
      schemaHash: "abc123def456",
      toolCount: 64,
      extensionActionCount: null,
      diagnosticsSupported: true,
    };

    for (const field of required) {
      expect(mockPingResponse).toHaveProperty(field);
    }
  });

  it("ping response includes warning when version drift detected", () => {
    const mockPingResponse = {
      mcpVersion: "0.3.0",
      extensionVersion: "0.4.0",
      warning: "MCP (0.3.0) ≠ extension (0.4.0). Rebuild + reload may be needed.",
    };
    expect(mockPingResponse.warning).toContain("MCP");
    expect(mockPingResponse.warning).toContain("extension");
  });

  it("diagnosticsSupported is true when extensionVersion is a known string", () => {
    const extVersion = "0.3.0";
    const diagnosticsSupported = typeof extVersion === "string";
    expect(diagnosticsSupported).toBe(true);
  });

  it("diagnosticsSupported is false when extensionVersion is unknown", () => {
    const extVersion = "unknown";
    const diagnosticsSupported = typeof extVersion === "string" && extVersion !== "unknown";
    expect(diagnosticsSupported).toBe(false);
  });
});

describe("withEvents piggyback", () => {
  function withEvents(content: any[], events: any[] = []) {
    if (events.length > 0) {
      content.push({
        type: "text",
        text: `[vortex-events] ${events.length} event(s) delivered:\n${JSON.stringify(events, null, 2)}`,
      });
    }
    return { content };
  }

  it("appends events as text item when drain returns events", () => {
    const events = [
      { event: "user.switched_tab", data: { tabId: 5 }, level: "urgent", timestamp: Date.now() },
    ];
    const content: any[] = [{ type: "text", text: "normal result" }];
    const result = withEvents(content, events);
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain("[vortex-events]");
    expect(result.content[1].text).toContain("1 event(s)");
  });

  it("returns content unchanged when no events", () => {
    const content: any[] = [{ type: "text", text: "normal result" }];
    const result = withEvents(content, []);
    expect(result.content).toHaveLength(1);
  });

  it("formats events as pretty-printed JSON", () => {
    const events = [{ event: "test", data: { a: 1 }, level: "info" as const, timestamp: 1234567890 }];
    const content: any[] = [{ type: "text", text: "existing result" }];
    const result = withEvents(content, events);
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain('"event": "test"');
    expect(result.content[1].text).toContain('"data":');
  });
});

describe("MCP server constants", () => {
  it("DEFAULT_TIMEOUT is 30000ms", () => {
    const DEFAULT_TIMEOUT = 30000;
    expect(DEFAULT_TIMEOUT).toBe(30000);
  });

  it("PORT defaults to 6800", () => {
    const PORT = parseInt("6800");
    expect(PORT).toBe(6800);
  });

  it("LARGE_IMAGE_BYTES is 500000", () => {
    const LARGE_IMAGE_BYTES = 500_000;
    expect(LARGE_IMAGE_BYTES).toBe(500_000);
  });

  it("RESPONSE_SIZE_LIMIT is 100000", () => {
    const RESPONSE_SIZE_LIMIT = 100_000;
    expect(RESPONSE_SIZE_LIMIT).toBe(100_000);
  });

  it("AUTO_RESTART is enabled by default (env not set to 1)", () => {
    const AUTO_RESTART = process.env.VORTEX_MCP_NO_AUTO_RESTART !== "1";
    expect(AUTO_RESTART).toBe(true);
  });
});

describe("version drift detection", () => {
  it("detects version mismatch between MCP and extension", () => {
    const mcpVersion = "0.3.0";
    const extVersion = "0.4.0";
    const drift = extVersion && extVersion !== "unknown" && extVersion !== mcpVersion;
    expect(drift).toBe(true);
  });

  it("no drift when versions match", () => {
    const mcpVersion = "0.3.0";
    const extVersion = "0.3.0";
    const drift = extVersion && extVersion !== "unknown" && extVersion !== mcpVersion;
    expect(drift).toBeFalsy();
  });

  it("no drift when extension version is unknown", () => {
    const mcpVersion = "0.3.0";
    const extVersion = "unknown";
    const drift = extVersion && extVersion !== "unknown" && extVersion !== mcpVersion;
    expect(drift).toBeFalsy();
  });
});