import type { NmMessageFromExtension, NmMessageFromServer } from "@vortex-browser/shared";

const NM_HOST_NAME = "com.vortexbrowser.host";
const KEEPALIVE_ALARM = "vortex-keepalive";

type OnMessageCallback = (msg: NmMessageFromServer) => void;
type OnDisconnectCallback = () => void;
type OnConnectedCallback = () => void;

export class NativeMessagingClient {
  private port: chrome.runtime.Port | null = null;
  private onMessage: OnMessageCallback;
  private onDisconnect: OnDisconnectCallback;
  private onConnected: OnConnectedCallback;

  constructor(
    onMessage: OnMessageCallback,
    onDisconnect: OnDisconnectCallback,
    onConnected: OnConnectedCallback = () => {},
  ) {
    this.onMessage = onMessage;
    this.onDisconnect = onDisconnect;
    this.onConnected = onConnected;

    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_ALARM) {
        this.ensureConnected();
      }
    });
  }

  connect(): void {
    if (this.port) return;
    try {
      this.port = chrome.runtime.connectNative(NM_HOST_NAME);
      this.port.onMessage.addListener((msg: NmMessageFromServer) => {
        if (msg.type === "ping") {
          this.send({ type: "pong" });
          return;
        }
        this.onMessage(msg);
      });
      this.port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.warn("[vortex-nm] disconnected:", error?.message ?? "unknown");
        this.port = null;
        this.onDisconnect();
      });
      console.log("[vortex-nm] connected to", NM_HOST_NAME);
      this.onConnected();
    } catch (err) {
      console.error("[vortex-nm] connect failed:", err);
      this.port = null;
    }
  }

  send(msg: NmMessageFromExtension): void {
    if (!this.port) {
      console.warn("[vortex-nm] not connected, dropping message");
      return;
    }
    this.port.postMessage(msg);
  }

  isConnected(): boolean {
    return this.port !== null;
  }

  private ensureConnected(): void {
    if (!this.port) {
      console.log("[vortex-nm] reconnecting...");
      this.connect();
    }
  }

  disconnect(): void {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
  }
}
