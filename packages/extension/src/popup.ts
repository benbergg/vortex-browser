/** popup 直连 host 本地 HTTP(默认 6800),查 trusted 状态 / 触发一键重启。 */
const BASE = "http://127.0.0.1:6800";

export interface TrustedStatus {
  connected: boolean;
  trustedMode: boolean;
}

export async function fetchTrustedStatus(base: string = BASE): Promise<TrustedStatus> {
  try {
    const r = await fetch(`${base}/trusted-mode`);
    if (!r.ok) return { connected: false, trustedMode: false };
    const j = (await r.json()) as { trustedMode?: boolean };
    return { connected: true, trustedMode: j.trustedMode === true };
  } catch {
    return { connected: false, trustedMode: false };
  }
}

export async function requestRelaunch(base: string = BASE): Promise<boolean> {
  try {
    const r = await fetch(`${base}/relaunch-trusted`, { method: "POST" });
    return r.ok;
  } catch {
    return false;
  }
}

export function statusLabel(s: TrustedStatus): string {
  if (!s.connected) return "未连接 vortex server";
  return s.trustedMode ? "当前:trusted 模式(无黄条)" : "当前:普通模式";
}

if (typeof document !== "undefined") {
  const statusEl = () => document.getElementById("status")!;
  const btn = () => document.getElementById("relaunch") as HTMLButtonElement;
  const confirmEl = () => document.getElementById("confirm")!;

  async function refresh(): Promise<void> {
    const s = await fetchTrustedStatus();
    statusEl().textContent = statusLabel(s);
    btn().disabled = !s.connected || s.trustedMode;
  }

  let armed = false;
  function onClick(): void {
    if (!armed) {
      armed = true;
      confirmEl().textContent =
        "将关闭当前所有标签页,并以抑制 Chrome 调试安全提示的方式重启。再次点击确认。";
      btn().textContent = "确认重启";
      return;
    }
    void requestRelaunch().then((ok) => {
      confirmEl().textContent = ok
        ? "已触发,Chrome 即将重启…"
        : "触发失败,请手动启动(见 docs/trusted-mode.md)。";
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    btn().addEventListener("click", onClick);
    void refresh();
  });
}
