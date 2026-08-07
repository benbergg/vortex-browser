/**
 * Author: qingwa
 * Description: Maps compiled-style imports to TypeScript source for child-process tests.
 */
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@vortex-browser/shared") {
    return nextResolve(new URL("../../../shared/src/index.ts", import.meta.url).href, context);
  }
  if (specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL).href;
    try {
      return await nextResolve(candidate, context);
    } catch {
      return nextResolve(specifier, context);
    }
  }
  return nextResolve(specifier, context);
}

void fileURLToPath;
