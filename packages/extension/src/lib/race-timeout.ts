/**
 * 有界等待:超时返回哨兵而非抛错。
 *
 * 与 handlers/js.ts 的 withTimeout 区别在语义——那个把超时转成 TIMEOUT 错误直接
 * 抛给调用方;此处用于「超时就跳过该项、继续处理其余」的降级场景,调用方需要区分
 * 「超时」与「正常返回 null」,故用哨兵而非 null。
 *
 * 动机:chrome.scripting.executeScript 在坏 SW/tab 态下既不 resolve 也不 reject
 * (见 PROBE_TIMEOUT_MS / INJECT_TIMEOUT_MS 同族修复),裸 await 会让整条链路挂到
 * 外层传输超时。
 */
export const TIMED_OUT = Symbol("vtx.timed-out");

export async function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
