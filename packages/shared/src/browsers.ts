export interface BrowserChannel {
  label: string;
  profileDir: string;
  nmDir: string;
}

const CHANNELS: ReadonlyArray<{ label: string; darwin: string; posix?: string }> = [
  { label: "Google Chrome", darwin: "Google/Chrome", posix: "google-chrome" },
  { label: "Google Chrome Beta", darwin: "Google/Chrome Beta", posix: "google-chrome-beta" },
  { label: "Google Chrome Dev", darwin: "Google/Chrome Dev", posix: "google-chrome-unstable" },
  { label: "Google Chrome Canary", darwin: "Google/Chrome Canary" },
  { label: "Google Chrome for Testing", darwin: "Google/Chrome for Testing" },
  { label: "Chromium", darwin: "Chromium", posix: "chromium" },
  { label: "Microsoft Edge", darwin: "Microsoft Edge", posix: "microsoft-edge" },
  { label: "Microsoft Edge Beta", darwin: "Microsoft Edge Beta", posix: "microsoft-edge-beta" },
  { label: "Microsoft Edge Dev", darwin: "Microsoft Edge Dev", posix: "microsoft-edge-dev" },
  { label: "Microsoft Edge Canary", darwin: "Microsoft Edge Canary" },
];

function joinPath(...parts: string[]): string {
  const separator = parts.some((part) => part.includes("\\")) ? "\\" : "/";
  return parts
    .map((part, index) => index === 0
      ? part.replace(/[\\/]+$/, "")
      : part.replace(/^[\\/]+|[\\/]+$/g, ""))
    .filter(Boolean)
    .join(separator);
}

export function browserChannels(home: string, plat: string): BrowserChannel[] {
  const isMac = plat === "darwin";
  const out: BrowserChannel[] = [];
  for (const c of CHANNELS) {
    const rel = isMac
      ? joinPath("Library/Application Support", c.darwin)
      : c.posix && joinPath(".config", c.posix);
    if (!rel) continue;
    const profileDir = joinPath(home, rel);
    out.push({ label: c.label, profileDir, nmDir: joinPath(profileDir, "NativeMessagingHosts") });
  }
  return out;
}

export const NM_HOST_FILENAME = "com.vortexbrowser.host.json";

const LAUNCHABLE = new Set(["Google Chrome", "Microsoft Edge", "Chromium"]);

export function launchCommand(
  label: string,
  platform: string,
): { cmd: string; args: string[] } | null {
  if (platform !== "darwin" || !LAUNCHABLE.has(label)) return null;
  return { cmd: "open", args: ["-a", label] };
}
