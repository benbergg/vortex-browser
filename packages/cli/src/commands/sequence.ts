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
import { resolveTargetTab } from "./session-tab.js";

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
 * click 强制开副作用信号采集（observeEffect）—— 不开就永远判不出「点了没有」。
 * hover **不开**：扩展侧 dom.hover 既不消费 observeEffect、结果里也没有 effect，
 * 「悬停有没有生效」压根没有自证通道。这种步**不参与自证判定**
 * （shared 的 supportsSelfVerification），不会被当成「判定失败」，也不会让序列停下。
 *
 * 退出码（packages/cli/README.md 的退出码契约）：报告里出现 failed 步 ⇒ 退出码 1。
 * 报告照常完整打印，退出码只是把「命令失败」这件事告诉调用脚本。
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

      // @ref 目标要按**实际 tab 身份**校验快照 ⇒ 先解析这次请求真正会落到的 tab
      // （显式 --tab 就是它；没指定就是该 session 当时的当前 tab）。定向修复轮 Important ①。
      const needsTab = steps.some((step) => step.target.startsWith("@"));
      let targetTab: number | undefined = tab;
      if (needsTab) {
        try {
          targetTab = await resolveTargetTab({ port, session, tab });
        } catch (err: unknown) {
          exitWithError(err instanceof Error ? err.message : String(err));
        }
      }

      const report = await runSequence(steps, onFailure, async (step) => {
        try {
          const { extensionAction, params } = buildActParams(
            {
              action: step.action,
              target: step.target,
              value: step.value,
              // click 的自证只能靠副作用信号，不开就恒退化成 unknown。
              // hover 没有自证通道，不开（开了也没人消费，见 shared 的 supportsSelfVerification）。
              observeEffect: step.action === "click",
            },
            { session, tab: targetTab, frameId },
          );
          const resp = await sendRequest(extensionAction, params, { port, session, tabId: targetTab });
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

      // 退出码契约：有 failed 步 ⇒ 退出码 1（报告已经完整打印，退出码只补「命令失败」这件事）。
      // 用 process.exitCode 而不是 process.exit：让进程自然退出，stdout 才不会被截断。
      if (report.summary.failed > 0) {
        process.exitCode = 1;
      }
    });
}
