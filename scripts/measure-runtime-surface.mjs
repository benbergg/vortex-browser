#!/usr/bin/env node
/**
 * 真实运行时工具面测量：直接握手 vortex MCP（stdio）取 tools/list，
 * 再对**实际注入模型上下文的那份 JSON**做 token 估算。
 *
 * 口径（结构化估算，**非精确 tokenizer**）：
 *   - 中文/全角字符（码位 > 0x2E80）按 1 字 1 token 计；
 *   - 其余 ASCII 字符按 4 字符 1 token 计，向上取整。
 *   ⇒ 该数字用于**体积闸门与前后对比**，不等同于真实模型的分词结果。
 *   （与 packages/mcp/src/contract.ts 的 estimateTokens 同口径，两边可对照。）
 *
 * 前置条件（本脚本**不自动构建**，缺失即报错退出，避免测出"旧构建"的数）：
 *   pnpm install
 *   pnpm -C packages/shared build && pnpm -C packages/hub build && pnpm -C packages/mcp build
 *
 * 依赖说明：MCP SDK 来自 packages/mcp 的**既有依赖**（@modelcontextprotocol/sdk），
 * 本脚本只在运行时从 packages/mcp/node_modules 解析它，**不新增任何依赖**。
 *
 * 用法：
 *   node scripts/measure-runtime-surface.mjs                    # 打印 JSON 报告
 *   VORTEX_REPO=/path/to/vortex node scripts/measure-runtime-surface.mjs
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：优先环境变量，否则取本脚本所在 scripts/ 的上一级。 */
const VORTEX = process.env.VORTEX_REPO ?? resolve(HERE, "..");
const SERVER = join(VORTEX, "packages/mcp/dist/src/server.js");

/**
 * 结构化 token 估算：**不是精确 tokenizer**。
 * 中文/全角 1 字 1 token，其余 ASCII 4 字符 1 token，向上取整。
 */
export function estimateTokens(text) {
  let wide = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x2e80) wide += 1; // 中文/全角/CJK 标点等
    else ascii += 1;
  }
  return wide + Math.ceil(ascii / 4);
}

/**
 * 解析 MCP SDK 的 ESM 入口（不新增依赖）。
 * 首选 brief 指定的 pnpm 路径；兜底用 createRequire 从 packages/mcp 反查包根。
 */
function resolveSdkFile(fileName) {
  const pnpmEntry = join(
    VORTEX,
    "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client",
    fileName,
  );
  if (existsSync(pnpmEntry)) return pnpmEntry;

  try {
    const req = createRequire(join(VORTEX, "packages/mcp/package.json"));
    const anchor = req.resolve("@modelcontextprotocol/sdk/client");
    const marker = "/@modelcontextprotocol/sdk";
    const at = anchor.indexOf(marker);
    if (at >= 0) {
      const root = anchor.slice(0, at + marker.length);
      const fallback = join(root, "dist/esm/client", fileName);
      if (existsSync(fallback)) return fallback;
    }
  } catch {
    // 落到下面的统一报错
  }

  throw new Error(
    `解析 MCP SDK 失败：${fileName}\n` +
      `  期望路径：packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/${fileName}\n` +
      `  修复：pnpm install（SDK 是 packages/mcp 的既有依赖，本脚本不新增依赖）`,
  );
}

/** instructions 体积闸门：与 packages/mcp/src/contract.ts 同源（构建产物优先，缺失回退常量）。 */
async function loadInstructionsBudget() {
  const built = join(VORTEX, "packages/mcp/dist/src/contract.js");
  if (existsSync(built)) {
    try {
      const mod = await import(pathToFileURL(built).href);
      if (typeof mod.INSTRUCTIONS_TOKEN_BUDGET === "number") {
        return mod.INSTRUCTIONS_TOKEN_BUDGET;
      }
    } catch {
      // 回退常量
    }
  }
  return 1200; // contract.ts 的同值兜底
}

async function main() {
  if (!existsSync(SERVER)) {
    throw new Error(
      `MCP server 构建产物缺失：${SERVER}\n` +
        "  修复：pnpm -C packages/shared build && pnpm -C packages/hub build && pnpm -C packages/mcp build",
    );
  }

  const clientEntry = resolveSdkFile("index.js");
  const stdioEntry = resolveSdkFile("stdio.js");
  const { Client } = await import(pathToFileURL(clientEntry).href);
  const { StdioClientTransport } = await import(pathToFileURL(stdioEntry).href);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: "ignore",
  });
  const client = new Client({ name: "vortex-measure-runtime-surface", version: "0.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    // instructions 由 initialize 响应下发（Server 构造参数），不在 tools/list 里；
    // SDK Client 用 getInstructions() 暴露它。
    const instructions = client.getInstructions();

    const descTokens = tools.reduce((a, t) => a + estimateTokens(t.description ?? ""), 0);
    const schemaTokens = tools.reduce(
      (a, t) => a + estimateTokens(JSON.stringify(t.inputSchema ?? {})),
      0,
    );
    const totalTokens = estimateTokens(JSON.stringify(tools));
    const instructionsTokens = instructions ? estimateTokens(instructions) : 0;
    const instructionsBudget = await loadInstructionsBudget();

    const out = {
      repoRoot: VORTEX,
      server: SERVER,
      sdkClient: clientEntry,
      toolCount: tools.length,
      instructionsPresent: instructions != null && instructions !== "",
      instructionsTokens,
      instructionsBudget,
      instructionsWithinBudget: instructionsTokens <= instructionsBudget,
      descriptionTokens: descTokens,
      schemaTokens,
      totalTokens,
      perTool: tools
        .map((t) => ({
          name: t.name,
          tokens:
            estimateTokens(t.description ?? "") +
            estimateTokens(JSON.stringify(t.inputSchema ?? {})),
          descTokens: estimateTokens(t.description ?? ""),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    };

    console.log(JSON.stringify(out, null, 2));
  } finally {
    await client.close().catch(() => {});
  }
}

try {
  await main();
} catch (err) {
  console.error(`[measure-runtime-surface] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
