/**
 * Author: qingwa
 * Description: Verifies native-messaging connect emits the browser hello frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BACKGROUND = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "background.ts"),
  "utf8",
);

describe("NativeMessagingClient NmHello", () => {
  beforeEach(() => vi.resetModules());

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends NmHello with the persisted browserId after connecting", async () => {
    const port = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    const get = vi.fn().mockResolvedValue({ vortexBrowserId: "browser-persisted" });
    const chromeMock = {
      alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
      runtime: { connectNative: vi.fn(() => port), lastError: undefined },
      storage: { local: { get, set: vi.fn() } },
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      userAgentData: { brands: [{ brand: "Microsoft Edge", version: "140" }] },
    });

    const { NativeMessagingClient } = await import("../src/lib/native-messaging.js");
    const { sendNmHello } = await import("../src/lib/nm-hello.js");
    const order: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => { order.push("log"); });
    let client!: InstanceType<typeof NativeMessagingClient>;
    client = new NativeMessagingClient(
      vi.fn(),
      vi.fn(),
      () => {
        order.push("connected");
        void sendNmHello(client);
      },
    );
    client.connect();

    expect(order).toEqual(["log", "connected"]);

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hello",
        browserId: "browser-persisted",
        label: "Microsoft Edge",
        extensionVersion: expect.any(String),
        buildStamp: expect.any(String),
      }),
    ));
  });

  it("wires the connect callback to the background NmHello sender", () => {
    expect(BACKGROUND).toContain('import { sendNmHello } from "./lib/nm-hello.js";');
    expect(BACKGROUND).toMatch(/sendNmHello\(nm\)/);
  });
});
