/**
 * Author: qingwa
 * Description: Registers the `vortex observe` command and keeps the ref → index context.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { VtxErrorCode } from "@vortex-browser/shared";
import { sendRequest, formatCliError } from "../client.js";
import { printResponse, exitWithError } from "../output.js";
import { getGlobalOpts } from "./helpers.js";

/** observe 的枚举参数，取值与公开工具契约一致（packages/mcp/src/tools/schemas-public.ts）。 */
const DETAIL_VALUES = ["compact", "full"] as const;
const SCOPE_VALUES = ["viewport", "full"] as const;
const FILTER_VALUES = ["interactive", "all"] as const;
const FRAMES_VALUES = ["main", "all-same-origin", "all-permitted", "all"] as const;

/**
 * 枚举值就地校验：扩展对未知 frames 取值会静默退化成只扫主 frame，
 * 与其让用户拿到半份快照，不如当场报错说清可选值。
 */
function requireEnum<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  exitWithError(formatCliError({
    code: VtxErrorCode.INVALID_PARAMS,
    message: `observe: ${name} must be one of ${allowed.join("|")}, got ${String(value)}`,
  }));
}

/** observe 元素里可用于定位的最小字段集。 */
interface ObserveElement {
  index?: number;
  ref?: string;
  frameId?: number;
}

/** 一个 ref 在快照里的落点（扩展端 resolveTarget 认 index + snapshotId）。 */
export interface RefEntry {
  index: number;
  frameId?: number;
}

/** 最近一次 observe 的快照上下文，act 用它把 @ref 翻成 index + snapshotId。 */
export interface SnapshotContext {
  snapshotId: string;
  capturedAt: number;
  refs: Record<string, RefEntry>;
}

/** CLI 本地状态目录：默认 ~/.vortex/cli，可用 VORTEX_CLI_STATE_DIR 覆盖（测试用）。 */
function stateDir(): string {
  return process.env.VORTEX_CLI_STATE_DIR ?? join(homedir(), ".vortex", "cli");
}

/** 会话名可能带路径分隔符，落盘前先收敛成安全文件名。 */
function safeSessionName(session: string): string {
  return session.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function snapshotContextPath(session: string): string {
  return join(stateDir(), `${safeSessionName(session)}.snapshot.json`);
}

/**
 * 落盘最近一次 observe 的快照上下文。
 * 写盘失败不致命（observe 本身已经成功），只把原因交回调用方决定要不要提示。
 */
export function saveSnapshotContext(session: string, context: SnapshotContext): string | undefined {
  const path = snapshotContextPath(session);
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(context), "utf8");
    return undefined;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 读取最近一次 observe 的快照上下文；没有或读坏了都当作「没有快照」。 */
export function loadSnapshotContext(session: string): SnapshotContext | undefined {
  try {
    const raw = readFileSync(snapshotContextPath(session), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const ctx = parsed as Partial<SnapshotContext>;
    if (typeof ctx.snapshotId !== "string" || !ctx.snapshotId) return undefined;
    const refs: Record<string, RefEntry> = {};
    if (ctx.refs && typeof ctx.refs === "object") {
      for (const [ref, entry] of Object.entries(ctx.refs)) {
        if (!entry || typeof entry !== "object") continue;
        const index = (entry as RefEntry).index;
        if (typeof index !== "number") continue;
        const frameId = (entry as RefEntry).frameId;
        refs[ref] = typeof frameId === "number" ? { index, frameId } : { index };
      }
    }
    return { snapshotId: ctx.snapshotId, capturedAt: ctx.capturedAt ?? 0, refs };
  } catch {
    return undefined;
  }
}

/**
 * 从 observe 返回的 elements 里抽出 ref 列表。
 *
 * 只认服务端**明确给出**的非空 `ref`：compact 形态的元素没有 ref 字段，
 * 自行按 index 推导等于造一个服务端没承诺过的引用 —— 那样的 ref 落不到
 * 扩展的快照里，act 拿着它只会打空。
 */
export function extractRefs(elements: unknown): Array<{ ref: string; entry: RefEntry }> {
  if (!Array.isArray(elements)) return [];
  const out: Array<{ ref: string; entry: RefEntry }> = [];
  const seen = new Set<string>();
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const element = raw as ObserveElement;
    if (typeof element.ref !== "string" || element.ref.length === 0) continue;
    if (typeof element.index !== "number") continue;
    const frameId = typeof element.frameId === "number" ? element.frameId : undefined;
    const ref = element.ref;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      ref,
      entry: frameId === undefined ? { index: element.index } : { index: element.index, frameId },
    });
  }
  return out;
}

/**
 * `vortex observe` —— 抓一份可访问性快照，并把元素的 ref 列出来。
 *
 * stdout 保持 NDJSON（可直接喂 jq），`[refs]` 行走 stderr：辅助信息混进 stdout
 * 会让下游 jq 拿到非 JSON 行。参见 packages/cli/src/output.ts 的同款取舍。
 */
export function registerObserveCommand(program: Command): void {
  program
    .command("observe")
    .description("Capture a snapshot and list element refs (refs line goes to stderr; stdout stays NDJSON)")
    .option("--detail <mode>", "compact | full", "full")
    .option("--scope <scope>", "viewport | full", "viewport")
    .option("--frames <frames>", "main | all-same-origin | all-permitted | all", "main")
    .option("--filter <filter>", "interactive | all", "interactive")
    .option("--include-boxes", "include element bounding boxes")
    .option("--timeout <ms>", "snapshot timeout in milliseconds", parseInt)
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getGlobalOpts(cmd);
      const detail = requireEnum("--detail", opts.detail, DETAIL_VALUES);
      const scope = requireEnum("--scope", opts.scope, SCOPE_VALUES);
      const frames = requireEnum("--frames", opts.frames, FRAMES_VALUES);
      const filter = requireEnum("--filter", opts.filter, FILTER_VALUES);
      try {
        const params: Record<string, unknown> = {
          format: detail,
          viewport: scope === "full" ? "full" : "visible",
          frames,
          filter,
        };
        if (opts.includeBoxes) params.includeBoxes = true;
        if (opts.timeout != null) params.timeout = opts.timeout;
        if (frameId != null) params.frameId = frameId;

        const resp = await sendRequest("observe.snapshot", params, { port, session, tabId: tab });
        printResponse(resp, { pretty, quiet });

        const result = resp.result as { snapshotId?: string; elements?: unknown } | undefined;
        const refs = extractRefs(result?.elements);
        if (refs.length > 0) {
          console.error(`[refs] ${refs.map((item) => item.ref).join(" ")}`);
        }
        if (typeof result?.snapshotId === "string" && result.snapshotId) {
          // 上下文永远反映「最近一次 observe」：compact 形态没有服务端 ref，
          // refs 就是空的，act 拿任何 ref 来都会命中「未知 ref」分支。
          const failed = saveSnapshotContext(session, {
            snapshotId: result.snapshotId,
            capturedAt: Date.now(),
            refs: Object.fromEntries(refs.map((item) => [item.ref, item.entry])),
          });
          if (failed) {
            console.error(`[vortex-cli] observe snapshot context not saved: ${failed}`);
          }
        }
      } catch (err: any) {
        // client.sendRequest 已用 formatCliError 渲染过，这里原样透出（不二次格式化）。
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });
}
