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
  console.log(`PASS ${passed} / FAIL ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

export function skip(label: string, reason: string): void {
  console.log(`  – 跳过 ${label}：${reason}`);
}
