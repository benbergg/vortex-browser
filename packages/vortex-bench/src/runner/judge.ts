// packages/vortex-bench/src/runner/judge.ts
// I/O:每页 observe+screenshot → 2 轮 LLM 自一致 → recall-miss findings。
// synth 模式额外跑消融 TP run。无离线单测,靠 live 验收。

import { readFile } from "node:fs/promises";
import { createMcpConnection, closeMcpConnection, type McpConnection } from "./mcp-client.js";
import { parseObserveSnapshot } from "./observe-parser.js";
import { buildJudgePrompt } from "./judge-prompt.js";
import { parseJudgeResponse } from "./judge-parse.js";
import { intersectPasses } from "./judge-consistency.js";
import { ablateRows, computeCalibration } from "./judge-calibrate.js";
import { callJudge, type JudgeImage } from "./judge-llm.js";
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
  mcpBin: string;
  model: string;
  playgroundUrl: string;
  /** synth 模式消融抽行数 */
  ablate: number;
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

  // file 模式:text block 内是 JSON { savedTo, width, height, bytes }
  const txt = extractText(res);
  try {
    const meta = JSON.parse(txt) as { savedTo?: string };
    if (meta.savedTo) {
      const buf = await readFile(meta.savedTo);
      const mime = meta.savedTo.endsWith(".png") ? "image/png" : "image/jpeg";
      return { base64: buf.toString("base64"), mimeType: mime };
    }
  } catch {
    // fallthrough — JSON 解析失败或无 savedTo
  }

  throw new Error("无法从 screenshot 返回取得图像");
}

type CallFn = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** 对给定 observe 解析结果跑 2 轮自一致 → 确认 miss 列表 */
async function judgeTwice(
  parsed: ParsedObserve,
  image: JudgeImage,
  model: string,
): Promise<ClaimedMiss[]> {
  const prompt = buildJudgePrompt(parsed);
  const r1 = parseJudgeResponse(await callJudge({ model, prompt, image }));
  const r2 = parseJudgeResponse(await callJudge({ model, prompt, image }));
  return intersectPasses(r1, r2);
}

/** 每页编排器:navigate → observe → screenshot → judge(2 轮) → [synth: 消融 TP run] */
export async function judgePage(
  target: JudgeTarget,
  opts: JudgeOptions,
): Promise<JudgePageResult> {
  const mcp: McpConnection = await createMcpConnection({
    command: process.execPath,
    args: [opts.mcpBin],
    env: { ...(process.env as Record<string, string>) },
  });

  // callTool 签名与 robustness-live.ts 保持一致
  const call: CallFn = (name, args) =>
    mcp.client.callTool({ name, arguments: args });

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
    const image = await extractImage(await call("vortex_screenshot", { format: "jpeg", quality: 70 }));

    // FP run:原样列表 2 轮自一致取交集
    const confirmed = await judgeTwice(parsed, image, opts.model);
    const findings: Finding[] = confirmed.map((m) => ({
      severity: "P0",
      kind: "recall-miss",
      fixture: target.page,
      pattern: "_judge",
      detail: `${m.label} @[${m.bbox.join(",")}] — ${m.reason}`,
    }));

    const result: JudgePageResult = {
      page: target.page,
      totalObserveRows: parsed.rows.filter((r) => r.frameId === 0).length,
      confirmedMisses: confirmed,
      findings,
    };

    // synth 模式:消融 TP run(重渲染抽行后的列表喂第二次判官)
    if (target.synthPath) {
      const { kept, ablated } = ablateRows(parsed.rows, opts.ablate);
      const ablatedParsed: ParsedObserve = { ...parsed, rows: kept };
      // TP run:把 kept 列表喂判官,判官报的 miss 里应含被抽掉的那些行
      const tpMisses = await judgeTwice(ablatedParsed, image, opts.model);
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
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await closeMcpConnection(mcp);
  }
}
