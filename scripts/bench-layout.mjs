#!/usr/bin/env node
/**
 * 每帧成本的量具（07 台账"大图谱帧率没量过"那一格）：
 * esbuild 把 scripts/bench-paint.ts 打成 ESM → node 跑 → 打印读数表。
 *
 *   npm run bench
 *   node scripts/bench-layout.mjs --sizes=200,800 --codes=radial
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const outDir = mkdtempSync(join(tmpdir(), "zmind-bench-"));
const outFile = join(outDir, "bench-paint.mjs");
try {
  await esbuild.build({
    entryPoints: [join(ROOT, "scripts", "bench-paint.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: outFile,
    logLevel: "warning",
  });
  const { runBench, BENCH_CODES, BENCH_SIZES } = await import(pathToFileURL(outFile).href);
  const sizes = flag("sizes") ? flag("sizes").split(",").map(Number) : BENCH_SIZES;
  const codes = flag("codes") ? flag("codes").split(",") : BENCH_CODES;
  const rows = runBench(codes, sizes);

  console.log(
    `环境：node ${process.version}｜CPU ${cpus()[0]?.model.trim()}｜核 ${cpus().length}｜内存 ${(totalmem() / 1073741824).toFixed(0)} GB`
  );
  console.log(
    "口径：拖动中每帧真正调的那一次 = paintPage(page,{liveBranch})；**不含 React 提交 DOM**，所以是每帧成本的下界。\n"
  );
  const head = [
    "版式码",
    "主题",
    "盒子",
    "连线",
    "整页重排 p50",
    "拖一帧 p50",
    "拖一帧 p95",
    "省",
    "每帧 fps",
    "60fps 预算 16.7ms",
  ];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(cell(r, i)).length)));
  console.log(head.map((h, i) => h.padEnd(w[i])).join(" │ "));
  console.log(w.map((n) => "─".repeat(n)).join("─┼─"));
  for (const r of rows)
    console.log(head.map((_, i) => String(cell(r, i)).padEnd(w[i])).join(" │ "));
  console.log(
    "\n判定：拖一帧 p50 ≤ 16.7ms 才谈得上 60fps；16.7~33.3ms 之间是「掉帧但跟手」；> 33.3ms（<30fps）拖动会明显滞后。"
  );
  const worst = rows.reduce((a, b) => (b.drag50 > a.drag50 ? b : a), rows[0]);
  console.log(
    `最贵的一格：${worst.code} @ ${worst.topics} 主题 —— 拖一帧 p50 ${worst.drag50.toFixed(2)}ms` +
      `（p95 ${worst.drag95.toFixed(2)}ms，约 ${(1000 / worst.drag50).toFixed(1)} fps 的引擎上限；` +
      `整页重排那一列 ${worst.cold50.toFixed(2)}ms 是不缓存时的代价）`
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function cell(r, i) {
  switch (i) {
    case 0:
      return r.code;
    case 1:
      return r.topics;
    case 2:
      return r.boxes;
    case 3:
      return r.connectors;
    case 4:
      return `${r.cold50.toFixed(2)}ms`;
    case 5:
      return `${r.drag50.toFixed(2)}ms`;
    case 6:
      return `${r.drag95.toFixed(2)}ms`;
    case 7:
      return `${(r.cold50 / r.drag50).toFixed(1)}×`;
    case 8:
      return r.fps.toFixed(1);
    default: {
      const fps = 1000 / r.drag50;
      return fps >= 60 ? "在预算内" : fps >= 30 ? "掉帧但跟手" : "跟不上（<30fps）";
    }
  }
}
