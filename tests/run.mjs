#!/usr/bin/env node
/**
 * 零依赖测试跑子（对齐 z-biz-tool-terminal 的约定）：
 *   esbuild 把单个 tests/*.test.ts 打成 ESM → node 执行 → 正则收集 "PASS n / FAIL m"。
 *
 * 单独打包而不是整体 bundle：一个文件编译失败不会连坐其它文件，
 * 报错也能精确到文件名。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");
const filter = process.argv[2];

const files = readdirSync(testsDir)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error(`没有匹配 "${filter ?? ""}" 的测试文件（tests/*.test.ts）`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "z-mind-tests-"));
const rows = [];
let totalPass = 0;
let totalFail = 0;

for (const file of files) {
  const outfile = join(tmp, file.replace(/\.tsx?$/, ".mjs"));
  try {
    await esbuild.build({
      entryPoints: [join(testsDir, file)],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      logLevel: "warning",
      banner: {
        js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
      },
    });
  } catch (e) {
    rows.push({ file, pass: 0, fail: 1, note: `打包失败：${e.message}` });
    totalFail += 1;
    continue;
  }

  const r = spawnSync(process.execPath, [outfile], { encoding: "utf8", timeout: 60_000, cwd: root });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) {
    rows.push({ file, pass: 0, fail: 1, note: `执行失败：${r.error.message}` });
    totalFail += 1;
    continue;
  }
  const segs = [...out.matchAll(/PASS (\d+) \/ FAIL (\d+)/g)];
  if (!segs.length) {
    // 没打印汇总行 = 中途崩了，按失败处理，绝不能当通过
    rows.push({ file, pass: 0, fail: 1, note: "没有汇总行（测试文件异常退出）" });
    console.log(out.trim().split("\n").slice(-14).join("\n"));
    totalFail += 1;
    continue;
  }
  let p = 0;
  let f = 0;
  for (const m of segs) {
    p += Number(m[1]);
    f += Number(m[2]);
  }
  const noise = out
    .split("\n")
    .filter((l) => l.trim() && !/^PASS \d+ \/ FAIL \d+$/.test(l.trim()))
    .slice(0, 8)
    .join("\n");
  rows.push({ file, pass: p, fail: f, note: f ? noise : "" });
  totalPass += p;
  totalFail += f;
}

rmSync(tmp, { recursive: true, force: true });

console.log("");
for (const row of rows) {
  const mark = row.fail ? "✗" : "✓";
  console.log(`${mark} ${row.file.padEnd(28)} PASS ${row.pass} / FAIL ${row.fail}`);
  if (row.note) console.log(row.note.split("\n").map((l) => `    ${l}`).join("\n"));
}
console.log(`\n===== ${files.length} 个测试文件，共 ${totalPass + totalFail} 例 =====`);
process.exit(totalFail ? 1 : 0);
