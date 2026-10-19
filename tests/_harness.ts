/**
 * 零依赖断言工具：所有测试文件共用一份。
 *
 * 为什么不用 vitest/jest：参考项目 z-biz-tool-terminal 的约定是
 * `node tests/run.mjs`，一条命令、无额外运行时、离线可跑。
 * 这里只保留 ok/eq/near/throws 四件套，输出统一的 `PASS n / FAIL m`，
 * 由 run.mjs 汇总。
 */
let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Uint8Array) return `Bytes(${v.length})`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

export function eq(label: string, actual: unknown, expected: unknown): void {
  const a = show(actual);
  const b = show(expected);
  ok(label, a === b, `实际 ${a} ≠ 期望 ${b}`);
}

export function near(label: string, actual: number, expected: number, eps = 0.51): void {
  ok(label, Math.abs(actual - expected) <= eps, `实际 ${actual} 偏离期望 ${expected} 超过 ${eps}`);
}

export function throws(label: string, fn: () => unknown, match?: string): void {
  try {
    fn();
    ok(label, false, "预期抛错但没有抛");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(label, !match || msg.includes(match), `抛错信息是 "${msg}"，不含 "${match}"`);
  }
}

export async function rejects(label: string, p: Promise<unknown>, match?: string): Promise<void> {
  try {
    await p;
    ok(label, false, "预期 reject 但成功了");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(label, !match || msg.includes(match), `报错信息是 "${msg}"，不含 "${match}"`);
  }
}

/** 打印汇总并设置退出码；run.mjs 靠这行正则统计。 */
export function done(): void {
  for (const f of failures) console.log(f);
  // 跳过数**必须出现在汇总行里**。
  //
  // 之前 skip() 只打印一行说明、不计数，于是：
  //   - 汇总行只报 PASS/FAIL ⇒ "跑满了" 与 "少跑了几百例" 在输出上长得一样；
  //   - run.mjs 在没有失败时把那几行说明当噪声丢掉 ⇒ 连"有东西被跳过"都看不见。
  // 本仓有一批断言依赖 `_research/`（亿图装机的解包样本，**故意不入库**），
  // 于是任何新克隆与 CI 都跑不到它们，而日志是全绿的 —— 台账里那句
  // "2,678 例"也就只有持有素材的那台机器复现得了。
  // 跳过不是失败（素材按设计不可再分发），但它必须**可见**。
  console.log(`PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * 跳过一条断言分支。
 *
 * 跳过的**原因**必须写清楚 —— 因为"跳过"往往是"这台机器/这个环境没有那批数据"，
 * 而读日志的人需要一眼看出「少跑的到底是什么」。
 */
export function skip(label: string, reason: string): void {
  skipped += 1;
  console.log(`  – 跳过 ${label}：${reason}`);
}
