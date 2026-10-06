/**
 * 大纲文本 ⇄ 主题树 的同构原语（doc/复刻方案/00 §0.3 P-3、§3.6）。
 *
 * 为什么单独一个模块：批量加主题、粘贴多行文本、Markdown 导入、OCR 结果入树、
 * AI 生成子树，本质上是同一件事 —— "一段带缩进的文本，插到某个位置"。
 * 实现成 5 个纯函数后，这 5 个入口共用一条代码路径，缩进规则只需要对一个地方负责。
 *
 * 缩进解析用"列宽 + 栈"而不是"除以缩进单位"：
 * 后者要求整份文本用同一种单位，遇到制表符和空格混用就会算错层；
 * 前者只依赖"比上一层更缩进 / 和某一层齐平"这两种相对关系，天然抗混用。
 */

import type { Page, Shape } from "../types/model.ts";
import { plainText } from "../types/model.ts";
import { descendants, demote, getShape, insertChild, insertSibling, moveShape, promote, updateText, visibleChildren } from "./tree.ts";

export interface OutlineLine {
  level: number;
  text: string;
}

const TAB_COLUMNS = 4;

/**
 * 一段文本里最"像缩进"的前导空白 → 列宽 + 消耗的字符数。
 * 两个值必须分开给：制表符是 1 个字符但 4 列，只回列宽就会让调用方 slice 掉正文
 * —— 亿图的复制粘贴和我们的 dumpOutline 全都用制表符缩进，那就是 P-3 整条链路失效。
 */
function indentColumns(raw: string): { cols: number; chars: number } {
  let cols = 0;
  let chars = 0;
  for (const ch of raw) {
    if (ch === " ") cols += 1;
    else if (ch === "\t") cols += TAB_COLUMNS;
    else break;
    chars += 1;
  }
  return { cols, chars };
}

const MD_BULLET = /^(#{1,6}|[-*+]|>\s?|\[[ xX]\]|\d+[.)])\s+/;

/** 剥掉 Markdown 的行首标记；返回剥掉的标记数，用于补偿缩进（`#` 的层级即 1 级）。 */
function stripMarkdown(body: string): { text: string; headingLevel: number } {
  let text = body;
  let headingLevel = 0;
  const m = text.match(/^(#{1,6})\s+/);
  if (m) {
    headingLevel = m[1].length - 1;
    text = text.slice(m[0].length);
    return { text, headingLevel };
  }
  // 列表符号 / 引用 / 任务勾选 / 有序列表：只吃掉标记本身，缩进仍由列宽决定
  const b = text.match(MD_BULLET);
  if (b) text = text.slice(b[0].length);
  if (/\[[ xX]\]\s*/.test(text)) text = text.replace(/\[[ xX]\]\s*/, "");
  return { text, headingLevel };
}

export function parseOutline(input: string, markdown = false): OutlineLine[] {
  const out: OutlineLine[] = [];
  // 栈里存"已出现的列宽"，栈深即层级 —— 这是跳过空行后仍能保持相对层级的关键。
  const stack: number[] = [];
  for (const raw of input.split(/\r\n|\r|\n/)) {
    if (raw.trim() === "") continue;
    const { cols, chars } = indentColumns(raw);
    const body = raw.slice(chars).trimEnd();
    if (body === "") continue;
    const { text, headingLevel } = markdown ? stripMarkdown(body) : { text: body, headingLevel: 0 };
    // 行中间的制表符是内容里的杂散空白，不是缩进：留着它，画布 fillText、SVG 与 PDF 三条绘制路径
    // 会各自解释（对齐 P-2 只有一条绘制路径），主题文字里也不该出现控制字符。
    // 只吞 ASCII 空白，全角空格是正文（见"全角空格按普通字符"那条用例）。
    const label = text.replace(/[ \t\v\f]*[\t\v\f][ \t\v\f]*/g, " ");
    if (label === "") continue;

    while (stack.length > 1 && stack[stack.length - 1] > cols) stack.pop();
    let level: number;
    if (stack.length === 0) {
      stack.push(cols);
      level = 0;
    } else if (cols > stack[stack.length - 1]) {
      stack.push(cols);
      level = stack.length - 1;
    } else {
      level = stack.indexOf(stack.find((c) => c === cols) ?? cols);
      if (level < 0) level = stack.length - 1;
    }
    out.push({ level: level + headingLevel, text: label });
  }
  return normalizeLevels(out);
}

/** 首行必须是 level 0，中间不能跳层（1 → 3 会被压成 1 → 2），否则插入时无父可寻。 */
export function normalizeLevels(lines: OutlineLine[]): OutlineLine[] {
  const out: OutlineLine[] = [];
  let prev = -1;
  for (const l of lines) {
    let level = Math.max(0, l.level);
    if (out.length === 0) level = 0;
    else if (level > prev + 1) level = prev + 1;
    out.push({ level, text: l.text });
    prev = level;
  }
  return out;
}

export interface OutlineEntry {
  id: string;
  level: number;
  shape: Shape;
}

/**
 * 大纲行的唯一走法（P-1：一棵树六个投影，"大纲"只能有一套行序）。
 *
 * 三条规则都在这里：
 * - 折叠的分支不出行 —— 与画布、大纲面板所见一致。想拿到全部内容由展开后再复制，
 *   反过来（文本永远全量、面板却少几行）会让"复制粘贴"和"看到的图"变成两件事。
 * - 浮动主题另起一段、从 0 级开始：它们不在中心主题的子树里，硬挂进树形会凭空多一层。
 * - 段间换行由 plainText 保留，多段主题在文本里仍是多段。
 */
export function outlineEntries(page: Page): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const walk = (id: string, level: number) => {
    const s = page.shapes[id];
    if (!s) return;
    out.push({ id, level, shape: s });
    for (const c of visibleChildren(page, id)) walk(c.id, level + 1);
  };
  if (!getShape(page, page.rootId)) return out;
  walk(page.rootId, 0);
  for (const s of Object.values(page.shapes)) {
    if (s.floating && !s.parentId) walk(s.id, 0);
  }
  return out;
}

export function dumpOutline(page: Page): OutlineLine[] {
  return outlineEntries(page).map((e) => ({ level: e.level, text: plainText(e.shape.text) }));
}

export function outlineToText(page: Page, indent = "\t"): string {
  return dumpOutline(page)
    .map((l) => indent.repeat(l.level) + l.text)
    .join("\n");
}

export type InsertMode =
  /** 作为目标主题的子树追加（"插入 → 剪贴板内容"、AI 生成子主题）。 */
  | "appendChildren"
  /** 目标正在编辑：首行替换其文本，余行按相对层级成为兄弟（多行粘贴）。 */
  | "editPaste"
  /** 作为目标主题之后的兄弟插入（大纲面板回车）。 */
  | "afterSibling";

/**
 * 把一段大纲文本插进树里。三种模式共用同一个"相对层级 → 绝对父节点"的换算。
 */
export function insertOutline(
  page: Page,
  targetId: string,
  input: string,
  mode: InsertMode,
  markdown = false
): { page: Page; ids: string[] } {
  let lines = parseOutline(input, markdown);
  if (!lines.length) return { page, ids: [] };
  const target = getShape(page, targetId);
  if (!target) return { page, ids: [] };

  const ids: string[] = [];
  const baseLevel = lines[0].level;
  lines = lines.map((l) => ({ level: l.level - baseLevel, text: l.text }));

  let cur = page;
  // parentByLevel[level] = 该层应当挂到的父 id；level 0 的父就是锚点。
  const parentByLevel: Record<number, string> = { [-1]: targetId, 0: targetId };

  if (mode === "editPaste") {
    cur = updateText(cur, targetId, lines[0].text);
    ids.push(targetId);
    lines = lines.slice(1).map((l) => ({ level: Math.max(1, l.level), text: l.text }));
    if (!lines.length) return { page: cur, ids };
    parentByLevel[0] = targetId;
  }

  let anchorSibling = targetId;
  for (const line of lines) {
    const level = line.level;
    let parentId: string;
    if (mode === "appendChildren") {
      parentId = parentByLevel[level - 1] ?? targetId;
    } else if (mode === "afterSibling") {
      parentId = level === 0 ? (target.parentId ?? targetId) : parentByLevel[level - 1] ?? anchorSibling;
    } else {
      // editPaste：level 0 已经吃掉，剩余 level>=1 一律挂在目标或其派生子下
      parentId = parentByLevel[level - 1] ?? targetId;
    }
    const r =
      mode === "afterSibling" && level === 0
        ? (() => {
            const s = insertSibling(cur, anchorSibling, "after", line.text);
            return s;
          })()
        : insertChild(cur, parentId, line.text);
    cur = r.page;
    ids.push(r.id);
    parentByLevel[level] = r.id;
    if (mode === "afterSibling") anchorSibling = r.id;
  }
  return { page: cur, ids };
}

/**
 * Tab / Shift+Tab 的作用域版本：选中多个主题时，整段一起升降。
 * 顺序敏感 —— 降级必须"从前往后"，升级必须"从后往前"，否则兄弟关系会被自己刚建出的节点绕掉。
 */
export function indentRange(page: Page, ids: string[], dir: 1 | -1): { page: Page; skipped: number } {
  const ordered = dir === 1 ? [...ids] : [...ids].reverse();
  let cur = page;
  let skipped = 0;
  for (const id of ordered) {
    if (!getShape(cur, id)) {
      skipped += 1;
      continue;
    }
    // 不能把父节点降进它自己的孩子里
    if (dir === 1) {
      const ix = cur.shapes[id].parentId
        ? cur.shapes[cur.shapes[id].parentId as string].childIds.indexOf(id)
        : -1;
      if (ix <= 0) {
        skipped += 1;
        continue;
      }
    }
    const r = dir === 1 ? demote(cur, id) : promote(cur, id);
    if (r.ok) cur = r.page;
    else skipped += 1;
  }
  return { page: cur, skipped };
}

/**
 * 大纲里删除一行 = 连同子树删掉（与 tree.removeShape 同语义）。
 * 中心主题删不掉：大纲面板的第一行按 Delete 等于清空整张图，那是数据丢失不是编辑。
 */
export function removeSubtree(page: Page, id: string): Page {
  const target = getShape(page, id);
  if (!target || !target.parentId) return page;
  const doomed = new Set(descendants(page, id).concat(id));
  const shapes = { ...page.shapes };
  for (const d of doomed) delete shapes[d];
  shapes[target.parentId] = {
    ...shapes[target.parentId],
    childIds: shapes[target.parentId].childIds.filter((c) => c !== id),
  };
  return { ...page, shapes };
}

/**
 * 大纲行拖拽：等价于树上的 moveShape，只多一步"目标父 + 插入位"的换算。
 *
 * 插入位必须在**摘掉拖拽节点之后**的那份 childIds 上取：moveShape 的 at 就是对着摘完的列表数的，
 * 用摘之前的下标会让"往前拖"和"往后拖"落到同一行的两侧（同一个落点两种结果）。
 */
export function moveBetweenLines(page: Page, dragId: string, overId: string, asChild: boolean): Page {
  if (asChild) return moveShape(page, dragId, overId);
  const over = getShape(page, overId);
  if (!over?.parentId) return moveShape(page, dragId, overId);
  const rest = page.shapes[over.parentId].childIds.filter((c) => c !== dragId);
  return moveShape(page, dragId, over.parentId, Math.max(0, rest.indexOf(overId)));
}
