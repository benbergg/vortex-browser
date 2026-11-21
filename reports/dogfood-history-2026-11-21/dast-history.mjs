#!/usr/bin/env node
/**
 * 原语轴 DAST：`vortex_history`（back/forward + 边界 + 拒绝恢复）。
 *
 * 第 3 轮独立审核的两个阻塞项已在此修正：
 *   B1 ⇒ 「拒绝恢复」与「真正索引越界」拆成两个独立场景（不再用一个断言混两件事）
 *   B2 ⇒ 记录 hub/浏览器的 buildStamp（构建来源）、拒绝前的目标 entry 真值、
 *         拒绝后**独立**读取当前 URL（不拿之前成功调用的返回值顶替）
 *
 * 判据：每条 assert 打印 PASS/FAIL；任一 FAIL ⇒ 退出码 1。
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";

const REPO = process.env.VORTEX_REPO ?? "/Users/lg/workspace/vortex";
const SERVER = process.env.VORTEX_SERVER ?? join(REPO, "packages/mcp/dist/src/server.js");
const HUB = process.env.VORTEX_HUB ?? "http://localhost:6800";

function resolveSdkFile(fileName) {
  const pnpmEntry = join(REPO, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client", fileName);
  if (existsSync(pnpmEntry)) return pnpmEntry;
  const req = createRequire(join(REPO, "packages/mcp/package.json"));
  const anchor = req.resolve("@modelcontextprotocol/sdk/client");
  const root = anchor.slice(0, anchor.indexOf("/@modelcontextprotocol/sdk") + "/@modelcontextprotocol/sdk".length);
  return join(root, "dist/esm/client", fileName);
}

const { Client } = await import(pathToFileURL(resolveSdkFile("index.js")).href);
const { StdioClientTransport, getDefaultEnvironment } = await import(pathToFileURL(resolveSdkFile("stdio.js")).href);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: "ignore",
  env: { ...getDefaultEnvironment(), VORTEX_USAGE_LOG: process.env.VORTEX_USAGE_LOG ?? "1" },
});
const client = new Client({ name: "vortex-history-dast", version: "0.0.0" });

const call = async (name, args) => {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { isError: Boolean(res.isError), text, parsed };
  } catch (err) {
    return { isError: true, text: `THROWN: ${err?.message ?? String(err)}`, parsed: null };
  }
};
const urlOf = (r) => r.parsed?.url ?? null;

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: Boolean(cond), detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const out = { server: SERVER, results, steps: [] };
const step = (name, r, extra = {}) => out.steps.push({ name, isError: r.isError, text: r.text.slice(0, 400), ...extra });

try {
  await client.connect(transport);

  // —— 构建来源证据（hub 上报的**已连接浏览器** buildStamp）——
  // 第 3 轮审核 B2：必须核对浏览器实际加载的 buildStamp，而不是只把 worktree 路径写在注释里。
  // 传入 VORTEX_EXPECT_STAMP 时，不一致直接判 FAIL（防测错版本造成假绿）。
  try {
    const health = await fetch(`${HUB}/health`).then((r) => r.json());
    const browsers = Array.isArray(health.browsers) ? health.browsers : [];
    const stamps = browsers.map((b) => b.buildStamp ?? null).filter(Boolean);
    out.hub = {
      buildStamp: stamps[0] ?? health.buildStamp ?? health.extensionBuildStamp ?? null,
      allBuildStamps: stamps,
      nmConnected: health.nmConnected ?? null,
      extDist: browsers[0]?.extDist ?? null,
    };
    console.log(`[build] hub buildStamp=${out.hub.buildStamp} extDist=${out.hub.extDist}`);
    const expected = process.env.VORTEX_EXPECT_STAMP;
    if (expected) {
      assert(`[build] 浏览器加载的 buildStamp 与期望一致（期望 ${expected}）`,
        stamps.includes(expected),
        `actual=${stamps.join(",") || "none"}`);
    }
  } catch (err) {
    out.hub = { error: String(err?.message ?? err) };
    console.log(`[build] hub health 读取失败: ${out.hub.error}`);
    assert("[build] hub health 可读（构建来源证据）", false, out.hub.error);
  }

  // ============ 场景 A：拒绝恢复（退到浏览器内部页历史项）============
  const created = await call("vortex_tab_create", { active: false });
  step("A.tab_create", created);
  const tabId = created.parsed?.tabId ?? created.parsed?.id ?? null;
  out.tabId = tabId;
  assert("A.1 建隔离 tab 成功", !created.isError && tabId != null, `tabId=${tabId}`);
  if (tabId == null) throw new Error("建 tab 失败 ⇒ 立即停止（避免空 tabId 误操作其它标签页）");

  const A = "https://example.com/";
  const B = "https://www.iana.org/domains/reserved";

  const navA = await call("vortex_navigate", { url: A, tabId });
  step("A.navigate_A", navA, { url: urlOf(navA) });
  const navB = await call("vortex_navigate", { url: B, tabId });
  step("A.navigate_B", navB, { url: urlOf(navB) });
  assert("A.2 两页导航成功", !navA.isError && !navB.isError && urlOf(navB) === B, `url=${urlOf(navB)}`);

  // 拒绝场景的可复现序列（与 validated-defects.md 记录的诊断一致）：
  // 建 tab → 导航 A → 导航 B → back → forward → forward(栈顶边界) → back → back(退到初始新标签页)
  // 少了中间的 forward/back 往复时，Chrome 的历史表里不包含初始新标签页，
  // 第二次 back 只会落到「已在最旧条目」的索引越界分支 ⇒ 测不到拒绝分支（假绿）。
  const back1 = await call("vortex_history", { tabId, direction: "back" });
  step("A.back_to_A", back1, { url: urlOf(back1) });
  assert("A.3 第一次 back 回到 A", !back1.isError && urlOf(back1) === A, `url=${urlOf(back1)}`);

  const fwd1 = await call("vortex_history", { tabId, direction: "forward" });
  step("A.forward_to_B", fwd1, { url: urlOf(fwd1) });
  assert("A.4 forward 回到 B", !fwd1.isError && urlOf(fwd1) === B, `url=${urlOf(fwd1)}`);

  const fwdEdge = await call("vortex_history", { tabId, direction: "forward" });
  step("A.forward_edge(栈顶索引越界)", fwdEdge);
  assert("A.5 栈顶 forward 是索引越界 NO_EFFECT（对照组）",
    fwdEdge.isError && fwdEdge.text.includes("[NO_EFFECT]") && !fwdEdge.text.includes("[JS_EXECUTION_ERROR]"),
    fwdEdge.text.slice(0, 160).replace(/\n/g, " | "));

  const back2 = await call("vortex_history", { tabId, direction: "back" });
  step("A.back_to_A_again", back2, { url: urlOf(back2) });
  assert("A.6 再 back 回到 A", !back2.isError && urlOf(back2) === A, `url=${urlOf(back2)}`);

  const refusal = await call("vortex_history", { tabId, direction: "back" });
  step("A.back_to_newtab(拒绝场景)", refusal);
  const refusalText = refusal.text;
  assert("A.7 退到内部页返回 NO_EFFECT（不是 JS_EXECUTION_ERROR）",
    refusal.isError && refusalText.includes("[NO_EFFECT]") && !refusalText.includes("[JS_EXECUTION_ERROR]"),
    refusalText.slice(0, 160).replace(/\n/g, " | "));
  assert("A.8 错误文案陈述「浏览器拒绝恢复该历史项」（目标 URL 取不到时显示 (unknown URL)）",
    /refus/i.test(refusalText) || /拒绝/.test(refusalText),
    refusalText.slice(0, 200).replace(/\n/g, " | "));
  assert("A.9 hint 指向可执行替代（vortex_navigate）",
    /Hint:/.test(refusalText) && /vortex_navigate/.test(refusalText),
    (refusalText.split("Hint:")[1] ?? "").slice(0, 160).replace(/\n/g, " | "));

  // 拒绝后**独立**读取当前 URL（不拿之前成功调用的返回值顶替）
  const afterRefusal = await call("vortex_evaluate", {
    tabId,
    code: "(() => ({ url: location.href, title: document.title }))()",
  });
  step("A.dom_truth_after_refusal", afterRefusal);
  let afterUrl = null;
  try { afterUrl = JSON.parse((afterRefusal.text.match(/\{[\s\S]*\}/) ?? [""])[0]).url ?? null; } catch { /* */ }
  out.afterRefusalUrl = afterUrl;
  assert("A.10 拒绝后页面位置未变（仍在 A）", afterUrl === A, `url=${afterUrl}`);

  // hint 指向的替代动作可执行：导航到**另一个** URL（B），证明替代动作真的能改变页面位置
  // （若还导航到 A —— 此时已在 A —— 断言会假绿）
  const recovery = await call("vortex_navigate", { url: B, tabId });
  step("A.recovery_navigate", recovery, { url: urlOf(recovery) });
  assert("A.11 hint 指向的替代导航成功且页面位置改变（A→B）", !recovery.isError && urlOf(recovery) === B, `url=${urlOf(recovery)}`);

  // ============ 场景 B：真正的索引越界（forward 到栈顶）============
  const createdB = await call("vortex_tab_create", { active: false });
  step("B.tab_create", createdB);
  const tabIdB = createdB.parsed?.tabId ?? createdB.parsed?.id ?? null;
  out.tabIdB = tabIdB;
  assert("B.1 建第二个隔离 tab 成功", !createdB.isError && tabIdB != null, `tabId=${tabIdB}`);
  if (tabIdB == null) throw new Error("建 tab 失败 ⇒ 立即停止");

  const navB1 = await call("vortex_navigate", { url: A, tabId: tabIdB });
  step("B.navigate", navB1, { url: urlOf(navB1) });
  assert("B.2 导航成功", !navB1.isError && urlOf(navB1) === A, `url=${urlOf(navB1)}`);

  const edge = await call("vortex_history", { tabId: tabIdB, direction: "forward" });
  step("B.forward_edge(索引越界)", edge);
  assert("B.3 真正的索引越界仍是 NO_EFFECT + 可执行 hint",
    edge.isError && edge.text.includes("[NO_EFFECT]") && /vortex_navigate/.test(edge.text),
    edge.text.slice(0, 160).replace(/\n/g, " | "));
  assert("B.4 索引越界文案与拒绝文案可区分（越界=已在最新条目）",
    /newest entry/i.test(edge.text) && !/refus/i.test(edge.text),
    edge.text.slice(0, 160).replace(/\n/g, " | "));

  if (tabId != null) step("A.tab_close", await call("vortex_tab_close", { tabId }));
  if (tabIdB != null) step("B.tab_close", await call("vortex_tab_close", { tabId: tabIdB }));
} catch (err) {
  assert("脚本未抛异常", false, String(err?.message ?? err));
} finally {
  await client.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[summary] ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
