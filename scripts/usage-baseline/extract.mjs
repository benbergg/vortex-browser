// 多源 vortex 使用日志抽取器(纯函数,无 IO 副作用)。
//
// 为什么拆出来:抽取器是"诊断底座",它算错就把整周结论带偏。
// 所以解析逻辑必须能被 fixture 单测覆盖(乱序结果、缺结果、重复块、嵌套调用),
// 也不能把 IO 和解析混在一起——IO 留在 collect.mjs。
//
// 三个源的记录形态完全不同,归一化成同一件事:
//   call  = 一次 vortex 工具调用(有 callId)
//   result= 该调用的返回(按 callId 配对)
// 事实表的一行 = 一次调用 + 它的结局。
//
// 结局四态(见 collect.mjs 口径):
//   ok / error / unpaired(有调用无结果) / unknown(有结果无调用)
// unknown 不算成功,也不进错误率分母,单独报占比。

/** 错误签名归一化:同一类错误每次带着不同 id/尺寸/选择器,不归一化就散成几十个只出现一次的串。 */
export function errorSignature(text) {
  return String(text)
    .slice(0, 400)
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/@[0-9a-f]{4,}:e\d+/gi, "<ref>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** 从错误文本里取稳定错误码(Error [CODE]: ...)。取不到就归到 <no-code>。 */
export function errorCode(text) {
  const m = /Error \[([A-Z_]+)\]/.exec(String(text));
  return m ? m[1] : "<no-code>";
}

export function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c && typeof c === "object" && c.type === "text" ? c.text : ""))
      .join("\n");
  }
  return "";
}

// 成功但没内容。isError 看不见这一类:调用返回 200、结构合法、载荷为空。
const EMPTY_PATTERNS = [
  /^\s*(\[\]|\{\}|""|null|undefined)\s*$/,
  /"(items|rows|matches|elements|results|records|data|tabs)"\s*:\s*\[\s*\]/,
  /\btotal"?\s*:\s*0\b/,
  /^\s*No .{0,40}(found|match)/i,
];

// 非文本载荷(截图的 image block)不能按文本判空,否则 screenshot 会 94% 显示"空返回"。
function hasNonTextPayload(content) {
  return Array.isArray(content) && content.some((c) => c && typeof c === "object" && c.type !== "text");
}

export function isEmptySuccess(content) {
  if (hasNonTextPayload(content)) return false;
  const t = resultText(content).trim();
  if (!t) return true;
  if (t.length > 4000) return false; // 大响应不可能是空
  return EMPTY_PATTERNS.some((re) => re.test(t));
}

/** vortex 工具名归一:三种来源的命名不同,统一成 "evaluate" / "act" 这种裸名。 */
export function normalizeToolName(name, args) {
  if (!name) return null;
  if (name === "mcp__vortex") return args?.tool ? String(args.tool).replace(/^vortex_/, "") : null;
  if (name.startsWith("mcp__vortex__vortex_")) return name.slice("mcp__vortex__vortex_".length);
  if (name.startsWith("vortex_")) return name.slice("vortex_".length);
  return null;
}

/** 这个工具名是不是 vortex 的(不靠入参也能判定)。 */
export function isVortexToolName(name) {
  if (!name) return false;
  return name === "mcp__vortex" || name.startsWith("mcp__vortex__vortex_") || name.startsWith("vortex_");
}

// ─────────────────────────── Claude Code ───────────────────────────
// transcript 每行一个 JSON:d.message.content 里是 tool_use / tool_result 块。

export function parseClaudeFile(text, file) {
  const calls = [];
  const results = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(d.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        const tool = normalizeToolName(b.name, b.input);
        if (!tool) continue;
        calls.push({
          src: "claude",
          callId: b.id,
          tool,
          ts,
          file,
          line: i + 1,
          sessionId: d.sessionId ?? "?",
          project: d.cwd ?? "?",
          argsLen: JSON.stringify(b.input ?? {}).length,
          timeoutArg: Number(b.input?.timeout) || null,
        });
      } else if (b.type === "tool_result") {
        results.push({
          src: "claude",
          callId: b.tool_use_id,
          ts,
          file,
          line: i + 1,
          isError: Boolean(b.is_error),
          text: resultText(b.content),
        });
      }
    }
  }
  // 只保留与本文件内 vortex 调用配对的结果:非 vortex 工具的 result 不算 "unknown"。
  const ids = new Set(calls.map((c) => c.callId));
  // Claude 的 tool_result 不带工具名,无法归属的孤儿结果只能丢(否则非 vortex 工具会混进来);
  // 因此 Claude 源的 unknown 恒为 0。Pi 的 result 带 toolName,孤儿能归属 → 计入 unknown。
  return { calls, results: results.filter((r) => ids.has(r.callId)) };
}
// ─────────────────────────── Pi ───────────────────────────
// Pi 的真实记录形态（2026-10-30 codex 复核后修正）：
//   ① 直接调用：assistant 消息里 {"type":"toolCall","name":"mcp__vortex","arguments":{"tool":"vortex_x","args":{}}}
//      → 对应 toolResult 里还会带 nestedCalls（"<id>/1" name="mcp__vortex__vortex_x"），
//        那是**同一次调用**的展开，不能再计一次。
//   ② codemode 调用：assistant 消息里 {"type":"toolCall","name":"codemode","arguments":{"code":"..."}}
//      → 对应 toolResult 的 **message.nestedCalls.calls[]** 里才是真正执行的 vortex 调用，
//        每个条目形如 {id, name, status, arguments, durationMs, error?}。
//        旧实现只看外层 toolCall，②这一整类（本周 34 次）被漏掉。
//   ③ 嵌套树里 “<outer>/1”（name=mcp__vortex）是根调用，“<outer>/1/1”
//      （name=mcp__vortex__vortex_x）是它的展开 —— 只算没有 vortex 祖先的那一层。

export function parsePiFile(text, file) {
  const calls = [];
  const results = [];
  const lines = text.split("\n");
  const assistantCalls = new Map();
  const toolResults = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message;
    if (!m || typeof m !== "object") continue;
    const ts = Date.parse(d.timestamp ?? m.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;

    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== "object" || b.type !== "toolCall") continue;
        assistantCalls.set(b.id, { id: b.id, name: b.name, arguments: b.arguments, ts, line: i + 1 });
      }
    } else if (m.role === "toolResult") {
      toolResults.set(m.toolCallId, {
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        ts,
        line: i + 1,
        isError: Boolean(m.isError),
        durationMs: typeof m.durationMs === "number" ? m.durationMs : null,
        text: resultText(m.content),
        nestedCalls: m.nestedCalls ?? null,
      });
    }
  }

  for (const ac of assistantCalls.values()) {
    const tr = toolResults.get(ac.id);
    // ① 直接调用：外层本身就是 vortex
    if (isVortexToolName(ac.name)) {
      const tool = normalizeToolName(ac.name, ac.arguments);
      if (!tool) continue;
      calls.push({
        src: "pi",
        callId: ac.id,
        tool,
        ts: ac.ts,
        file,
        line: ac.line,
        sessionId: file,
        project: file,
        argsLen: JSON.stringify(ac.arguments ?? {}).length,
        timeoutArg: Number(ac.arguments?.timeout ?? ac.arguments?.args?.timeout) || null,
      });
      if (tr) {
        results.push({
          src: "pi",
          callId: ac.id,
          toolName: tr.toolName,
          ts: tr.ts,
          file,
          line: tr.line,
          isError: tr.isError,
          durationMs: tr.durationMs,
          text: tr.text,
        });
      }
      continue;
    }
    // ② codemode：真正的 vortex 调用在 nestedCalls 里
    const nested = tr?.nestedCalls?.calls;
    if (!Array.isArray(nested) || nested.length === 0) continue;
    const byId = new Map(nested.map((c) => [c.id, c]));
    for (const entry of nested) {
      if (!entry || !isVortexToolName(entry.name)) continue;
      if (hasVortexAncestor(entry.id, ac.id, byId)) continue; // 展开层，同一次调用
      const tool = normalizeToolName(entry.name, entry.arguments);
      if (!tool) continue;
      const callId = `${ac.id}#nested#${entry.id}`;
      calls.push({
        src: "pi",
        callId,
        tool,
        ts: ac.ts,
        file,
        line: tr?.line ?? ac.line,
        sessionId: file,
        project: file,
        argsLen: JSON.stringify(entry.arguments ?? {}).length,
        timeoutArg: Number(entry.arguments?.timeout ?? entry.arguments?.args?.timeout) || null,
      });
      results.push({
        src: "pi",
        callId,
        toolName: entry.name,
        ts: ac.ts,
        file,
        line: tr?.line ?? ac.line,
        isError: entry.status === "error",
        durationMs: typeof entry.durationMs === "number" ? entry.durationMs : null,
        text: typeof entry.error === "string" ? entry.error : "",
        // 嵌套记录没有返回正文 → “空返回”不可判定（null），不能当 false 计入
        resultLen: null,
        hasText: false,
      });
    }
  }

  return { calls, results };
}

/** entry.id 的祖先链里是否已有 vortex 展开（“<outer>/1/1” 这类） */
function hasVortexAncestor(entryId, outerId, byId) {
  if (!entryId || !entryId.startsWith(`${outerId}/`)) return false;
  const path = entryId.slice(outerId.length + 1).split("/");
  for (let k = 1; k < path.length; k++) {
    const ancestorId = `${outerId}/${path.slice(0, k).join("/")}`;
    const ancestor = byId.get(ancestorId);
    if (ancestor && isVortexToolName(ancestor.name)) return true;
  }
  return false;
}
// ─────────────────────────── vortex 自身遥测 sink ───────────────────────────
// MCP server 自己落的 JSONL（packages/mcp/src/usage-log.ts）：
// { ts, tool, outcome, errorCode, durationMs, argLen, resultLen, client, pid }
// 只记长度不记内容 —— 它能给出**服务端真相**（真实耗时、错误码、结局），
// 是 transcript 反解拿不到的。客户端侧 schema 校验拒绝仍不在其中（请求根本没到服务端）。

export function parseSinkFile(text, file) {
  const calls = [];
  const results = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof d?.ts !== "string" || typeof d?.tool !== "string") continue;
    const ts = Date.parse(d.ts);
    if (!Number.isFinite(ts)) continue;
    const outcome = d.outcome === "ok" ? "ok" : d.outcome === "error" ? "error" : "unknown";
    const callId = `${file}#${i}`;
    calls.push({
      src: "sink",
      callId,
      tool: d.tool.replace(/^vortex_/, ""),
      ts,
      file,
      line: i + 1,
      sessionId: file,
      project: file,
      argsLen: typeof d.argLen === "number" ? d.argLen : 0,
      timeoutArg: null,
    });
    results.push({
      src: "sink",
      callId,
      tool: d.tool.replace(/^vortex_/, ""),
      ts,
      file,
      line: i + 1,
      // 只接受已知结局；未知结局不能当成功
      isError: outcome === "error",
      outcome,
      durationMs: typeof d.durationMs === "number" ? d.durationMs : null,
      text: "",
      // sink 只记长度不记内容 → “空返回”不可判定
      resultLen: typeof d.resultLen === "number" ? d.resultLen : null,
      hasText: false,
      errorCode: typeof d.errorCode === "string" ? d.errorCode : null,
    });
  }
  return { calls, results };
}

// ─────────────────────────── Codex(仅辅助证据) ───────────────────────────
// Codex 走 codemode,MCP 调用被包在 exec 的 JS 文本里(`tools.mcp__vortex__vortex_x(...)`),
// 没有结构化的 call/result 配对。只统计**真正发起调用的 exec 脚本**里的调用形态,
// 覆盖率不足,按计划只作辅助证据,不进主分母。
//
// 为什么不扫全文:会话里经常包含被读取的 vortex 源码/文档,里面同样有
// `tools.mcp__vortex__vortex_x(` 和 `Error [CODE]` 字样,全文扫描会把它们
// 误算成调用与错误。只看 custom_tool_call 的 input(即 agent 真正跑的脚本)。

export function parseCodexFile(text, fromTs, toTs) {
  const counts = new Map();
  const callRe = /tools\.mcp__vortex__vortex_([a-z_]+)\s*\(/g;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (fromTs != null) {
      const ts = Date.parse(d.timestamp ?? "");
      if (!Number.isFinite(ts) || ts < fromTs || ts >= toTs) continue;
    }
    const p = d.payload;
    if (!p || p.type !== "custom_tool_call") continue;
    // 只认真正的 exec 脚本：其它自定义工具（如 apply_patch）里的同名字样不是调用
    if (p.name !== "exec") continue;
    const input = typeof p.input === "string" ? p.input : "";
    let m;
    while ((m = callRe.exec(input)) !== null) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return { calls: counts };
}

// ─────────────────────────── 归一与配对 ───────────────────────────

/**
 * 把多源事件归一为事实表。
 * 配对键:src + callId(不同源可能撞 id)。
 */
export function buildFacts(sources) {
  const calls = [];
  const results = [];
  for (const s of sources) {
    calls.push(...s.calls);
    results.push(...s.results);
  }
  const byKey = new Map();
  for (const r of results) {
    const key = `${r.src}:${r.callId}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const seen = new Set();
  const facts = [];
  for (const c of calls) {
    const key = `${c.src}:${c.callId}`;
    if (seen.has(key)) continue; // 同一 callId 重复出现(块重复/续写)只算一次
    seen.add(key);
    const rs = byKey.get(key) ?? [];
    byKey.delete(key);
    const r = rs[0] ?? null;
    let outcome;
    if (!r) outcome = "unpaired";
    else if (r.outcome === "ok" || r.outcome === "error" || r.outcome === "unknown") outcome = r.outcome;
    else if (r.isError) outcome = "error";
    else if (r.isError === false) outcome = "ok";
    else outcome = "unknown";
    facts.push({
      ...c,
      outcome,
      durationMs: r?.durationMs ?? (r ? Math.max(0, r.ts - c.ts) : null),
      resultLen: r ? (r.resultLen ?? r.text.length) : 0,
      errorCode: outcome === "error" ? (r.errorCode ?? errorCode(r.text)) : null,
      errorSig:
        outcome === "error"
          ? r.text
            ? `${c.tool} | ${errorSignature(r.text)}`
            : `${c.tool} | Error [${r.errorCode ?? "<no-code>"}]`
          : null,
      // null = “空返回不可判定”（只记长度的 sink / codemode 嵌套记录）；不当作 false
      emptySuccess:
        outcome === "ok"
          ? r.hasText === false
            ? null // 该来源没有返回正文（sink / codemode 嵌套）→ 不可判定
            : isEmptySuccess(r.text)
          : false,
    });
  }
  // 有结果没调用 → unknown(不计入成功,也不进错误率分母)
  for (const [key, rs] of byKey) {
    for (const r of rs) {
      facts.push({
        src: r.src,
        callId: r.callId,
        tool: r.tool ?? "?",
        ts: r.ts,
        file: r.file,
        line: r.line,
        sessionId: r.file,
        project: r.file,
        argsLen: 0,
        timeoutArg: null,
        outcome: "unknown",
        durationMs: r.durationMs ?? null,
        resultLen: r.text.length,
        errorCode: errorCode(r.text),
        errorSig: `${r.tool ?? "?"} | ${errorSignature(r.text)}`,
        emptySuccess: false,
        _orphanKey: key,
      });
    }
  }
  return facts;
}

/** 事实表 → 快照(比率口径见 collect.mjs) */
export function reduceFacts(facts, meta = {}) {
  const perTool = new Map();
  const perSource = new Map();
  const perSession = new Map();
  const errorCounts = new Map();
  const codeCounts = new Map();
  const byDay = new Map();
  let ok = 0;
  let error = 0;
  let unpaired = 0;
  let unknown = 0;
  let emptySuccess = 0;
  let emptyUnknown = 0; // “空返回”不可判定（只记长度的 sink / codemode 嵌套记录）
  let resultChars = 0;
  let argsChars = 0;
  const durations = [];

  const bump = (map, key, field) => {
    if (!map.has(key)) map.set(key, { calls: 0, ok: 0, errors: 0, emptySuccess: 0, emptyUnknown: 0, unpaired: 0, unknown: 0, resultChars: 0, argsChars: 0, durations: [] });
    map.get(key)[field] += 1;
  };

  const pctOf = (arr, p) => {
    if (!arr.length) return null;
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  };

  for (const f of facts) {
    // unknown 是"有结果无调用"的孤儿,它不是一次调用,不计入 calls
    if (f.outcome !== "unknown") {
      bump(perTool, f.tool, "calls");
      bump(perSource, f.src, "calls");
      bump(perSession, f.sessionId ?? f.file ?? "?", "calls");
    }
    if (f.outcome === "ok") {
      ok++;
      bump(perTool, f.tool, "ok");
      bump(perSource, f.src, "ok");
      bump(perSession, f.sessionId ?? f.file ?? "?", "ok");
      if (f.emptySuccess === true) {
        emptySuccess++;
        bump(perTool, f.tool, "emptySuccess");
        bump(perSource, f.src, "emptySuccess");
      } else if (f.emptySuccess === null) {
        emptyUnknown++;
        bump(perTool, f.tool, "emptyUnknown");
        bump(perSource, f.src, "emptyUnknown");
      }
    } else if (f.outcome === "error") {
      error++;
      bump(perTool, f.tool, "errors");
      bump(perSource, f.src, "errors");
      bump(perSession, f.sessionId ?? f.file ?? "?", "errors");
      errorCounts.set(f.errorSig, (errorCounts.get(f.errorSig) ?? 0) + 1);
      codeCounts.set(f.errorCode, (codeCounts.get(f.errorCode) ?? 0) + 1);
    } else if (f.outcome === "unpaired") {
      unpaired++;
      bump(perTool, f.tool, "unpaired");
      bump(perSource, f.src, "unpaired");
    } else {
      unknown++;
      bump(perTool, f.tool, "unknown");
      bump(perSource, f.src, "unknown");
    }
    resultChars += f.resultLen ?? 0;
    argsChars += f.argsLen ?? 0;
    if (f.outcome !== "unknown") {
      const t = perTool.get(f.tool);
      t.resultChars += f.resultLen ?? 0;
      t.argsChars += f.argsLen ?? 0;
      const s = perSource.get(f.src);
      s.resultChars += f.resultLen ?? 0;
      s.argsChars += f.argsLen ?? 0;
      if (typeof f.durationMs === "number") {
        t.durations.push(f.durationMs);
        s.durations.push(f.durationMs);
      }
    }
    if (typeof f.durationMs === "number") durations.push(f.durationMs);
    const day = new Date(f.ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  const toolRows = [...perTool.entries()]
    .map(([tool, v]) => {
      const settled = v.ok + v.errors; // 只有配对成功的才进错误率分母
      return {
        tool,
        calls: v.calls,
        ok: v.ok,
        errors: v.errors,
        errorRate: settled ? +(v.errors / settled).toFixed(4) : null,
        emptySuccess: v.emptySuccess,
        emptyUnknown: v.emptyUnknown,
        emptyRate: v.ok - v.emptyUnknown > 0 ? +(v.emptySuccess / (v.ok - v.emptyUnknown)).toFixed(4) : null,
        unpaired: v.unpaired,
        unknown: v.unknown,
        resultChars: v.resultChars,
        argsChars: v.argsChars,
        medianDurationMs: pctOf(v.durations, 50),
        p95DurationMs: pctOf(v.durations, 95),
        maxDurationMs: v.durations.length ? Math.max(...v.durations) : null,
        over5s: v.durations.filter((d) => d > 5000).length,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const sourceRows = [...perSource.entries()].map(([src, v]) => {
    const settled = v.ok + v.errors;
    return {
      src,
      calls: v.calls,
      ok: v.ok,
      errors: v.errors,
      errorRate: settled ? +(v.errors / settled).toFixed(4) : null,
      emptySuccess: v.emptySuccess,
      unpaired: v.unpaired,
      unknown: v.unknown,
    };
  });

  // 会话维度：样本偏斜与“错误后恢复”都必须在会话内算，跨会话拼时间序会得出假结论
  const sessionRows = [...perSession.entries()]
    .map(([sid, v]) => {
      const settled = v.ok + v.errors;
      return {
        session: sid,
        calls: v.calls,
        ok: v.ok,
        errors: v.errors,
        errorRate: settled ? +(v.errors / settled).toFixed(4) : null,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const recovery = { nextOk: 0, nextError: 0, nextOther: 0, sessions: 0 };
  {
    const bySession = new Map();
    for (const f of facts) {
      const key = f.sessionId ?? f.file ?? "?";
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(f);
    }
    for (const arr of bySession.values()) {
      arr.sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < arr.length - 1; i++) {
        if (arr[i].outcome !== "error") continue;
        const n = arr[i + 1].outcome;
        if (n === "ok") recovery.nextOk++;
        else if (n === "error") recovery.nextError++;
        else recovery.nextOther++;
      }
      recovery.sessions = bySession.size;
    }
  }

  const sortedDur = durations.slice().sort((a, b) => a - b);
  const pct = (p) => (sortedDur.length ? sortedDur[Math.min(sortedDur.length - 1, Math.floor((p / 100) * sortedDur.length))] : null);

  const total = ok + error + unpaired;
  const settled = ok + error;

  return {
    schema: 2,
    window: meta.window ?? null,
    coverage: meta.coverage ?? null,
    totals: {
      calls: total,
      ok,
      errors: error,
      settled,
      unpaired,
      unknown,
      errorRate: settled ? +(error / settled).toFixed(4) : null,
      emptySuccess,
      emptyUnknown,
      emptyRate: ok - emptyUnknown > 0 ? +(emptySuccess / (ok - emptyUnknown)).toFixed(4) : null,
      unknownRate: total + unknown ? +(unknown / (total + unknown)).toFixed(4) : null,
      unpairedRate: total ? +(unpaired / total).toFixed(4) : null,
    },
    cost: {
      resultChars,
      argsChars,
      medianDurationMs: pct(50),
      p95DurationMs: pct(95),
      durationSamples: durations.length,
    },
    perTool: toolRows,
    perSource: sourceRows,
    perSession: sessionRows,
    recovery,
    perDay: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    topErrors: [...errorCounts.entries()]
      .map(([sig, count]) => ({ sig, count }))
      .sort((a, b) => b.count - a.count),
    topErrorCodes: [...codeCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
  };
}
