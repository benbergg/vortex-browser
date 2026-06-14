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
    // root 解析:target 自身或祖先匹配 combobox/listbox role 则用之,否则用 target 本身
    // (容器)。**不潜入 target 内部找 combobox 当 root**——react-select 的容器内层是 0×0
    // 隐藏 input(role=combobox),潜入会让 root 退化成那个不可见 input,后续 trigger/作用域
    // 全错(2026-06-03 react-select live 修)。
    const root = (target.closest(closestSelector) ?? target) as HTMLElement;

    const labels = Array.isArray(val) ? (val as unknown[]).map((v) => String(v)) : [String(val)];
    const isMultiple = Array.isArray(val);
    // 共享超时预算:开弹层 + 各 label 等选项统一从 deadline 扣减(同族 I 评审 R2-HIGH-2)。
    const startTs = Date.now();
    const remaining = () => Math.max(0, startTs + timeoutMs - Date.now());

    // 可点击的 trigger:候选 = root 自身(若是 combobox/haspopup)+ 其内的 combobox/haspopup
    // 元素 + root 兜底 + root 的可见祖先(react-select 的可点击 control 是 combobox input 的
    // 祖先且无 ARIA role),**取第一个可见**的。react-select 的 [role="combobox"] 是内层 0×0
    // 隐藏 input,点它不开弹层;可见性过滤让 trigger 落到外层可点击 control(评审 H2)。
    const triggerCandidates: HTMLElement[] = [];
    if (root.matches('[role="combobox"], [aria-haspopup="listbox"]')) triggerCandidates.push(root);
    triggerCandidates.push(
      ...(Array.from(
        root.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]'),
      ) as HTMLElement[]),
    );
    triggerCandidates.push(root);
    let anc = root.parentElement;
    for (let i = 0; i < 4 && anc; i++) {
      triggerCandidates.push(anc);
      anc = anc.parentElement;
    }
    const trigger = triggerCandidates.find((c) => isVisible(c)) ?? root;

    // 选项识别:优先 ARIA 标准 [role="option"];部分库(antd v6 rc-virtual-list)把 role=option
    // 放在 0 宽 a11y 测量节点上,可见可点的选项行用自有 class —— 仅当标准 role=option 取不到
    // 可见选项时退到这些已知库的 class(保持 ARIA-first),覆盖 antd 真实站(2026-06-03 live)。
    const OPTION_FALLBACK_SEL = ".ant-select-item-option, .rc-select-item-option";
    const collectVisible = (scope: ParentNode): HTMLElement[] => {
      const role = (Array.from(scope.querySelectorAll('[role="option"]')) as HTMLElement[]).filter(
        isVisible,
      );
      if (role.length > 0) return role;
      return (Array.from(scope.querySelectorAll(OPTION_FALLBACK_SEL)) as HTMLElement[]).filter(
        isVisible,
      );
    };
    const isOptDisabled = (o: HTMLElement): boolean =>
      o.getAttribute("aria-disabled") === "true" ||
      o.classList.contains("ant-select-item-option-disabled");
    const isOptSelected = (o: HTMLElement): boolean =>
      o.getAttribute("aria-selected") === "true" ||
      o.classList.contains("ant-select-item-option-selected");

    // 取本 select 弹层的 aria-controls/aria-owns id。**关键**:trigger(经可见性过滤后常是
    // antd 的 .ant-select-selector / react-select control)自身往往不带该属性,真正持有的是
    // 内层 input[role=combobox];故 id 来源必须也扫 root 子树内任意 [aria-controls](评审
    // HIGH-1)。否则 scope 退化到文档级,多 antd select 同名选项跨组件污染。
    const controlsId = (): string | null =>
      trigger.getAttribute("aria-controls") ||
      trigger.getAttribute("aria-owns") ||
      root.getAttribute("aria-controls") ||
      root.getAttribute("aria-owns") ||
      root.querySelector("[aria-controls]")?.getAttribute("aria-controls") ||
      root.querySelector("[aria-owns]")?.getAttribute("aria-owns") ||
      null;

    // 找**自身可见**的 listbox(react-select/MUI/Radix 的弹层 listbox 即可见容器);多个
    // 同时可见时取几何离 trigger 最近的,避免错配别处残留弹层(评审 M1)。注意:antd v6 的
    // rc-virtual-list 把 [role=listbox] 放在 0 尺寸测量 holder 上(且 aria-controls 指向它),
    // 此函数对这类返回 null —— 由 optionPool 退到「文档级可见 [role=option]」兜住。
    const findVisibleListbox = (): HTMLElement | null => {
      const idAttr = controlsId();
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

    // 经 aria-controls 目标向上走到「含可见选项」的祖先容器(antd:listbox 0 尺寸但其祖先
    // dropdown 持有可见选项行)。aria-controls id 每个 select 唯一,故作用域锁定**本** select
    // 的弹层,避免页面多 select 同时渲染时的跨组件污染(评审 M1)。
    const ariaControlsScope = (): HTMLElement | null => {
      const idAttr = controlsId();
      if (!idAttr) return null;
      let el: HTMLElement | null = document.getElementById(idAttr.split(/\s+/)[0]);
      // 到 body 即停:body/html 作作用域等于文档级,失去锚定意义且会命中邻居弹层(评审 M2)。
      for (let i = 0; el && el !== document.body && i < 6; i++) {
        if (collectVisible(el).length > 0) return el;
        el = el.parentElement;
      }
      return null;
    };

    // option 为中心(而非 listbox 为中心):弹层「开」= 出现可见选项行。优先级:① 可见 listbox
    // 子树(react-select/MUI/Radix 干净作用域)→ ② aria-controls 祖先容器(antd 虚拟列表,锁本
    // select)→ ③ 文档级兜底。跨库统一靠「可见 option(标准 role 或已知库 class)」而非「可见
    // listbox」(2026-06-03 antd v6 + react-select live 修)。
    const optionPool = (): HTMLElement[] => {
      const lb = findVisibleListbox();
      if (lb) {
        const scoped = collectVisible(lb);
        if (scoped.length > 0) return scoped;
      }
      const scope = ariaControlsScope();
      if (scope) {
        const s = collectVisible(scope);
        if (s.length > 0) return s;
      }
      return collectVisible(document);
    };

    const clicked: string[] = [];
    const unknown: string[] = [];

    for (const label of labels) {
      const wantLabel = norm(label);

      // 1. 确保弹层打开:无可见选项就点 trigger 开(多选每次提交后弹层可能关闭)。
      let opened = optionPool().length > 0;
      if (!opened) {
        trigger.scrollIntoView({ block: "center", inline: "center" });
        dispatchMouseClick(trigger);
        // 鼠标开仅给短 cap,快速 fail 到键盘兜底(react-select 等不会响应合成鼠标开)。
        opened = await waitFor(
          () => (optionPool().length > 0 ? true : null),
          Math.min(remaining(), 1000),
        );
      }
      // 键盘兜底:focus combobox input + 合成 ArrowDown keydown。react-select 等库对控件
      // 的 mousedown gating isTrusted(合成鼠标点不开),但响应合成 ArrowDown;这也是 W3C
      // ARIA APG combobox 的标准开弹层键(2026-06-03 react-select live 实证:合成鼠标开失败、
      // 键盘开成功,且开后合成 click 选项有效)。
      if (!opened) {
        // kbTarget 限定为**搜索式** combobox input(role=combobox / aria-autocomplete)或 trigger
        // 本身,不取 root 内任意 input——否则可能 focus 到表单里无关 input 触发别的 onFocus UI
        // (评审 HIGH-2)。
        const searchInput = (
          trigger.matches('input[role="combobox"], input[aria-autocomplete]')
            ? trigger
            : root.querySelector('input[role="combobox"], input[aria-autocomplete]')
        ) as HTMLInputElement | null;
        const kbTarget = (searchInput ?? trigger) as HTMLElement | null;
        // 清掉上一 label 的 typeahead 残留:带串 ArrowDown 会按残留串过滤把列表筛空,
        // 多选第二个 label 走键盘开时找不到选项误报 unknown(评审 HIGH-2)。
        if (searchInput && searchInput.value) {
          const sv = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set;
          if (sv) sv.call(searchInput, "");
          else searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        kbTarget?.focus?.();
        kbTarget?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            code: "ArrowDown",
            keyCode: 40,
            which: 40,
            bubbles: true,
          }),
        );
        opened = await waitFor(() => (optionPool().length > 0 ? true : null), remaining());
      }
      if (!opened) {
        return {
          error: "ARIA listbox did not open within timeout (no visible [role=option] appeared)",
          errorCode: "COMMIT_FAILED",
          stage: "open-listbox",
        };
      }

      // 2. 找选项:轮询等异步/remote 渲染,只取非 aria-disabled 的精确(norm)匹配。
      //    per-label cap:一个 unknown label 不该耗尽共享 deadline 把后续合法 label 也
      //    饿成 unknown(评审 H3)。cap 3000ms 足够 remote 渲染又留预算给其余 label。
      const findEnabled = (): HTMLElement | null =>
        optionPool().find((o) => !isOptDisabled(o) && norm(o.textContent || "") === wantLabel) ??
        null;
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
        const disabledHit = optionPool().find(
          (o) => isOptDisabled(o) && norm(o.textContent || "") === wantLabel,
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
      const available = optionPool().map((o) => norm(o.textContent || ""));
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
    //
    //    verify 作用域 = root 自身 + 有界祖先链。observe 的 ref 常指向 react-select 内层
    //    极小 input[role=combobox],input 自身匹配 closestSelector → root 塌缩成 input,
    //    而选中值 singleValue 渲染在 input 的**兄弟**(control 容器内),选后菜单还 unmount
    //    致 option pool 空,三信号全 scope 到塌缩 input 子树 → 全空 → 假 COMMIT_FAILED
    //    (2026-06-14 react-select live)。故沿祖先上爬找值;停在含 2+ combobox 的共享祖先,
    //    避免页面多 select 时串到邻居 widget 的值(trigger 逻辑同款有界爬升的对称补齐)。
    const verifyScopes = (): HTMLElement[] => {
      const scopes: HTMLElement[] = [root];
      let el = root.parentElement;
      for (let i = 0; i < 4 && el && el !== document.body; i++) {
        if (el.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]').length > 1) break;
        scopes.push(el);
        el = el.parentElement;
      }
      return scopes;
    };
    const valueText = (scope: HTMLElement): string => {
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
      walk(scope);
      return norm(t);
    };
    const inputValues = (scope: HTMLElement): string[] =>
      (Array.from(scope.querySelectorAll('input:not([type="hidden"])')) as HTMLInputElement[]).map(
        (i) => norm(i.value || ""),
      );
    // 选中态信号:option 池里 aria-selected="true" 的可见选项(弹层仍开时权威,多选打钩/
    // 单选高亮);弹层关闭后池为空,退到 valueText/input.value 兜底。
    const selectedTexts = (): string[] =>
      optionPool()
        .filter(isOptSelected)
        .map((o) => norm(o.textContent || ""));
    const reflected = (l: string): boolean => {
      const w = norm(l);
      const scopes = verifyScopes();
      // exact 优先(单值显示/aria-selected/input 回填),避免 "Apple Pie" includes "Apple" 假阳。
      // exact 与 substring 各自跨全部 scope,保证 exact 整体优先于 substring(不因近 scope
      // 的 substring 命中而越过远 scope 的 exact)。
      if (selectedTexts().some((t) => t === w)) return true;
      for (const s of scopes) {
        if (valueText(s) === w || inputValues(s).some((t) => t === w)) return true;
      }
      // 再 substring(多选 chip 拼接 / 值显示含额外文本)——best-effort,同 el-select 限制
      for (const s of scopes) {
        if (valueText(s).includes(w) || inputValues(s).some((t) => t.includes(w))) return true;
      }
      return false;
    };
    const allReflected = await waitFor(
      () => (labels.every(reflected) ? true : null),
      Math.min(remaining(), 1500),
    );
    if (!allReflected) {
      const notReflected = labels.filter((l) => !reflected(l));
      return {
        error: `Selected option(s) not reflected after commit: ${notReflected.join(", ")} (combobox value shows "${valueText(root)}"). Likely a dropped click, a single-select given multiple labels, or async not settled.`,
        errorCode: "COMMIT_FAILED",
        stage: "verify",
        extras: { notReflected, valueText: valueText(root), clicked },
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
