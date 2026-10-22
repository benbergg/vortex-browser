/**
 * 安装脚本的 shell 变量引用护栏。
 *
 * 背景:bash 在 C/UTF-8 locale 下会把「变量名紧跟多字节字符」里的首个多字节字节
 * 并入变量名 —— `"$NM_EXIT）。"` 会被解析成变量 `NM_EXIT\xef...`，
 * 在 `set -u` 下直接报 `unbound variable`，把本该看到的错误信息换成一句天书。
 * （2026-10-22 本地安装实测撞到：install.sh 的 NM 注册失败分支。）
 *
 * 契约:仓库内 shell 脚本里，变量引用后紧跟非 ASCII 字符时必须写成 ${VAR}。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function shellScripts(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) shellScripts(p, acc);
    else if (name.endsWith(".sh")) acc.push(p);
  }
  return acc;
}

// $VAR 紧跟非 ASCII 字符（bash 会把多字节首字节并入变量名）
const RISKY = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

describe("shell 脚本：变量引用后紧跟非 ASCII 字符必须用 ${VAR}", () => {
  it("scripts/ 与 packages/*/scripts/ 下无裸 $VAR 紧跟 CJK 的写法", () => {
    const files = [
      ...shellScripts(join(REPO_ROOT, "scripts")),
      ...shellScripts(join(REPO_ROOT, "packages")),
    ];
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.trim().startsWith("#")) return;
        if (RISKY.test(line)) offenders.push(`${f.replace(REPO_ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
