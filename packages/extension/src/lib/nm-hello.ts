/**
 * Author: qingwa
 * Description: Builds and sends the extension identity frame over native messaging.
 */
import type { NativeMessagingClient } from "./native-messaging.js";
import { getBrowserId } from "./browser-id.js";
import { detectBrowserLabel } from "./browser-label.js";

declare const __EXTENSION_VERSION__: string | undefined;
declare const __VORTEX_BUILD__: string | undefined;

const EXTENSION_VERSION =
  typeof __EXTENSION_VERSION__ !== "undefined" ? __EXTENSION_VERSION__ : "unknown";
const BUILD_STAMP =
  typeof __VORTEX_BUILD__ !== "undefined" ? __VORTEX_BUILD__ : "dev";

export async function sendNmHello(
  client: Pick<NativeMessagingClient, "send" | "isConnected">,
): Promise<void> {
  const browserId = await getBrowserId();
  if (!client.isConnected()) return;
  client.send({
    type: "hello",
    browserId,
    label: currentBrowserLabel(),
    extensionVersion: EXTENSION_VERSION,
    buildStamp: BUILD_STAMP,
  });
}

// brands 是同步属性（getHighEntropyValues 才是异步），SW 中可用
function currentBrowserLabel(): string {
  const data = (navigator as Navigator & {
    userAgentData?: { brands?: readonly { brand: string; version?: string }[] };
  }).userAgentData;
  return detectBrowserLabel({ brands: data?.brands, userAgent: navigator.userAgent });
}
