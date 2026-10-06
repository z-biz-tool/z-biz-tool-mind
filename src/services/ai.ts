/**
 * AI 生成（doc/复刻方案/00 §3.13）。
 *
 * 两条约束决定了这里的形状：
 * 1) 只走 OpenAI 兼容的 chat/completions。复刻不绑某一家供应商，端点与模型名来自「选项 → 高级」，
 *    密钥走钥匙串（native.secretReveal），因此这里绝不打日志 —— 崩溃上报会把 console 带走。
 * 2) 生成结果入树必须复用 engine/outline.ts（P-3）。批量录入、Markdown 粘贴、OCR、AI
 *    共用同一条缩进协议；再写一套解析，就会出现"AI 插进来的节点删不掉/升不了级"这种第二份数据结构的病。
 */
import type { Page } from "../types/model.ts";
import { insertOutline, parseOutline } from "../engine/outline.ts";
import { activePage, useDoc } from "../stores/docStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { canGenerate } from "../utils/entitlement.ts";
import { native } from "./native.ts";

export interface AiRequest {
  prompt: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  signal?: AbortSignal;
}

/** 与「选项 → 高级」的密钥输入框约定的槽位名（Rust secret.rs 同名）。 */
const SECRET_KEY = "ai-api-key";

const SYSTEM_PROMPT =
  "你是思维导图大纲生成器。只输出大纲本身：每行一个主题，第一行为中心主题，用制表符缩进表示层级，" +
  "不要解释、不要代码块围栏、不要编号。";

export async function generateOutline(req: AiRequest): Promise<string> {
  const endpoint = req.endpoint.trim();
  if (!endpoint) {
    throw new Error("尚未配置 AI 接口地址，请在「选项 → 高级」里填写 OpenAI 兼容的服务地址（如 https://api.openai.com/v1）。");
  }
  const model = req.model.trim();
  if (!model) {
    throw new Error("尚未配置 AI 模型名称，请在「选项 → 高级」里填写，例如 gpt-4o-mini。");
  }
  const apiKey = req.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new Error("尚未配置 AI API Key，请在「选项 → 高级」里填写密钥；密钥只存在系统钥匙串，不会写进配置文件。");
  }

  // 有人填baseUrl 有人填完整路径，两种都收，省一次"为什么 404"的客服问题。
  const url = /\/chat\/completions\/?$/.test(endpoint)
    ? endpoint
    : `${endpoint.replace(/\/+$/, "")}/chat/completions`;

  // 超时读「选项 → 网络」：走代理的用户 20 秒不够，写死就是替用户做错了决定。
  const timeoutSec = Math.max(1, useSettings.getState().settings.network.timeoutSec || 20);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  const outer = req.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: req.prompt },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    // 三种中止原因要分清楚：用户主动停 ≠ 网络慢 ≠ 地址错了。
    if (outer?.aborted) throw new Error("AI 生成已取消。");
    if (ctrl.signal.aborted) {
      throw new Error(`AI 服务在 ${timeoutSec} 秒内没有响应，已超时；请在「选项 → 网络」里加大超时或检查代理设置。`);
    }
    throw new Error(`无法连接 AI 服务：${e instanceof Error ? e.message : String(e)}；请检查接口地址与网络代理。`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 只带状态码：有些网关的响应体会把 Authorization 回显出来，那句话不能进界面日志。
    throw new Error(`AI 服务返回错误（HTTP ${res.status}），请确认接口地址、模型名称与 API Key 是否匹配。`);
  }

  let content = "";
  try {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    content = data.choices?.[0]?.message?.content ?? "";
  } catch {
    throw new Error("AI 服务返回的不是可解析的 JSON，请确认填写的是 OpenAI 兼容的 chat/completions 接口地址。");
  }
  if (!content.trim()) throw new Error("AI 服务没有返回任何内容，请换一种更具体的描述后重试。");
  return content;
}

/**
 * 同步版本：mutate() 的回调必须是同步的（撤销栈在它返回时才快照），
 * 所以异步外壳里其实一次 await 都没有 —— 保留 async 签名是给未来真要 await 的余量。
 */
function insertOutlineText(page: Page, markdown: string): Page {
  const lines = parseOutline(flattenIndent(stripFence(markdown)), true);
  if (!lines.length) return page;
  // 层级重定基后整段作为**分支**挂到中心主题之下：不改写中心主题，
  // 用户的标题是他写的，AI 只负责往下长。
  const flat = lines.map((l) => INDENT.repeat(l.level) + l.text).join("\n");
  return insertOutline(page, page.rootId, flat, "appendChildren", false).page;
}

/** 与 engine/outline.ts 的 TAB_COLUMNS 同宽；重定基后的缩进也用它，两处必须一致。 */
const INDENT = "    ";

/**
 * 交给共用解析之前先把行首制表符摊成空格。
 *
 * 原因不是风格：parseOutline 用"列宽"当缩进量，却拿同一个数去 slice 字符数
 * （outline.ts:60 的 `raw.slice(cols)`），制表符一列≠一字符，凡是行首带 \t 的行都被当成空行丢掉。
 * 大纲模型、OCR 和多数接口的返回正好爱用 \t —— 不摊平，AI 生成的分支会整层消失。
 * 这里只换缩进单位，不另写解析器：协议仍然只有 engine/outline.ts 那一份（P-3）。
 */
function flattenIndent(text: string): string {
  return text.replace(/^[ \t]+/gm, (lead) => lead.replace(/\t/g, INDENT));
}

/** 模型爱把整段结果包在 ``` 里，不剥掉会多出一个叫 "markdown" 的主题。 */
function stripFence(text: string): string {
  const m = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?\s*```\s*$/);
  return m ? m[1] : text;
}

export async function outlineToPage(page: Page, markdown: string): Promise<Page> {
  return insertOutlineText(page, markdown);
}

/**
 * UI 直接调的那一条完整流程：配置检查 → 配额预检 → 生成 → 结算 → 提交。
 * 返回的句子原样 show 出来，所以每个失败分支都得说清楚"缺什么、去哪儿填"。
 */
export async function runAiInsert(label: string): Promise<{ ok: boolean; message: string }> {
  const settings = useSettings.getState().settings;
  const endpoint = settings.advanced.aiEndpoint.trim();
  const model = settings.advanced.aiModel.trim();
  if (!endpoint) {
    return { ok: false, message: "尚未配置 AI 接口地址，请在「选项 → 高级」里填写 OpenAI 兼容的服务地址后再生成。" };
  }
  if (!model) {
    return { ok: false, message: "尚未配置 AI 模型名称，请在「选项 → 高级」里填写，例如 gpt-4o-mini。" };
  }

  let apiKey: string | null = null;
  try {
    apiKey = await native.secretReveal(SECRET_KEY);
  } catch {
    apiKey = null; // 浏览器模式没有钥匙串：和"没配过"同样处理，别把原生错误抛给用户
  }
  if (!apiKey) {
    return { ok: false, message: "尚未配置 AI API Key，请在「选项 → 高级」里填写密钥。" };
  }

  const page = activePage(useDoc.getState());
  if (!page) {
    return { ok: false, message: "还没有打开文档，请先新建或打开一个脑图，再让 AI 生成。" };
  }

  const q = settings.quota;
  // 先按输入字数拦一次，别为注定要失败的请求花网络钱；结算按生成出来的实际字数（"按上报字数计费"）。
  const precheck = canGenerate(label.length, q.aiPoints, q.aiUsed);
  if (!precheck.ok) return { ok: false, message: precheck.reason };

  let outline: string;
  try {
    outline = await generateOutline({
      prompt: `请把下面的主题描述整理成思维导图大纲：\n${label}`,
      endpoint,
      model,
      apiKey,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  const after = useSettings.getState().settings.quota;
  const billed = canGenerate(outline.length, after.aiPoints, after.aiUsed);
  if (!billed.ok) return { ok: false, message: billed.reason };
  const paid = await useSettings.getState().spendAiPoints(outline.length);
  if (!paid) return { ok: false, message: billed.reason }; // 没扣下点数就不落这棵树，否则白送一次生成

  // 在 mutate 的回调里对**当前页**重算插入：生成期间用户可能又改了主题，
  // 拿旧页算好的结果覆盖回去会吃掉那几步编辑。
  const committed = useDoc.getState().mutate("AI 生成", (live) => insertOutlineText(live, outline));
  if (!committed) {
    return { ok: false, message: "AI 生成失败：文档已经关闭，生成结果没有写入。" };
  }
  const now = activePage(useDoc.getState());
  const added = now ? Object.keys(now.shapes).length - Object.keys(page.shapes).length : 0;
  if (!added) return { ok: true, message: "AI 这次没有给出可识别的大纲，树没有变化。" };

  const left = Math.max(0, after.aiPoints - after.aiUsed - billed.need);
  return { ok: true, message: `AI 生成完成：新增 ${added} 个主题，消耗 ${billed.need} 点，剩余 ${left} 点。` };
}
