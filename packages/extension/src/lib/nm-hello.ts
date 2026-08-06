/**
 * Author: qingwa
 * Description: Builds and sends the extension identity frame over native messaging.
 */
import type { NativeMessagingClient } from "./native-messaging.js";
import { getBrowserId } from "./browser-id.js";

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
    extensionVersion: EXTENSION_VERSION,
    buildStamp: BUILD_STAMP,
  });
}
