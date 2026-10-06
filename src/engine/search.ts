/**
 * 查找与替换（Ribbon「查找」Ctrl+F，命中后自动展开折叠分支）。
 *
 * 命中位置以"主题正文的纯文本偏移"表达，画布和大纲共用同一份结果；
 * 替换走 updateText，因此被改过的主题会失去段内混排（这是刻意的取舍：
 * 替换是批量操作，保留逐 run 样式需要重写整套富文本 diff，收益不抵风险）。
 */
import type { Page } from "../types/model.ts";
import { plainText } from "../types/model.ts";
import { ancestors, getShape, setCollapsed, updateExtras, updateText } from "./tree.ts";

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** 备注（笔记）里也搜。 */
  inNote?: boolean;
}

export interface Match {
  shapeId: string;
  /** 命中所在字段，UI 用它决定高亮位置（正文/备注在文字上，标签在角标上）。 */
  field: "text" | "note" | "label";
  /** 相对该字段自己的偏移；field 为 label 时相对第 labelIndex 个标签。 */
  start: number;
  length: number;
  /** 命中前后各 20 字的上下文，大纲行直接显示。 */
  preview: string;
  labelIndex?: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 全字匹配的边界只认拉丁单词字符：中日韩不做分词，"AI助手" 里的 AI 在亿图实测能整词命中，
 * 把 CJK 也划进边界字符集就会让中英混排的英文段一个都搜不到。
 */
function buildPattern(query: string, opts: SearchOptions): RegExp {
  const flags = "g" + (opts.caseSensitive ? "" : "i");
  const body = opts.wholeWord ? `(?<!\\w)${escapeRe(query)}(?!\\w)` : escapeRe(query);
  return new RegExp(body, flags);
}

function previewOf(text: string, start: number, len: number): string {
  const from = Math.max(0, start - 20);
  const to = Math.min(text.length, start + len + 20);
  return (from > 0 ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "");
}

export function findMatches(page: Page, query: string, opts: SearchOptions = {}): Match[] {
  if (!query) return [];
  const out: Match[] = [];
  // 每个字段单独建一个 RegExp：带 g 的实例有 lastIndex，共用会在第二个字段上漏掉开头的命中。
  const scan = (shapeId: string, field: Match["field"], hay: string, labelIndex?: number) => {
    const re = buildPattern(query, opts);
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(hay))) {
      out.push({
        shapeId,
        field,
        start: hit.index,
        length: hit[0].length,
        preview: previewOf(hay, hit.index, hit[0].length),
        ...(labelIndex === undefined ? {} : { labelIndex }),
      });
      if (hit[0].length === 0) re.lastIndex += 1; // 空匹配防死循环
    }
  };

  for (const s of Object.values(page.shapes)) {
    scan(s.id, "text", plainText(s.text));
    if (opts.inNote && s.extras.note) scan(s.id, "note", s.extras.note);
    s.extras.labels?.forEach((label, i) => scan(s.id, "label", label, i));
  }
  // 稳定顺序：按主题 id 数值，再按偏移。遍历列表和大纲高亮都依赖它。
  out.sort((a, b) => Number(a.shapeId) - Number(b.shapeId) || a.start - b.start);
  return out;
}

/**
 * 批量替换。命中的标签不做替换：标签是结构化字段（角标 + 颜色），
 * 逐字符改写会把语义换坏，需要改标签的走"编辑标签"入口。
 */
export function replaceAll(
  page: Page,
  query: string,
  replacement: string,
  opts: SearchOptions = {}
): { page: Page; count: number } {
  if (!query) return { page, count: 0 };
  let out = page;
  let count = 0;
  const re = buildPattern(query, opts);
  // 用户输入的替换串按普通文本处理：字符串形式的 replace 会把 $& / $1 当反向引用展开。
  const literal = () => replacement;
  for (const s of Object.values(page.shapes)) {
    const text = plainText(s.text);
    const hits = [...text.matchAll(new RegExp(re.source, re.flags))];
    if (hits.length) {
      out = updateText(out, s.id, text.replace(re, literal));
      count += hits.length;
    }
    if (opts.inNote && s.extras.note) {
      const noteHits = [...s.extras.note.matchAll(new RegExp(re.source, re.flags))];
      if (noteHits.length) {
        out = updateExtras(out, s.id, { note: s.extras.note.replace(re, literal) });
        count += noteHits.length;
      }
    }
  }
  return { page: out, count };
}

/** 命中一个被折叠隐藏的主题前，先把祖先全部展开，否则跳转过去看不见。 */
export function revealShape(page: Page, shapeId: string): Page {
  if (!getShape(page, shapeId)) return page;
  let out = page;
  for (const id of ancestors(page, shapeId)) {
    if (getShape(out, id)?.extras.collapsed) out = setCollapsed(out, id, false);
  }
  return out;
}

/** 环形步进：返回下一个命中在 matches 里的下标。 */
export function stepIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  return (((current + dir) % total) + total) % total;
}

export function matchCount(matches: Match[], shapeId: string): number {
  return matches.reduce((n, m) => (m.shapeId === shapeId ? n + 1 : n), 0);
}
