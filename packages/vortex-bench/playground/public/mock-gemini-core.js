/**
 * mock Gemini 合成区 · 纯逻辑核心（无 DOM、无依赖）
 *
 * 用途：N023 缺陷回归夹具。页面 `mock-gemini-composer.html` 引用本模块驱动 UI，
 * 回归测试直接 import 本模块驱动同一套状态机，保证"测的就是页面跑的那份逻辑"。
 *
 * ── 重要：夹具不是 Gemini 行为权威模型 ──────────────────────────────
 * 本文件里"站点如何响应 Enter / 何时算可提交"是**为复现缺陷而设的构造**，
 * 不是对 Gemini 真实实现的断言。真实 Gemini 在 D1/D1b/D1c 上带附件提交 12/12 成功
 * （见 docs/20261006-Bug分析与修复方案.md v3），说明真实站点对小文件是**容忍**的。
 * 因此这里把两种站点性格都做成可开关（focusStrict / uploadGate），
 * 夹具既能复现缺陷，也能表现健康站点，避免做成只能复现缺陷的单向陷阱。
 *
 * 与真站实测对齐的**结构事实**（这些是实测，见 v3 文档 4.5c/4.5d）：
 *   - 编辑器为 contenteditable，可访问名 role=textbox
 *   - 「上传和工具」按钮点击后 aria-expanded 由 false → true
 *   - 菜单项**延迟插入 DOM**，实测真实 Gemini 约 t≈5.1s（D1 误判即源于此）
 *   - 菜单内含隐藏 input[type=file]，挂载后出现附件 chip
 *   - 有文字/有附件时「发送」按钮才可用
 *   - 提交成功后对话区追加一条用户消息并消费 chip
 */

/** @typedef {{id:string,name:string,size:number,status:'uploading'|'ready'}} Attachment */
/** @typedef {{text:string,attachments:{name:string,size:number}[]}} TranscriptEntry */

export const DEFAULT_CONFIG = {
  /** 菜单项插入延迟（ms）。实测真实 Gemini ≈5100；夹具默认调小以便测试快，可开关。 */
  menuItemDelayMs: 200,
  /** true：站点只响应"焦点在编辑器上"的 Enter —— 用于复现 F2/F4。 */
  focusStrict: true,
  /** 'strict'：附件未就绪时提交被忽略 —— 用于复现 F3。'tolerant'：容忍并照发（贴近实测真站）。 */
  uploadGate: 'strict',
};

export class MockGeminiComposer {
  /** @param {Partial<typeof DEFAULT_CONFIG>} [config] */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.reset();
  }

  reset() {
    /** @type {string} */
    this.editorText = '';
    /** @type {Attachment[]} */
    this.attachments = [];
    /** @type {TranscriptEntry[]} */
    this.transcript = [];
    /**
     * **观测得到的**焦点分类，不是独立设置的开关。
     * 'editor'  = document.activeElement 是编辑器（可操作目标）
     * 'body'    = document.activeElement 是 body/documentElement（**无可操作焦点目标**）
     * 'control' = document.activeElement 是按钮/chip 等其他控件（有元素焦点，但不是编辑器）
     *
     * R2 核销要求：模型 focusTarget 与 document.activeElement 不得混用。
     * 页面必须由 document.activeElement **反推**本字段，不得直接赋值。
     * 另：'control' 与 'body' 站点行为相同（都被忽略），
     * 但 P4 修复范围**只覆盖 'body'**——见 fixScope 说明。
     * @type {'editor'|'body'|'control'}
     */
    this.focusTarget = 'editor';
    this.menuOpen = false;
    this.menuItemsInserted = false;
    this._nextId = 1;
    /** @type {Map<string, any>} */
    this._timers = new Map();
    return this;
  }

  /**
   * 由调用方（页面）传入**真实** document.activeElement 来同步焦点分类。
   * 页面必须用本方法，**不得**直接写 focusTarget。
   * @param {Element|null} activeEl
   */
  syncFocusFrom(activeEl) {
    const doc = /** @type {any} */ (this)._doc;
    const el = activeEl;
    if (!el || el === doc?.body || el === doc?.documentElement) {
      this.focusTarget = 'body';
    } else if (el.getAttribute?.('role') === 'textbox' || el.isContentEditable) {
      this.focusTarget = 'editor';
    } else {
      this.focusTarget = 'control';
    }
    return this.focusTarget;
  }

  // ── 合成区 ────────────────────────────────────────────────
  setText(text) {
    this.editorText = text;
    return this;
  }

  /**
   * 挂载附件。站点逻辑在 change 之后等 uploadDelayMs 才标记 ready（复现 F3 的竞态窗口）。
   * @param {{name:string,size:number}} file
   * @param {{uploadDelayMs?:number}} [opts]
   */
  attach(file, opts = {}) {
    const delay = opts.uploadDelayMs ?? this.config.menuItemDelayMs * 5;
    /** @type {Attachment} */
    const att = {
      id: `att-${this._nextId++}`,
      name: file.name,
      size: file.size,
      status: 'uploading',
    };
    this.attachments.push(att);
    const t = setTimeout(() => {
      att.status = 'ready';
      this._timers.delete(att.id);
    }, delay);
    this._timers.set(att.id, t);
    return att.id;
  }

  /** 供测试/页面用：不等真实计时器，直接把某附件标记为就绪。 */
  markReady(attId) {
    const a = this.attachments.find((x) => x.id === attId);
    if (!a) return false;
    const t = this._timers.get(attId);
    if (t) { clearTimeout(t); this._timers.delete(attId); }
    a.status = 'ready';
    return true;
  }

  get hasPendingUpload() {
    return this.attachments.some((a) => a.status === 'uploading');
  }

  get canSubmit() {
    if (this.editorText.trim() === '' && this.attachments.length === 0) return false;
    if (this.config.uploadGate === 'strict' && this.hasPendingUpload) return false;
    return true;
  }

  /**
   * 场景 A 触发点（供**测试**使用；页面必须改用 syncFocusFrom 读真实 activeElement）。
   * @param {'editor'|'body'|'control'} target
   */
  focusTo(target) {
    this.focusTarget = target;
    return this;
  }

  /**
   * 挂载真实 document，供 syncFocusFrom 判定 body/documentElement。
   * @param {Document} doc
   */
  attachDocument(doc) {
    this._doc = doc;
    return this;
  }

  // ── 菜单 ──────────────────────────────────────────────────
  openMenu() {
    this.menuOpen = true;
    // 菜单项延迟插入：真实 Gemini 实测 ≈5.1s，这是 D1 把"未渲染"误判为"渲染异常"的成因。
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.menuItemsInserted = true;
        this._timers.delete('menu');
        resolve(true);
      }, this.config.menuItemDelayMs);
      this._timers.set('menu', t);
    });
  }

  closeMenu() {
    this.menuOpen = false;
    this.menuItemsInserted = false;
    return this;
  }

  // ── 提交 ──────────────────────────────────────────────────
  /**
   * 提交处理。site 只会对"送达编辑器"且"内容可提交"的 Enter 做出反应。
   *
   * focusStrict 描述的是**站点行为**（非编辑器焦点时忽略 Enter）。
   * 注意：'body' 与 'control' 站点行为相同——这与真实夹具 E2E 一致
   * （D2 中焦点为 button#btnStealFocus 时 transcript 同样为 0）。
   * 但 P4 修复范围**只覆盖 'body'**（无可操作焦点目标），
   * 'control' 属于已知未覆盖残留，见 docs 残留不确定性。
   *
   * @param {'Enter'|'send-button'} [via]
   * @returns {{ok:boolean, reason?:string, entry?:TranscriptEntry}}
   */
  submit(via = 'Enter') {
    // ① 焦点不是编辑器 → 站点收不到这条 Enter，什么都不发生
    if (via === 'Enter' && this.config.focusStrict && this.focusTarget !== 'editor') {
      return {
        ok: false,
        reason: this.focusTarget === 'body' ? 'no-actionable-focus-target' : 'focus-not-on-editor',
      };
    }
    // ② 附件仍在上传 → 站点忽略本次提交（复现 F3）
    if (this.config.uploadGate === 'strict' && this.hasPendingUpload) {
      return { ok: false, reason: 'upload-in-progress' };
    }
    // ③ 空提交
    if (this.editorText.trim() === '' && this.attachments.length === 0) {
      return { ok: false, reason: 'nothing-to-send' };
    }
    const entry = {
      text: this.editorText,
      attachments: this.attachments.map((a) => ({ name: a.name, size: a.size })),
    };
    this.transcript.push(entry);
    this.editorText = '';
    this.attachments = [];
    return { ok: true, entry };
  }

  dispose() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    return this;
  }
}
