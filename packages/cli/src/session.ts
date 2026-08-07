/**
 * Author: qingwa
 * Description: Resolves the CLI session name from options and environment.
 */
export interface SessionEnvironment {
  USER?: string;
  VORTEX_SESSION_NAME?: string;
}

export function resolveSessionName(
  explicit: string | undefined,
  env: SessionEnvironment = process.env,
): string {
  return explicit ?? env.VORTEX_SESSION_NAME ?? `cli-${env.USER ?? "default"}`;
}
