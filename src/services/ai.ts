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
import {
  parseDiagram,
  placeDiagram,
  attachImageToShape,
  imageMediaName,
  replaceImageBytes,
} from "../engine/diagram.ts";
import type { NormalizedDiagram } from "../engine/diagram.ts";
import { removeShape, insertChild, setFloating } from "../engine/tree.ts";
import { activePage, activeDoc, useDoc } from "../stores/docStore.ts";
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

/**
 * 通用文本生成底座：结构化图与大纲走同一条传输通道（Rust cap-llm），
 * 系统提示词由后端命令自己决定 —— 前端只区分调哪个命令。
 *
 * 单独露出来是因为 generateOutline 的大纲语义（空内容提示写"换一种描述"）
 * 对图同样成立，而传输/脱敏/结构化失败的那一套两个入口共用。
 */
async function generateText(
  req: AiRequest & { kind: "outline" | "diagram" }
): Promise<string> {
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
    const callArgs = {
      prompt: req.prompt,
      endpoint,
      model,
      timeoutSec,
    };
    const content =
      req.kind === "diagram"
        ? await native.aiGenerateDiagram(callArgs)
        : await native.aiGenerateOutline(callArgs);
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

export async function generateOutline(req: AiRequest): Promise<string> {
  return generateText({ ...req, kind: "outline" });
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
async function generateLocked(
  prompt: string,
  conn: Extract<AiConnection, { ok: true }>,
  kind: "outline" | "diagram" = "outline"
): Promise<string> {
  useUi.getState().setAiBusy(true);
  try {
    return await generateText({ prompt, endpoint: conn.endpoint, model: conn.model, kind });
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

/** 选中主题上的完整流程，与 runAiInsert 同一条纪律：配置 → 预检 → 锁 → 生成 → 结算 → 提交。 */export async function runAiOnTopic(id: string, verb: AiVerb): Promise<AiResult> {
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

// ======================================================================
// AI 生成结构化图（§3.13 A 层延伸）：一句话 → 节点/连线 JSON → 可编辑的图。
//
// 与大纲生成共用同一条管道（配置 → 预检 → 锁 → 生成 → 结算 → mutate 提交），
// 差别有三：提示词要求 JSON；解析走 engine/diagram.ts 的第二份协议（它必须
// 存在的理由见那个文件的头注释）；落图是"replace 整页"而不是"append 子枝"。
// ======================================================================

/** 纯函数：结构化图的提示词。单独导出便于测试钉住协议要点。 */
export function buildDiagramPrompt(description: string): string {
  return (
    `请根据下面的描述，生成一张结构图的 JSON 数据。结构图用于思维导图软件展示，` +
    `节点之间用 parent（父子隶属）表达层级，用 edges（连线）表达流程或引用关系。\n\n` +
    `输出格式（严格 JSON，不要代码围栏、不要解释）：\n` +
    `{"nodes":[{"id":"n1","text":"节点文字","parent":null},` +
    `{"id":"n2","text":"子节点文字","parent":"n1"}],` +
    `"edges":[{"from":"n1","to":"n2","text":"连线说明"}]}\n\n` +
    `规则：\n` +
    `- 恰好一个节点 parent 为 null（根）；其余节点的 parent 指向已存在的 id。\n` +
    `- 层级用 parent 表达隶属；不属于隶属关系的连接（流程、引用、依赖）放进 edges。\n` +
    `- id 用 n1/n2/n3 这样的短代号；节点文字不超过 20 字。\n` +
    `- 不要把没有连线语义的图硬造 edges；纯层级图 edges 给空数组。\n\n` +
    `描述：\n${description}`
  );
}

/** 纯函数：把模型回包落成整页（replace）。解析失败返回 null，由调用方给用户一句人话。 */
export function applyDiagramToPage(page: Page, raw: string): NormalizedDiagram | null {
  const parsed = parseDiagram(raw);
  if (!parsed.ok) return null;
  placeDiagram(page, parsed.diagram, "replace");
  return parsed.diagram;
}

/**
 * 「AI 生成图」的完整流程（工具栏入口）。
 *
 * 与 runAiInsert 同一条纪律的每一步都不能省：
 * - 配置三件套预检：不花网络钱就能发现的失败，先拦。
 * - 配额预检按输入字数：注定失败的请求不发出。
 * - 画布锁只在生成这一段收着：提交在解锁之后，不会被自己的锁挡住。
 * - 结算按生成出来的实际字数：模型回了多少字就扣多少。
 */
export async function runAiDiagram(description: string): Promise<AiResult> {
  const label = description.trim();
  if (!label) {
    return { ok: false, message: "请先描述要生成的图，例如「一个登录流程：输入账号 → 校验 → 进首页」。" };
  }

  const conn = await aiConnection();
  if (!conn.ok) return conn;

  const page = activePage(useDoc.getState());
  if (!page) {
    return { ok: false, message: "还没有打开文档，请先新建或打开一个脑图，再让 AI 生成。" };
  }

  const q = useSettings.getState().settings.quota;
  const prompt = buildDiagramPrompt(label);
  const precheck = canGenerate(prompt.length, q.aiPoints, q.aiUsed);
  if (!precheck.ok) {
    logEvent(
      "warn",
      `AI 配额不足（生成图）：需要 ${precheck.need} 点，可用 ${Math.max(0, q.aiPoints - q.aiUsed)} 点`
    );
    return { ok: false, message: precheck.reason };
  }

  let raw: string;
  try {
    raw = await generateLocked(prompt, conn, "diagram");
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      failure: failureOf(e) ?? undefined,
    };
  }

  const billed = await billOutline(raw);
  if (!billed.ok) return { ok: false, message: billed.message };

  // 解析在提交之前：脏回包在这里整份拒绝，点数已扣但树不会落半棵 ——
  // 日志里要留得下「扣了点为什么没有图」这一句。
  const parsed = parseDiagram(raw);
  if (!parsed.ok) {
    logEvent("error", `AI 生成图解析失败：${parsed.message}（回包 ${raw.length} 字）`);
    return { ok: false, message: parsed.message };
  }

  // 在 mutate 的回调里对**当前页**重算落图：生成期间用户可能又改了主题。
  const nodeCount = parsed.diagram.nodes.length;
  const edgeCount = parsed.diagram.edges.length;
  const committed = useDoc.getState().mutate("AI 生成图", (live) => {
    const r = placeDiagram(live, parsed.diagram, "replace");
    return r.page;
  });
  if (!committed) {
    logEvent("error", `AI 生成图未能写入：文档已关闭（${nodeCount} 节点）`);
    return { ok: false, message: "AI 生成失败：文档已经关闭，生成结果没有写入。" };
  }

  const after = useSettings.getState().settings.quota;
  const left = Math.max(0, after.aiPoints - after.aiUsed);
  logEvent(
    "info",
    `AI 生成图落树：${nodeCount} 节点 / ${edgeCount} 连线，扣 ${billed.need} 点，余 ${left} 点`
  );
  const edgeText = edgeCount ? `、${edgeCount} 条连线` : "";
  return {
    ok: true,
    message: `AI 生成图完成：${nodeCount} 个节点${edgeText}，消耗 ${billed.need} 点，剩余 ${left} 点。可在画布上继续编辑。`,
  };
}

// ======================================================================
// 像素级生图（第二步）：一句话 → 生图网关 → PNG 落到一个主题上。
//
// 与结构化图的分工：结构图管逻辑（可编辑的节点树），像素图管观感
// （插画/示意图/封面）。两者并存互补，入口也在同一个对话框里。
//
// 兜底纪律（CEO 裁定）：网关是自建服务，不保证在线 ——
// 未配置/不可达/超时都必须给一句能照着改的话，UI 不灰不崩不静默。
// ======================================================================

const IMAGE_SECRET_KEY = "image-api-key";

/** 生图配置预检：endpoint/model 必须已填，key 可选（自建网关常免鉴权）。 */
async function imageConnection(): Promise<
  { ok: true; endpoint: string; model: string; apiKey: string } | { ok: false; message: string; failure?: AiFailure }
> {
  const settings = useSettings.getState().settings;
  const endpoint = settings.advanced.imageEndpoint.trim();
  const model = settings.advanced.imageModel.trim();
  if (!endpoint) {
    return {
      ok: false,
      message: "尚未配置图像服务地址，请在「选项 → 高级」里填写生图网关（如 http://192.168.31.249:8200/v1）。",
      failure: {
        kind: "notConfigured",
        status: null,
        message: "尚未配置图像服务地址。",
        hint: "填 OpenAI 兼容的生图网关根地址（以 /v1 结尾）。自建网关不保证在线，连不上时先确认服务已启动。",
        focus: "baseUrl",
      },
    };
  }
  if (!model) {
    return {
      ok: false,
      message: "尚未配置图像模型名，请在「选项 → 高级」里填写（如 zBiz-Image-FLUX）。",
      failure: {
        kind: "notConfigured",
        status: null,
        message: "尚未配置图像模型名。",
        hint: "填网关 /v1/models 列表里的图像模型 id。",
        focus: "model",
      },
    };
  }
  let apiKey = "";
  try {
    // 密钥可选：自建网关常免鉴权，探不到不拦
    const has = await native.secretExists(IMAGE_SECRET_KEY);
    apiKey = has ? "present" : "";
  } catch {
    apiKey = "";
  }
  return { ok: true, endpoint, model, apiKey };
}

/** 尺寸档位：FLUX 支持任意，但对思维导图场景三档够了。 */
export const IMAGE_SIZES = ["1024x1024", "1024x576", "576x1024"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * 「AI 绘图」完整流程：预检 → 生成（长等待，不锁画布——用户可以继续编辑别的）→
 * 落成一个新主题（media 字节 + extras.image 引用）。
 *
 * 为什么不锁画布：FLUX 55~140s/张，锁 2 分钟画布不可编辑是不可接受的。
 * 落图用 mutate 一步提交，生成期间用户的编辑互不干扰。
 */
export async function runAiImageDraw(
  prompt: string,
  size: ImageSize = "1024x1024"
): Promise<AiResult & { shapeId?: string }> {
  const desc = prompt.trim();
  if (!desc) {
    return { ok: false, message: "请先描述要生成的图像内容。" };
  }

  const conn = await imageConnection();
  if (!conn.ok) return conn;

  const page = activePage(useDoc.getState());
  if (!page) {
    return { ok: false, message: "还没有打开文档，请先新建或打开一个脑图。" };
  }

  logEvent(
    "info",
    `AI 生图请求 → ${conn.endpoint}（模型 ${conn.model}，尺寸 ${size}，描述 ${desc.length} 字）`
  );

  let r: { b64?: string; url?: string; seed?: number; elapsedS?: number };
  try {
    r = await native.aiGenerateImage({
      endpoint: conn.endpoint,
      model: conn.model,
      prompt: desc,
      size,
      timeoutSec: Math.max(300, useSettings.getState().settings.network.timeoutSec || 300),
    });
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      failure: failureOf(e) ?? undefined,
    };
  }

  if (!r.b64 && !r.url) {
    return { ok: false, message: "图像服务没有返回图片数据。" };
  }

  // 落图：建一个浮动主题，PNG 字节进 doc.media，引用进 extras.image。
  // mutate 回调必须同步 —— b64 解码在回调外先做好。
  let bytes: Uint8Array | null = null;
  if (r.b64) {
    const bin = atob(r.b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }

  // 先在回调外拿 nextShapeId（回调里不能 await，但 nextShapeId 是纯函数，
  // 在回调内对活页现算 —— 生成期间用户可能加了主题，旧号会撞）。
  const committed = useDoc.getState().mutateDoc("AI 绘图", (doc) => {
    const livePage = doc.pages.find((p) => p.id === (activePage(useDoc.getState())?.id ?? "")) ?? doc.pages[0];
    // 插一个主题到根下再转浮动：浮动主题位置归用户（P-2 例外），画布上独立成点。
    const r2 = insertChild(livePage, livePage.rootId, desc.slice(0, 40) || "AI 图像");
    const sid = r2.id;
    let p2 = setFloating(r2.page, sid, 0, 0, true);
    if (bytes) {
      p2 = attachImageToShape(p2, sid, 320, 320);
    }
    const mediaName = imageMediaName(sid);
    const media = { ...doc.media };
    if (bytes) media[mediaName] = bytes;
    return {
      ...doc,
      media,
      pages: doc.pages.map((p) => (p.id === livePage.id ? p2 : p)),
    };
  });

  if (!committed) {
    logEvent("error", "AI 生图结果未能写入：文档已关闭");
    return { ok: false, message: "AI 生图失败：文档已经关闭，生成结果没有写入。" };
  }

  logEvent("info", `AI 生图落图成功（seed=${r.seed ?? "?"}，耗时 ${r.elapsedS ?? "?"}s）`);
  return {
    ok: true,
    message: `AI 绘图完成（耗时 ${r.elapsedS ?? "?"} 秒）。图像已作为一个新主题落到画布上，可拖动、可随文档保存。`,
  };
}

// ======================================================================
// AI 看图（第三步，多模态理解）：画布上的图 → 视觉模型 → 结构化结果。
//
// 与结构化图/大纲共用同一条纪律（配置 → 预检 → 锁 → 生成 → 结算 → 提交），
// 差别有三：输入是图片字节而不是一句话；模型是视觉模型（可与文本模型不同名）；
// 产出固定是「大纲行」，落成选中主题的子枝 —— 图片转导图是 mind 的差异化。
// ======================================================================

/** 看图的三个动词。文案与提示词一一对应，测试钉住。 */
export type VisionVerb = "toOutline" | "extractText" | "describe";

export const VISION_VERB_LABEL: Record<VisionVerb, string> = {
  toOutline: "转成导图",
  extractText: "提取文字",
  describe: "描述内容",
};

/** 纯函数：三个动词各自的指令（发给视觉模型）。单独导出便于测试钉住协议要点。 */
export function buildVisionPrompt(verb: VisionVerb, topic: string, extra: string): string {
  const anchor = topic ? `（这张图挂在主题「${topic}」下）` : "";
  const hint = extra.trim();
  switch (verb) {
    case "toOutline":
      return (
        `请把这张图片的内容整理成思维导图大纲${anchor}。` +
        `只输出大纲本身：每行一个要点，用缩进（空格或制表符）表示层级，不要编号、不要解释、不要代码围栏。` +
        (hint ? `\n附加要求：${hint}` : "")
      );
    case "extractText":
      return (
        `请提取这张图片里的全部文字${anchor}。` +
        `只输出提取到的文字：按阅读顺序每行一段，保留原有层级缩进（如有）；图中没有文字就回答「图中没有文字」。` +
        (hint ? `\n附加要求：${hint}` : "")
      );
    case "describe":
      return (
        `请描述这张图片的内容${anchor}。` +
        `只输出描述本身：每行一个要点，可用缩进表示从属关系，不要开场白、不要代码围栏。` +
        (hint ? `\n附加要求：${hint}` : "")
      );
  }
}

/** 纯函数：Uint8Array → base64（分块避免 String.fromCharCode 栈溢出）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 「AI 看图」完整流程：取图 → 预检 → 锁 → 生成 → 结算 → 落成子枝。
 *
 * - 图片从 doc.media 取（ai 绘图/既有图片都存在那里）；取不到字节时报一句人话。
 * - 模型用视觉模型名（settings.advanced.visionModel），空则回落文本模型 ——
 *   单模型端点（多数云服务商）不用再填一遍。
 * - 结果一律走 outline 协议入树（insertAiLines）：AI 看图的产出跟手打大纲是同一种东西。
 */
export async function runAiVision(
  shapeId: string,
  verb: VisionVerb,
  extra: string
): Promise<AiResult> {
  const page = activePage(useDoc.getState());
  const shape = page?.shapes[shapeId];
  if (!page || !shape) {
    return { ok: false, message: "选中的主题已经不在画布上了，请重新选择后再用 AI 看图。" };
  }

  // ---- 取图：extras.image 引用 → doc.media 字节。引用在字节不在 = 报错不静默。
  const doc = activeDoc(useDoc.getState());
  const ref = shape.extras.image;
  if (!ref) {
    return {
      ok: false,
      message: "这个主题上没有图片。先插入图片（或用「AI 绘图」生成一张），再看图。",
    };
  }
  const bytes = doc?.media[ref.relId];
  if (!bytes || !bytes.length) {
    return {
      ok: false,
      message: "图片数据缺失（引用在，字节不在）。这个文件可能在别的设备上生成、同步时丢了媒体内容。",
    };
  }

  // ---- 配置三件套：与文本同一把钥匙（端点/密钥），模型可用视觉模型名覆盖。
  const conn = await aiConnection();
  if (!conn.ok) return conn;
  const settings = useSettings.getState().settings;
  const visionModel = settings.advanced.visionModel.trim() || conn.model;
  const endpoint = conn.endpoint;

  // ---- 配额预检：图片按张折算字数（一张图 200 字 ≈ 20 点，与生图同量级的粗口径）。
  const prompt = buildVisionPrompt(verb, plainText(shape.text), extra);
  const IMAGE_BILLED_CHARS = 200;
  const q = useSettings.getState().settings.quota;
  const precheck = canGenerate(IMAGE_BILLED_CHARS, q.aiPoints, q.aiUsed);
  if (!precheck.ok) {
    logEvent(
      "warn",
      `AI 配额不足（看图）：需要 ${precheck.need} 点，可用 ${Math.max(0, q.aiPoints - q.aiUsed)} 点`
    );
    return { ok: false, message: precheck.reason };
  }

  logEvent(
    "info",
    `AI 看图请求 → ${originOf(endpoint)}（模型 ${visionModel}，动词 ${VISION_VERB_LABEL[verb]}，图 ${bytes.length} 字节）`
  );

  // ---- 锁 + 生成。视觉推理 5~30s，锁画布可接受（与文本生成同策略）。
  let content: string;
  try {
    useUi.getState().setAiBusy(true);
    content = await native.aiVision({
      endpoint,
      model: visionModel,
      prompt,
      image: `data:image/png;base64,${bytesToBase64(bytes)}`,
      timeoutSec: Math.max(30, settings.network.timeoutSec || 60) * 3,
    });
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      failure: failureOf(e) ?? undefined,
    };
  } finally {
    useUi.getState().setAiBusy(false);
  }
  if (!content.trim()) {
    logEvent("warn", `AI 看图返回空内容（${originOf(endpoint)}，模型 ${visionModel}）`);
    return { ok: false, message: "视觉模型没有返回任何内容，请换一张更清晰的图或换个说法。" };
  }

  // ---- 结算：按实际回复字数（与大纲同口径）；会员在 spendAiPoints 里放行。
  const billed = await billOutline(content);
  if (!billed.ok) return { ok: false, message: billed.message };

  // ---- 落树：解析交给 outline 协议（P-3 的纪律——再写一套解析就是第二份数据结构的病）。
  const lines = parseOutline(flattenIndent(stripFence(content)), true);
  if (!lines.length) {
    logEvent("warn", `AI 看图结果无法识别为大纲（${content.length} 字）`);
    return { ok: true, message: "AI 看图完成，但结果不是可识别的大纲格式，没有写入树。" };
  }
  const before = Object.keys(page.shapes).length;
  const committed = useDoc.getState().mutate(`AI 看图（${VISION_VERB_LABEL[verb]}）`, (live) =>
    insertAiLines(live, shapeId, lines, "appendChildren")
  );
  if (!committed) {
    logEvent("error", `AI 看图结果未能写入：文档已关闭（${content.length} 字）`);
    return { ok: false, message: "AI 看图失败：文档已经关闭，生成结果没有写入。" };
  }
  const now = activePage(useDoc.getState());
  const added = now ? Object.keys(now.shapes).length - before : 0;
  if (!added) {
    return { ok: true, message: "AI 看图完成，但没有生成新的主题。" };
  }

  const after = useSettings.getState().settings.quota;
  const left = Math.max(0, after.aiPoints - after.aiUsed);
  logEvent(
    "info",
    `AI 看图落树：锚点 ${shapeId}，新增 ${added} 主题，扣 ${billed.need} 点，余 ${left} 点`
  );
  return {
    ok: true,
    message: `AI 看图完成：新增 ${added} 个主题，消耗 ${billed.need} 点，剩余 ${left} 点。`,
  };
}

// ======================================================================
// AI 改图（第四步，图生图）：画布上已有的图 + 一句改动要求 → 新的图。
//
// 与前三步的分工：结构图管逻辑、像素图管观感、看图管「读懂」、
// 改图管「重画」—— 有了图之后能不能继续迭代，是「什么图都能造」的最后一块。
//
// ## 为什么原地替换，而不是新开一个主题
//
// 用户说「把这张改成夜景」，期望的是**这根枝上的图变了**，不是旁边多出一张。
// 原地替换还有一个好处：media 字节在文档快照里（structuredClone 认得
// Uint8Array），所以撤销能真的把原图还回来 —— 新开主题的话，撤销只撤主题，
// 那张被替换掉的原图就没了。
//
// ## 为什么 denoise 默认 0.85
//
// 实测 FLUX schnell 在 0.5~0.6 只改纹理，≥0.85 才明显改结构。
// 「改图」这个动作的期望就是**看得出的变化**，力度定低等于功能不存在。
// ======================================================================

/** 力度档位：给用户「改多少」的语义，而不是裸数字。 */
export const EDIT_DENOISE_PRESETS = [
  { key: "light", label: "轻微", denoise: 0.45, tip: "保留原图大部分，只调色调、光线、质感" },
  { key: "medium", label: "适中", denoise: 0.7, tip: "改动明显，但主体还是原来那个" },
  { key: "strong", label: "大幅", denoise: 0.9, tip: "按要求重画，构图与细节都可能变" },
] as const;

export type EditDenoiseKey = (typeof EDIT_DENOISE_PRESETS)[number]["key"];

/** 默认档位：大幅。「改图」若只改出一点纹理，用户会以为功能坏了。 */
export const DEFAULT_EDIT_DENOISE_KEY: EditDenoiseKey = "strong";

/** 纯函数：档位 → denoise 数值（网关与 Rust 侧都接受 0.05~0.95）。 */
export function denoiseOf(key: EditDenoiseKey): number {
  return EDIT_DENOISE_PRESETS.find((p) => p.key === key)?.denoise ?? 0.85;
}

/** 纯函数：改图提示词。单独导出便于测试钉住协议要点。 */
export function buildEditPrompt(requirement: string, topic: string): string {
  const t = topic ? `（这张图挂在主题「${topic}」下）` : "";
  return (
    `请按照下面的要求重画这张图片${t}。\n` +
    `要求：${requirement}\n` +
    `保持与原图一致的画幅尺寸；除要求改动的内容外，其余部分尽量保持原样。`
  );
}

/**
 * 「AI 改图」完整流程：取原图 → 预检 → 生成 → 结算 → 原地替换。
 *
 * 纪律与生图一致：
 * - 配置预检（复用 imageConnection：与生图同一处配置，不新增设置项）；
 * - 配额预检按「一张图」的粗口径（200 字折算），注定失败的请求不发出；
 * - **不锁画布**：改图同样可能两三分钟，锁着不可编辑是不可接受的；
 * - 结算按实际生成结果计。
 */
export async function runAiImageEdit(
  shapeId: string,
  requirement: string,
  denoiseKey: EditDenoiseKey = DEFAULT_EDIT_DENOISE_KEY
): Promise<AiResult> {
  const req = requirement.trim();
  if (!req) {
    return { ok: false, message: "请先说明要把这张图改成什么样，例如「改成夜晚的街道」。" };
  }

  const page = activePage(useDoc.getState());
  const shape = page?.shapes[shapeId];
  if (!page || !shape) {
    return { ok: false, message: "选中的主题已经不在画布上了，请重新选择后再用 AI 改图。" };
  }

  // ---- 取原图：extras.image 引用 → doc.media 字节。引用在字节不在 = 报错不静默。
  const doc = activeDoc(useDoc.getState());
  const ref = shape.extras.image;
  if (!ref) {
    return {
      ok: false,
      message: "这个主题上没有图片。先插入图片（或用「AI 绘图」生成一张），再改图。",
    };
  }
  const bytes = doc?.media[ref.relId];
  if (!bytes || !bytes.length) {
    return {
      ok: false,
      message: "图片数据缺失（引用在，字节不在）。这个文件可能在别的设备上生成、同步时丢了媒体内容。",
    };
  }

  const conn = await imageConnection();
  if (!conn.ok) return conn;

  // ---- 配额预检：按张折算（与看图同量级）。
  const IMAGE_BILLED_CHARS = 200;
  const q = useSettings.getState().settings.quota;
  const precheck = canGenerate(IMAGE_BILLED_CHARS, q.aiPoints, q.aiUsed);
  if (!precheck.ok) {
    logEvent(
      "warn",
      `AI 配额不足（改图）：需要 ${precheck.need} 点，可用 ${Math.max(0, q.aiPoints - q.aiUsed)} 点`
    );
    return { ok: false, message: precheck.reason };
  }

  const denoise = denoiseOf(denoiseKey);
  const prompt = buildEditPrompt(req, plainText(shape.text));
  logEvent(
    "info",
    `AI 改图请求 → ${originOf(conn.endpoint)}（模型 ${conn.model}，力度 ${denoise}，原图 ${bytes.length} 字节）`
  );

  let r: { b64?: string; url?: string; seed?: number; elapsedS?: number };
  try {
    r = await native.aiEditImage({
      endpoint: conn.endpoint,
      model: conn.model,
      prompt,
      image: `data:image/png;base64,${bytesToBase64(bytes)}`,
      denoise,
      timeoutSec: Math.max(300, useSettings.getState().settings.network.timeoutSec || 300),
    });
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      failure: failureOf(e) ?? undefined,
    };
  }

  if (!r.b64 && !r.url) {
    return { ok: false, message: "图像服务没有返回新的图片数据。" };
  }

  // b64 → 字节（回调外解好：mutateDoc 的回调必须同步）。
  let newBytes: Uint8Array | null = null;
  if (r.b64) {
    const bin = atob(r.b64);
    newBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) newBytes[i] = bin.charCodeAt(i);
  }
  if (!newBytes) {
    return { ok: false, message: "图像服务只返回了图片地址，本次改图没有拿到字节，未覆盖原图。" };
  }

  // ---- 原地替换：media 字节换新，extras.image 引用不动（尺寸沿用原图的，
  // 网关 img2img 输出尺寸 = 输入尺寸，尺寸不变才不会让画布布局跳动）。
  // 换字节的规则住在 engine/diagram.ts —— 媒体约定只有那一处说了算。
  const relId = ref.relId;
  const committed = useDoc
    .getState()
    .mutateDoc("AI 改图", (d) => replaceImageBytes(d, relId, newBytes as Uint8Array));
  if (!committed) {
    logEvent("error", "AI 改图结果未能写入：文档已关闭");
    return { ok: false, message: "AI 改图失败：文档已经关闭，生成结果没有写入。" };
  }

  const after = useSettings.getState().settings.quota;
  const left = Math.max(0, after.aiPoints - after.aiUsed);
  // 像素生成目前只做配额预检、不扣点（按张计费的口径还没定），
  // 但日志里要写清剩余点数 —— 事后问「为什么还能用」时得有据可查。
  logEvent(
    "info",
    `AI 改图落图成功（锚点 ${shapeId}，力度 ${denoise}，seed=${r.seed ?? "?"}，耗时 ${r.elapsedS ?? "?"}s，余 ${left} 点）`
  );
  return {
    ok: true,
    message: `AI 改图完成（耗时 ${r.elapsedS ?? "?"} 秒）。原图已被替换，可用 Ctrl+Z 撤销。`,
  };
}
