/**
 * 视口几何：只有一件事 —— 把"整张图装进窗口"算出来。
 *
 * 放在 engine 而不是画布组件里，是因为组件里的这一步没法单独验证：
 * 它要等 ResizeObserver 量出尺寸，而 CI 里没有窗口。
 */
import { ZOOM_STEPS } from "../model/constants.ts";

const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export interface Viewport {
  w: number;
  h: number;
}

export interface ContentBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * 求一个缩放 + 位移，让内容外框带着一圈边距居中落进视口。
 *
 * 返回 null 表示现在还算不出来（视口没量到、或者内容为空），调用方要把这次请求留到下一帧，
 * 而不是当成"用户没要求"。缩放上限固定 100%：适应画布只解决装不下，不负责把小图撑满窗口 ——
 * 放大到 400% 之后一屏只剩两三个主题，比原样还难读。
 */
export function fitView(
  view: Viewport,
  box: ContentBox,
  pad = 48
): { zoom: number; pan: { x: number; y: number } } | null {
  if (!(view.w > 0) || !(view.h > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  const zoom = Math.min(
    ZOOM_MAX,
    Math.max(ZOOM_MIN, Math.min(1, (view.w - pad * 2) / box.width, (view.h - pad * 2) / box.height))
  );
  return {
    zoom,
    pan: {
      x: view.w / 2 - (box.minX + box.width / 2) * zoom,
      y: view.h / 2 - (box.minY + box.height / 2) * zoom,
    },
  };
}

/** 屏幕坐标下的一个矩形（已经乘过 zoom、加过 pan）。 */
export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 快捷操作条该贴在哪一侧。 */
export type BarSide = "above" | "below";

export interface BarAnchor {
  left: number;
  top: number;
  side: BarSide;
}

const BAR_EDGE = 4;

/**
 * 给选中主题旁浮出来的那条操作求一个位置。
 *
 * 默认贴在节点上沿之上（亿图就是这个位置），上边放不下就翻到下边 —— 顶行主题、
 * 或者画布被压得很扁时会翻。横向永远居中于节点，但被视口两边夹住，
 * 免得半条工具条滑出窗口外点不到。
 */
export function quickBarAnchor(
  node: ScreenBox,
  view: Viewport,
  bar: { w: number; h: number },
  gap = 8
): BarAnchor | null {
  if (!(view.w > 0) || !(view.h > 0) || !(node.width > 0) || !(node.height > 0)) return null;
  if (!(bar.w > 0) || !(bar.h > 0)) return null;

  const above = node.top - gap - bar.h;
  const below = node.top + node.height + gap;
  const side: BarSide = above >= BAR_EDGE ? "above" : "below";
  const rawTop = side === "above" ? above : below;
  const top = Math.min(rawTop, Math.max(BAR_EDGE, view.h - bar.h - BAR_EDGE));

  const maxLeft = Math.max(BAR_EDGE, view.w - bar.w - BAR_EDGE);
  const left = Math.min(maxLeft, Math.max(BAR_EDGE, node.left + node.width / 2 - bar.w / 2));
  return { left, top, side };
}
