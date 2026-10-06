/**
 * 思维导图画布：SVG 渲染层 + 全部直接操纵（doc/复刻方案/00 §3.1、§5.1）。
 *
 * 三条不可让步的规则，决定了这个文件里所有看似啰嗦的写法：
 * 1. 坐标只来自 computeLayout（经 paintPage 转发），画布永不把布局结果写回 model —— P-2；
 * 2. 颜色 / 字号 / 折行 / 折叠徽标只从 paintPage 取，屏上所见与 SVG·PNG·PDF 导出必须同源，
 *    这里出现第二套取色逻辑就是复刻的破绽；
 * 3. 每一次改动都走 docStore.mutate(中文标签, 树原语)，撤销栈才不漏步。
 *
 * 编辑框用绝对定位的 <textarea> 覆盖层而不是 foreignObject：
 * 这张 SVG 会被整段序列化去导出，foreignObject 会跟着进文件，
 * 在 PDF/图片管线和本机看图软件里都是渲染事故。
 */
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LayoutCode, Page } from "../types/model.ts";
import { plainText } from "../types/model.ts";
import { DEFAULTS } from "../model/constants.ts";
import {
  cornerBadgePaths,
  labelChips,
  lineGap,
  paintPage,
  textStartY,
  type Paint,
  type ShapePaint,
} from "../engine/export/svg.ts";
import { fitView, quickBarAnchor } from "../engine/view.ts";
import type { NodeBox } from "../engine/layout.ts";
import {
  descendants,
  demote,
  insertChild,
  insertParent,
  insertSibling,
  moveShape,
  promote,
  removeShape,
  setCollapsed,
  swapSibling,
  siblingIndex,
  toggleCollapsed,
  updateText,
} from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { useUi } from "../stores/uiStore.ts";

export interface MindCanvasProps {
  page: Page;
}

type Dir = "left" | "right" | "up" | "down";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 拖拽落点：mode=child 表示"成为它的子主题"，mode=gap 表示"插在两主题之间"。 */
interface DropTarget extends Rect {
  mode: "child" | "gap";
  parentId: string;
  at: number | undefined;
}

const ACCENT = "#1677ff";
/** 命中主题上下沿多少像素算"插在中间"（世界坐标，缩放不影响判定）。 */
const GAP_BAND = 12;
/** 超过这个位移才认为用户在拖拽而不是点击。 */
const DRAG_SLOP = 4;
const NEW_TOPIC = "新建主题";

const VERTICAL_LAYOUTS: LayoutCode[] = [
  "treeRight",
  "treeLeft",
  "orgUp",
  "orgDown",
  "orgBoth",
  "matrix",
  "timelineVertical",
];

/** 子主题往下走的键向：水平布局看 side（左半树的子在左边），竖直布局一律向下。 */
function kidDirOf(side: number, vertical: boolean): Dir {
  if (vertical) return "down";
  return side === -1 ? "left" : "right";
}

function isVertical(code: LayoutCode): boolean {
  return VERTICAL_LAYOUTS.includes(code);
}

/** 与 buildSvg 同一条基线公式：屏上文字和导出文字错开一个像素都算 bug。 */
function topicLines(b: ShapePaint) {
  const lh = lineGap(b.fontSize);
  const startY = textStartY(b);
  return b.lines.map((line, ix) => (
    <text
      key={ix}
      x={b.x + b.w / 2}
      y={startY + ix * lh}
      fontSize={b.fontSize}
      fontFamily={b.fontFamily}
      fontWeight={b.bold ? "bold" : undefined}
      textAnchor="middle"
      fill={b.textColor}
      pointerEvents="none"
    >
      {line}
    </text>
  ));
}

function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

function idsInRect(paint: Paint, r: Rect): string[] {
  return paint.boxes
    .filter((b) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y)
    .map((b) => b.id);
}

/** 后画的在上层，命中测试要倒着走。skip 用来排除被拖节点自己的子树。 */
function hitBox(paint: Paint, x: number, y: number, skip: Set<string>): ShapePaint | null {
  for (let i = paint.boxes.length - 1; i >= 0; i -= 1) {
    const b = paint.boxes[i];
    if (skip.has(b.id)) continue;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
  }
  return null;
}

function dropTargetAt(
  page: Page,
  paint: Paint,
  draggedId: string,
  x: number,
  y: number
): DropTarget | null {
  const dragged = page.shapes[draggedId];
  if (!dragged) return null;
  const skip = new Set([draggedId, ...descendants(page, draggedId)]);
  const host = hitBox(paint, x, y, skip);
  if (!host) return null;
  const asChild = (): DropTarget => ({
    mode: "child",
    parentId: host.id,
    at: undefined,
    x: host.x,
    y: host.y,
    w: host.w,
    h: host.h,
  });
  // 中心主题没有兄弟，浮动主题的子树也没有"之间"可插，只能收为子主题
  const parentId = host.id === page.rootId ? null : (page.shapes[host.id]?.parentId ?? null);
  const atTop = y <= host.y + GAP_BAND;
  const atBottom = y >= host.y + host.h - GAP_BAND;
  if (!parentId || (!atTop && !atBottom)) return asChild();
  const sibs = page.shapes[parentId].childIds;
  const ix = sibs.indexOf(host.id);
  if (ix < 0) return asChild();
  const raw = atTop ? ix : ix + 1;
  // moveShape 先把节点从原父摘走再插入，同父时落点要前移一位才是眼睛看到的那个位置
  const old = dragged.parentId === parentId ? sibs.indexOf(draggedId) : -1;
  return {
    mode: "gap",
    parentId,
    at: old >= 0 && old < raw ? raw - 1 : raw,
    x: host.x - 6,
    y: atTop ? host.y : host.y + host.h,
    w: host.w + 12,
    h: 0,
  };
}

/**
 * 方向键的落点：先看语义（外侧=孩子、内侧=父），语义走不通再退回几何最近。
 * 只查布局结果不查树 —— 折叠和"显示层级数"裁掉的节点本来就不在画布上（§3.2）。
 */
function stepTarget(page: Page, paint: Paint, id: string, dir: Dir): string | null {
  const boxes = paint.layout.boxes;
  const cur = boxes[id];
  if (!cur) return null;
  const vertical = isVertical(page.layout.code);
  const toKids = kidDirOf(cur.side, vertical);
  const toParent: Dir = toKids === "down" ? "up" : toKids === "left" ? "right" : "left";
  if (dir === toKids) {
    const kid = page.shapes[id]?.childIds.find((c) => Boolean(boxes[c]));
    if (kid) return kid;
  }
  if (dir === toParent && cur.parentId && boxes[cur.parentId]) return cur.parentId;
  return nearestBox(boxes, cur, dir);
}

function nearestBox(boxes: Record<string, NodeBox>, cur: NodeBox, dir: Dir): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const b of Object.values(boxes)) {
    if (b.id === cur.id) continue;
    const dx = b.x - cur.x;
    const dy = b.y - cur.y;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    if (along <= 1) continue;
    // 横向偏移加倍罚分：先保证还在同一条带上，再比远近
    const cross = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = along + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = b.id;
    }
  }
  return best;
}

/** 往折叠节点里插新主题要先展开，否则用户会以为按了没反应。 */
function withOpenParent(page: Page, parentId: string): Page {
  return page.shapes[parentId]?.extras.collapsed ? setCollapsed(page, parentId, false) : page;
}

export function MindCanvas({ page }: MindCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const zoom = useUi((s) => s.zoom);
  const setZoom = useUi((s) => s.setZoom);
  const fitNonce = useUi((s) => s.fitNonce);
  const displayLevels = useUi((s) => s.displayLevels);
  const selection = useDoc((s) => s.selection);
  const editingId = useDoc((s) => s.editingId);
  const dragButton = useSettings((s) => s.settings.general.canvasDragButton);
  const wheelAt = useSettings((s) => s.settings.general.wheelZoom);
  const showQuickBar = useSettings((s) => s.settings.general.showQuickBar);
  const topicWidthMode = useSettings((s) => s.settings.format.topicWidthMode);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [draggingCanvas, setDraggingCanvas] = useState(false);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);

  // P-2：布局是算出来的。page 是整页快照，换指向就是唯一的失效信号；
  // 框宽模式不在 page 里（它是应用级设置），所以换模式也得重算，否则开关只在下一次编辑时才生效。
  const paint = useMemo(
    () => paintPage(page, { displayLevel: displayLevels, topicWidthMode }),
    [page, displayLevels, topicWidthMode]
  );
  const lineOf = useMemo(() => new Map(paint.boxes.map((b) => [b.id, b.line])), [paint]);
  const picked = useMemo(
    () => selection.filter((id) => Boolean(page.shapes[id])),
    [selection, page]
  );
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const editBox = useMemo(
    () => (editingId ? paint.boxes.find((b) => b.id === editingId) : undefined),
    [editingId, paint]
  );

  // window 上的监听器只挂一次，读值一律经过这里，避免闭包拿到旧的 page / pan。
  const live = useRef({ page, paint, zoom, pan, size, picked, dragButton, wheelAt });
  useLayoutEffect(() => {
    live.current = { page, paint, zoom, pan, size, picked, dragButton, wheelAt };
  });

  // ------------------------------------------------------------ 视口尺寸与居中
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 换页 / 第一次量出尺寸时把内容摆到视口中心；此后用户自己拖的位置不再被动。
  const centered = useRef<string | null>(null);
  useEffect(() => {
    const { size: s, paint: p, zoom: z } = live.current;
    if (!s.w || !s.h || centered.current === page.id) return;
    centered.current = page.id;
    setPan({
      x: s.w / 2 - (p.minX + p.width / 2) * z,
      y: s.h / 2 - (p.minY + p.height / 2) * z,
    });
  }, [size.w, size.h, page.id]);

  // ------------------------------------------------------------ 缩放
  // ctrl+wheel 自己算完 pan，其它来源（工具栏、步进按钮）改 zoom 时也要按住
  // 屏幕中心那个世界点不动，否则画面会越缩越偏。
  const zoomAnchor = useRef<{ sx: number; sy: number } | null>(null);
  const prevZoom = useRef(zoom);
  // 适应画布自己已经把 pan 算到位了，这一次 zoom 变化不能再按中心重算，否则会被拽偏。
  const fitted = useRef(false);
  useEffect(() => {
    const z0 = prevZoom.current;
    prevZoom.current = zoom;
    if (z0 === zoom) return;
    if (fitted.current) {
      fitted.current = false;
      return;
    }
    const { pan: p, size: s } = live.current;
    const a = zoomAnchor.current ?? { sx: s.w / 2, sy: s.h / 2 };
    zoomAnchor.current = null;
    setPan({ x: a.sx - ((a.sx - p.x) / z0) * zoom, y: a.sy - ((a.sy - p.y) / z0) * zoom });
  }, [zoom]);

  // ------------------------------------------------------------ 适应画布
  // 请求可能早于首次量到视口尺寸（打开文档时画布还没挂载），所以先记下"还欠一次适应"，
  // 等 size 到位再补上，否则这次请求会被静默丢掉。
  const fitWanted = useRef(false);
  useEffect(() => {
    if (fitNonce > 0) fitWanted.current = true;
    const { size: s, paint: p } = live.current;
    const fit = fitView({ w: s.w, h: s.h }, p);
    if (!fitWanted.current || !fit) return;
    fitWanted.current = false;
    fitted.current = true;
    setZoom(fit.zoom);
    setPan(fit.pan);
  }, [fitNonce, size.w, size.h, setZoom]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      // 不 preventDefault 的话浏览器会连页面缩放一起触发
      e.preventDefault();
      const { zoom: z, wheelAt: mode } = live.current;
      const factor = Math.exp(-e.deltaY * 0.0016);
      const next = Math.min(4, Math.max(0.25, z * factor));
      if (next === z) return;
      const r = el.getBoundingClientRect();
      zoomAnchor.current =
        mode === "center"
          ? { sx: r.width / 2, sy: r.height / 2 }
          : { sx: e.clientX - r.left, sy: e.clientY - r.top };
      useUi.getState().setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ------------------------------------------------------------ 就地改文字
  useEffect(() => {
    if (!editingId) {
      setDraft(null);
      return;
    }
    const s = live.current.page.shapes[editingId];
    // 依赖里不放 page：编辑期间任何整页快照变化都不该把用户正在敲的字冲掉
    setDraft(s ? { id: editingId, text: plainText(s.text) } : null);
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(0, el.value.length);
    }
  }, [editingId]);

  const closeEditor = () => useDoc.getState().setEditing(null);

  const commitEditor = () => {
    const doc = useDoc.getState();
    const id = draft?.id;
    const text = draft?.text;
    if (!id || text === undefined) return;
    const cur = doc.hist ? live.current.page.shapes[id] : undefined;
    if (cur && plainText(cur.text) !== text)
      doc.mutate("修改主题文字", (p) => updateText(p, id, text));
    setDraft(null);
    doc.setEditing(null);
  };

  // ------------------------------------------------------------ 指针：平移 / 框选 / 拖主题
  const track = (move: (e: PointerEvent) => void, up: (e: PointerEvent | null) => void) => {
    const onMove = (e: PointerEvent) => move(e);
    const end = (e: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      up(e);
    };
    const onEnd = (e: PointerEvent) => end(e);
    // 指针被系统抢走（切窗口、触控手势接管）时中止手势：没有落点，就一律不改选区
    const onCancel = () => end(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onCancel);
  };

  /** 屏幕坐标 → 世界坐标（= 布局坐标系）。 */
  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    const { pan: p, zoom: z } = live.current;
    const sx = cx - (r?.left ?? 0);
    const sy = cy - (r?.top ?? 0);
    return { sx, sy, x: (sx - p.x) / z, y: (sy - p.y) / z };
  };

  const startPan = (e: ReactPointerEvent) => {
    const from = { x: e.clientX, y: e.clientY };
    const base = live.current.pan;
    setDraggingCanvas(true);
    track(
      (ev) => setPan({ x: base.x + ev.clientX - from.x, y: base.y + ev.clientY - from.y }),
      () => setDraggingCanvas(false)
    );
  };

  const startMarquee = (e: ReactPointerEvent) => {
    const a = toWorld(e.clientX, e.clientY);
    let boxed = false;
    track(
      (ev) => {
        const b = toWorld(ev.clientX, ev.clientY);
        if (!boxed && Math.hypot(b.sx - a.sx, b.sy - a.sy) < DRAG_SLOP) return;
        boxed = true;
        setMarquee(normRect(a.x, a.y, b.x, b.y));
      },
      (ev) => {
        setMarquee(null);
        const doc = useDoc.getState();
        if (!ev) return;
        if (!boxed) {
          // 空处单击 = 取消选中，和亿图一致
          doc.select([]);
          return;
        }
        const b = toWorld(ev.clientX, ev.clientY);
        const ids = idsInRect(live.current.paint, normRect(a.x, a.y, b.x, b.y));
        doc.select(ev.shiftKey ? Array.from(new Set([...live.current.picked, ...ids])) : ids);
      }
    );
  };

  const dragTopic = (e: ReactPointerEvent, id: string) => {
    const from = { x: e.clientX, y: e.clientY };
    let moving = false;
    let target: DropTarget | null = null;
    track(
      (ev) => {
        if (!moving && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_SLOP) return;
        moving = true;
        const w = toWorld(ev.clientX, ev.clientY);
        target = dropTargetAt(live.current.page, live.current.paint, id, w.x, w.y);
        setDrop(target);
      },
      () => {
        setDrop(null);
        if (!moving) return;
        // 移进自己子树这种非法落点由 moveShape 自己拒绝，这里只负责不崩
        const t: DropTarget | null = target;
        if (t) useDoc.getState().mutate("移动主题", (p) => moveShape(p, id, t.parentId, t.at));
      }
    );
  };

  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    const panning =
      (e.button === 0 && live.current.dragButton === "left") ||
      (e.button === 2 && live.current.dragButton === "right");
    if (panning) {
      startPan(e);
      return;
    }
    if (e.button === 0) startMarquee(e);
  };

  const onTopicPointerDown = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return; // 右键继续冒泡给画布，走平移
    e.stopPropagation();
    const doc = useDoc.getState();
    const sel = live.current.picked;
    if (e.shiftKey) {
      doc.select(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
      return;
    }
    // 已经在多选里就保留整组，只有点空手才把选区收到这一个
    if (!sel.includes(id)) doc.select([id], id);
    dragTopic(e, id);
  };

  const onTopicDoubleClick = (id: string) => {
    const doc = useDoc.getState();
    doc.select([id], id);
    doc.setEditing(id);
  };

  const toggleFold = (id: string) => {
    const doc = useDoc.getState();
    if (!doc.hist) return;
    const label = live.current.page.shapes[id]?.extras.collapsed ? "展开分支" : "折叠分支";
    doc.mutate(label, (p) => toggleCollapsed(p, id));
  };

  // 键盘和快捷操作条共用同一批操作。两条入口各写一份 mutate，
  // 撤销栈里就会出现"新建子主题"和"添加子主题"两种标签，用户按一次撤销只退一半。
  const addChild = (id: string) => {
    const doc = useDoc.getState();
    if (!doc.hist) return;
    let newId = "";
    doc.mutate("新建子主题", (p) => {
      const r = insertChild(withOpenParent(p, id), id, NEW_TOPIC);
      newId = r.id;
      return r.page;
    });
    if (newId) doc.select([newId], newId);
  };

  const addSibling = (id: string, before: boolean) => {
    const doc = useDoc.getState();
    if (!doc.hist) return;
    const parent = live.current.page.shapes[id]?.parentId ?? id;
    let newId = "";
    doc.mutate("新建同级主题", (p) => {
      const r = insertSibling(
        withOpenParent(p, parent),
        id,
        before ? "before" : "after",
        NEW_TOPIC
      );
      newId = r.id;
      return r.page;
    });
    if (newId) doc.select([newId], newId);
  };

  const removeTopics = (ids: string[]) => {
    const doc = useDoc.getState();
    const pg = live.current.page;
    if (!doc.hist) return;
    const doomed = ids.filter((id) => Boolean(pg.shapes[id]?.parentId));
    if (!doomed.length) return; // 中心主题不可删（removeShape 也会拒）
    const gone = new Set(doomed);
    let back: string | null = pg.shapes[doomed[0]]?.parentId ?? null;
    while (back && gone.has(back)) back = pg.shapes[back]?.parentId ?? null;
    doc.mutate("删除主题", (p) => doomed.reduce((q, id) => removeShape(q, id), p));
    doc.select([back ?? pg.rootId], back ?? pg.rootId);
  };

  // ------------------------------------------------------------ 键盘（§3.1 第一公民）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (useUi.getState().dialog) return;
      const doc = useDoc.getState();
      if (!doc.hist) return;
      const { page: pg, paint: pt, picked: sel } = live.current;
      const ctrl = e.ctrlKey || e.metaKey;
      const alt = e.altKey;
      const anchor = sel.find((id) => Boolean(pg.shapes[id])) ?? pg.rootId;

      // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 不在这里处理：那是 App 通过 shortcuts 注册表
      // 统一派发的应用级命令。画布再抢一份，两个 window 监听器就会一次按撤两步。
      if (ctrl && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        doc.select(pt.boxes.map((b) => b.id));
        return;
      }
      if (e.key === "Escape") {
        if (sel.length) doc.select([]);
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        doc.setEditing(anchor);
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        toggleFold(anchor);
        return;
      }
      if (e.shiftKey && e.key === "Insert") {
        e.preventDefault();
        let newId = "";
        doc.mutate("新建父主题", (p) => {
          const r = insertParent(p, anchor);
          newId = r.id;
          return r.page;
        });
        if (newId) doc.select([newId], newId);
        return;
      }
      // §3.1：Tab / Insert / Ctrl+Enter 三个键都是"插入子主题"
      const wantChild =
        e.key === "Insert" || (e.key === "Tab" && !ctrl) || (e.key === "Enter" && ctrl);
      if (wantChild) {
        e.preventDefault();
        addChild(anchor);
        return;
      }
      if (e.key === "Enter" && !ctrl) {
        e.preventDefault();
        addSibling(anchor, e.shiftKey);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!sel.some((id) => Boolean(pg.shapes[id]?.parentId))) return;
        e.preventDefault();
        removeTopics(sel);
        return;
      }
      if (alt && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const dir: -1 | 1 = e.key === "ArrowUp" ? -1 : 1;
        doc.mutate(dir === -1 ? "上移主题" : "下移主题", (p) => swapSibling(p, anchor, dir));
        return;
      }
      if (alt && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        // 升降级按"离中心更远 = 更深"判定：左半树的孩子长在左边，方向要反过来
        const outward = (pt.layout.boxes[anchor]?.side ?? 1) === -1 ? "ArrowLeft" : "ArrowRight";
        const down = e.key === outward;
        const parent = pg.shapes[anchor]?.parentId;
        // demote / promote 自己会拒绝不可能的情况，这里先判一次，免得往撤销栈里塞空步
        if (!(down ? siblingIndex(pg, anchor) > 0 : Boolean(parent && pg.shapes[parent]?.parentId)))
          return;
        doc.mutate(
          down ? "降级主题" : "升级主题",
          (p) => (down ? demote(p, anchor) : promote(p, anchor)).page
        );
        return;
      }
      const dirKey: Dir | undefined =
        e.key === "ArrowLeft"
          ? "left"
          : e.key === "ArrowRight"
            ? "right"
            : e.key === "ArrowUp"
              ? "up"
              : e.key === "ArrowDown"
                ? "down"
                : undefined;
      if (dirKey) {
        e.preventDefault();
        const to = stepTarget(pg, pt, anchor, dirKey);
        if (to) doc.select([to], to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ------------------------------------------------------------ 渲染
  const cursor = draggingCanvas ? "grabbing" : dragButton === "left" ? "grab" : "crosshair";
  const rxOf = (b: ShapePaint) => Math.min(b.rounding, b.w / 2, b.h / 2);

  // ---------------------------------------------------------- 快捷操作条（§3.1）
  // 只在"单选、没在打字、没在拖"时出现：多选时这五个动作会一次作用在几十个主题上，
  // 太容易失手；编辑中让位给输入框。
  const barTarget =
    showQuickBar && !editingId && !drop && picked.length === 1
      ? paint.boxes.find((b) => b.id === picked[0])
      : undefined;
  const barShape = barTarget ? page.shapes[barTarget.id] : undefined;
  const barBtns: { k: string; label: string; tip: string; run: () => void }[] = [];
  if (barShape) {
    const id = barShape.id;
    barBtns.push({
      k: "child",
      label: "子主题",
      tip: "插入子主题（Tab）",
      run: () => addChild(id),
    });
    barBtns.push({
      k: "sibling",
      label: "同级",
      tip: "插入同级主题（Enter）",
      run: () => addSibling(id, false),
    });
    if (barShape.childIds.length)
      barBtns.push({
        k: "fold",
        label: barShape.extras.collapsed ? "展开" : "折叠",
        tip: "折叠 / 展开这条分支（F4）",
        run: () => toggleFold(id),
      });
    if (barShape.parentId)
      barBtns.push({
        k: "del",
        label: "删除",
        tip: "删除这个主题及其分支（Delete）",
        run: () => removeTopics([id]),
      });
    barBtns.push({
      k: "note",
      label: "附注",
      tip: "备注与超链接",
      run: () => useUi.getState().openDialog("topicInfo"),
    });
    barBtns.push({
      k: "edit",
      label: "改名",
      tip: "编辑文字（F2 或双击）",
      run: () => useDoc.getState().setEditing(id),
    });
  }
  // 宽度按"中文字 12px + 左右内边距"估：条子居中偏几个像素不要紧，滑出视口才要紧。
  const barW = barBtns.reduce((n, b) => n + b.label.length * 12 + 16, 4) + (barBtns.length - 1) * 4;
  const barAt = barTarget
    ? quickBarAnchor(
        {
          left: pan.x + barTarget.x * zoom,
          top: pan.y + barTarget.y * zoom,
          width: barTarget.w * zoom,
          height: barTarget.h * zoom,
        },
        size,
        { w: barW, h: 28 }
      )
    : null;

  return (
    <div
      ref={wrapRef}
      // 右键是画布平移键，浏览器的菜单会把拖拽打断
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: 240,
        minHeight: 200,
        overflow: "hidden",
        background: paint.background,
        cursor,
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ display: "block" }}
        onPointerDown={onCanvasPointerDown}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          <g fill="none" strokeLinecap="round">
            {paint.connectors.map((c) => (
              <path
                key={c.id}
                d={c.d}
                stroke={lineOf.get(c.toId) ?? DEFAULTS.lineColor}
                strokeWidth={1.6}
              />
            ))}
          </g>

          {paint.boxes.map((b) => (
            <g
              key={b.id}
              style={{ cursor: "pointer" }}
              onPointerDown={(e) => onTopicPointerDown(e, b.id)}
              onDoubleClick={() => onTopicDoubleClick(b.id)}
            >
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={rxOf(b)}
                fill={b.fill}
                stroke={b.line}
                strokeWidth={b.lineWidth}
              />
              {b.id !== editingId && topicLines(b)}
              {cornerBadgePaths(b).map((d, i) => (
                <path
                  key={`badge-${i}`}
                  d={d}
                  fill="none"
                  stroke={b.line}
                  strokeWidth={1}
                  pointerEvents="none"
                />
              ))}
              {labelChips(b).map((c, i) => (
                <g key={`label-${i}`} pointerEvents="none">
                  <rect
                    x={c.x}
                    y={c.y}
                    width={c.w}
                    height={c.h}
                    rx={2}
                    fill="none"
                    stroke={b.line}
                    strokeWidth={1}
                  />
                  <text
                    x={c.x + c.w / 2}
                    y={c.y + c.h / 2 + b.fontSize * 0.24}
                    fontSize={b.fontSize * 0.68}
                    textAnchor="middle"
                    fill={b.textColor}
                  >
                    {c.text}
                  </text>
                </g>
              ))}
              {b.hiddenCount > 0 && (
                <g
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFold(b.id);
                  }}
                >
                  <circle
                    cx={b.x + b.w - 6}
                    cy={b.y + b.h - 6}
                    r={7}
                    fill="#ffffff"
                    stroke={b.line}
                  />
                  <text
                    x={b.x + b.w - 6}
                    y={b.y + b.h - 2.5}
                    fontSize={8}
                    textAnchor="middle"
                    fill={b.line}
                    pointerEvents="none"
                  >
                    {b.hiddenCount}
                  </text>
                </g>
              )}
            </g>
          ))}

          {paint.boxes
            .filter((b) => pickedSet.has(b.id))
            .map((b) => (
              // 线宽除以 zoom：选中框在 25% 和 400% 下看起来一样粗
              <rect
                key={`pick-${b.id}`}
                x={b.x - 3}
                y={b.y - 3}
                width={b.w + 6}
                height={b.h + 6}
                rx={rxOf(b) + 3}
                fill="none"
                stroke={ACCENT}
                strokeWidth={1.4 / zoom}
                strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                pointerEvents="none"
              />
            ))}

          {drop &&
            (drop.mode === "child" ? (
              <rect
                x={drop.x - 4}
                y={drop.y - 4}
                width={drop.w + 8}
                height={drop.h + 8}
                rx={8}
                fill="none"
                stroke={ACCENT}
                strokeWidth={2 / zoom}
                pointerEvents="none"
              />
            ) : (
              <g pointerEvents="none">
                <line
                  x1={drop.x}
                  y1={drop.y}
                  x2={drop.x + drop.w}
                  y2={drop.y}
                  stroke={ACCENT}
                  strokeWidth={2.5 / zoom}
                  strokeLinecap="round"
                />
                <circle cx={drop.x} cy={drop.y} r={3 / zoom} fill={ACCENT} />
              </g>
            ))}

          {marquee && (
            <rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              fill={ACCENT}
              fillOpacity={0.08}
              stroke={ACCENT}
              strokeWidth={1 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>

      {barAt && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            left: barAt.left,
            top: barAt.top,
            display: "flex",
            gap: 4,
            height: 28,
            padding: "0 2px",
            boxSizing: "border-box",
            background: "#ffffff",
            border: "1px solid #d9d9d9",
            borderRadius: 6,
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            alignItems: "center",
            cursor: "default",
          }}
        >
          {barBtns.map((b) => (
            <button
              key={b.k}
              type="button"
              title={b.tip}
              onClick={b.run}
              style={{
                border: 0,
                background: "transparent",
                padding: "0 8px",
                height: 26,
                fontSize: 12,
                lineHeight: "26px",
                color: "#333333",
                borderRadius: 5,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {editingId && editBox && (
        <textarea
          ref={inputRef}
          value={
            draft && draft.id === editingId ? draft.text : plainText(page.shapes[editingId].text)
          }
          onChange={(e) => setDraft({ id: editingId, text: e.target.value })}
          onBlur={commitEditor}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
              closeEditor();
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              commitEditor();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          spellCheck={false}
          style={{
            position: "absolute",
            left: pan.x + editBox.x * zoom,
            top: pan.y + editBox.y * zoom,
            width: editBox.w * zoom,
            height: editBox.h * zoom,
            padding: `${DEFAULTS.topicPadY * zoom}px ${DEFAULTS.topicPadX * zoom}px`,
            boxSizing: "border-box",
            border: `1px solid ${ACCENT}`,
            borderRadius: rxOf(editBox) * zoom,
            background: editBox.fill,
            color: editBox.textColor,
            // 字号/行高/字体全部沿用 paint 的输出，输入框和它替换的那段文字要严丝合缝
            fontFamily: editBox.fontFamily,
            fontSize: editBox.fontSize * zoom,
            lineHeight: `${editBox.fontSize * 1.35 * zoom}px`,
            fontWeight: editBox.bold ? "bold" : "normal",
            textAlign: "center",
            resize: "none",
            overflow: "hidden",
            outline: "none",
            userSelect: "text",
          }}
        />
      )}
    </div>
  );
}

export default MindCanvas;
