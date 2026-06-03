// Generic W3C ARIA combobox/listbox COMMIT page-side driver
// (IIFE, attaches to window.__vortexCommitAriaSelect).
//
// 覆盖 react-select / antd Select / MUI Select / Radix / Headless UI 等遵循 W3C ARIA
// APG 模式的组件库:trigger 打开 [role="listbox"] 弹层、选项 [role="option"]、选中态
// aria-selected="true"。现有 commit driver 只有 6 个 Element Plus el-* 选择器,对现代
// React 组件库零覆盖(2026-06-03 act 原语白盒审计族 I #24)。
//
// Host-side call:
//   await loadPageSideModule(tabId, frameId, 'commit-aria-select')
//   const result = await nativePageQuery(tabId, frameId,
//     (sel, closestSelector, val, timeoutMs) =>
//       (window as any).__vortexCommitAriaSelect.run(sel, closestSelector, val, timeoutMs),
//     [selector, driver.closestSelector, value, timeout])

(function () {
  if ((window as any).__vortexCommitAriaSelect?.version === 1) return;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 折叠内部空白:选项 label 夹图标/换行时 textContent 带多余空白(同族 I #25)。
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  async function waitFor<T>(
    probe: () => T | null | undefined,
    to: number,
    intervalMs = 50,
  ): Promise<T | null> {
    const deadline = Date.now() + to;
    for (;;) {
      const r = probe();
      if (r) return r;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  function isVisible(el: Element | null): el is HTMLElement {
    if (!el) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function dispatchMouseClick(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    // react-select 在 option 的 mousedown 上提交(避免 input blur 抢先),故 mousedown
    // 必须先发且与 click 一致命中元素中心。Radix/Headless UI 以 pointer 事件为主,
    // 故 pointerdown/pointerup 一并补发(评审 H4),最大化合成事件的跨库兼容。
    const pOpts = { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", pOpts));
    } catch {
      /* PointerEvent 不可用的老环境忽略,退化为纯 mouse 事件 */
    }
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", pOpts));
    } catch {
      /* 同上 */
    }
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  /**
   * Run generic ARIA combobox/listbox commit.
   * - sel: element selector (target passed by agent)
   * - closestSelector: driver's closestSelector(combobox/listbox role 集合)
   * - val: string(single)| string[](multiple)— option label(s)
   * - timeoutMs: overall operation timeout
   */
  async function run(
    sel: string,
    closestSelector: string,
    val: unknown,
    timeoutMs: number,
  ): Promise<{
    result?: unknown;
    error?: string;
    errorCode?: string;
    stage?: string;
    extras?: Record<string, unknown>;
  }> {
    const els = document.querySelectorAll(sel);
    if (els.length === 0)
      return { error: `Element not found: ${sel}`, errorCode: "ELEMENT_NOT_FOUND" };
    if (els.length > 1)
      return {
        error: `Selector "${sel}" matched ${els.length} elements`,
        errorCode: "SELECTOR_AMBIGUOUS",
        extras: { matchCount: els.length },
      };
    const target = els[0] as HTMLElement;
    // 容错:agent 可能直接传可见控件;closest 匹配不到就用 target 本身,再不行用其内的
    // combobox/listbox 后代。
    const root = (target.closest(closestSelector) ??
      target.querySelector(closestSelector) ??
      target) as HTMLElement;

    const labels = Array.isArray(val) ? (val as unknown[]).map((v) => String(v)) : [String(val)];
    const isMultiple = Array.isArray(val);
    // 共享超时预算:开弹层 + 各 label 等选项统一从 deadline 扣减(同族 I 评审 R2-HIGH-2)。
    const startTs = Date.now();
    const remaining = () => Math.max(0, startTs + timeoutMs - Date.now());

    // 可点击的 trigger:候选 = root 自身(若是 combobox/haspopup)+ 其内的 combobox/
    // haspopup 元素 + root 兜底,**取第一个可见**的。react-select 的 [role="combobox"]
    // 是内层 0×0 隐藏 input,点它不开弹层;可见性过滤让 trigger 落到外层可点击 control
    // (评审 H2)。
    const triggerCandidates: HTMLElement[] = [];
    if (root.matches('[role="combobox"], [aria-haspopup="listbox"]')) triggerCandidates.push(root);
    triggerCandidates.push(
      ...(Array.from(
        root.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]'),
      ) as HTMLElement[]),
    );
    triggerCandidates.push(root);
    const trigger = triggerCandidates.find((c) => isVisible(c)) ?? root;

    // 定位弹层 listbox:trigger/root 的 aria-controls/aria-owns(可能多 id),否则文档级
    // 扫可见 [role="listbox"](覆盖 portal 到 body 的弹层)。多个弹层同时可见时(页面
    // 多个 select 组件)取**几何上离 trigger 最近**的,避免错配别处残留弹层(评审 M1)。
    const findListbox = (): HTMLElement | null => {
      const idAttr =
        trigger.getAttribute("aria-controls") ||
        trigger.getAttribute("aria-owns") ||
        root.getAttribute("aria-controls") ||
        root.getAttribute("aria-owns");
      if (idAttr) {
        for (const one of idAttr.split(/\s+/)) {
          const el = document.getElementById(one);
          if (isVisible(el)) return el;
        }
      }
      const visibles = (
        Array.from(document.querySelectorAll('[role="listbox"]')) as HTMLElement[]
      ).filter(isVisible);
      if (visibles.length <= 1) return visibles[0] ?? null;
      const tr = trigger.getBoundingClientRect();
      let best: HTMLElement | null = null;
      let bestD = Infinity;
      for (const el of visibles) {
        const r = el.getBoundingClientRect();
        const dx = Math.max(0, tr.left - r.right, r.left - tr.right);
        const dy = Math.max(0, tr.top - r.bottom, r.top - tr.bottom);
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = el;
        }
      }
      return best;
    };

    const optionsIn = (lb: HTMLElement): HTMLElement[] =>
      Array.from(lb.querySelectorAll('[role="option"]')) as HTMLElement[];

    const clicked: string[] = [];
    const unknown: string[] = [];

    for (const label of labels) {
      const wantLabel = norm(label);

      // 1. 确保弹层打开:无可见 listbox 就点 trigger 开(多选每次提交后弹层可能关闭)。
      let listbox = findListbox();
      if (!listbox) {
        trigger.scrollIntoView({ block: "center", inline: "center" });
        dispatchMouseClick(trigger);
        listbox = await waitFor(() => findListbox(), remaining());
      }
      if (!listbox) {
        return {
          error: "ARIA listbox did not open within timeout",
          errorCode: "COMMIT_FAILED",
          stage: "open-listbox",
        };
      }

      // 2. 找选项:轮询等异步/remote 渲染,只取非 aria-disabled 的精确(norm)匹配。
      //    per-label cap:一个 unknown label 不该耗尽共享 deadline 把后续合法 label 也
      //    饿成 unknown(评审 H3)。cap 3000ms 足够 remote 渲染又留预算给其余 label。
      const findEnabled = (): HTMLElement | null =>
        optionsIn(findListbox() ?? listbox!).find(
          (o) =>
            o.getAttribute("aria-disabled") !== "true" &&
            norm(o.textContent || "") === wantLabel,
        ) ?? null;
      const optWait = () => Math.min(remaining(), 3000);
      let hit = await waitFor(findEnabled, optWait());

      // 3. typeahead 兜底:仍找不到且是**搜索式** combobox(role=combobox / aria-autocomplete
      //    / trigger 本身是 input)才写 label 过滤——避免污染无关 input 的受控状态(评审 M2)。
      //    写前先清空(对齐 el-select),防多选时上一 label 过滤串残留叠加。
      if (!hit) {
        const inputEl = (trigger.matches("input")
          ? (trigger as HTMLInputElement)
          : (root.querySelector('input:not([type="hidden"])') as HTMLInputElement | null)) as
          | HTMLInputElement
          | null;
        const isSearchInput =
          !!inputEl &&
          (inputEl.getAttribute("role") === "combobox" ||
            inputEl.hasAttribute("aria-autocomplete") ||
            inputEl === trigger);
        if (inputEl && isSearchInput) {
          const setVal = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set;
          const writeFilter = (v: string) => {
            if (setVal) setVal.call(inputEl, v);
            else inputEl.value = v;
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          };
          writeFilter("");
          await sleep(30);
          writeFilter(wantLabel);
          hit = await waitFor(findEnabled, optWait());
        }
      }

      if (!hit) {
        // 区分:文本存在但禁用 → 明确 disabled;否则 unknown。
        const disabledHit = optionsIn(findListbox() ?? listbox).find(
          (o) =>
            o.getAttribute("aria-disabled") === "true" &&
            norm(o.textContent || "") === wantLabel,
        );
        if (disabledHit) {
          return {
            error: `Option "${label}" is disabled and cannot be selected`,
            errorCode: "INVALID_PARAMS",
            extras: { disabled: label },
          };
        }
        unknown.push(label);
        continue;
      }

      dispatchMouseClick(hit);
      clicked.push(label);
      await sleep(60); // 让框架提交一拍;单选弹层会关、多选保持
    }

    if (unknown.length > 0) {
      const lb = findListbox();
      const available = lb ? optionsIn(lb).map((o) => norm(o.textContent || "")) : [];
      return {
        error: `Unknown option label(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`,
        errorCode: "INVALID_PARAMS",
        extras: { unknown, available },
      };
    }

    // 4. verify 回读:仅凭点击成功是 silent-false-success(disabled/动画丢 click/未 settle
    //    都会「点了没选上」)。三路正向证据 union,exact 优先再 substring(评审 M4):
    //    (a) valueText —— root 文本但**排除 [role=listbox] 子树**(react-select 默认菜单
    //        inline 在容器内,不排除会把菜单里所有选项文本当 value 假阳);单选看 value 显示、
    //        多选看 chip。
    //    (b) root 内 input.value —— react-select/antd/MUI 单选选中值常回填到 <input value>,
    //        不进 textContent,只看 valueText 会假报 COMMIT_FAILED(评审 H1)。
    //    (c) 存活的 [role=option][aria-selected="true"] 文本(弹层仍开时的权威信号)。
    //    用 waitFor 轮询(而非固定 sleep)等框架异步提交 + 关闭动画 settle(评审 M3)。
    const valueText = (): string => {
      let t = "";
      const walk = (node: Node): void => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === 1) {
            if ((child as HTMLElement).getAttribute?.("role") === "listbox") continue;
            walk(child);
          } else if (child.nodeType === 3) {
            t += child.nodeValue ?? "";
          }
        }
      };
      walk(root);
      return norm(t);
    };
    const inputValues = (): string[] =>
      (Array.from(root.querySelectorAll('input:not([type="hidden"])')) as HTMLInputElement[]).map(
        (i) => norm(i.value || ""),
      );
    const selectedTexts = (): string[] => {
      const lb = findListbox();
      return lb
        ? (Array.from(lb.querySelectorAll('[role="option"][aria-selected="true"]')) as HTMLElement[]).map(
            (o) => norm(o.textContent || ""),
          )
        : [];
    };
    const reflected = (l: string): boolean => {
      const w = norm(l);
      const vt = valueText();
      const ivs = inputValues();
      const sel = selectedTexts();
      // exact 优先(单值显示/aria-selected/input 回填),避免 "Apple Pie" includes "Apple" 假阳
      if (sel.some((t) => t === w) || ivs.some((t) => t === w) || vt === w) return true;
      // 再 substring(多选 chip 拼接 / 值显示含额外文本)——best-effort,同 el-select 限制
      return vt.includes(w) || ivs.some((t) => t.includes(w));
    };
    const allReflected = await waitFor(
      () => (labels.every(reflected) ? true : null),
      Math.min(remaining(), 1500),
    );
    if (!allReflected) {
      const notReflected = labels.filter((l) => !reflected(l));
      return {
        error: `Selected option(s) not reflected after commit: ${notReflected.join(", ")} (combobox value shows "${valueText()}"). Likely a dropped click, a single-select given multiple labels, or async not settled.`,
        errorCode: "COMMIT_FAILED",
        stage: "verify",
        extras: { notReflected, valueText: valueText(), clicked },
      };
    }

    return {
      result: {
        success: true,
        driver: "generic-aria-select",
        multiple: isMultiple,
        clicked,
      },
    };
  }

  (window as any).__vortexCommitAriaSelect = {
    version: 1,
    run,
  };
})();

export {};
