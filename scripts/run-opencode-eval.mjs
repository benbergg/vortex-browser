#!/usr/bin/env node
/**
 * opencode + MiniMax 评测包装器：注入代理/NO_PROXY/key，阻塞跑 `opencode run`，
 * 把 M3 会话输出落 <cycle-dir>/m3-session.log，退出码透传给编排。
 *
 * 关键坑（来自历史教训）：opencode 后台跑只继承全局 ClashX 代理但缺 NO_PROXY，
 * 导致 localhost 的 vortex MCP 连不上。本包装器同时：
 *   - 设代理（MiniMax API 走代理）：HTTP_PROXY/HTTPS_PROXY/ALL_PROXY（从小写补齐大写）
 *   - 设 NO_PROXY=localhost,127.0.0.1,::1（localhost MCP 绕过代理）
 *
 * 用法：
 *   node scripts/run-opencode-eval.mjs --brief <path> --cycle-dir <path> [--model <id>]
 *   node scripts/run-opencode-eval.mjs --mode implement --brief <path> [--cycle-dir <path>] [--model <id>]
 *   node scripts/run-opencode-eval.mjs --selfcheck [--model <id>]
 *
 * 模式（--mode，默认 eval）：
 *   - eval     ：真站评测，产出 anomalies.json + eval-observations.md（既有行为）。
 *   - implement：把 brief 当 SDD task brief（含完整 TDD 步骤+代码），M3 严格按步骤
 *                写失败测试→跑红→最小实现→跑绿→按 brief 的 commit message 提交。
 *                Claude 控制器随后在本侧评审 diff。--cycle-dir 可选（默认
 *                reports/_opencode-impl/），加 --dangerously-skip-permissions 保证非交互。
 *
 * 模型默认 env MINIMAX_MODEL || 'minimax-cn-coding-plan/MiniMax-M3'。
 * 选 minimax-cn-coding-plan provider 的原因（2026-06-19 实测确认）：
 *   - 它解析到国内端点 api.minimaxi.com（代理/直连均可达），且与本机 auth.json 里
 *     已存的 CN coding-plan key 匹配（实测最小请求 HTTP 200）。
 *   - 旧默认 minimax/MiniMax-M2.7 解析到国际端点 api.minimax.io，经本机代理不可达
 *     （socket closed），导致 M3 空转重试、零工具调用。
 * 该 provider 下 MiniMax-M3 可用，取最新的 M3 作默认，可用 --model 覆盖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const MCP_SERVER = path.join(REPO, "packages/mcp/dist/src/server.js");
// opencode 经常驻 supervisor 启动 vortex(免重连:改 MCP 代码 build 后 supervisor
// 自动重启 child 保连接)。supervisor 把 server.js 作为子进程拉起,二者都需存在。
const MCP_SUPERVISOR = path.join(REPO, "packages/mcp/dist/src/supervisor.js");
const NO_PROXY_VALUE = "localhost,127.0.0.1,::1";
// 固定 server 端口：实跑时让 opencode run 在此端口起 server，便于另开终端
// `opencode attach http://localhost:<port>` 实时观看任务 TUI（可用 env 覆盖）。
const ATTACH_PORT = Number(process.env.OPENCODE_ATTACH_PORT) || 4567;
// opencode 凭证/模型缓存路径（用于 selfcheck 真实探端点；缺失则探测降级为软跳过）
const OPENCODE_MODELS_CACHE = path.join(os.homedir(), ".cache/opencode/models.json");
const OPENCODE_AUTH = path.join(os.homedir(), ".local/share/opencode/auth.json");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function resolveModel(args) {
  if (typeof args.model === "string") return args.model;
  return process.env.MINIMAX_MODEL || "minimax-cn-coding-plan/MiniMax-M3";
}

/** 模式：implement（按 SDD task brief 实现并提交）或 eval（默认，真站评测）。 */
function resolveMode(args) {
  return args.mode === "implement" ? "implement" : "eval";
}

/** implement 模式给 M3 的指令文案：严格按 brief TDD 实现并 commit。 */
const IMPLEMENT_MESSAGE =
  "你是实现 subagent。附带文件是一份 SDD task brief,内含完整的 TDD 步骤与可直接落地的代码。" +
  "严格按 brief 的 Step 顺序执行:① 写失败测试 → ② 跑测试确认失败(用 brief 给的命令) → " +
  "③ 写最小实现 → ④ 跑测试确认通过 → ⑤ 用 brief 中给出的 commit message 执行 git commit。" +
  "硬约束:只修改 brief 的 Files 节列出的文件;commit 用 Conventional Commits 中文描述、" +
  "禁止 Co-Authored-By 等署名;不要跑与本 task 无关的命令、不要改其他文件、不要 git push。" +
  "完成后用一段话报告:改了哪些文件、测试命令与结果(通过数)、commit hash。";

/** eval 模式给 M3 的指令文案（既有行为）。 */
const EVAL_MESSAGE =
  "请严格按附带的 EVAL-BRIEF.md 执行本轮 vortex 真站评测。只用 vortex MCP 工具;" +
  "evaluate 仅作证据读 DOM 真值,禁止旁路完成交互。完成后产出 brief 中指定路径的双产物:" +
  "anomalies.json(严格符合 reports/_dogfood/anomalies.schema.json)+ eval-observations.md。";

/** 构造注入后的 env：补齐大写代理 + NO_PROXY + 透传 key。 */
function buildEnv() {
  const env = { ...process.env };
  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy;
  const allProxy = env.ALL_PROXY || env.all_proxy;
  if (httpProxy) { env.HTTP_PROXY = httpProxy; env.http_proxy = httpProxy; }
  if (httpsProxy) { env.HTTPS_PROXY = httpsProxy; env.https_proxy = httpsProxy; }
  if (allProxy) { env.ALL_PROXY = allProxy; env.all_proxy = allProxy; }
  // NO_PROXY：确保 localhost 三件套在内（保留已有条目）
  const existing = (env.NO_PROXY || env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);
  const merged = Array.from(new Set([...existing, ...NO_PROXY_VALUE.split(",")]));
  env.NO_PROXY = merged.join(",");
  env.no_proxy = env.NO_PROXY;
  return env;
}

function modelAvailable(model) {
  const r = spawnSync("opencode", ["models"], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, reason: `opencode models 退出码 ${r.status}` };
  const listed = r.stdout.split("\n").map((s) => s.trim()).includes(model);
  return { ok: listed, reason: listed ? "" : `模型 ${model} 不在 opencode models 列表` };
}

/** 读 JSON 文件，失败返回 null（不抛）。 */
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * 从 model id（`<provider>/<modelName>`）解析出 anthropic 端点 + 鉴权 key。
 * 端点取 opencode models 缓存的 provider.api；key 优先 auth.json 对应 provider，
 * 退回 env.MINIMAX_API_KEY。任一缺失返回 { resolvable:false }，探测降级软跳过。
 */
function resolveEndpointAndKey(model, env) {
  const slash = model.indexOf("/");
  if (slash < 0) return { resolvable: false, reason: "模型 id 无 provider 前缀" };
  const provider = model.slice(0, slash);
  const modelName = model.slice(slash + 1);
  const models = readJsonSafe(OPENCODE_MODELS_CACHE);
  const api = models && models[provider] && models[provider].api;
  if (!api) return { resolvable: false, reason: `models 缓存无 provider ${provider} 的 api 端点` };
  const auth = readJsonSafe(OPENCODE_AUTH);
  const key = (auth && auth[provider] && auth[provider].key) || env.MINIMAX_API_KEY;
  if (!key) return { resolvable: false, reason: `auth.json 与 env 均无 provider ${provider} 的 key` };
  return { resolvable: true, api, modelName, key, provider };
}

/**
 * 真实探端点：通过与实跑相同的代理 env，对解析出的 anthropic 端点发最小请求，
 * 验证「连通 + 鉴权过」。这是防 selfcheck 假性通过（只查 env 存在性）的承重断言：
 * 2026-06-19 旧默认模型解析到不可达端点但 selfcheck 仍放行，白白空转启动了一轮 M3。
 * 用 curl（继承 env 的 HTTP(S)_PROXY/NO_PROXY，忠实复刻 opencode 的代理路径）。
 */
function probeEndpoint(model, env) {
  const r = resolveEndpointAndKey(model, env);
  if (!r.resolvable) return { ok: true, soft: true, reason: `探测跳过（${r.reason}）` };
  const url = `${r.api.replace(/\/$/, "")}/messages`;
  const body = JSON.stringify({ model: r.modelName, max_tokens: 8, messages: [{ role: "user", content: "ping" }] });
  const cr = spawnSync("curl", [
    "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "25",
    url,
    "-H", "Content-Type: application/json",
    "-H", `x-api-key: ${r.key}`,
    "-H", "anthropic-version: 2023-06-01",
    "-d", body,
  ], { encoding: "utf8", env });
  const code = (cr.stdout || "").trim();
  if (code === "200") return { ok: true, reason: `端点连通+鉴权通过 ${r.api}（HTTP 200）` };
  if (code === "000" || code === "") return { ok: false, reason: `端点不可达 ${r.api}（HTTP ${code || "无响应"}，疑代理路由不通）` };
  return { ok: false, reason: `端点鉴权/请求失败 ${r.api}（HTTP ${code}）` };
}

function cmdSelfcheck(args) {
  const model = resolveModel(args);
  const env = buildEnv();
  const checks = [];

  checks.push({ name: "vortex MCP supervisor.js 存在", ok: fs.existsSync(MCP_SUPERVISOR), detail: MCP_SUPERVISOR });
  checks.push({ name: "vortex MCP server.js 存在(supervisor 的 child)", ok: fs.existsSync(MCP_SERVER), detail: MCP_SERVER });
  const ma = modelAvailable(model);
  checks.push({ name: `模型可用: ${model}`, ok: ma.ok, detail: ma.reason || "在 opencode models 列表中" });
  checks.push({ name: "NO_PROXY 含 localhost", ok: env.NO_PROXY.includes("localhost"), detail: env.NO_PROXY });
  checks.push({ name: "HTTP(S)_PROXY 已设(MiniMax API)", ok: !!env.HTTPS_PROXY, detail: env.HTTPS_PROXY || "(无)" });
  checks.push({
    name: "MINIMAX_API_KEY 或 opencode 凭证",
    ok: !!env.MINIMAX_API_KEY,
    detail: env.MINIMAX_API_KEY ? "env 已设" : "env 未设——opencode 可能用 `opencode auth` 存储凭证,非阻塞",
  });
  // 承重断言：真实探端点（连通+鉴权）。可解析时为硬性，不可解析时软跳过（保持跨机可移植）。
  const probe = probeEndpoint(model, env);
  checks.push({ name: "端点真实可达(连通+鉴权)", ok: probe.ok, detail: probe.reason, soft: !!probe.soft });

  for (const c of checks) console.error(`${c.ok ? (c.soft ? "○" : "✓") : "✗"} ${c.name} — ${c.detail}`);
  // 硬性：supervisor.js + server.js + 模型在列表 + 端点真实可达（非软跳过时）
  const hardFail = !checks[0].ok || !checks[1].ok || !checks[2].ok || (!probe.ok && !probe.soft);
  console.log(JSON.stringify({ selfcheck: true, model, pass: !hardFail, checks }, null, 2));
  process.exit(hardFail ? 1 : 0);
}

/** 同步阻塞 ms（基于 Atomics，避免 spawn sleep）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 端口是否已被监听（127.0.0.1）。 */
function portListening(port) {
  return spawnSync("nc", ["-z", "-w1", "127.0.0.1", String(port)]).status === 0;
}

/**
 * 起（或复用）attach server，供 run --attach 与 `opencode attach` TUI 共享同一会话。
 * 注意：opencode run --port 不会真起监听 server（2026-06-19 实测端口不绑），必须用
 * `opencode serve` 独立起 server，再让 run `--attach` 连上。起不来则返回 null，
 * 调用方降级为普通 run（观看功能绝不拖垮评测）。
 */
function startAttachServer(env) {
  if (portListening(ATTACH_PORT)) {
    console.error(`[run-opencode-eval] 复用已在 ${ATTACH_PORT} 的 opencode server`);
    return { child: null, url: `http://localhost:${ATTACH_PORT}` };
  }
  const child = spawn("opencode", ["serve", "--port", String(ATTACH_PORT)], { cwd: REPO, env, stdio: "ignore" });
  for (let i = 0; i < 24; i++) { if (portListening(ATTACH_PORT)) return { child, url: `http://localhost:${ATTACH_PORT}` }; sleepSync(500); }
  console.error(`[run-opencode-eval] ⚠ attach server 12s 未监听，降级为无观看模式`);
  try { child.kill(); } catch { /* ignore */ }
  return { child: null, url: null };
}

function cmdRun(args) {
  const mode = resolveMode(args);
  const brief = args.brief;
  // eval 模式 cycle-dir 必填；implement 模式可选（默认 reports/_opencode-impl/）。
  const cycleDir = args["cycle-dir"] || (mode === "implement" ? "reports/_opencode-impl" : undefined);
  if (typeof brief !== "string" || typeof cycleDir !== "string") {
    console.error("用法: [--mode implement] --brief <path> [--cycle-dir <path>] [--model <id>]");
    process.exit(2);
  }
  const briefAbs = path.resolve(REPO, brief);
  const cycleDirAbs = path.resolve(REPO, cycleDir);
  if (!fs.existsSync(briefAbs)) { console.error(`brief 不存在: ${briefAbs}`); process.exit(2); }
  fs.mkdirSync(cycleDirAbs, { recursive: true });

  const model = resolveModel(args);
  const env = buildEnv();
  const logPath = path.join(cycleDirAbs, "m3-session.log");
  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  const message = mode === "implement" ? IMPLEMENT_MESSAGE : EVAL_MESSAGE;

  // 起 attach server（失败则降级普通 run，不影响评测）
  const server = startAttachServer(env);
  const cliArgs = ["run", message, "-f", briefAbs, "-m", model, "--print-logs",
    // implement 模式需 headless 非交互（自动批准未显式拒绝的 edit/bash/commit）。
    ...(mode === "implement" ? ["--dangerously-skip-permissions"] : []),
    ...(server.url ? ["--attach", server.url] : [])];
  console.error(`[run-opencode-eval] mode=${mode} model=${model} brief=${brief}`);
  console.error(`[run-opencode-eval] NO_PROXY=${env.NO_PROXY}  HTTPS_PROXY=${env.HTTPS_PROXY || "(无)"}`);
  console.error(`[run-opencode-eval] 日志 → ${path.relative(REPO, logPath)}（阻塞，M3 跑完才返回）`);
  // 注意：裸 attach 只连 server 不开会话，需 -c（续最近 session=本轮 run）才能看到任务
  if (server.url) console.error(`[run-opencode-eval] 👁  实时观看：另开终端运行  opencode attach ${server.url} -c`);

  const cleanupServer = () => { if (server.child) { try { server.child.kill(); } catch { /* ignore */ } } };
  const child = spawn("opencode", cliArgs, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { process.stdout.write(d); logStream.write(d); });
  child.stderr.on("data", (d) => { process.stderr.write(d); logStream.write(d); });
  child.on("close", (code) => {
    logStream.end();
    cleanupServer();
    console.error(`[run-opencode-eval] opencode 退出码 ${code}（浏览器已释放，Claude 可接手校验）`);
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    logStream.write(`spawn error: ${err.message}\n`);
    logStream.end();
    cleanupServer();
    console.error(`[run-opencode-eval] 启动 opencode 失败: ${err.message}`);
    process.exit(1);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfcheck) cmdSelfcheck(args);
  else cmdRun(args);
}

main();
