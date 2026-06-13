/**
 * TDD 测试集：getEventListeners 真值交互信号
 *
 * 任务 T3：CDP getEventListeners 作为高优先交互判定信号。
 * 凌驾于 cursor:pointer 启发式之上，但**绝不剔除**已有启发式识别的元素（并集增强）。
 *
 * 测试覆盖：
 *   1. 有监听器（click/mousedown/mouseup/pointerdown/pointerup）的元素返回索引集合
 *   2. [listener] 标记出现在渲染输出
 *   3. 元素总数 >N 时跳过，返回空集，不抛
 *   4. CDP 失败时回退空集，不抛
 *   5. 召回不回退：原启发式判为交互的元素在 listenerIndices 为空时仍保留
 *   6. listenerInteractive 仅新增信号，不删除原有元素（并集增强语义）
 *   7. mouseup/pointerup 也触发 listenerInteractive（事件类型补全覆盖）
 */

import { describe, it, expect, vi } from "vitest";
import {
  collectJsListenerIndices,
  JS_LISTENER_ELEMENT_CAP,
  applyListenerSignal,
} from "../src/handlers/observe-js-listener.js";
import { renderObserveTree } from "../../mcp/src/lib/observe-render.js";

// --- 工具函数 ---

/** 构造最小 DebuggerManager mock */
function makeDbg(opts: {
  evalResult?: unknown;
  evalThrows?: boolean;
}): { enableDomain: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> } {
  const sendCommand = vi.fn().mockImplementation((_tabId: number, method: string) => {
    if (opts.evalThrows) throw new Error("CDP error");
    if (method === "Runtime.evaluate") {
      return Promise.resolve({ result: { value: opts.evalResult ?? null } });
    }
    return Promise.resolve({});
  });
  const attach = vi.fn().mockResolvedValue(undefined);
  const enableDomain = vi.fn().mockResolvedValue(undefined);
  return { enableDomain, sendCommand, attach };
}

// ---- 测试 collectJsListenerIndices ----

describe("collectJsListenerIndices", () => {
  it("CDP 返回有监听器的索引集合", async () => {
    // 模拟 CDP Runtime.evaluate 返回 {0: true, 2: true}（元素 0 和 2 有监听器）
    const dbg = makeDbg({ evalResult: { 0: true, 2: true } });
    const indices = await collectJsListenerIndices(dbg as any, 1, 0);
    expect(indices).toBeInstanceOf(Set);
    expect(indices.has(0)).toBe(true);
    expect(indices.has(1)).toBe(false);
    expect(indices.has(2)).toBe(true);
  });

  it("CDP 返回 null（>N 元素跳过路径）→ 返回空集，不抛", async () => {
    const dbg = makeDbg({ evalResult: null });
    const indices = await collectJsListenerIndices(dbg as any, 1, 0);
    expect(indices.size).toBe(0);
  });

  it("CDP 抛出错误 → 返回空集，不抛（回退启发式）", async () => {
    const dbg = makeDbg({ evalThrows: true });
    const indices = await collectJsListenerIndices(dbg as any, 1, 0);
    expect(indices.size).toBe(0);
  });

  it("JS_LISTENER_ELEMENT_CAP 常量存在且为正整数（参考 browser-use ~10000）", () => {
    expect(JS_LISTENER_ELEMENT_CAP).toBeGreaterThan(0);
    expect(Number.isInteger(JS_LISTENER_ELEMENT_CAP)).toBe(true);
  });

  it("CDP 返回空对象 → 空集", async () => {
    const dbg = makeDbg({ evalResult: {} });
    const indices = await collectJsListenerIndices(dbg as any, 1, 0);
    expect(indices.size).toBe(0);
  });

  it("CDP 返回含非数字键的对象 → 仅数字键入集", async () => {
    // 防御：有时 CDP 返回结果可能含非数字键
    const dbg = makeDbg({ evalResult: { 0: true, foo: true, 3: true } });
    const indices = await collectJsListenerIndices(dbg as any, 1, 0);
    expect(indices.has(0)).toBe(true);
    expect(indices.has(3)).toBe(true);
    expect(indices.size).toBe(2);
  });

  it("mouseup/pointerup 监听器元素同样被收入索引集（事件类型补全）", async () => {
    // 模拟页面侧表达式识别到 mouseup(idx=1) 和 pointerup(idx=3) 监听器
    // CDP 返回的是已过滤后的索引映射（页面侧 CLICK_TYPES 包含 mouseup/pointerup 后正确过滤）
    const dbg = makeDbg({ evalResult: { 1: true, 3: true } });
    const indices = await collectJsListenerIndices(dbg as any, 1, 0);
    // 两者均应进入集合（证明调用方正确消费 CDP 结果）
    expect(indices.has(1)).toBe(true);
    expect(indices.has(3)).toBe(true);
    expect(indices.has(0)).toBe(false);
    expect(indices.size).toBe(2);
  });
});

// ---- 测试 applyListenerSignal（并集增强）----

describe("applyListenerSignal", () => {
  it("有监听器的元素被标记 listenerInteractive=true", () => {
    const elements = [
      { role: "div", name: "按钮A" },
      { role: "div", name: "按钮B" },
      { role: "div", name: "按钮C" },
    ];
    const listenerIndices = new Set([0, 2]); // 元素 0 和 2 有监听器
    applyListenerSignal(elements as any, listenerIndices);
    expect((elements[0] as any).listenerInteractive).toBe(true);
    expect((elements[1] as any).listenerInteractive).toBeUndefined(); // 不误标
    expect((elements[2] as any).listenerInteractive).toBe(true);
  });

  it("listenerIndices 为空 → 无元素被标记（召回不回退：元素集大小不变）", () => {
    const elements = [
      { role: "button", name: "提交", reactClickable: true as const },
      { role: "div", name: "关闭" },
    ];
    const original = elements.map((e) => ({ ...e }));
    applyListenerSignal(elements as any, new Set());
    // 召回铁律：元素数量不变
    expect(elements.length).toBe(original.length);
    // 原有元素字段不被删除
    expect((elements[0] as any).reactClickable).toBe(true);
    expect((elements[0] as any).name).toBe("提交");
    // 无 listenerInteractive 被误打
    expect((elements[0] as any).listenerInteractive).toBeUndefined();
  });

  it("已有 reactClickable 的元素被追加 listenerInteractive，不删除原字段", () => {
    const elements = [
      { role: "div", name: "菜单项", reactClickable: true as const },
    ];
    applyListenerSignal(elements as any, new Set([0]));
    expect((elements[0] as any).listenerInteractive).toBe(true);
    expect((elements[0] as any).reactClickable).toBe(true); // 不丢
    expect((elements[0] as any).name).toBe("菜单项"); // 不丢
  });

  it("listenerIndices 越界（超过 elements 长度）→ 不崩溃", () => {
    const elements = [{ role: "button", name: "保存" }];
    // 索引 99 超出范围，应静默跳过
    expect(() => applyListenerSignal(elements as any, new Set([0, 99]))).not.toThrow();
    expect((elements[0] as any).listenerInteractive).toBe(true);
  });
});

// ---- 测试渲染层 [listener] 标记 ----

describe("observe-render [listener] 标记", () => {
  it("listenerInteractive=true → 渲染输出含 [listener]", () => {
    const data = {
      snapshotId: "s1",
      url: "https://example.com",
      elements: [
        {
          index: 0,
          tag: "div",
          role: "div",
          name: "自定义按钮",
          frameId: 0,
          listenerInteractive: true,
        },
      ],
    };
    const out = renderObserveTree(data as any, null);
    expect(out).toContain("[listener]");
  });

  it("reactClickable=true 且 listenerInteractive=true → 同时含 [cursor=pointer] 和 [listener]", () => {
    const data = {
      snapshotId: "s1",
      url: "https://example.com",
      elements: [
        {
          index: 0,
          tag: "div",
          role: "div",
          name: "React 按钮",
          frameId: 0,
          reactClickable: true as const,
          listenerInteractive: true,
        },
      ],
    };
    const out = renderObserveTree(data as any, null);
    expect(out).toContain("[cursor=pointer]");
    expect(out).toContain("[listener]");
  });

  it("无 listenerInteractive → 不含 [listener]", () => {
    const data = {
      snapshotId: "s1",
      url: "https://example.com",
      elements: [
        {
          index: 0,
          tag: "button",
          role: "button",
          name: "提交",
          frameId: 0,
        },
      ],
    };
    const out = renderObserveTree(data as any, null);
    expect(out).not.toContain("[listener]");
  });
});

// ---- 召回不回退：真值信号只增不删 ----

describe("召回零回退铁律", () => {
  it("原 cursor:pointer 启发式识别的元素在监听信号空时仍完整保留", () => {
    // 模拟：原有 2 个启发式元素，listenerIndices 为空集（CDP 失败场景）
    const elements = [
      { role: "div", name: "菜单项", reactClickable: true as const },
      { role: "button", name: "提交" },
    ];
    applyListenerSignal(elements as any, new Set()); // 空集 = CDP 失败回退
    // 所有元素仍在
    expect(elements.length).toBe(2);
    // 原有字段完整
    expect(elements[0].name).toBe("菜单项");
    expect((elements[0] as any).reactClickable).toBe(true);
    expect(elements[1].name).toBe("提交");
    // 无误标
    expect((elements[0] as any).listenerInteractive).toBeUndefined();
    expect((elements[1] as any).listenerInteractive).toBeUndefined();
  });

  it("listenerIndices 非空时，已有元素仍保留（不因监听信号删除）", () => {
    // 元素 0 有监听器，元素 1 没有 → 元素 1 仍保留（不被删）
    const elements = [
      { role: "div", name: "有监听" },
      { role: "div", name: "无监听但有 cursor:pointer", reactClickable: true as const },
    ];
    applyListenerSignal(elements as any, new Set([0]));
    expect(elements.length).toBe(2); // 元素集大小恒定
    expect((elements[0] as any).listenerInteractive).toBe(true);
    expect((elements[1] as any).listenerInteractive).toBeUndefined(); // 不误标
    expect((elements[1] as any).reactClickable).toBe(true); // 原有标记不删
  });
});
