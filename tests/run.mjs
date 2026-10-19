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
const filter = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
// --require-all：有本机取证素材时用它确认「真样本」那批断言真的跑了。
//
// 默认不失败：_research/ 按设计不入库（不是我们能再分发的东西），
// 任何新克隆与 CI 都必然跳过那批，跳过不是失败。
// 但**持有素材的机器**上，"因为路径写错导致素材没被找到"与"素材本来就没有"
// 在输出上长得一样 —— 这个开关把两者分开：有跳过就红。
const requireAll = process.argv.includes("--require-all");

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
let totalSkip = 0;

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
    rows.push({ file, pass: 0, fail: 1, skip: 0, note: `打包失败：${e.message}`, skips: [] });
    totalFail += 1;
    continue;
  }

  const r = spawnSync(process.execPath, [outfile], { encoding: "utf8", timeout: 60_000, cwd: root });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) {
    rows.push({ file, pass: 0, fail: 1, skip: 0, note: `执行失败：${r.error.message}`, skips: [] });
    totalFail += 1;
    continue;
  }
  const segs = [...out.matchAll(/PASS (\d+) \/ FAIL (\d+)(?: \/ SKIP (\d+))?/g)];
  if (!segs.length) {
    // 没打印汇总行 = 中途崩了，按失败处理，绝不能当通过
    rows.push({ file, pass: 0, fail: 1, skip: 0, note: "没有汇总行（测试文件异常退出）", skips: [] });
    console.log(out.trim().split("\n").slice(-14).join("\n"));
    totalFail += 1;
    continue;
  }
  let p = 0;
  let f = 0;
  let s = 0;
  for (const m of segs) {
    p += Number(m[1]);
    f += Number(m[2]);
    s += Number(m[3] ?? 0);
  }
  // 跳过明细要单独收上来：它们**不是噪声**，是"这台机器少跑了什么"的证据。
  const skips = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("– 跳过"));
  const noise = out
    .split("\n")
    .filter((l) => l.trim() && !/^PASS \d+ \/ FAIL \d+( \/ SKIP \d+)?$/.test(l.trim()))
    .filter((l) => !l.trim().startsWith("– 跳过"))
    .slice(0, 8)
    .join("\n");
  rows.push({ file, pass: p, fail: f, skip: s, note: f ? noise : "", skips });
  totalPass += p;
  totalFail += f;
  totalSkip += s;
}

rmSync(tmp, { recursive: true, force: true });

console.log("");
for (const row of rows) {
  const mark = row.fail ? "✗" : "✓";
  const skipTxt = row.skip ? ` / SKIP ${row.skip}` : "";
  console.log(`${mark} ${row.file.padEnd(28)} PASS ${row.pass} / FAIL ${row.fail}${skipTxt}`);
  if (row.note) console.log(row.note.split("\n").map((l) => `    ${l}`).join("\n"));
}
console.log(`\n===== ${files.length} 个测试文件，共 ${totalPass + totalFail} 例（跳过 ${totalSkip} 处分支） =====`);

// 跳过清单必须**显眼**。
//
// 为什么: 本仓有一批断言依赖 `_research/`（亿图装机的解包样本与逐屏截图，
// 按设计不可再分发 ⇒ 不入库）。没有素材时那些分支整段跳过，而"跳过"既不
// 计入 PASS 也不计入 FAIL —— 于是「全绿」和「少跑了几百例」在日志上长得一模一样。
// 台账里那句"2,678 例"也只有持有素材的那台机器复现得了。
//
// 所以这里把每一处跳过连同原因列出来：CI 日志里能直接看到「本机没跑什么」。
if (totalSkip > 0) {
  console.log(`\n⚠ 以下 ${totalSkip} 处分支被跳过（不是失败，但这些断言本次没跑）：`);
  for (const row of rows) {
    if (!row.skips.length) continue;
    console.log(`  ${row.file}`);
    for (const s of row.skips) console.log(`    ${s}`);
  }
  console.log(
    "\n  多数是「本机取证素材 _research/ 缺失」——该目录按设计不入库（不是我们能再分发的东西），"
  );
  console.log("  任何新克隆与 CI 都跑不到这批。台账引用测试数时必须写清是哪一档。");
  if (requireAll) {
    console.error(
      "\n✗ --require-all：有分支被跳过，本次运行按失败处理。\n" +
        "  如果你手上**有** _research/ 素材却看到这些跳过，多半是路径写错了 —— 先查路径再谈素材。"
    );
    process.exit(1);
  }
}
process.exit(totalFail ? 1 : 0);
