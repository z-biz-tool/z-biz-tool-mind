/**
 * 本页真正该用的色板：画布、SVG/PNG/PDF 导出、打印、"恢复主题配色"共用这一份。
 *
 * 不是 store —— 它只是把"文档自带的 theme.xml 整份 + 本页绑的两个主题 ID"三件事 memoize 起来。
 * 三个依赖都是对象身份或数字：换文档 / 换页 / 换主题才重算，拖动中每帧不重解一遍 XML。
 * 放在一处是有原因的：色板只要有一份算错，画布和导出就会分叉，而分叉的表现是
 * "屏幕上看着对，导出来的图换了套颜色" —— 这类 bug 单测里各测各的都发现不了。
 */
import { useMemo } from "react";
import { paletteOf, themeRootOf } from "../engine/emmx/theme.ts";
import type { ThemePalette } from "../engine/style.ts";
import { activeDoc, activePage, useDoc } from "./docStore.ts";

export function usePalette(): ThemePalette {
  const root = useDoc((s) => themeRootOf(activeDoc(s)));
  const colorId = useDoc((s) => activePage(s)?.theme.colorId);
  const textId = useDoc((s) => activePage(s)?.theme.textId);
  return useMemo(() => paletteOf(root, colorId, textId), [root, colorId, textId]);
}
