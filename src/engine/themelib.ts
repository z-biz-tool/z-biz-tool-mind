/**
 * 主题库（03 §1.3-17）：一套能起名字的色板，加上它的增删改与"应用到这份文档"。
 *
 * 与 3A 的分工：`engine/emmx/theme.ts` 管"文件里的 theme.xml 说了什么色"，这一层管
 * "用户存下来的那几套色，以及把它写回文件"。两边共用同一条 pick 规矩和同一份 normalize，
 * 所以写完一定能读回来（tests/themelib.test.ts 逐条钉着）。
 *
 * 刻意没有做的事：
 * - 不内置亿图那 47 套主题表。仓库里能找到的只有 Angel 一套的实际取值
 *   （`_research/extract/doc1..5/theme.xml.txt` 五份同构），其余 46 套的色值是编造，
 *   编出来的东西还会被当成实测写进 .emmx 带走。所以库里只有「默认（Angel）」+ 用户自己存的。
 * - 不在"应用"时把颜色烤进每个主题的 style（applyPalette 那条路）。slot 绑定的节点
 *   本来就跟着 theme.xml 现推，烤一遍反而会把文件里的 `ThemeColor="N"` 槽位号洗成死值。
 *   需要交还主题的那些（用户单独配过色的）仍然用工具条上的「恢复主题配色」。
 */
import type { DocumentModel, Page } from "../types/model.ts";
import {
  parseHex,
  toHex,
  defaultPalette,
  EDRAW_FONT_FAMILY,
  EDRAW_FONT_SIZES,
  type ThemePalette,
} from "./style.ts";
import { colorNameOf, paletteForDoc, themeRootOf, withPalette } from "./emmx/theme.ts";

/** 存进 config.json 的一套主题：字段全是可序列化的标量/数组，没有 XmlNode。 */
export interface StoredTheme {
  id: string;
  /** 列表里给用户看的名字。 */
  name: string;
  accents: string[];
  fontSizes: number[];
  fontFamily: string;
  /** 写回 theme.xml 时盖在 `ThemeColor/@Name` 上的名字；缺省用 name。 */
  themeName?: string;
}

/**
 * 自定义主题套数上限。亿图那份是会员功能 + 个人云同步，没给数字；
 * 这里要的只是一个不至于把 config.json 撑爆的边界（QUOTA 同层规则）。
 */
export const THEME_MAX = 50;
/** 名称长度上限（同上：不是实测，取一个列表行放得下的数）。 */
export const THEME_NAME_MAX = 20;
/** 主色档数：1 档等于全图一色，16 档足够；再长就没人能配得好看。 */
export const ACCENT_MIN = 1;
export const ACCENT_MAX = 16;
/** 字号**档数**上限（实测那份是 8 档，数组下标 = 层级）。名字里带 LEVEL 是因为它不是字号本身的上限。 */
export const FONT_LEVEL_MAX = 12;

export const BUILTIN_DEFAULT_ID = "default";

/** 内置那一套：就是 3A 之前全应用唯一的一份色板（Angel 十色 + 微软雅黑 8 档）。 */
export const BUILTIN_DEFAULT: StoredTheme = {
  id: BUILTIN_DEFAULT_ID,
  name: "默认（Edraw）",
  themeName: "Angel",
  ...defaultPalette(),
};

export function paletteOfTheme(t: StoredTheme): ThemePalette {
  return { accents: [...t.accents], fontSizes: [...t.fontSizes], fontFamily: t.fontFamily };
}

/** 两套色板是否逐值相同（"这一套正在被使用"、"应用了没变化"都问它）。 */
export function samePalette(a: ThemePalette, b: ThemePalette): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.accents.length === b.accents.length &&
    a.accents.every((c, i) => c === b.accents[i]) &&
    a.fontSizes.length === b.fontSizes.length &&
    a.fontSizes.every((n, i) => n === b.fontSizes[i])
  );
}

const HEX = (v: unknown): string => {
  if (typeof v !== "string") return "";
  const c = parseHex(v);
  return c ? toHex(c) : "";
};

/**
 * 单个主题的边界校验：config.json 是用户能手改的（也会跨版本），
 * 一个坏值进列表就是画布上一块 NaN 底色，所以认不出就整条丢，不猜。
 */
export function sanitizeTheme(raw: unknown, fallbackId = ""): StoredTheme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, THEME_NAME_MAX) : "";
  const accents = (Array.isArray(r.accents) ? r.accents : []).map(HEX).filter(Boolean);
  if (!name || !accents.length || accents.length < ACCENT_MIN || accents.length > ACCENT_MAX) {
    return undefined;
  }
  const fontSizes = (Array.isArray(r.fontSizes) ? r.fontSizes : [])
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0))
    .filter((n) => n > 0)
    .slice(0, FONT_LEVEL_MAX);
  const id = typeof r.id === "string" && r.id ? r.id : fallbackId;
  const out: StoredTheme = {
    id,
    name,
    accents,
    fontSizes: fontSizes.length ? fontSizes : [...EDRAW_FONT_SIZES],
    fontFamily:
      typeof r.fontFamily === "string" && r.fontFamily.trim()
        ? r.fontFamily.trim().slice(0, 40)
        : EDRAW_FONT_FAMILY,
  };
  const themeName =
    typeof r.themeName === "string" ? r.themeName.trim().slice(0, THEME_NAME_MAX) : "";
  if (themeName) out.themeName = themeName;
  return out;
}

/** 整份列表的校验：坏条丢掉、同名留第一个、超出上限裁掉。 */
export function sanitizeThemes(raw: unknown): StoredTheme[] {
  if (!Array.isArray(raw)) return [];
  const seenId = new Set<string>();
  const seenName = new Set<string>();
  const out: StoredTheme[] = [];
  raw.forEach((item, i) => {
    const t = sanitizeTheme(item, `t${i + 1}`);
    if (!t) return;
    const key = t.name.toLowerCase();
    if (seenId.has(t.id) || seenName.has(key)) return;
    seenId.add(t.id);
    seenName.add(key);
    out.push(t);
  });
  return out.slice(0, THEME_MAX);
}

/** 新主题的空草稿：不是"某套已存在的主题"，所以名字留给用户填。 */
export function blankTheme(): StoredTheme {
  return {
    id: "",
    name: "",
    accents: [...defaultPalette().accents],
    fontSizes: [...EDRAW_FONT_SIZES],
    fontFamily: EDRAW_FONT_FAMILY,
  };
}

/** 把这份文档此刻的配色取成一套主题（亿图文案：「没有可用的自定义主题。是否从当前文档提取主题？」）。 */
export function extractTheme(doc: DocumentModel, page: Page): StoredTheme {
  const palette = paletteForDoc(doc, page);
  const file = colorNameOf(themeRootOf(doc), page.theme.colorId);
  return { id: "", name: file || "当前主题", ...palette, ...(file ? { themeName: file } : {}) };
}

/** 下一个可用主题号。带序号是为了 config.json 里人眼可读，比 uuid 好复现。 */
export function nextThemeId(list: readonly StoredTheme[]): string {
  let n = 1;
  for (;;) {
    const id = `t${n}`;
    if (!list.some((t) => t.id === id)) return id;
    n += 1;
  }
}

export type ThemeReason = "name" | "colors" | "dup" | "full" | "missing";

/** 失败文案：重名那一句是参考软件解包字符串原文（CustomThemeDialog「保存失败，该自定义主题已经存在。」）。 */
export const THEME_REASON_TEXT: Record<ThemeReason, string> = {
  name: "主题名称是空的，没有保存。",
  colors: "这套主题一个能用的颜色都没有，没有保存。",
  dup: "保存失败，该自定义主题已经存在。",
  full: `自定义主题最多存 ${THEME_MAX} 套，先删掉几套再存。`,
  missing: "这一套自定义主题已经不在了。",
};

export type ThemeOp =
  { ok: true; list: StoredTheme[] } | { ok: false; reason: ThemeReason; list: StoredTheme[] };

/**
 * 存一套（新建与改现有都走它，按 id 认）。
 * 重名要当场拒绝而不是悄悄加个"2"：亿图给的就是「保存失败，该自定义主题已经存在。」，
 * 静默改名会让人以为存了两套一样的。
 */
export function saveTheme(list: readonly StoredTheme[], t: StoredTheme): ThemeOp {
  const base = [...list];
  const name = t.name.trim().slice(0, THEME_NAME_MAX);
  if (!name) return { ok: false, reason: "name", list: base };
  const accents = t.accents.map(HEX).filter(Boolean);
  if (!accents.length || accents.length > ACCENT_MAX)
    return { ok: false, reason: "colors", list: base };
  if (base.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: "dup", list: base };
  }
  const next: StoredTheme = {
    ...t,
    name,
    accents,
    fontSizes: (t.fontSizes.length ? t.fontSizes : [...EDRAW_FONT_SIZES]).slice(0, FONT_LEVEL_MAX),
    fontFamily: t.fontFamily.trim() || EDRAW_FONT_FAMILY,
  };
  const at = t.id ? base.findIndex((x) => x.id === t.id) : -1;
  if (at >= 0) {
    base[at] = next;
    return { ok: true, list: base };
  }
  if (base.length >= THEME_MAX) return { ok: false, reason: "full", list: base };
  next.id = t.id || nextThemeId(base);
  base.push(next);
  return { ok: true, list: base };
}

export function removeTheme(list: readonly StoredTheme[], id: string): StoredTheme[] {
  return list.filter((t) => t.id !== id);
}

export function findTheme(
  list: readonly StoredTheme[],
  id: string | undefined
): StoredTheme | undefined {
  if (!id || id === BUILTIN_DEFAULT_ID) return undefined;
  return list.find((t) => t.id === id);
}

/**
 * 把一套主题写进这份文档的 theme.xml（返回新 doc，原 doc 不动）。
 * 写的是**本页 colorId/textId 绑定的那两套**：theme.xml 是文档级的一份文件，
 * 每个页签靠自己的槽位号从里面取，所以多页文档里换主题只影响绑这一档的页。
 */
export function applyTheme(doc: DocumentModel, page: Page, t: StoredTheme): DocumentModel {
  const root = withPalette(themeRootOf(doc), paletteOfTheme(t), {
    colorId: page.theme.colorId,
    textId: page.theme.textId,
    themeName: t.themeName || t.name,
  });
  return { ...doc, rawUnknown: { ...(doc.rawUnknown ?? {}), themeRoot: root } };
}
