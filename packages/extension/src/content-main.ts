// Vortex content script - MAIN world
//
// 运行在页面 JS 同一个全局，拦截 alert/confirm/prompt。必须在页面脚本之前
// 执行（manifest 声明 run_at=document_start + world=MAIN），否则页面脚本
// 可能已缓存原始 window.alert 引用。
//
// 自身无法调 chrome.runtime.sendMessage（MAIN world 没有 chrome API），
// 通过 window.postMessage 把事件发给同页 ISOLATED world 的 content script
// 再由后者转发给 background。
// override 现在会查询 window.__vortexDialogPolicy 决定是抑制应答还是透传原生。

(() => {
  // 与 packages/shared/src/dialog-policy.ts 的 VortexDialogPolicy **逻辑等价的内联副本**
  // (executeScript/content-script MAIN world 注入丢模块作用域,不能 import,改一处须同步另一处)。
  type DialogKind = "alert" | "confirm" | "prompt";
  interface DialogPolicy {
    armed: boolean;
    until: number;
    answer: "accept" | "dismiss";
    promptText: string | null;
    captured: Array<{ type: DialogKind; message: string }>;
  }
  const POLICY_KEY = "__vortexDialogPolicy"; // === DIALOG_POLICY_KEY
  const w = window as unknown as { [k: string]: DialogPolicy | undefined };

  // armed(动作中,无时限)或 grace 窗内(动作后 until 截止前)→ 抑制并按策略应答。
  function activePolicy(): DialogPolicy | null {
    const p = w[POLICY_KEY];
    if (p && (p.armed || Date.now() < p.until)) return p;
    return null;
  }

  function notify(kind: DialogKind, text: string): void {
    try {
      window.postMessage({ __vortex__: true, type: "dialog.opened", kind, text }, "*");
    } catch {
      // postMessage 极端情况可能失败,忽略
    }
  }

  const origAlert = window.alert;
  window.alert = function (msg?: unknown): void {
    const text = String(msg ?? "");
    notify("alert", text);
    const p = activePolicy();
    if (p) {
      p.captured.push({ type: "alert", message: text });
      return; // 抑制原生框(alert 无返回值)
    }
    return origAlert.call(window, msg as string); // 空闲:透传,用户自己的 alert 照常
  };

  const origConfirm = window.confirm;
  window.confirm = function (msg?: unknown): boolean {
    const text = String(msg ?? "");
    notify("confirm", text);
    const p = activePolicy();
    if (p) {
      p.captured.push({ type: "confirm", message: text });
      return p.answer === "accept";
    }
    return origConfirm.call(window, msg as string);
  };

  const origPrompt = window.prompt;
  window.prompt = function (msg?: unknown, def?: unknown): string | null {
    const text = String(msg ?? "");
    notify("prompt", text);
    const p = activePolicy();
    if (p) {
      p.captured.push({ type: "prompt", message: text });
      if (p.answer !== "accept") return null;
      return p.promptText != null ? p.promptText : def != null ? String(def) : "";
    }
    return origPrompt.call(window, msg as string, def as string);
  };
})();
