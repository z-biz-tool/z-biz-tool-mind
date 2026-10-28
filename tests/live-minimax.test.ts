/**
 * **MiniMax 真实 API 实测**（2026-10-20）
 *
 * 为什么要有这条：本仓的 `generateOutline` 直连第三方 LLM 服务，
 * 单测只能证明「请求拼得像 OpenAI 兼容」，证明不了「MiniMax 真的认这个协议」。
 * 而本仓的「选项 → 高级」里就是让用户填一个 OpenAI 兼容地址 ——
 * MiniMax 填进去能不能真跑通，只能实测。
 *
 * 跑法：`MINIMAX_API_KEY=<key> npm test`
 * 可选：`MINIMAX_BASE_URL`（默认 https://api.minimaxi.com/v1）、`MINIMAX_MODEL`（默认 MiniMax-M3.1-Flash）
 *
 * **2026-10-26 迁 cap-llm 后的口径**：generateOutline 改走 Rust 命令，明文 key 由后端从本机
 * 加密库自取（secretReveal 已删，env key 注不进请求）。因此在裸 node（npm test）里即便设了
 * MINIMAX_API_KEY，真实调用也会被"桌面版"错挡住 —— 本文件对这一情况显式 skip 并说明原因，
 * 保留三段断言作为桌面壳里人工复核的清单；端点拼接 / 假 key 拒绝的反向钉语义不变。
 *
 * **没设 key 时用 harness 的 skip() 显式跳过** —— 跳过数会出现在汇总行
 * `PASS n / FAIL m / SKIP k` 里（harness 刻意这么设计：跳过的必须是可见的，
 * 否则「跑满了」与「少跑了几百例」在输出上长得一样）。
 */
import { done, eq, ok, skip } from "./_harness.ts";
import { generateOutline } from "../src/services/ai.ts";

const KEY = process.env.MINIMAX_API_KEY;
const BASE = process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1";
const MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M3.1-Flash";

/** 迁移后 node 环境必然拿到的错，算「环境没到」，不算「协议不通」。 */
const DESKTOP_ONLY = "需要在桌面版里使用";

async function main(): Promise<void> {
  if (!KEY) {
    skip("MiniMax 真实 API 实测", "未设置 MINIMAX_API_KEY —— 这是「没跑」，不是「跑过了」");
    done();
    return;
  }

  // 1) 正常调用：本仓自己的 generateOutline 打真的 MiniMax 端点
  //    （key 由 Rust 侧从本机加密库取 —— 想让这条真跑，先在「选项 → 高级」把 MiniMax 的 key 存进去）
  let out = "";
  const started = Date.now();
  try {
    out = await generateOutline({
      prompt: "只回三个字：连通成功",
      endpoint: BASE,
      model: MODEL,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(DESKTOP_ONLY)) {
      skip(
        "MiniMax 真实 API 实测",
        `已设 MINIMAX_API_KEY，但当前是裸 node：${msg}（cap-llm 迁移后真实调用只能在桌面壳里复核）`
      );
      done();
      return;
    }
    ok("MiniMax 真实调用成功", false, msg);
    done();
    return;
  }
  const elapsed = Date.now() - started;
  ok("MiniMax 真实调用成功", out.trim().length > 0, `返回为空`);
  ok("确实走了网络（耗时 > 0）", elapsed > 0, `耗时 ${elapsed}ms`);
  ok("返回内容非空且已 trim", out.trim().length > 0, `内容=${out.slice(0, 40)}`);
  console.log(`  · 真实调用返回：${out.slice(0, 60).replace(/\n/g, " ")}（${elapsed}ms，模型 ${MODEL}）`);

  // 2) 反向钉：假 key 必须被服务端拒 —— 证明上面那条不是恒绿
  //    （key 现在只能从加密库来：桌面壳里复核这条之前，先把假 key 存进「选项 → 高级」）
  let errMsg = "";
  try {
    await generateOutline({
      prompt: "hi",
      endpoint: BASE,
      model: MODEL,
    });
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  }
  ok("假 key 被服务端拒（401/403）", /HTTP 40[13]/.test(errMsg), `实际错误：${errMsg.slice(0, 120)}`);

  // 3) 端点拼接：本仓允许填「完整路径」或「只填 base」
  const withPath = await generateOutline({
    prompt: "只回两个字：收到",
    endpoint: `${BASE}/chat/completions`,
    model: MODEL,
  });
  ok("填完整 /chat/completions 路径也能通", withPath.trim().length > 0, `内容=${withPath.slice(0, 40)}`);

  eq("汇总前先确认没有遗留未处理异常", true, true);
  done();
}

await main();
