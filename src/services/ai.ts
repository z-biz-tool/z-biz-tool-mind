/**
 * AI 生成（doc/复刻方案/00 §3.13）。
 *
 * 两条约束决定了这里的形状：
 * 1) 只走 OpenAI 兼容的 chat/completions。复刻不绑某一家供应商，端点与模型名来自「选项 → 高级」，
 *    密钥留在本机加密库、由 Rust 侧请求时自取（前端拿不到明文），因此这里绝不打日志 —— 崩溃上报会把 console 带走。
 * 2) 生成结果入树必须复用 engine/outline.ts（P-3）。批量录入、Markdown 粘贴、OCR、AI
 *    共用同一条缩进协议；再写一套解析，就会出现"AI 插进来的节点删不掉/升不了级"这种第二份数据结构的病。
 */
import type { Page } from "../types/model.ts";
import { plainText } from "../types/model.ts";
import { insertOutline, parseOutline } from "../engine/outline.ts";
import type { InsertMode, OutlineLine } from "../engine/outline.ts";
import { removeShape } from "../engine/tree.ts";
import { activePage, useDoc } from "../stores/docStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { canGenerate } from "../utils/entitlement.ts";
import { native } from "./native.ts";
import { type AiFailure, failureOf, toAiFailureError } from "./aiFailure.ts";

/**
 * UI 直接调用的结果。
 *
 * `failure` 只在「后端/配置给出了**可判断**的失败」时出现（缺密钥、401、404…）；
 * 配额不足、文档已关闭这类只有一句话结论的情况不带它 ——
 * 给它们编一个 `focus` 会把用户送进一个跟失败无关的输入框。
 */
export type AiResult = { ok: boolean; message: string; failure?: AiFailure };

export interface AiRequest {
  prompt: string;
  endpoint: string;
  model: string;
}

/** 与「选项 → 高级」的密钥输入框约定的槽位名（Rust secret.rs 同名）。 */
const SECRET_KEY = "ai-api-key";

/**
 * 往运行日志里记一条，且**永远不打断生成**。
 *
 * 日志是排查手段，不是功能本身：写盘的 IPC 挂了（磁盘满、目录不可写）不该让用户看到"AI 生成失败"。
 * Rust 那侧按「选项 → 高级」的级别过滤，所以这里只管把事写清楚，够不够格由它判。
 */
function logEvent(level: "debug" | "info" | "warn" | "error", message: string): void {
  void native.logWrite(level, message, "ai").catch(() => undefined);
}

/**
 * 只取 origin（协议 + 主机 + 端口），路径和查询串都丢掉。
 *
 * 有些网关把凭据放在 `?api_key=…` 里，日志文件是用户会直接发给别人看的文本，
 * 一条完整的 URL 就等于把密钥抄进了日志。端点配置本身在「选项 → 高级」里看得见，不必再抄一遍。
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "（地址无法解析）";
  }
}

// 系统提示词在 Rust 侧（ai.rs）—— 前端只管把用户的主题描述送过去。

export async function generateOutline(req: AiRequest): Promise<string> {
  const endpoint = req.endpoint.trim();
  if (!endpoint) {
    throw new Error(
      "尚未配置 AI 接口地址，请在「选项 → 高级」里填写 OpenAI 兼容的服务地址（如 https://api.openai.com/v1）。"
    );
  }
  const model = req.model.trim();
  if (!model) {
    throw new Error("尚未配置 AI 模型名称，请在「选项 → 高级」里填写，例如 gpt-4o-mini。");
  }

  // 超时读「选项 → 网络」：走代理的用户 20 秒不够，写死就是替用户做错了决定。
  // 超时与重试语义由后端（cap-llm）执行 —— 它持有连接，也只有它能掐断它。
  const timeoutSec = Math.max(1, useSettings.getState().settings.network.timeoutSec || 20);
  logEvent(
    "debug",
    `AI 请求 → ${originOf(endpoint)}（模型 ${model}，超时 ${timeoutSec}s，描述 ${req.prompt.length} 字）`
  );

  // 2026-10-26 起请求走 Rust 命令（cap-llm）：明文 key 由后端从本机加密库解出，
  // **不再回传 webview** —— 此前前端自己拼 Authorization 头 fetch，key 一直摊在 JS 内存里。
  try {
    const content = await native.aiGenerateOutline({
      prompt: req.prompt,
      endpoint,
      model,
      timeoutSec,
    });
    if (!content.trim()) {
      logEvent("warn", `AI 返回空内容（${originOf(endpoint)}，模型 ${model}）`);
      throw new Error("AI 服务没有返回任何内容，请换一种更具体的描述后重试。");
    }
    logEvent("info", `AI 返回 ${content.length} 字（${originOf(endpoint)}，模型 ${model}）`);
    return content;
  } catch (e) {
    // 后端的失败是结构化的（kind/status/hint/focus），一路带上去给对话框分流。
    // 这里若把它压成一句 message，界面就只剩「AI 生成失败」——
    // 用户知道失败了，但不知道是密钥、地址、模型还是网络。
    const failure = failureOf(e);
    const message = e instanceof Error ? e.message : String(e);
    // 后端的错误已经脱敏（不会带 key），这里只补日志；文案原样透传给用户。
    logEvent("error", `AI 生成失败：${message}（${originOf(endpoint)}）`);
    throw failure ? toAiFailureError(e) : e instanceof Error ? e : new Error(message);
  }
}

/** AI 生成的内容打上 extras.ai（会话级打标；.emmx 无对应键，存盘重开即丢 —— 有意为之）。 */
function tagAi(page: Page, ids: readonly string[]): Page {
  let next: Page | null = null;
  for (const id of ids) {
    const s = (next ?? page).shapes[id];
    if (!s) continue;
    if (!next) next = { ...page, shapes: { ...page.shapes } };
    next.shapes[id] = { ...s, extras: { ...s.extras, ai: true } };
  }
  return next ?? page;
}

/**
 * 同步版本：mutate() 的回调必须是同步的（撤销栈在它返回时才快照），
 * 所以异步外壳里其实一次 await 都没有 —— 保留 async 签名是给未来真要 await 的余量。
 */
function insertAiLines(page: Page, targetId: string, lines: OutlineLine[], mode: InsertMode): Page {
  if (!lines.length) return page;
  // 层级重定基后整段挂到目标之下：目标自己的文字是用户写的，AI 只负责往下长。
  const flat = lines.map((l) => INDENT.repeat(l.level) + l.text).join("\n");
  const r = insertOutline(page, targetId, flat, mode, false);
  return tagAi(r.page, r.ids);
}

function insertAiOutline(page: Page, targetId: string, markdown: string, mode: InsertMode): Page {
  return insertAiLines(page, targetId, parseOutline(flattenIndent(stripFence(markdown)), true), mode);
}

function insertOutlineText(page: Page, markdown: string): Page {
  return insertAiOutline(page, page.rootId, markdown, "appendChildren");
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

/** 配置三件套的检查（端点/模型在设置里，密钥只探存在不取明文），runAiInsert 与 runAiOnTopic 共用。 */
type AiConnection =
  | { ok: true; endpoint: string; model: string }
  | { ok: false; message: string; failure?: AiFailure };

/**
 * 配置三件事的本地预检。
 *
 * 每一项失败都带 `focus`：地址、模型、密钥分处「选项 → 高级」的三个输入框。
 * 只说「去填一下」等于让用户把三个框都试一遍，所以连光标该落哪儿一起给出去。
 */
async function aiConnection(): Promise<AiConnection> {
  const settings = useSettings.getState().settings;
  const endpoint = settings.advanced.aiEndpoint.trim();
  const model = settings.advanced.aiModel.trim();
  if (!endpoint) {
    return {
      ok: false,
      message: "尚未配置 AI 接口地址，请在「选项 → 高级」里填写 OpenAI 兼容的服务地址后再生成。",
      failure: {
        kind: "notConfigured",
        status: null,
        message: "尚未配置 AI 接口地址。",
        hint: "填 OpenAI 兼容的服务地址，例如 https://api.openai.com/v1、https://api.deepseek.com/v1。",
        focus: "baseUrl",
      },
    };
  }
  if (!model) {
    return {
      ok: false,
      message: "尚未配置 AI 模型名称，请在「选项 → 高级」里填写，例如 gpt-4o-mini。",
      failure: {
        kind: "notConfigured",
        status: null,
        message: "尚未配置 AI 模型名称。",
        hint: "填一个能对话的模型，例如 gpt-4o-mini、deepseek-chat、qwen-plus。",
        focus: "model",
      },
    };
  }

  // 只探存在、不 reveal：明文 key 自 2026-10-26 起不出 Rust（请求在后端发，
  // key 由后端从加密库解）。这里探不到就引导去「选项 → 高级」填。
  let hasKey = false;
  try {
    hasKey = await native.secretExists(SECRET_KEY);
  } catch {
    hasKey = false; // 浏览器模式没有本机加密库：和"没配过"同样处理
  }
  if (!hasKey) {
    return {
      ok: false,
      message: "尚未配置 AI API Key，请在「选项 → 高级」里填写密钥。",
      failure: {
        kind: "notConfigured",
        status: null,
        message: "尚未配置 AI API Key。",
        hint: "在「选项 → 高级」粘贴服务商给的密钥。它只存本机加密库，不会写入配置文件。",
        focus: "apiKey",
      },
    };
  }
  return { ok: true, endpoint, model };
}

/** 生成完按实际上报字数结算；没扣下点数就不落树，否则白送一次生成。 */
async function billOutline(
  outline: string
): Promise<{ ok: true; need: number } | { ok: false; message: string }> {
  const after = useSettings.getState().settings.quota;
  const billed = canGenerate(outline.length, after.aiPoints, after.aiUsed);
  if (!billed.ok) return { ok: false, message: billed.reason };
  const paid = await useSettings.getState().spendAiPoints(outline.length);
  if (!paid) return { ok: false, message: billed.reason };
  return { ok: true, need: billed.need };
}

/** 生成期间的画布锁：只有生成这一段收着，提交（mutate）在解锁之后，不会被自己的锁挡住。 */
async function generateLocked(prompt: string, conn: Extract<AiConnection, { ok: true }>): Promise<string> {
  useUi.getState().setAiBusy(true);
  try {
    return await generateOutline({ prompt, endpoint: conn.endpoint, model: conn.model });
  } finally {
    useUi.getState().setAiBusy(false);
  }
}

/**
 * UI 直接调的那一条完整流程：配置检查 → 配额预检 → 生成 → 结算 → 提交。
 * 返回的句子原样 show 出来，所以每个失败分支都得说清楚"缺什么、去哪儿填"。
 */
export async function runAiInsert(label: string): Promise<AiResult> {
  const conn = await aiConnection();
  if (!conn.ok) return conn;

  const page = activePage(useDoc.getState());
  if (!page) {
    return { ok: false, message: "还没有打开文档，请先新建或打开一个脑图，再让 AI 生成。" };
  }

  const q = useSettings.getState().settings.quota;
  // 先按输入字数拦一次，别为注定要失败的请求花网络钱；结算按生成出来的实际字数（"按上报字数计费"）。
  const precheck = canGenerate(label.length, q.aiPoints, q.aiUsed);
  if (!precheck.ok) {
    // 配额拦下来时一分钱网络请求都没花，日志里要留得下"为什么点按钮没反应"这一句。
    logEvent(
      "warn",
      `AI 配额不足：需要 ${precheck.need} 点，可用 ${Math.max(0, q.aiPoints - q.aiUsed)} 点`
    );
    return { ok: false, message: precheck.reason };
  }

  let outline: string;
  try {
    outline = await generateLocked(
      `请把下面的主题描述整理成思维导图大纲：\n${label}`,
      conn
    );
  } catch (e) {
    // 生成失败一律带上结构化失败（缺密钥 / 401 / 404 / 网络…），
    // 界面的动作按钮全靠它决定把用户送去哪一栏。
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      failure: failureOf(e) ?? undefined,
    };
  }

  const billed = await billOutline(outline);
  if (!billed.ok) return { ok: false, message: billed.message };

  // 在 mutate 的回调里对**当前页**重算插入：生成期间用户可能又改了主题，
  // 拿旧页算好的结果覆盖回去会吃掉那几步编辑。
  const committed = useDoc.getState().mutate("AI 生成", (live) => insertOutlineText(live, outline));
  if (!committed) {
    // 生成了、也扣了点数，但树没落下去 —— 这一条必须留在日志里，否则事后完全无从解释。
    logEvent("error", `AI 结果未能写入：文档已关闭（生成 ${outline.length} 字）`);
    return { ok: false, message: "AI 生成失败：文档已经关闭，生成结果没有写入。" };
  }
  const now = activePage(useDoc.getState());
  const added = now ? Object.keys(now.shapes).length - Object.keys(page.shapes).length : 0;
  if (!added) {
    logEvent("warn", `AI 返回的 ${outline.length} 字没有被识别为大纲，树未变化`);
    return { ok: true, message: "AI 这次没有给出可识别的大纲，树没有变化。" };
  }

  const after = useSettings.getState().settings.quota;
  const left = Math.max(0, after.aiPoints - after.aiUsed);
  logEvent("info", `AI 生成落树：新增 ${added} 个主题，扣 ${billed.need} 点，余 ${left} 点`);
  return {
    ok: true,
    message: `AI 生成完成：新增 ${added} 个主题，消耗 ${billed.need} 点，剩余 ${left} 点。`,
  };
}

// ======================================================================
// 选中主题上的「生成结构」三件（02 §3 A 层）：生成子主题 / 丰富·精简 / 再生成。
// 与一句话生成共用同一条管道（generateOutline → outline 入树协议 → 点数结算），
// 差别只有两处：锚点是选中主题而不是中心主题；精简/再生成要先把原有子枝摘掉。
// ======================================================================

export type AiVerb = "subtopics" | "expand" | "condense" | "regen";

export const AI_VERB_LABEL: Record<AiVerb, string> = {
  subtopics: "生成子主题",
  expand: "丰富内容",
  condense: "精简内容",
  regen: "重新生成",
};

/** 纯函数：四个动词各自的提示词。childTitles 传入时已有子主题的标题（丰富/精简要看着它说话）。 */
export function buildTopicPrompt(verb: AiVerb, text: string, childTitles: string[]): string {
  const t = text || "（无标题）";
  switch (verb) {
    case "subtopics":
      return `请为思维导图主题「${t}」生成 5~8 个一级子主题。只输出子主题：每行一个，可用缩进表示更深的层级，不要编号、不要解释。`;
    case "expand":
      return (
        `思维导图主题「${t}」已经有这些子主题：${childTitles.length ? childTitles.join("、") : "（还没有）"}。\n` +
        `请从新的角度补充生成 4~6 个子主题，不要重复已有内容。只输出新子主题：每行一个，可用缩进表示更深的层级，不要编号、不要解释。`
      );
    case "condense":
      return (
        `下面是思维导图主题「${t}」的全部子内容：\n${childTitles.length ? childTitles.join("\n") : t}\n` +
        `请把它们提炼成 3~5 个关键点，作为这个主题的新子主题，覆盖原有子内容的核心信息。只输出关键点：每行一个，可用缩进表示更深的层级，不要编号、不要解释。`
      );
    case "regen":
      return `请围绕思维导图主题「${t}」重新生成 5~8 个一级子主题（不必参考原有内容）。只输出子主题：每行一个，可用缩进表示更深的层级，不要编号、不要解释。`;
  }
}

/** 纯函数：把大纲落到选中主题上。精简/再生成先摘原有子枝（同一棵 page 里完成，撤销只算一步）。 */
export function applyTopicAction(page: Page, id: string, verb: AiVerb, outline: string): Page {
  // 先确认解析出得了货、再摘旧枝：AI 返回空纲时不能把用户的原子主题洗掉。
  const lines = parseOutline(flattenIndent(stripFence(outline)), true);
  if (!lines.length) return page;
  let next = page;
  if (verb === "condense" || verb === "regen") {
    for (const c of page.shapes[id]?.childIds ?? []) next = removeShape(next, c);
  }
  return insertAiLines(next, id, lines, "appendChildren");
}

/** 选中主题上的完整流程，与 runAiInsert 同一条纪律：配置 → 预检 → 锁 → 生成 → 结算 → 提交。 */
export async function runAiOnTopic(id: string, verb: AiVerb): Promise<AiResult> {
  const conn = await aiConnection();
  if (!conn.ok) return conn;

  const page = activePage(useDoc.getState());
  const shape = page?.shapes[id];
  if (!page || !shape) {
    return { ok: false, message: "选中的主题已经不在画布上了，请重新选择后再用 AI。" };
  }
  const text = plainText(shape.text);
  const childTitles = shape.childIds
    .map((c) => (page.shapes[c] ? plainText(page.shapes[c].text) : ""))
    .filter(Boolean);
  const prompt = buildTopicPrompt(verb, text, childTitles);

  const q = useSettings.getState().settings.quota;
  const precheck = canGenerate(prompt.length, q.aiPoints, q.aiUsed);
  if (!precheck.ok) {
    logEvent(
      "warn",
      `AI 配额不足（${AI_VERB_LABEL[verb]}）：需要 ${precheck.need} 点，可用 ${Math.max(0, q.aiPoints - q.aiUsed)} 点`
    );
    return { ok: false, message: precheck.reason };
  }

  let outline: string;
  try {
    outline = await generateLocked(prompt, conn);
  } catch (e) {
    // 生成失败一律带上结构化失败（缺密钥 / 401 / 404 / 网络…），
    // 界面的动作按钮全靠它决定把用户送去哪一栏。
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      failure: failureOf(e) ?? undefined,
    };
  }

  const billed = await billOutline(outline);
  if (!billed.ok) return { ok: false, message: billed.message };

  const before = Object.keys(page.shapes).length;
  const committed = useDoc
    .getState()
    .mutate(`AI ${AI_VERB_LABEL[verb]}`, (live) => applyTopicAction(live, id, verb, outline));
  if (!committed) {
    logEvent("error", `AI 结果未能写入：文档已关闭（${AI_VERB_LABEL[verb]}，生成 ${outline.length} 字）`);
    return { ok: false, message: "AI 生成失败：文档已经关闭，生成结果没有写入。" };
  }
  const now = activePage(useDoc.getState());
  const delta = now ? Object.keys(now.shapes).length - before : 0;
  if (!delta) {
    logEvent("warn", `AI 返回的 ${outline.length} 字没有被识别为大纲，树未变化`);
    return { ok: true, message: "AI 这次没有给出可识别的大纲，树没有变化。" };
  }

  const after = useSettings.getState().settings.quota;
  const left = Math.max(0, after.aiPoints - after.aiUsed);
  // 精简/再生成是替换语义，净变化可以是负的 —— 措辞按实际情况说，不硬称"新增"。
  const deltaText = delta > 0 ? `新增 ${delta} 个主题` : `精简掉 ${-delta} 个主题`;
  logEvent(
    "info",
    `AI ${AI_VERB_LABEL[verb]}落树：锚点 ${id}，${deltaText}，扣 ${billed.need} 点，余 ${left} 点`
  );
  return {
    ok: true,
    message: `AI ${AI_VERB_LABEL[verb]}完成：${deltaText}，消耗 ${billed.need} 点，剩余 ${left} 点。`,
  };
}
