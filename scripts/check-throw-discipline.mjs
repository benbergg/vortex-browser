#!/usr/bin/env node
/**
 * 错误抛出规范检查（替代 ESLint custom rule）
 *
 * 规则：handlers / lib 层禁止 `throw new Error(...)`，应使用
 * `@vortex-browser/shared` 的 vtxError() 构造结构化错误：
 *
 *   throw vtxError(VtxErrorCode.XXX, "msg", { context });
 *
 * 作用域：
 *   - packages/extension/src/handlers
 *   - packages/extension/src/lib
 *   - packages/mcp/src/lib
 *
 * 运行：pnpm run lint:errors
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const TARGETS = [
  "packages/extension/src/handlers",
  "packages/extension/src/lib",
  "packages/mcp/src/lib",
  "packages/hub/src",
];

const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;
const PATTERN = /throw\s+new\s+Error\s*\(/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (SOURCE_EXT.test(name)) yield p;
  }
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

const violations = [];
let scannedFiles = 0;

for (const target of TARGETS) {
  const absTarget = resolve(ROOT, target);
  for (const file of walk(absTarget)) {
    scannedFiles++;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (PATTERN.test(line)) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          content: line.trim(),
        });
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\n❌ 发现 ${violations.length} 处 \`throw new Error\`（应使用 vtxError）：\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.content}`);
  }
  console.error(`\n改造方式：`);
  console.error(`  import { VtxErrorCode, vtxError } from "@vortex-browser/shared";`);
  console.error(`  throw vtxError(VtxErrorCode.XXX, "msg", { selector, tabId });\n`);
  process.exit(1);
}

console.log(`✓ throw discipline check passed (${scannedFiles} files scanned)`);
