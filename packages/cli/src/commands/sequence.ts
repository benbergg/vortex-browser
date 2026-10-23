/**
 * Author: qingwa
 * Description: Registers the `vortex sequence` command (multi-step, each step self-verified).
 */
import type { Command } from "commander";
import { splitDiagnosis, runSequence } from "@vortex-browser/shared";
import type { OnFailure, SequenceStepInput } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { sendRequest, formatCliError } from "../client.js";
import { printSequenceResult, exitWithError } from "../output.js";
import { getGlobalOpts } from "./helpers.js";
import { buildActParams } from "./act-params.js";

const ON_FAILURE_VALUES = ["stop", "continue"] as const;

/**
 * 解析 --steps：JSON 数组，每项 {action, target, value?}。
 * 形状与 MCP 的 vortex_sequence 一致（同一份序列语义，shared/src/sequence.ts）。
 */
function parseSteps(raw: string): SequenceStepInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    exitWithError(formatCliError({
      code: VtxErrorCode.INVALID_PARAMS,
      message: `sequence: --steps must be a JSON array, got: ${raw.slice(0, 120)}`,
      hint: `e.g. --steps '[{"action":"click","target":"@e12"},{"action":"fill","target":"@e13","value":"hi"}]'`,
    }));
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    exitWithError(formatCliError({
      code: VtxErrorCode.INVALID_PARAMS,
      message: "sequence: steps must be a non-empty array",
      hint: `e.g. --steps '[{"action":"click","target":"@e12"}]'`,
    }));
  }
  const steps: SequenceStepInput[] = [];
  for (const [i, item] of parsed.entries()) {
    if (!item || typeof item !== "object") {
      exitWithError(formatCliError({
        code: VtxErrorCode.INVALID_PARAMS,
        message: `sequence: step ${i + 1} must be an object`,
      }));
    }
    const step = item as Record<string, unknown>;
    const action = typeof step.action === "string" ? step.action : "";
    const target = typeof step.target === "string" ? step.target : "";
    if (!action || !target) {
      exitWithError(formatCliError({
        code: VtxErrorCode.INVALID_PARAMS,
        message: `sequence: step ${i + 1} needs both "action" and "target"`,
      }));
    }
    steps.push({
      action,
      target,
      ...(step.value !== undefined ? { value: step.value as unknown } : {}),
    });
  }
  return steps;
}

/**
 * `vortex sequence` —— 一次跑多步，每步自证。
 *
 * 与 MCP 的 vortex_sequence 同一份判定口径（@vortex-browser/shared 的 sequence.ts）：
 * 每步落到 executed_verified / executed_unverified / failed / not_executed，
 * 后续步骤是否继续由 --on-failure 决定（stop = 只有验证通过才继续）。
 *
 * click/hover 强制开副作用信号采集（observeEffect）—— 不开就永远判不出「点了没有」。
 */
export function registerSequenceCommand(program: Command): void {
  program
    .command("sequence")
    .description("Run multiple actions in one call, each self-verified before the next")
    .requiredOption("--steps <json>", 'steps as JSON array, e.g. \'[{"action":"click","target":"@e12"}]\'')
    .option("--on-failure <mode>", "stop | continue", "stop")
    .option("--json", "print the raw JSON report instead of the readable summary")
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab, frameId, pretty } = getGlobalOpts(cmd);

      const steps = parseSteps(String(opts.steps ?? ""));
      const onFailure = (ON_FAILURE_VALUES as readonly string[]).includes(opts.onFailure)
        ? (opts.onFailure as OnFailure)
        : "stop";
      if (!ON_FAILURE_VALUES.includes(opts.onFailure)) {
        exitWithError(formatCliError({
          code: VtxErrorCode.INVALID_PARAMS,
          message: `sequence: --on-failure must be one of ${ON_FAILURE_VALUES.join("|")}, got ${String(opts.onFailure)}`,
        }));
      }

      const report = await runSequence(steps, onFailure, async (step) => {
        try {
          const { extensionAction, params } = buildActParams(
            {
              action: step.action,
              target: step.target,
              value: step.value,
              // click/hover 的自证只能靠副作用信号，不开就恒退化成 unknown
              observeEffect: step.action === "click" || step.action === "hover",
            },
            { session, tab, frameId },
          );
          const resp = await sendRequest(extensionAction, params, { port, session, tabId: tab });
          const { value, diagnosis } = splitDiagnosis(resp.result);
          return {
            ok: true,
            result: (value ?? {}) as Record<string, unknown>,
            ...(diagnosis ? { diagnosis } : {}),
          };
        } catch (err: unknown) {
          // 一步失败不该掀掉整条序列：记成该步 failed，其余步按 --on-failure 继续。
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, pretty ? 2 : 0));
      } else {
        printSequenceResult(report, { pretty });
      }
    });
}
