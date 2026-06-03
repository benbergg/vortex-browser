// element-plus select COMMIT page-side driver (IIFE, attaches to window.__vortexCommitSelect).
// Migrated from dom.ts COMMIT handler driverId === "element-plus-select" branch (L1198-1281).
//
// Host-side call:
//   await loadPageSideModule(tabId, frameId, 'commit-select')
//   const result = await nativePageQuery(tabId, frameId,
//     (sel, closestSelector, val, timeoutMs) =>
//       (window as any).__vortexCommitSelect.run(sel, closestSelector, val, timeoutMs),
//     [selector, driver.closestSelector, value, timeout])

(function () {
  if ((window as any).__vortexCommitSelect?.version === 1) return;

  // Page-side inline helpers (matching original dom.ts page-side func; cannot import across files)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitFor<T>(
    probe: () => T | null | undefined,
    to: number,
    intervalMs = 50,
  ): Promise<T | null> {
    const deadline = Date.now() + to;
    while (Date.now() < deadline) {
      const r = probe();
      if (r) return r;
      await sleep(intervalMs);
    }
    return null;
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
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  /**
   * Run el-select commit.
   * - sel: element selector (the target element passed by agent)
   * - closestSelector: driver's closestSelector (".el-select")
   * - val: string or string[] (option label(s) to select)
   * - timeoutMs: overall operation timeout
   *
   * Returns: { result?, error?, errorCode?, stage?, extras? } — same contract as dom.ts COMMIT path.
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
    // Resolve root element (mirrors dom.ts L939-958 element resolution block)
    const els = document.querySelectorAll(sel);
    if (els.length === 0) return { error: `Element not found: ${sel}`, errorCode: "ELEMENT_NOT_FOUND" };
    if (els.length > 1)
      return {
        error: `Selector "${sel}" matched ${els.length} elements`,
        errorCode: "SELECTOR_AMBIGUOUS",
        extras: { matchCount: els.length },
      };
    const target = els[0] as HTMLElement;
    const root = (target.closest(closestSelector) ??
      target.querySelector(closestSelector)) as HTMLElement | null;
    if (!root)
      return {
        error: `Target does not match driver closestSelector "${closestSelector}" (neither ancestor nor descendant)`,
        errorCode: "UNSUPPORTED_TARGET",
        extras: { driverId: "element-plus-select" },
      };

    // -------- Element Plus el-select driver --------
    const labels = Array.isArray(val)
      ? (val as unknown[]).map((v) => String(v))
      : [String(val)];
    const isMultiple = Array.isArray(val) || root.classList.contains("is-multiple");

    // trigger: el-select 2.x uses .el-select__wrapper, older versions use .select-trigger
    const wrapper =
      (root.querySelector(".el-select__wrapper") as HTMLElement | null) ??
      (root.querySelector(".select-trigger") as HTMLElement | null) ??
      (root as HTMLElement);

    // 1. Click wrapper to open popper
    wrapper.scrollIntoView({ block: "center", inline: "center" });
    dispatchMouseClick(wrapper);

    // 2. Wait for current select's dropdown to appear and be visible.
    //    el-select wrapper has aria-controls pointing to popper id.
    const popperId = wrapper.getAttribute("aria-controls");
    const dropdown = await waitFor(() => {
      if (popperId) {
        const el = document.getElementById(popperId);
        if (el && el.getBoundingClientRect().width > 0) return el as HTMLElement;
      }
      // fallback: scan all visible dropdowns, take first
      const all = document.querySelectorAll(".el-select-dropdown");
      for (const d of Array.from(all)) {
        if ((d as HTMLElement).getBoundingClientRect().width > 0) return d as HTMLElement;
      }
      return null;
    }, timeoutMs);
    if (!dropdown) {
      return {
        error: "Select dropdown did not open within timeout",
        errorCode: "COMMIT_FAILED",
        stage: "open-dropdown",
      };
    }

    // 3a. el-select-v2 filterable mode: when the wrapper has class
    //     `is-filterable`, the dropdown is rendered as a virtual list
    //     and only ~10 items live in the DOM at any moment. To reach a
    //     cross-screen option (e.g. Option 500 in a 1000-item list),
    //     write the label as a filter string via the inner input —
    //     same input the framework binds for typing-to-filter. This
    //     bypasses dom.type's actionability check (Element Plus
    //     stacks a placeholder div over the input, triggering
    //     OBSCURED) by writing directly through nativeInputValueSetter.
    //     Issue #24.
    const filterInput =
      (root.querySelector(".el-select__input") as HTMLInputElement | null) ??
      (root.querySelector("input.el-select-v2__input") as HTMLInputElement | null);
    const wrapperIsFilterable = wrapper.classList.contains("is-filterable");
    const supportsFilter =
      !!filterInput && wrapperIsFilterable;

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    function writeFilter(input: HTMLInputElement, value: string): void {
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, value);
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 3b. Find and click option for each label
    const clicked: string[] = [];
    const unknown: string[] = [];
    for (const label of labels) {
      if (supportsFilter && filterInput) {
        // Clear any prior filter (matters in multi-select / re-iter)
        writeFilter(filterInput, "");
        await sleep(50);
        // Type the label as filter — virtual list re-renders to
        // only items whose label matches (substring on textContent).
        writeFilter(filterInput, label);
        // Let Vue reactivity + virtual list re-layout settle.
        // 150ms covers an Element Plus v2 cycle on a 1000-item list.
        await sleep(150);
      }

      const items = Array.from(
        dropdown.querySelectorAll(".el-select-dropdown__item"),
      ) as HTMLElement[];
      const hit = items.find((it) => (it.textContent || "").trim() === label);
      if (!hit) {
        unknown.push(label);
        continue;
      }
      dispatchMouseClick(hit);
      clicked.push(label);
      await sleep(40); // let Vue run one tick before clicking next option
    }

    // Reset filter so the placeholder div doesn't keep showing the
    // search string after the popper closes (cosmetic, matters in
    // multi-select where popper stays open).
    if (supportsFilter && filterInput && filterInput.value) {
      writeFilter(filterInput, "");
    }

    // 4. Multi-select: click wrapper to close popper; single-select closes automatically
    if (isMultiple && dropdown.getBoundingClientRect().width > 0) {
      dispatchMouseClick(wrapper);
      await sleep(40);
    }

    if (unknown.length > 0) {
      const available = Array.from(
        dropdown.querySelectorAll(".el-select-dropdown__item"),
      ).map((i) => ((i as HTMLElement).textContent || "").trim());
      return {
        error: `Unknown option label(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`,
        errorCode: "INVALID_PARAMS",
        extras: { unknown, available },
      };
    }

    // Verify: 回读触发器显示的已选项——每个 label 都应反映。点中 DOM item 不等于 Vue
    // 真 commit(disabled option / 动画期丢 click / 单选被传多 label / 异步未 settle 都会
    // 「点了但没选上」),仅凭 clicked 返回 success 是 silent false-success。对照同目录
    // checkbox-group 的 is-checked 回读范式(2026-06-03 act 原语白盒审计族 A,#20)。
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    // 优先读独立的已选项元素(multi 的 tag / single 的 selected-item)做精确匹配,
    // 避免触发器整体文本的子串误判(label 是 placeholder 或另一 tag 子串时假通过)。
    const itemEls = wrapper.querySelectorAll(
      ".el-tag, .el-select__selected-item, .el-select__tags-text",
    );
    const displayed = norm(wrapper.innerText || "");
    let notReflected: string[];
    if (itemEls.length > 0) {
      const itemTexts = Array.from(itemEls).map((e) => norm((e as HTMLElement).textContent || ""));
      notReflected = labels.filter(
        (l) => !itemTexts.some((t) => t === l || t.includes(l)),
      );
    } else {
      notReflected = labels.filter((l) => !displayed.includes(l));
    }
    if (notReflected.length > 0) {
      return {
        error: `Selected option(s) not reflected after commit: ${notReflected.join(", ")} (trigger shows "${displayed}"). Likely a disabled option, a dropped click, or a single-select given multiple labels.`,
        errorCode: "COMMIT_FAILED",
        stage: "verify",
        extras: { notReflected, displayed, clicked },
      };
    }

    return {
      result: {
        success: true,
        driver: "element-plus-select",
        multiple: isMultiple,
        clicked,
      },
    };
  }

  (window as any).__vortexCommitSelect = {
    version: 1,
    run,
  };
})();

export {};
