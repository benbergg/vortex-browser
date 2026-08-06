/**
 * Author: qingwa
 * Description: Persists the browser identity used by the hub assignment layer.
 */
const STORAGE_KEY = "vortexBrowserId";
let browserIdPromise: Promise<string> | null = null;

export function getBrowserId(): Promise<string> {
  if (browserIdPromise) return browserIdPromise;
  browserIdPromise = loadBrowserId().catch((error: unknown) => {
    browserIdPromise = null;
    throw error;
  });
  return browserIdPromise;
}

async function loadBrowserId(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const existing = stored[STORAGE_KEY];
  if (typeof existing === "string" && existing.length > 0) return existing;

  const browserId = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEY]: browserId });
  return browserId;
}
