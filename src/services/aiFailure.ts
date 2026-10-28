/**
 * AI 失败的结构化表达（与 Rust `ai::LlmFailure` 一一对应）。
 *
 * ## 为什么单独一个模块
 *
 * 后端 `ai_generate_outline` 的 Err 值不再是字符串，而是一个对象。
 * 这个对象要穿过三层：Tauri invoke → `services/native.ts` → `services/ai.ts` →
 * `views/AiTopicDialog.tsx`。三处各写一份「判断这是不是结构化失败」的鸭子类型判断，
 * 迟早会有一处漏掉字段名（`focus` vs `focusField`），而失效的表现是
 * 「错误提示退化成一句话」—— 没人会把它当 bug 报。
 *
 * 所以：**认这一种形状、只在这里认**。
 */
export type AiFocus = "apiKey" | "baseUrl" | "model" | "none";

export interface AiFailure {
  /** notConfigured / network / timeout / http / parse / unsupported / io */
  kind: string;
  /** 仅 kind === "http" 时非空 */
  status?: number | null;
  /** 原始错误（已脱敏、已截断） */
  message: string;
  /** 一句话动机 + 一个动作 */
  hint: string;
  /** 该把光标送进哪一栏 */
  focus: AiFocus;
}

const FOCUSES: readonly string[] = ["apiKey", "baseUrl", "model", "none"];

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * 判断一个被 reject 的值是不是后端给的结构化失败。
 *
 * 三个字段必须同时像样才认：`message` 是字符串、`focus` 是四个已知值之一、`kind` 是字符串。
 * 放宽到「有 message 就算」会把任何 `Error` 都认成结构化失败，
 * 于是 `focus` 变成 undefined，界面拿它去比 `"apiKey"` 永远不成立，
 * 动作按钮静默消失 —— 又一个「看起来只是没提示」的故障。
 */
export function isAiFailure(v: unknown): v is AiFailure {
  const r = asRecord(v);
  if (!r) return false;
  return (
    typeof r.message === "string" &&
    typeof r.kind === "string" &&
    typeof r.focus === "string" &&
    FOCUSES.includes(r.focus)
  );
}

/** 携带完整结构化信息的错误，供上层的 `catch` 直接取用。 */
export class AiFailureError extends Error {
  readonly failure: AiFailure;

  constructor(failure: AiFailure) {
    super(failure.message);
    this.name = "AiFailureError";
    this.failure = failure;
  }
}

/**
 * 把任意异常规范成 `AiFailureError`。
 *
 * 字符串异常（含 Tauri 抛的普通错误）转成 kind = "unknown"、focus = "none" ——
 * 刻意**不猜**它该聚焦哪一栏：猜错了会把用户送进一个跟错误无关的输入框，
 * 比不送更浪费时间。
 */
export function toAiFailureError(e: unknown): AiFailureError {
  if (e instanceof AiFailureError) return e;
  if (isAiFailure(e)) return new AiFailureError(e);
  const message = e instanceof Error ? e.message : String(e);
  return new AiFailureError({
    kind: "unknown",
    status: null,
    message,
    hint: "",
    focus: "none",
  });
}

/** 从任意异常里取结构化失败（取不到就返回 null）。 */
export function failureOf(e: unknown): AiFailure | null {
  if (e instanceof AiFailureError) return e.failure;
  if (isAiFailure(e)) return e;
  return null;
}
