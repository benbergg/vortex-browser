// 序列执行的纯逻辑已迁到 @vortex-browser/shared（packages/shared/src/sequence.ts）。
//
// **为什么迁**：CLI 直连 vortex-server → 扩展，没有 MCP 层，够不到这里的实现；
// 同一个「多步序列每步自证」的能力在两条路上必须是同一份判定口径，
// 各写一份必然漂移（verified/unverified 结论不一致）。
//
// 这里保留转出，MCP 侧既有 import 路径（./lib/sequence-run.js）与测试都不必改。
export {
  verifyStepEffect,
  classifyStep,
  shouldContinue,
  summarizeTrace,
  runSequence,
} from "@vortex-browser/shared";

export type {
  StepState,
  OnFailure,
  StepEffect,
  StepTrace,
  StepFingerprintLike,
  SequenceStepInput,
  SequenceOutcome,
  SequenceReport,
} from "@vortex-browser/shared";
