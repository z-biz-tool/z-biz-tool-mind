/**
 * 主题推导（doc/复刻方案/00 §3.5：颜色 / 效果 / 文字 / 形状四个子主题可独立混搭）。
 *
 * 实测依据：theme.xml 的 `<ThemeColor Name="Angel" ID="3">` 给了 10 个 Accent 主色，
 * `<ThemeText Name="微软雅黑" ID="8">` 给了 8 档字号 14/12/10/10/11/10/10/10，
 * `<ThemeEffect>` 里每个 ShapeFormat 用 `Shade` / `Tint` 相对 `Ref` 推导实际填充。
 * 所以颜色不是直接取 V，而是 V 与 (Ref, Shade/Tint) 两条路都要能算，
 * 否则换一个主题就全塌。
 */
import type { ColorValue, FontSpec, Page, Shape, ShapeStyle } from "../types/model.ts";
import { ANGEL_ACCENTS, DEFAULTS } from "../model/constants.ts";
import { branchIndex, levelOf, updateStyle } from "./tree.ts";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb | undefined {
  let h = hex.replace("#", "").trim();
  if (h.length === 8) h = h.slice(2); // 亿图写 #aarrggbb，取 ggbb 部分
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return undefined;
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function toHex(c: Rgb): string {
  const p = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

/** 变暗：向黑靠拢。pct 0..100。 */
export function shade(hex: string, pct: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const k = 1 - clampPct(pct) / 100;
  return toHex({ r: c.r * k, g: c.g * k, b: c.b * k });
}

/** 变亮：向白靠拢。pct 0..100。 */
export function tint(hex: string, pct: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const k = clampPct(pct) / 100;
  return toHex({ r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k });
}

export function mix(a: string, b: string, t = 0.5): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  const k = Math.max(0, Math.min(1, t));
  return toHex({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k });
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
}

/**
 * 颜色四元组 → 终值。有 Shade/Tint 时以 Ref 为基准推导，否则用 V。
 *
 * ThemeColor 槽位（实测 .emmx 里绑定主色的写法）必须在 V 之前参与取值：
 * 这类节点的 V 常常是占位的 #ffffffff，不读槽位的话所有绑定主色的形状都掉成白色。
 * 槽位 1..10 对应 Accent1..Accent10，取色板用主题自己的 accents，不是内置那份。
 */
export function resolveColor(c?: ColorValue, accents: readonly string[] = ANGEL_ACCENTS): string | undefined {
  if (!c) return undefined;
  const bound =
    c.themeColor !== undefined && c.themeColor > 0 && accents.length ? accents[(c.themeColor - 1) % accents.length] : undefined;
  const v = stripAlpha(bound ?? c.v);
  if (c.shade !== undefined && c.shade !== 0) return shade(c.ref ?? v, c.shade);
  if (c.tint !== undefined && c.tint !== 0) return tint(c.ref ?? v, c.tint);
  return v;
}

/** 亿图把 #aarrggbb 也当终值写进来，画 SVG/Canvas 时只认 #rrggbb。 */
function stripAlpha(v: string): string {
  return v.startsWith("#") && v.length === 9 ? `#${v.slice(3)}` : v;
}

/** 实测 Edraw 文字主题字号档位（索引 0 = 中心主题）。 */
export const EDRAW_FONT_SIZES = [14, 12, 10, 10, 11, 10, 10, 10];
export const EDRAW_FONT_FAMILY = "微软雅黑";

export interface ThemePalette {
  accents: string[];
  fontSizes: number[];
  fontFamily: string;
}

export function defaultPalette(): ThemePalette {
  return { accents: [...ANGEL_ACCENTS], fontSizes: [...EDRAW_FONT_SIZES], fontFamily: EDRAW_FONT_FAMILY };
}

/** 分支取色：Rainbow 时按主分支序号轮转，非 Rainbow 也轮转（亿图默认就是每支一色）。 */
export function accentAt(palette: ThemePalette, branchIx: number): string {
  const list = palette.accents.length ? palette.accents : ANGEL_ACCENTS;
  return list[((branchIx % list.length) + list.length) % list.length];
}

export interface Resolved {
  fill: string;
  line: string;
  lineWidth: number;
  rounding: number;
  font: FontSpec;
  /** 概要/外框/关系线用主色的浅色版。 */
  soft: string;
}

/**
 * 一个主题的最终样式 = 主题推导 → 用户覆盖。
 * `style.mask` 的 bit0 表示填充被用户独立配色（StyleMask 语义，待确认部分以实测为准）。
 */
export function styleFor(page: Page, shape: Shape, palette = defaultPalette()): Resolved {
  const level = levelOf(page, shape.id);
  // 第 0 层（中心主题与浮动主题的根）没有"第几支"可言：branchIndex 对它返回 -1，
  // 而 -1 取模会绕到色板最后一格，于是中心主题拿到的是 Accent10 而不是主色 Accent1。
  const branch = level <= 0 ? 0 : branchIndex(page, shape.id);
  const base = accentAt(palette, branch);
  const derivedFill =
    shape.type === "MainIdea" ? shade(base, 10) : level <= 1 ? base : level === 2 ? tint(base, 35) : tint(base, 60);
  const ownFill = resolveColor(shape.style.fill?.color, palette.accents);
  const ownLine = resolveColor(shape.style.line?.fill?.color, palette.accents);
  const fill = ownFill ?? derivedFill;
  const font: FontSpec = {
    family: palette.fontFamily,
    size: palette.fontSizes[Math.min(level, palette.fontSizes.length - 1)] ?? DEFAULTS.fontSize,
    // 字色跟"实际底色"走，不跟层级走：Accent6/9/10 这类亮主色上做白字是看不见的。
    color: contrastText(fill),
    bold: level <= 1,
    align: 1,
    lineSpacing: 100,
  };
  return {
    fill,
    line: ownLine ?? shade(base, 25),
    lineWidth: shape.style.line?.weight ?? DEFAULTS.lineWeight,
    rounding: shape.style.line?.rounding ?? DEFAULTS.rounding,
    font: { ...font, ...shape.style.font },
    soft: tint(base, 78),
  };
}

/**
 * 换主题：把没有独立配色的主题重新推导一遍（P-1：只改样式，树不动）。
 *
 * 只覆盖"颜色"这一件事，其余一律合并而不是整体替换：
 * 虚线线型、线帽、箭头是用户画的，渐变的色标是用户挑的，换一次主题不该把它们洗成实线纯色。
 */
export function applyPalette(page: Page, palette = defaultPalette()): Page {
  let out = page;
  for (const s of Object.values(page.shapes)) {
    if ((s.style.mask ?? 0) & 1) continue;
    const r = styleFor(out, s, palette);
    const gradient = s.style.fill?.type === "Gradient" ? s.style.fill : undefined;
    const style: Partial<ShapeStyle> = {
      fill: gradient
        ? gradient
        : { type: "Solid", color: { v: r.fill, ref: r.fill } },
      line: {
        ...s.style.line,
        weight: r.lineWidth,
        rounding: r.rounding,
        fill: { ...s.style.line?.fill, type: "Solid", color: { v: r.line } },
      },
    };
    out = updateStyle(out, s.id, style);
  }
  return out;
}

/** 深底白字 / 浅底黑字，供标签、徽标自适配。 */
export function contrastText(bg: string): string {
  const c = parseHex(bg);
  if (!c) return DEFAULTS.textColor;
  const l = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return l > 0.62 ? DEFAULTS.textColor : "#ffffff";
}
