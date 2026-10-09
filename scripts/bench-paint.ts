/**
 * 拖动中每一帧真正调的那一次有多贵：`paintPage(page, { liveBranch })`。
 * 07 台账里"大图谱（几百主题）下的帧率没量过"那一格的量具。跑法：`npm run bench`。
 *
 * 读数只覆盖引擎那一半（布局 + 文字测量 + 连线 + 上色），**不含 React 提交 DOM 的成本**，
 * 所以它是每帧预算的下界，不是全部。
 *
 * 两列对照：
 * - `整页重排` = 每帧把 base 也算一遍（换一个新 page 引用，缓存必然失效）；
 * - `拖一帧` = 拖动里真实的那一次（page 不换，只有 liveBranch 在动，命中缓存）。
 * 拖动样本里位移每步都在变，所以把 `liveBranch` 误加进缓存键的话，这一列会立刻退回上一列的水位。
 */
import { createPage } from "../src/model/factory.ts";
import { insertChild } from "../src/engine/tree.ts";
import { paintPage } from "../src/engine/export/svg.ts";
import type { LayoutCode, Page } from "../src/types/model.ts";

/** 确定性 LCG：基准要能跨机器复跑对比，树形不能每次变。 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const WORDS = [
  "市场需求",
  "竞品分析",
  "定价策略",
  "渠道投放",
  "售后闭环",
  "关键里程碑",
  "风险与依赖",
  "下一步动作",
  "负责人",
  "备注",
];

function title(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) parts.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return parts.join("·");
}

/** 造一棵形状像真实脑图的树：根 → 若干主枝 → 深度 3~5，长短名混着，直到约 n 个主题。 */
function buildPage(n: number, code: LayoutCode): { page: Page; branch: string } {
  let page = createPage("基准");
  const rnd = rng(0x5eed + n);
  let count = 1;
  const add = (parent: string) => {
    const r = insertChild(page, parent, title(rnd));
    page = r.page;
    count += 1;
    return r.id;
  };
  const branches: string[] = [];
  while (count < n) {
    const b = add(page.rootId);
    branches.push(b);
    const kids = 2 + Math.floor(rnd() * 5);
    for (let i = 0; i < kids && count < n; i += 1) {
      const c = add(b);
      if (rnd() < 0.4) continue;
      const gc = 1 + Math.floor(rnd() * 4);
      for (let j = 0; j < gc && count < n; j += 1) {
        const g = add(c);
        if (rnd() < 0.35 && count < n) add(g);
        if (rnd() < 0.12 && count + 2 <= n) {
          const gg = add(g);
          add(gg);
        }
      }
    }
  }
  return {
    page: { ...page, layout: { ...page.layout, code } },
    branch: branches[1] ?? branches[0],
  };
}

/** `at(i)` 拿到第几次迭代：用来让每帧的位移都不同（真拖动就是每帧在变）。 */
function stats(at: (i: number) => unknown, iters: number) {
  for (let i = 0; i < 3; i += 1) at(i); // 预热：让 JIT 先编译稳定
  const xs: number[] = [];
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    at(i);
    xs.push(performance.now() - t0);
  }
  xs.sort((a, b) => a - b);
  return {
    p50: xs[xs.length >> 1],
    p95: xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))],
  };
}

export interface BenchRow {
  code: LayoutCode;
  topics: number;
  boxes: number;
  connectors: number;
  /** 每帧都重排整页 base（老做法的成本，也是缓存失效时的代价）。 */
  cold50: number;
  /** 拖动中真实的那一帧：命中缓存，只重做平移 + 连线 + 包围盒。 */
  drag50: number;
  drag95: number;
  fps: number;
}

/** 四码挑的是四条不同的热路径：直角折线 / 极坐标 / 气泡（含逐链半径累加）/ 表格（含格线并集）。 */
export const BENCH_CODES: LayoutCode[] = ["logicRight", "radial", "bubbleMap", "treeTableLeft"];
export const BENCH_SIZES = [100, 300, 600, 1200, 2400];

export function runBench(codes = BENCH_CODES, sizes = BENCH_SIZES): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const code of codes) {
    for (const n of sizes) {
      const { page, branch } = buildPage(n, code);
      const opts = (i: number) => ({
        displayLevel: 9,
        topicWidthMode: "auto" as const,
        liveBranch: { id: branch, x: 40 + i * 7, y: 60 + i * 5 },
      });
      const painted = paintPage(page, opts(0));
      // 拖动：page 引用全程不换，只有位移在变
      const drag = stats((i) => paintPage(page, opts(i)), 25);
      // 整页重排：每次换一个浅拷贝引用，缓存一律失效
      const cold = stats((i) => paintPage({ ...page }, opts(i)), 25);
      rows.push({
        code,
        topics: Object.keys(page.shapes).length,
        boxes: painted.boxes.length,
        connectors: painted.connectors.length,
        cold50: cold.p50,
        drag50: drag.p50,
        drag95: drag.p95,
        fps: 1000 / drag.p50,
      });
    }
  }
  return rows;
}
