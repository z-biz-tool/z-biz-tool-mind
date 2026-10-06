import { DEFAULT_THEME, DEFAULTS, QUOTA } from "./constants.ts";
import { LAYOUT_CODE_TO_NAME } from "../types/model.ts";
import type {
  DocProperties,
  DocumentModel,
  GanttOption,
  LayoutCode,
  Page,
  Shape,
  ShapeType,
} from "../types/model.ts";
import { makeText } from "../types/model.ts";

/** id 用数字串，和 .emmx 的 `ID="101"` 同构，避免导出时再做一次映射。 */
export function nextShapeId(page: Page): string {
  let max = Math.max(DEFAULTS.shapeIdBase - 1, page.maxShapeId ?? 0);
  for (const id of Object.keys(page.shapes)) {
    const n = Number(id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  // 关系线在 .emmx 里同样是 Shape，占同一个号段：只看 shapes 会给新主题发出和关系线重复的 ID。
  for (const r of page.relationships) {
    const n = Number(r.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

export function createShape(
  id: string,
  type: ShapeType,
  text: string,
  parentId: string | null
): Shape {
  return {
    id,
    type,
    parentId,
    childIds: [],
    text: makeText(text),
    transform: { x: 0, y: 0, w: 0, h: 0 },
    style: {},
    extras: {},
    floating: type === "Floating",
  };
}

/** 主题类型由"层级 + 是否浮动"决定，而不是用户选：中心 1 个，一级是 MainTopic，更深是 SubTopic。 */
export function topicTypeFor(level: number, floating: boolean): ShapeType {
  if (floating) return "Floating";
  if (level === 0) return "MainIdea";
  if (level === 1) return "MainTopic";
  return "SubTopic";
}

export function createPage(name: string, code: LayoutCode = "balanced"): Page {
  const rootId = String(DEFAULTS.shapeIdBase);
  const root = createShape(rootId, "MainIdea", "中心主题", null);
  return {
    id: String(DEFAULTS.pageIdBase),
    name,
    rootId,
    shapes: { [rootId]: root },
    relationships: [],
    layout: {
      code,
      hSpacing: DEFAULTS.hSpacing,
      vSpacing: DEFAULTS.vSpacing,
      levelLength: [],
      branchCount: [],
      rainbow: false,
    },
    props: {
      width: DEFAULTS.pageW,
      height: DEFAULTS.pageH,
      scrollX: 0.5,
      scrollY: 0.5,
      zoom: DEFAULTS.zoom,
    },
    print: {
      unit: "mm",
      paperW: 210,
      paperH: 297,
      marginTop: 10,
      marginRight: 10,
      marginBottom: 10,
      marginLeft: 10,
      fitToSheet: true,
      printBackground: true,
    },
    theme: { ...DEFAULT_THEME },
  };
}

export function createDocument(title = "未命名", code: LayoutCode = "balanced"): DocumentModel {
  const now = formatStamp(new Date());
  return {
    properties: {
      version: DEFAULTS.emmxVersion,
      docGuid: `{${randomGuid()}}`,
      creator: "",
      modifier: "",
      createdDate: now,
      modifiedDate: now,
      platform: currentPlatform(),
      dpi: 1,
      screenWidth: 1920,
      screenHeight: 1080,
      autoLayout: true,
      timelineWidth: 1000,
      calloutLayout: 1,
    },
    pages: [createPage(title, code)],
    activePageId: String(DEFAULTS.pageIdBase),
    gantt: {
      workDay: [...DEFAULTS.ganttWorkDay],
      majorTick: 3,
      minorTick: 0,
      startDate: 0,
      finishDate: 0,
      startTime: DEFAULTS.ganttStartTime,
      finishTime: DEFAULTS.ganttFinishTime,
      unitWidth: DEFAULTS.ganttUnitWidth,
    },
    markSheet: [],
    media: {},
  };
}

export function activePage(doc: DocumentModel): Page {
  return doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0];
}

export function withActivePage(doc: DocumentModel, page: Page): DocumentModel {
  return { ...doc, pages: doc.pages.map((p) => (p.id === page.id ? page : p)) };
}

/** Page / Document 都是纯数据（media 是 Uint8Array，structuredClone 认得），直接用引擎级深拷贝。 */
export function clonePage(page: Page): Page {
  return structuredClone(page);
}

export function cloneDocument(doc: DocumentModel): DocumentModel {
  return structuredClone(doc);
}

export function pageCountGuard(count: number, paid: boolean): { ok: boolean; reason?: string } {
  if (paid) return { ok: true };
  if (count >= QUOTA.freeMaxFiles) {
    return {
      ok: false,
      reason: `免费版本可保存最大文件个数为${QUOTA.freeMaxFiles}个文件`,
    };
  }
  return { ok: true };
}

export function layoutCodeFromNumber(n: number): LayoutCode {
  return LAYOUT_CODE_TO_NAME[n] ?? "balanced";
}

export function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

function randomGuid(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
}

export function currentPlatform(): DocProperties["platform"] {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("windows")) return "win";
  return "web";
}

export function newGanttOption(): GanttOption {
  return {
    workDay: [...DEFAULTS.ganttWorkDay],
    majorTick: 3,
    minorTick: 0,
    startDate: 0,
    finishDate: 0,
    startTime: DEFAULTS.ganttStartTime,
    finishTime: DEFAULTS.ganttFinishTime,
    unitWidth: DEFAULTS.ganttUnitWidth,
  };
}
