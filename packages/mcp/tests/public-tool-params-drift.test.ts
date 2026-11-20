// 防漂移（参数级）：PUBLIC_TOOLS 与内部 schemas.ts 的**参数集合**必须一致，
// 内部有、公开没有的参数必须逐条显式白名单（附理由）。
//
// 为什么锁这一侧（内部有 → 公开没有）：
//   内部 schema 有、公开面没有 ⇒ 运行时真支持、模型看不见 ⇒ 模型只能瞎猜参数名，
//   或者把参数塞进别的容器（如 D-1：顶层 pattern/includeResources 没声明，
//   模型塞进 filter，filter 是字符串时又被 Object.assign 静默丢弃）。
//   这类缺陷 SAST 看不见、只有真实 transcript 里才暴露，所以要有锁。
//
// 覆盖范围（限制，明说）：
//   本锁只覆盖**内部面有同名工具**的那些公开工具。vortex_debug_read 等 L4 一代工具
//   在内部 schemas.ts 里没有对应物 → 走另一条锁：直接断言公开 schema 对象
//   （packages/mcp/tests/vortex-debug-read-filter-description.test.ts 的 D-1 用例）。
//   内部有、公开没有的参数共 14 个，全部登记在下面的白名单里。
//
// 为什么只锁这一侧、不锁「公开有、内部没有」：
//   内部 schemas.ts 是 v0.6 内化面（25 个工具内部化），公开面是 L4 一代工具。
//   公开面独有的参数（frameId/force/quality…）在 L4 runtime 里真实存在，
//   内部面没有只是因为它是旧代实现 —— 锁这一侧会全是假红。
//
// 与 public-tool-names-drift.test.ts 同范式：集合级漂移锁 + 显式白名单。
import { describe, it, expect } from "vitest";
import { PUBLIC_TOOLS } from "../src/tools/schemas-public.js";
import { getAllToolDefs } from "../src/tools/schemas.js";

/**
 * 内部有、公开没有的参数 —— 逐条显式登记 + 理由。
 * 新增内部参数而没有在这里登记 → 测试红（这就是本锁的目的）。
 */
const INTERNAL_ONLY_WHITELIST: Record<string, Record<string, string>> = {
  vortex_observe: {
    detail: "历史兼容：内部旧代观察档位参数，公开面刻意不暴露",
    viewport: "历史兼容：内部旧代视口参数，公开面不暴露",
    maxElements: "历史兼容：内部旧代元素数上限，公开面不暴露",
    includeAX: "历史兼容：内部旧代 AX 开关，公开面不暴露",
    includeText: "历史兼容：内部旧代文本开关，公开面不暴露",
  },
  vortex_navigate: {
    waitForLoad: "历史兼容：旧命名，公开面用 waitUntil 表达",
    timeout: "历史兼容：旧命名，公开面用 timeoutMs",
  },
  vortex_screenshot: {
    clip: "历史兼容：旧命名，公开面用 target 表达裁剪区域",
    returnMode: "历史兼容：旧命名，公开面默认返回 PNG",
    frameRef: "历史兼容：旧命名，公开面用 frameId",
  },
  vortex_evaluate: {
    frameRef: "历史兼容：旧命名，公开面用 frameId",
  },
  vortex_mouse_click: {
    clickCount: "历史兼容：旧命名，公开面用 clicks",
  },
  vortex_fill: {
    fallbackToNative: "历史兼容：旧命名，公开面用 force",
    timeout: "历史兼容：旧命名，公开面用 timeoutMs",
  },
};

const internalMap = new Map(getAllToolDefs().map((d) => [d.name, d]));

function propsOf(schema: { properties?: Record<string, unknown> } | undefined): string[] {
  return Object.keys(schema?.properties ?? {});
}

describe("公开 schema 与内部 schema 的参数级漂移", () => {
  it("内部有、公开没有的参数必须逐条显式白名单", () => {
    const offenders: string[] = [];
    for (const pub of PUBLIC_TOOLS) {
      const internal = internalMap.get(pub.name);
      if (!internal) continue; // L4 一代工具在内部面没有对应物 → 本锁不适用
      const pubProps = propsOf(pub.schema);
      const allowed = INTERNAL_ONLY_WHITELIST[pub.name] ?? {};
      for (const p of propsOf(internal.schema)) {
        if (pubProps.includes(p)) continue;
        if (allowed[p]) continue;
        offenders.push(`${pub.name}.${p}`);
      }
    }
    expect(
      offenders,
      `以下内部参数在公开面缺失，必须补声明或在 INTERNAL_ONLY_WHITELIST 里登记理由: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("白名单本身不腐烂（登记的参数必须仍然内部有、公开没有）", () => {
    const stale: string[] = [];
    for (const [tool, params] of Object.entries(INTERNAL_ONLY_WHITELIST)) {
      const internal = internalMap.get(tool);
      const pub = PUBLIC_TOOLS.find((t) => t.name === tool);
      if (!internal || !pub) {
        stale.push(`${tool}（工具已不存在）`);
        continue;
      }
      const pubProps = propsOf(pub.schema);
      for (const p of Object.keys(params)) {
        if (pubProps.includes(p)) stale.push(`${tool}.${p}（公开面已声明，无需白名单）`);
        else if (!propsOf(internal.schema).includes(p)) stale.push(`${tool}.${p}（内部已不再有此参数）`);
      }
    }
    expect(stale, `白名单已过期，请删除: ${stale.join(", ")}`).toEqual([]);
  });

  it("白名单非空且确有历史漂移（防两侧同时空掉的假绿）", () => {
    expect(Object.keys(INTERNAL_ONLY_WHITELIST).length).toBeGreaterThan(0);
    const total = Object.values(INTERNAL_ONLY_WHITELIST).reduce((n, m) => n + Object.keys(m).length, 0);
    expect(total).toBeGreaterThan(0);
  });
});
