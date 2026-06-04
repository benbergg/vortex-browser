// packages/vortex-bench/src/runner/judge.ts
// I/O:每页 observe+screenshot → 2 轮 LLM 自一致 → recall-miss findings。
// synth 模式额外跑消融 TP run。无离线单测,靠 live 验收。

import { readFile } from "node:fs/promises";
import { createMcpConnection, closeMcpConnection, type McpConnection } from "./mcp-client.js";
import { parseObserveSnapshot } from "./observe-parser.js";
import { buildJudgePrompt } from "./judge-prompt.js";
import { parseJudgeResponse } from "./judge-parse.js";
import { intersectPasses } from "./judge-consistency.js";
import { reconcileByBbox } from "./judge-match.js";
import { ablateRows, computeCalibration } from "./judge-calibrate.js";
import { callJudge, type JudgeImage } from "./judge-llm.js";
import type { ScreenshotProfile } from "./judge-screenshot-profile.js";
import { profilePromptHint } from "./judge-screenshot-profile.js";
import type { ParsedObserve } from "../scan-types.js";
import type { ClaimedMiss, JudgePageResult } from "../judge-types.js";
import type { Finding } from "../scan-types.js";

export interface JudgeTarget {
  /** navigate 到此 URL;与 currentTab 二选一(live) */
  url?: string;
  currentTab?: boolean;
  /** synth fixture 路径(playground 相对,如 /synth/x.html);设了走 synth 校准模式 */
  synthPath?: string;
  /** 报告里的 page 名 */
  page: string;
}

export interface JudgeOptions {
  mcpBin?: string;
  model: string;
  playgroundUrl: string;
  /** synth 模式消融抽行数 */
  ablate?: number;
  /** 截图 profile(format/quality/dpr);省略时等同于 q70 默认 */
  screenshotProfile?: ScreenshotProfile;
  /** 可选 MCP 调用注入(测试用 mock)。传入时跳过真实 MCP 连接 */
  mcpCall?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** 从 MCP tool 响应里提取纯文本(与 robustness-live.ts 对齐) */
function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((i) => i && typeof i === "object" && "text" in i && (i as { type?: string }).type === "text")
    .map((i) => String((i as { text: unknown }).text))
    .join("\n");
}

/**
 * 从 screenshot MCP 响应的 content 数组里选出第一个含 savedTo 字段的 text block。
 * withEvents() 会在 content 末尾追加 "[vortex-events]..." text block,
 * 若将所有 text block 拼接后再 JSON.parse 则因多段文本拼接后非法 JSON 而抛错。
 * 此函数逐块解析,只取第一个能 JSON.parse 且含 savedTo 字段的块,避免该问题。
 */
export function pickSavedToPath(content: unknown[]): string | null {
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type !== "text" || typeof b.text !== "string") continue;
    try {
      const parsed = JSON.parse(b.text) as { savedTo?: unknown };
      if (typeof parsed.savedTo === "string") return parsed.savedTo;
    } catch {
      // 非 JSON 或无 savedTo,继续遍历下一块
    }
  }
  return null;
}

/**
 * screenshot MCP 返回的图像:
 *   - inline image block: content 里 {type:"image", data:<base64>, mimeType}
 *   - file/超大模式: text block,JSON 内含 {savedTo, width, height, bytes}
 * 两种形态都取成 {base64, mimeType}。
 */
async function extractImage(res: unknown): Promise<JudgeImage> {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("screenshot 返回无 content");

  // inline image block
  const imgBlock = content.find(
    (i) => i && typeof i === "object" && (i as { type?: string }).type === "image",
  );
  if (imgBlock) {
    const o = imgBlock as { data: string; mimeType: string };
    return { base64: o.data, mimeType: o.mimeType };
  }

  // file 模式:逐块解析 text block,取第一个含 savedTo 的 JSON 块
  // (不能拼接所有 text block 再 parse,withEvents() 会追加非 JSON 的事件块导致拼接后非法)
  const savedTo = pickSavedToPath(content);
  if (savedTo) {
    const buf = await readFile(savedTo);
    const mime = savedTo.endsWith(".png") ? "image/png" : "image/jpeg";
    return { base64: buf.toString("base64"), mimeType: mime };
  }

  throw new Error("无法从 screenshot 返回取得图像");
}

type CallFn = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** 对给定 observe 解析结果跑 2 轮自一致 → 确认 miss 列表 */
async function judgeTwice(
  parsed: ParsedObserve,
  image: JudgeImage,
  model: string,
  promptHint?: string,
): Promise<ClaimedMiss[]> {
  const prompt = buildJudgePrompt(parsed, promptHint);
  const r1 = parseJudgeResponse(await callJudge({ model, prompt, image }));
  const r2 = parseJudgeResponse(await callJudge({ model, prompt, image }));
  return intersectPasses(r1, r2);
}

/** 每页编排器:navigate → observe → screenshot → judge(2 轮) → [synth: 消融 TP run] */
export async function judgePage(
  target: JudgeTarget,
  opts: JudgeOptions,
): Promise<JudgePageResult> {
  // mcpCall 注入(测试 mock)或真实 MCP 连接二选一
  let mcp: McpConnection | null = null;
  let call: CallFn;

  if (opts.mcpCall) {
    // 测试 mock 注入:直接使用传入的函数,无需建立 MCP 连接
    call = opts.mcpCall;
  } else {
    mcp = await createMcpConnection({
      command: process.execPath,
      args: [opts.mcpBin!],
      env: { ...(process.env as Record<string, string>) },
    });
    call = (name, args) => mcp!.client.callTool({ name, arguments: args });
  }

  const profile = opts.screenshotProfile;
  const promptHint = profile ? profilePromptHint(profile) : "";
  const ablate = opts.ablate ?? 3;

  try {
    // 导航(可选)
    if (target.synthPath) {
      await call("vortex_navigate", { url: `${opts.playgroundUrl}${target.synthPath}` });
    } else if (target.url) {
      await call("vortex_navigate", { url: "about:blank" });
      await call("vortex_navigate", { url: target.url });
    }
    // currentTab 模式:不导航,直接在当前 tab 操作
    await call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });

    // observe(含 bbox) + screenshot
    const parsed = parseObserveSnapshot(
      extractText(await call("vortex_observe", { includeBoxes: true })),
    );
    // 根据 profile 决定截图参数;png 不带 quality,dpr=1 不传 deviceScaleFactor
    const screenshotArgs: Record<string, unknown> = {
      format: profile?.format ?? "jpeg",
      ...(profile?.format === "png"
        ? {}
        : { quality: profile?.quality ?? 70 }),
      ...(profile?.deviceScaleFactor != null && profile.deviceScaleFactor !== 1
        ? { deviceScaleFactor: profile.deviceScaleFactor }
        : {}),
    };
    const image = await extractImage(await call("vortex_screenshot", screenshotArgs));

    // FP run:原样列表 2 轮自一致取交集
    const confirmed = await judgeTwice(parsed, image, opts.model, promptHint || undefined);
    // live 路径加 bbox 兜底过滤判官假阳(候选左上角落在某 observe ref bbox 内 → observe
    // 已覆盖,丢弃;京东 banner "手机直降" vs observe "大促" 假阳修复,2026-06-04)。
    // synth 校准路径仍用原始 confirmed(下方 computeCalibration 的 FP 口径不变)。
    const liveMisses = target.synthPath
      ? confirmed
      : reconcileByBbox(confirmed, parsed.rows.filter((r) => r.frameId === 0));
    const findings: Finding[] = liveMisses.map((m) => ({
      severity: "P0",
      kind: "recall-miss",
      fixture: target.page,
      pattern: "_judge",
      detail: `${m.label} @[${m.bbox.join(",")}] — ${m.reason}`,
    }));

    const result: JudgePageResult = {
      page: target.page,
      totalObserveRows: parsed.rows.filter((r) => r.frameId === 0).length,
      confirmedMisses: liveMisses,
      findings,
      ...(profile
        ? {
            profile: {
              name: profile.name,
              format: profile.format,
              quality: profile.quality,
              deviceScaleFactor: profile.deviceScaleFactor,
              perFrame: profile.perFrame,
            },
          }
        : {}),
    };

    // synth 模式:消融 TP run(重渲染抽行后的列表喂第二次判官)
    if (target.synthPath) {
      // 注意:ablateRows 用 observe 全部输出行作 interactive 代理。
      // clean synth 页上 observe ≈ interactive,可接受。
      // 若 observe 含 precision-miss 噪声(非真正可交互但被误报的元素),
      // 会污染 TP 口径(ablated 含噪声行 → recovered 偏高 → 查全率偏宽松)。
      // live Step 2 标定时知情,排他校验留 backlog。
      const { kept, ablated } = ablateRows(parsed.rows, ablate);
      const ablatedParsed: ParsedObserve = { ...parsed, rows: kept };
      // TP run:把 kept 列表喂判官,判官报的 miss 里应含被抽掉的那些行
      const tpMisses = await judgeTwice(ablatedParsed, image, opts.model, promptHint || undefined);
      result.calibration = computeCalibration(confirmed, tpMisses, ablated);
      // synth 已知干净页:FP miss 仅用于校准,不当真 finding 上报
      result.findings = [];
    }

    return result;
  } catch (err) {
    return {
      page: target.page,
      totalObserveRows: 0,
      confirmedMisses: [],
      findings: [],
      ...(profile
        ? {
            profile: {
              name: profile.name,
              format: profile.format,
              quality: profile.quality,
              deviceScaleFactor: profile.deviceScaleFactor,
              perFrame: profile.perFrame,
            },
          }
        : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (mcp) await closeMcpConnection(mcp);
  }
}
