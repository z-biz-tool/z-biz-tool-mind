/**
 * 六个投影的统一出口（doc/复刻方案/00 §0.3 P-1）。
 *
 * App 只认这一份清单：切换投影 = 换一个组件，数据源始终是 docStore 里的同一条树，
 * 所以这里不导出任何状态、也不做任何缓存 —— 缓存一旦落地就成了第二份真相。
 *
 * 思维导图与大纲是高频路径，跟着首屏打进主包；其余四个各是一个懒加载 chunk：
 * 看板/幻灯片/甘特/浏览共享不到多少代码，全部预载只会拖慢启动。
 */
import type { ComponentType } from "react";
import { lazyPanel } from "../_shared/lazyPanel.tsx";
import type { Projection } from "../stores/uiStore.ts";
import type { Page } from "../types/model.ts";
import { MindMapView } from "./MindMapView.tsx";
import { OutlineView } from "./OutlineView.tsx";

export interface ProjectionProps {
  page: Page;
}

const KanbanView = lazyPanel<ProjectionProps>(() => import("./KanbanView.tsx"), "看板");
const SlidesView = lazyPanel<ProjectionProps>(() => import("./SlidesView.tsx"), "幻灯片");
const GanttView = lazyPanel<ProjectionProps>(() => import("./GanttView.tsx"), "甘特");
const TraverseView = lazyPanel<ProjectionProps>(() => import("./TraverseView.tsx"), "浏览");

export const PROJECTION_VIEWS: Record<Projection, ComponentType<ProjectionProps>> = {
  mindmap: MindMapView,
  outline: OutlineView,
  kanban: KanbanView,
  slides: SlidesView,
  gantt: GanttView,
  traverse: TraverseView,
};

export { MindMapView, OutlineView };
export default PROJECTION_VIEWS;
