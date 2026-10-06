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
