/**
 * 文档自带的 theme.xml → 画布与导出真正该用的色板（复刻方案 00 §2.5）。
 *
 * 实测（`_research/extract/doc1..5/theme.xml.txt` 五份同构）：
 *   `<ThemeColor Name="Angel" ID="3"><ColorScheme Accent1="#5e84ff" Accent3="#cc7eb0" Accent6="#f8ae1a" .../>`
 *
 * 两条只能从文件里读出来的规矩：
 *  1. **属性顺序是打乱的** —— 上面那份的实际书写顺序是 1,3,6,4,7,10,9,2,5,8，所以必须按 Accent 的序号落位，
 *     按属性出现顺序收会把色板洗成一列随机色。
 *  2. **数组下标就是槽位号** —— `Color ThemeColor="N"` 解的是 `accents[N-1]`（见 style.ts 的 resolveColor），
 *     所以缺那一档只能按 Angel 同档补位，不许压缩：压缩会让后面所有槽位集体错位，
 *     表现是换个主题只有一部分节点变色，而单看色板长度又是"正常"的。
 *
 * 为什么要这一份：渲染链今天一律 `defaultPalette()`（=Angel），于是"导入的文档自带自己的配色"只对了一半 ——
 * 节点上的槽位号原样带进来了，解槽位用的却还是 Angel 那十色。文件自己说了什么色，就该按它说的画。
 */
import type { DocumentModel, Page } from "../../types/model.ts";
import { ANGEL_ACCENTS } from "../../model/constants.ts";
import {
  EDRAW_FONT_FAMILY,
  EDRAW_FONT_SIZES,
  parseHex,
  toHex,
  type ThemePalette,
} from "../style.ts";
import type { XmlNode } from "./xparse.ts";
import { attr, el, find, findAll, numAttr } from "./xparse.ts";

export interface ThemeColorEntry {
  name: string;
  id: number;
  /** Accent1..N 按序号落位；一档都没有时是空数组（调用方回退 Angel）。 */
  accents: string[];
}

export interface ThemeTextEntry {
  name: string;
  id: number;
  fontFamily: string;
  /** 下标 = 层级（0 = 中心主题），与 EDRAW_FONT_SIZES 同一个约定。 */
  fontSizes: number[];
}

const ACCENT_RE = /^Accent(\d+)$/;

/** 认不出的值（空、非 16 进制）当作没写，与 parseHex 同一条口径。 */
function accentsOf(node: XmlNode | undefined): string[] {
  const found = new Map<number, string>();
  // 档数按"文件写了几个 Accent"算，而不是按"读出了几个能用的色"：
  // 写坏了的第四档仍然说明这套主题有四档，那一格回退 Angel；整列压缩会让后面所有槽位错位。
  let max = 0;
  for (const [k, v] of Object.entries(node?.attrs ?? {})) {
    const m = ACCENT_RE.exec(k);
    if (!m) continue;
    const i = Number(m[1]);
    if (i < 1 || Number.isNaN(i)) continue; // 槽位号从 1 起，0 与脏值都不算写过
    if (i > max) max = i;
    const rgb = parseHex(v);
    if (rgb) found.set(i, toHex(rgb));
  }
  // 一档都没读出来 ⇒ 当作这套主题没写色板，整列回退 Angel。
  // 只回退那一格会交出一份长度为 1 的色板，所有分支同色 —— 看着像"主题坏了"，其实是解析器在猜。
  if (!max || !found.size) return [];
  const out: string[] = [];
  for (let i = 1; i <= max; i += 1)
    out.push(found.get(i) ?? ANGEL_ACCENTS[(i - 1) % ANGEL_ACCENTS.length]);
  return out;
}

function fontSizesOf(list: XmlNode | undefined): number[] {
  const schemes = list ? findAll(list, "FontScheme") : [];
  if (!schemes.length) return [];
  return schemes.map((s, i) => {
    const v = numAttr(s, "FontSize", 0);
    return v > 0 ? v : EDRAW_FONT_SIZES[i % EDRAW_FONT_SIZES.length];
  });
}

function colorsOf(root: XmlNode): ThemeColorEntry[] {
  const out: ThemeColorEntry[] = [];
  for (const theme of findAll(root, "Theme"))
    for (const tc of findAll(theme, "ThemeColor"))
      out.push({
        name: attr(tc, "Name"),
        id: numAttr(tc, "ID", -1),
        accents: accentsOf(find(tc, "ColorScheme")),
      });
  return out;
}

function textsOf(root: XmlNode): ThemeTextEntry[] {
  const out: ThemeTextEntry[] = [];
  for (const theme of findAll(root, "Theme"))
    for (const tt of findAll(theme, "ThemeText")) {
      const lst = find(tt, "FontSchemeLst");
      out.push({
        name: attr(tt, "Name"),
        id: numAttr(tt, "ID", -1),
        // 字号档自己带字名，优先用它；文字主题名只是这一套的标签（实测两者同为「微软雅黑」）。
        fontFamily: attr(lst?.children[0], "FontName") || attr(tt, "Name"),
        fontSizes: fontSizesOf(lst),
      });
    }
  return out;
}

/** 解析结果按 themeRoot 的对象身份缓存：它是 codec 的解包缓存，一份文件只会有一种色板。 */
const cache = new WeakMap<XmlNode, { colors: ThemeColorEntry[]; texts: ThemeTextEntry[] }>();

export function docThemes(root: XmlNode | undefined): {
  colors: ThemeColorEntry[];
  texts: ThemeTextEntry[];
} {
  if (!root) return { colors: [], texts: [] };
  let hit = cache.get(root);
  if (!hit) {
    hit = { colors: colorsOf(root), texts: textsOf(root) };
    cache.set(root, hit);
  }
  return hit;
}

/**
 * 按 ID 选一套，认不出就取第一套（`<Theme>` 里通常各只有一个）。
 * 读写两侧共用这一条规矩（pickIndex）：各写一遍的话，"认不出取第一套"只会在一侧成立 ——
 * 给一份没有那个 ID 的文件换主题，写进去的是第一套，读回来的却是另一套。
 */
function pickIndex<T>(list: readonly T[], idOf: (x: T) => number, id: number | undefined): number {
  if (!list.length) return -1;
  const hit = list.findIndex((x) => id !== undefined && idOf(x) === id);
  return hit < 0 ? 0 : hit;
}

function pick<T extends { id: number }>(list: T[], id: number | undefined): T | undefined {
  const i = pickIndex(list, (x) => x.id, id);
  return i < 0 ? undefined : list[i];
}

export function paletteOf(
  root: XmlNode | undefined,
  colorId?: number,
  textId?: number
): ThemePalette {
  const t = docThemes(root);
  const c = pick(t.colors, colorId);
  const x = pick(t.texts, textId);
  return {
    accents: c?.accents.length ? [...c.accents] : [...ANGEL_ACCENTS],
    fontSizes: x?.fontSizes.length ? [...x.fontSizes] : [...EDRAW_FONT_SIZES],
    fontFamily: x?.fontFamily || EDRAW_FONT_FAMILY,
  };
}

/** theme.xml 在 codec 解包时就整份挂在 doc 级（rawUnknown 是解析缓存，写盘原样带走）。 */
export function themeRootOf(doc: DocumentModel | undefined): XmlNode | undefined {
  return doc?.rawUnknown?.themeRoot as XmlNode | undefined;
}

/** 文档 + 本页绑定的主题 → 色板。themeRoot 在 doc 级（theme.xml 整份原样带走），槽位号在 page 级。 */
export function paletteForDoc(doc: DocumentModel, page?: Page): ThemePalette {
  const root = themeRootOf(doc);
  return paletteOf(root, page?.theme?.colorId, page?.theme?.textId);
}

/** 这一套在文件里叫什么名（列表里"本文档"那一行要说真话，不能只报一串色值）。 */
export function colorNameOf(root: XmlNode | undefined, colorId?: number): string {
  return pick(docThemes(root).colors, colorId)?.name ?? "";
}

// ---------------------------------------------------------------- 写回（主题库"应用"的那一半）

/**
 * XmlNode 深拷贝。写色板必须 copy-on-write：
 * 原 root 是 codec 的解包缓存，也是撤销栈里那一份的同一个对象，就地改会把历史一起改掉。
 */
export function cloneNode(n: XmlNode): XmlNode {
  return {
    tag: n.tag,
    attrs: { ...n.attrs },
    children: n.children.map(cloneNode),
    text: n.text,
    selfShrink: n.selfShrink,
  };
}

/** 色板 → `Accent1..N` 属性表。按序号写，读侧那条"顺序是打乱的"规矩反过来同样成立。 */
export function accentAttrs(accents: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  accents.forEach((c, i) => {
    out[`Accent${i + 1}`] = c;
  });
  return out;
}

/** 实测 doc1 里 `<Theme>` 下的书写顺序：ThemeColor → ThemeEffect → ThemeText → ThemeShape。 */
const THEME_CHILD_ORDER = ["ThemeColor", "ThemeEffect", "ThemeText", "ThemeShape"];

/** 补缺失的子主题时按亿图的顺序插，不能一律 append 到 ThemeShape 后面。 */
function insertOrdered(theme: XmlNode, node: XmlNode): void {
  const rank = THEME_CHILD_ORDER.indexOf(node.tag);
  const after = theme.children.findIndex((c) => THEME_CHILD_ORDER.indexOf(c.tag) > rank);
  if (after < 0) theme.children.push(node);
  else theme.children.splice(after, 0, node);
}

export interface PaletteWriteOptions {
  /** 写进哪一套 ThemeColor：与读侧同一个规矩，认不出就写第一套。 */
  colorId?: number;
  textId?: number;
  /** 盖在 `ThemeColor/@Name` 上的名字。列表名不一定要进用户的文件，所以与显示名分开给。 */
  themeName?: string;
}

/**
 * 把一份色板写进文档的 theme.xml，返回**新的** root（原对象一个字节不动）。
 *
 * 只动 ColorScheme 的 Accent 条目和 FontSchemeLst 的字号/字名，其余（ThemeEffect 的
 * Shade/Tint、ThemeShape 的连线方案、文件里我们根本不认识的节点）原样带走 ——
 * 换一次配色不该把整份主题重写成我们认识的那一小截。
 * ColorScheme 上非 Accent 的属性也保留：那是亿图写的，不是我们编的。
 */
export function withPalette(
  root: XmlNode | undefined,
  palette: ThemePalette,
  opts: PaletteWriteOptions = {}
): XmlNode {
  const out = root ? cloneNode(root) : el("Themes");
  let theme = find(out, "Theme");
  if (!theme) {
    theme = el("Theme", {
      Effect: "0",
      Name: opts.themeName || "Custom",
      Rainbow: "0",
      ID: "31",
    });
    out.children.push(theme);
  }

  const colors = findAll(theme, "ThemeColor");
  const ci = pickIndex(colors, (c) => numAttr(c, "ID", -1), opts.colorId);
  let tc = ci < 0 ? undefined : colors[ci];
  if (!tc) {
    tc = el("ThemeColor", { Name: opts.themeName || "Custom", ID: String(opts.colorId ?? 3) });
    insertOrdered(theme, tc);
  } else if (opts.themeName) {
    tc.attrs.Name = opts.themeName;
  }
  const cs = find(tc, "ColorScheme");
  if (!cs) {
    tc.children.push(el("ColorScheme", accentAttrs(palette.accents)));
  } else {
    for (const k of Object.keys(cs.attrs)) if (ACCENT_RE.test(k)) delete cs.attrs[k];
    Object.assign(cs.attrs, accentAttrs(palette.accents));
  }

  const family = palette.fontFamily;
  const texts = findAll(theme, "ThemeText");
  const ti = pickIndex(texts, (t) => numAttr(t, "ID", -1), opts.textId);
  let tt = ti < 0 ? undefined : texts[ti];
  if (!tt) {
    tt = el("ThemeText", { Name: family, ID: String(opts.textId ?? 8) });
    insertOrdered(theme, tt);
  } else {
    tt.attrs.Name = family;
  }
  let lst = find(tt, "FontSchemeLst");
  if (!lst) {
    lst = el("FontSchemeLst");
    tt.children.push(lst);
  }
  // 逐档改写而不是整列重造：亿图在 FontScheme 上写的别的属性（我们不认识的那些）要留着。
  const keep = lst.children.filter((c) => c.tag === "FontScheme");
  lst.children = palette.fontSizes.map((size, i) => {
    const old = keep[i];
    const attrs: Record<string, string> = { ...(old?.attrs ?? {}) };
    attrs.FontName = family;
    attrs.FontSize = String(size);
    if (!("Flag" in attrs)) attrs.Flag = "0";
    return { tag: "FontScheme", attrs, children: [], text: "", selfShrink: true };
  });
  return out;
}
