/**
 * 结构化 AI 失败的形状契约（services/aiFailure.ts）。
 *
 * 这个模块是「后端 Err 对象 → 界面动作按钮」的唯一翻译层。它坏掉的表现很轻：
 * 错误提示还在，只是不再带动作按钮、不再指向具体那一栏 ——
 * 用户看到的仍然是一句人话，所以没人会把它当 bug 报上来。
 * 正因为「坏了也像正常的」，这里把每个判断都钉住。
 */
import { done, eq, ok } from "./_harness.ts";
import { AiFailureError, failureOf, isAiFailure, toAiFailureError } from "../src/services/aiFailure.ts";

/* -------------------------------------------------- 认形状 */

const real = {
  kind: "http",
  status: 401,
  message: "HTTP 401 — invalid api key",
  hint: "API Key 无效或已过期。",
  focus: "apiKey",
};
ok("后端给的对象被认成结构化失败", isAiFailure(real));

eq("普通 Error 不算结构化失败", isAiFailure(new Error("boom")), false);
eq("字符串不算", isAiFailure("HTTP 401"), false);
eq("null 不算", isAiFailure(null), false);
eq("undefined 不算", isAiFailure(undefined), false);

// 缺 focus 的对象必须**不**被认成结构化失败：认了就会得到一个 focus=undefined，
// 界面拿它去比 "apiKey" 永远不成立，动作按钮静默消失。
eq(
  "缺 focus 的不算（否则动作按钮会静默消失）",
  isAiFailure({ kind: "http", message: "x", hint: "y" }),
  false,
);
eq(
  "focus 不在已知四项里的不算（拼错字段值同样会丢按钮）",
  isAiFailure({ kind: "http", message: "x", hint: "y", focus: "api_key" }),
  false,
);
eq(
  "缺 hint 的仍算（hint 可以空，动作还在）",
  isAiFailure({ kind: "http", message: "x", hint: "", focus: "none" }),
  true,
);

/* -------------------------------------------------- 包成 Error */

const wrapped = toAiFailureError(real);
ok("包出来的仍然是 Error（调用方按 instanceof Error 判分支）", wrapped instanceof Error);
ok("包出来的带 AiFailureError 名字", wrapped instanceof AiFailureError);
eq("message 用原始错误", wrapped.message, real.message);
eq("failure 原样保留", wrapped.failure.focus, "apiKey");
eq("重复包不会套娃", toAiFailureError(wrapped), wrapped);

const plain = toAiFailureError(new Error("连不上"));
eq("普通错误降级为 unknown", plain.failure.kind, "unknown");
eq("普通错误不猜聚焦目标", plain.failure.focus, "none");
eq("普通错误保留原文", plain.message, "连不上");

/* -------------------------------------------------- 取回来 */

eq("from Error 取得回结构化失败", failureOf(wrapped)?.status, 401);
eq("from 裸对象也取得回", failureOf(real)?.kind, "http");
eq("from 字符串取不到", failureOf("nope"), null);

done();
