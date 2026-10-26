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
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { App as AntdApp } from "antd";
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
import { TABLE_LAYOUTS } from "../engine/layout.ts";
import type { NodeBox } from "../engine/layout.ts";
import {
  descendants,
  demote,
  insertChild,
  insertParent,
  insertSibling,
  moveShape,
  promote,
  removeOverlay,
  removeShape,
  resetBranch,
  setCollapsed,
  setFloating,
  setRelationshipText,
  shiftBranch,
  swapSibling,
  siblingIndex,
  relationshipBetween,
  toggleCollapsed,
  toggleRelationship,
  updateText,
  updateTransform,
  addBoundary,
  addCallout,
  addSummary,
} from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { usePalette } from "../stores/usePalette.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { shortcutLabel } from "../utils/shortcuts.ts";
import { keepActions, type MenuAction } from "./menuActions.ts";

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

/**
 * 拖拽落点：mode=child 表示"成为它的子主题"，mode=gap 表示"插在两主题之间"，
 * mode=move 表示"搬到这儿"（x/y 是新盒子左上角）—— 能落到空白处的只有浮动根、
 * 自由布局里的主题，和智慧版式里被整枝拖开的二级主题（后两者见 §3.3）。
 */
interface DropTarget extends Rect {
  mode: "child" | "gap" | "move";
  parentId: string;
  at: number | undefined;
}

/**
 * 右键菜单的落点。
 *
 * 屏幕坐标（sx/sy）用来摆菜单，世界坐标（x/y）用来在正确的位置新建自由主题 ——
 * 菜单是钉在点击处的那个"点"上的，画布平移之后那个点已经不是原来的内容了。
 */
interface MenuAt {
  sx: number;
  sy: number;
  x: number;
  y: number;
  /** 点在空白画布上：只有这时才给"新建自由主题"。 */
  onEmpty: boolean;
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
  "treeUpRight",
  "treeUpLeft",
  "treeDownSym",
  "treeUpSym",
  "orgUp",
  "orgDown",
  "orgBoth",
  "balancedDown",
  "stagger",
  "staggerUp",
  "matrix",
  "timelineVertical",
  "timelineUp",
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
  const { modal } = AntdApp.useApp();
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const zoom = useUi((s) => s.zoom);
  const setZoom = useUi((s) => s.setZoom);
  const fitNonce = useUi((s) => s.fitNonce);
  const displayLevels = useUi((s) => s.displayLevels);
  // 关系线"打开时自动展开"的揭示表：只影响绘制，模型不动（uiStore 的注释里有来龙去脉）。
  const reveal = useUi((s) => s.revealByPage[page.id]);
  const aiBusy = useUi((s) => s.aiBusy);
  const selection = useDoc((s) => s.selection);
  const editingId = useDoc((s) => s.editingId);
  const dragButton = useSettings((s) => s.settings.general.canvasDragButton);
  const wheelAt = useSettings((s) => s.settings.general.wheelZoom);
  const showQuickBar = useSettings((s) => s.settings.general.showQuickBar);
  const topicWidthMode = useSettings((s) => s.settings.format.topicWidthMode);
  const menuEnabled = useSettings((s) => s.settings.rightMenu.enabled);
  // 色板由文档自己说话（theme.xml 的 ColorScheme），不是写死的那十色。
  // 画布与导出/打印必须同一个来源，否则"屏幕上对、导出的图换色"这种分叉只能靠肉眼发现。
  const palette = usePalette();

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [draggingCanvas, setDraggingCanvas] = useState(false);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  // 关系线标注的临时草稿：只在回车或失焦时进撤销栈，边打字边改会把栈撑满
  const [relDraft, setRelDraft] = useState<{ id: string; text: string } | null>(null);
  // 右键菜单：整张画布同时只该有一个，所以状态放在这里而不是每个主题上
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // 右键拖动（画布平移）结束时不该弹菜单：Windows 在拖完之后照样发 contextmenu。
  const panDragged = useRef(false);
  // 按下落在菜单自己身上时不能先收菜单，否则条目永远点不着（见 onWrapPointerDown）
  const menuRef = useRef<HTMLDivElement>(null);

  // 拖动中的那一枝（§1.3-12）：位移只进这一帧的 paint，松手才写进 model，
  // 所以拖动过程中整枝（含连线）跟着手走，而不是画一个虚框告诉用户"大概落这儿"。
  const [liveBranch, setLiveBranch] = useState<{ id: string; x: number; y: number } | null>(null);
  // P-2：布局是算出来的。page 是整页快照，换指向就是唯一的失效信号；
  // 框宽模式不在 page 里（它是应用级设置），所以换模式也得重算，否则开关只在下一次编辑时才生效。
  const paint = useMemo(
    () =>
      paintPage(page, {
        displayLevel: displayLevels,
        topicWidthMode,
        liveBranch: liveBranch ?? undefined,
        palette,
        reveal,
      }),
    [page, displayLevels, topicWidthMode, liveBranch, palette, reveal]
  );
  const lineOf = useMemo(() => new Map(paint.boxes.map((b) => [b.id, b.line])), [paint]);
  const axis = paint.layout.axis;
  const grid = paint.layout.grid;
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
      (ev) => {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) >= DRAG_SLOP) {
          panDragged.current = true;
        }
        setPan({ x: base.x + ev.clientX - from.x, y: base.y + ev.clientY - from.y });
      },
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
    const start = toWorld(from.x, from.y);
    const dragged = live.current.page.shapes[id];
    const freeLayout = live.current.page.layout.code === "free";
    // 位置归用户的有三种：自由布局（整张图都不重算）、浮动根（P-2 的例外），
    // 以及智慧版式里的二级主题 —— 后者挪的是"整枝"，落点在 Shape.offset 上而不是 transform（§3.3）。
    // 落在别的主题上仍然走"挂上去"；三级往上的主题拖了也白拖，枝内结构归引擎。
    // 树形表格里格线是硬边界：把一整枝拖开会让格子和线对不上，引擎那边同样不叠位移。
    const branchDrag =
      !freeLayout &&
      !TABLE_LAYOUTS.includes(live.current.page.layout.code) &&
      Boolean(dragged) &&
      !dragged?.floating &&
      dragged?.parentId === live.current.page.rootId;
    const ownBox =
      dragged && (freeLayout || (dragged.floating && !dragged.parentId))
        ? live.current.paint.boxes.find((b) => b.id === id)
        : undefined;
    let moving = false;
    let target: DropTarget | null = null;
    // 分支拖动期间的实时位移，每帧都更新；松手时只有"没落到别的主题上"才写进 model
    let shift: { x: number; y: number } | null = null;
    track(
      (ev) => {
        if (!moving && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_SLOP) return;
        moving = true;
        const w = toWorld(ev.clientX, ev.clientY);
        target = dropTargetAt(live.current.page, live.current.paint, id, w.x, w.y);
        if (branchDrag) {
          // 命中别的主题时也要继续跟：一出现挂树预览就把整枝弹回原位，
          // 拖过邻居那一格会亮一下、枝也退一下，手和框脱节（真机量到过：6 步里第 2、3 步整枝没动）。
          shift = { x: Math.round(w.x - start.x), y: Math.round(w.y - start.y) };
          setLiveBranch({ id, x: shift.x, y: shift.y });
        }
        if (!target && ownBox) {
          target = {
            mode: "move",
            parentId: id,
            at: undefined,
            x: ownBox.x + (w.x - start.x),
            y: ownBox.y + (w.y - start.y),
            w: ownBox.w,
            h: ownBox.h,
          };
        }
        setDrop(target);
      },
      () => {
        setDrop(null);
        setLiveBranch(null);
        if (!moving) return;
        if (branchDrag) {
          // 拖的是整枝：位移记在二级主题上，枝内还是引擎的相对结构（§3.3）。
          if (!target && shift && (shift.x || shift.y)) {
            const d = shift;
            useDoc.getState().mutate("移动分支", (p) => shiftBranch(p, id, d.x, d.y));
          }
          if (!target) return;
        }
        const t: DropTarget | null = target;
        if (!t) return;
        if (t.mode === "move") {
          // 落点盒子是左上角，transform 存的是中心（布局与 .emmx 的 CX/CY 同一个约定）；
          // 不换算的话每拖一次就往左上偏半个盒子。取整：亚像素坐标存进文件只是噪声。
          const x = Math.round(t.x + t.w / 2);
          const y = Math.round(t.y + t.h / 2);
          useDoc
            .getState()
            .mutate(freeLayout ? "移动主题" : "移动浮动主题", (p) =>
              updateTransform(p, id, { x, y })
            );
          return;
        }
        // 移进自己子树这种非法落点由 moveShape 自己拒绝，这里只负责不崩
        useDoc.getState().mutate("移动主题", (p) => moveShape(p, id, t.parentId, t.at));
      }
    );
  };

  /**
   * 收菜单放在外壳的捕获阶段，而不是画布的 pointerdown 里：
   * 点在主题上时主题的 pointerdown 要 stopPropagation（它得自己起拖拽），事件根本冒泡不到画布，
   * 菜单就钉在原地不动了 —— 而"点哪儿都该关掉它"是右键菜单唯一的收起契约。
   *
   * 菜单自己身上的按下要放行，交给条目的 onClick 去收：这里抢先卸载节点，
   * 浏览器就把随后的 click 派到共同祖先上，表现是"菜单点什么都没反应"。
   */
  const onWrapPointerDown = (e: ReactPointerEvent) => {
    if (menuRef.current?.contains(e.target as Node)) return;
    setMenu(null);
    panDragged.current = false;
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

  /** 右键：自己弹菜单，浏览器的原生菜单永远不该出现（它会把右键平移打断）。 */
  const onCanvasContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (panDragged.current) return;
    const w = toWorld(e.clientX, e.clientY);
    const hit = hitBox(live.current.paint, w.x, w.y, new Set());
    // 右键点在一个没选中的主题上 = 把它单独选中；已经在多选里就保留整组（亿图也是这个规矩）。
    if (hit && !live.current.picked.includes(hit.id)) useDoc.getState().select([hit.id], hit.id);
    setMenu({
      sx: Math.round(w.sx),
      sy: Math.round(w.sy),
      x: w.x,
      y: w.y,
      onEmpty: !hit,
    });
  };

  /** 新建自由主题：先按普通子主题插进树，再立刻摘出来浮动 —— 复用同一批原语，不另写一套建形状的代码。 */
  const addFloatingAt = (x: number, y: number) => {
    const doc = useDoc.getState();
    if (!doc.hist) return;
    let newId = "";
    doc.mutate("新建自由主题", (p) => {
      const r = insertChild(p, p.rootId, NEW_TOPIC);
      newId = r.id;
      return setFloating(r.page, r.id, x, y, true);
    });
    if (newId) doc.select([newId], newId);
  };

  // 菜单开着时 Escape 收掉它。capture 阶段拦下，免得同一次 Escape 又去关掉外层对话框。
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

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
    const collapsing = !live.current.page.shapes[id]?.extras.collapsed;
    const label = collapsing ? "折叠分支" : "展开分支";
    doc.mutate(label, (p) => toggleCollapsed(p, id));
    // 揭示表里的 id 在绘制上永远当展开算：手动折叠的那一下要把它摘掉，用户才有真折叠可用。
    if (collapsing) useUi.getState().removeReveal(live.current.page.id, id);
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

  const deleteTopics = (ids: string[]) => {
    const doc = useDoc.getState();
    const pg = live.current.page;
    if (!doc.hist) return;
    // 覆盖层没有 parentId：走 removeShape 会和"中心主题不可删"一起被拒掉，得先分出去
    const layers = ids.filter((id) =>
      ["Callout", "Boundary", "Summary"].includes(pg.shapes[id]?.type ?? "")
    );
    // 浮动主题根也没有 parentId，但它是用户建的，不属于"中心主题不可删"那一档
    const doomed = ids.filter((id) => {
      const sh = pg.shapes[id];
      return Boolean(sh?.parentId) || Boolean(sh?.floating);
    });
    if (!doomed.length && !layers.length) return; // 中心主题不可删（removeShape 也会拒）
    const gone = new Set([...doomed, ...layers]);
    let back: string | null = pg.shapes[doomed[0]]?.parentId ?? null;
    while (back && gone.has(back)) back = pg.shapes[back]?.parentId ?? null;
    doc.mutate(layers.length && !doomed.length ? "删除覆盖层" : "删除主题", (p) =>
      layers.reduce(
        (q, id) => removeOverlay(q, id),
        doomed.reduce((q, id) => removeShape(q, id), p)
      )
    );
    doc.select([back ?? pg.rootId], back ?? pg.rootId);
  };

  /**
   * 删除前的取舍：单颗叶子主题是编辑主循环（Delete 一键删、撤销一步就回来），再弹一次框
   * 只会拖慢打字；会连带带走看不见的东西 —— 整枝子树、多选、成组的覆盖层 —— 才值得打断。
   */
  const removeTopics = (ids: string[]) => {
    const pg = live.current.page;
    if (!useDoc.getState().hist) return;
    const layers = ids.filter((id) =>
      ["Callout", "Boundary", "Summary"].includes(pg.shapes[id]?.type ?? "")
    );
    const doomed = ids.filter((id) => {
      const sh = pg.shapes[id];
      return Boolean(sh?.parentId) || Boolean(sh?.floating);
    });
    if (!doomed.length && !layers.length) return;
    const risky =
      doomed.length > 1 ||
      layers.length > 0 ||
      doomed.some((id) => (pg.shapes[id]?.childIds.length ?? 0) > 0);
    if (!risky) {
      deleteTopics(ids);
      return;
    }
    const removed = new Set<string>();
    for (const id of [...doomed, ...layers]) {
      removed.add(id);
      for (const child of descendants(pg, id)) removed.add(child);
    }
    const name =
      doomed.length > 1
        ? `选中的 ${doomed.length} 个主题`
        : doomed.length === 1
          ? `「${plainText(pg.shapes[doomed[0]].text) || "（空主题）"}」`
          : `选中的 ${layers.length} 个标注/外框`;
    modal.confirm({
      title: `删除 ${name}？`,
      content: `会一并删掉这组里的 ${removed.size} 项${layers.length ? `（含 ${layers.length} 个标注/外框）` : ""}；删除后按 ${shortcutLabel("undo")} 可撤销。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      focusable: { autoFocusButton: "cancel" },
      onOk: () => deleteTopics(ids),
    });
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
        // 这条挡的是中心主题（既没 parentId 也不浮动）；浮动根没有 parentId 但删得掉
        const canDel = (id: string) => {
          const sh = pg.shapes[id];
          return Boolean(sh?.parentId) || Boolean(sh?.floating);
        };
        if (!sel.some(canDel)) return;
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
  // 单选给主题动作；多选给"盖一层"的动作（外框/概要天生要两个以上主题），
  // 而"连一条关系线"只在两点之间有意义。编辑中让位给输入框。
  //
  // 动作表只认"选中了哪几个"，不认是谁要显示它：快捷条和右键菜单共用一份，
  // 否则关掉"显示快捷操作条"就等于砍掉一半功能，两处 run 里的撤销标签也会分叉。
  const actionsFor = (ids: string[]): MenuAction[] => {
    const out: MenuAction[] = [];
    const boxes = ids
      .map((id) => paint.boxes.find((b) => b.id === id))
      .filter((b): b is ShapePaint => Boolean(b));
    const only = ids.length === 1 ? page.shapes[ids[0]] : undefined;
    if (only && boxes.length === 1) {
      const id = only.id;
      // 标注泡不是主题：给它"插入子主题"会造出一棵亿图读不懂的树，只给改名和删除。
      if (only.type === "Callout") {
        out.push({
          k: "edit",
          label: "改文字",
          tip: "编辑标注内容（F2 或双击）",
          run: () => useDoc.getState().setEditing(id),
        });
        out.push({
          k: "del",
          label: "删标注",
          tip: "删掉这个标注框",
          run: () => useDoc.getState().mutate("删除标注", (p) => removeOverlay(p, id)),
        });
      } else {
        out.push({
          k: "child",
          label: "子主题",
          tip: "插入子主题（Tab）",
          run: () => addChild(id),
        });
        out.push({
          k: "sibling",
          label: "同级",
          tip: "插入同级主题（Enter）",
          run: () => addSibling(id, false),
        });
        if (only.childIds.length)
          out.push({
            k: "fold",
            label: only.extras.collapsed ? "展开" : "折叠",
            tip: "折叠 / 展开这条分支（F4）",
            run: () => toggleFold(id),
          });
        // 只在"这枝确实被拖开过"时出现：没拖过的主题给一个复位，是纯粹的噪声。
        if (only.offset && only.parentId === page.rootId)
          out.push({
            k: "branch",
            label: "复位分支",
            tip: "把这枝交还给布局引擎，撤掉拖出来的位移",
            run: () => useDoc.getState().mutate("复位分支", (p) => resetBranch(p, id)),
          });
        if (only.parentId || only.floating)
          out.push({
            k: "del",
            label: "删除",
            tip: "删除这个主题及其分支（Delete）",
            run: () => removeTopics([id]),
          });
        out.push({
          k: "note",
          label: "附注",
          tip: "备注与超链接",
          run: () => useUi.getState().openDialog("topicInfo"),
        });
        out.push({
          k: "edit",
          label: "改名",
          tip: "编辑文字（F2 或双击）",
          run: () => useDoc.getState().setEditing(id),
        });
        out.push({
          k: "callout",
          label: "标注",
          tip: "在这个主题上挂一个标注框",
          run: () => useDoc.getState().mutate("新建标注", (p) => addCallout(p, id, "").page),
        });
        out.push({
          k: "ai",
          label: "AI 助手",
          tip: "AI 生成子主题 / 丰富 / 精简 / 重新生成",
          run: () => useUi.getState().openDialog("aiTopic"),
        });
      }
    }
    if (ids.length >= 2 && boxes.length === ids.length) {
      out.push({
        k: "boundary",
        label: "外框",
        tip: "给选中的主题盖一层外框（再点一次取消）",
        run: () => useDoc.getState().mutate("外框", (p) => addBoundary(p, ids).page),
      });
      out.push({
        k: "summary",
        label: "概要",
        tip: "给选中的主题加一个大括号和概要主题（再点一次取消）",
        run: () => useDoc.getState().mutate("概要", (p) => addSummary(p, ids).page),
      });
    }
    if (ids.length === 2 && boxes.length === 2) {
      const [a, b] = ids;
      const linked = Boolean(relationshipBetween(page, a, b));
      out.push({
        k: "rel",
        label: linked ? "取消连线" : "连线",
        tip: linked ? "删掉这两个主题之间的关系线" : "在选中的两个主题之间连一条关系线",
        run: () =>
          useDoc
            .getState()
            .mutate(linked ? "取消关系线" : "新建关系线", (p) => toggleRelationship(p, a, b)),
      });
    }
    return out;
  };

  // 菜单开着的时候先让位：两处给的是同一批动作，叠在一起只会被点错。
  const barBoxes =
    showQuickBar && !menu && !editingId && !drop && picked.length
      ? picked
          .map((id) => paint.boxes.find((b) => b.id === id))
          .filter((b): b is ShapePaint => Boolean(b))
      : [];
  const barBtns = barBoxes.length ? actionsFor(picked) : [];
  // 关系线的标注文字：连上之后直接在条子上给一个输入框，省掉再开一个对话框
  const barRel = picked.length === 2 ? relationshipBetween(page, picked[0], picked[1]) : undefined;
  const relText = () =>
    barRel && relDraft && relDraft.id === barRel.id
      ? relDraft.text
      : barRel
        ? plainText(barRel.text)
        : "";
  const commitRelText = () => {
    if (!barRel || !relDraft || relDraft.id !== barRel.id) return;
    const v = relDraft.text.trim();
    setRelDraft(null);
    if (v === plainText(barRel.text)) return;
    useDoc.getState().mutate("编辑关系线标注", (p) => setRelationshipText(p, barRel.id, v));
  };
  // 宽度按"中文字 12px + 左右内边距"估：条子居中偏几个像素不要紧，滑出视口才要紧。
  const barW =
    barBtns.reduce((n, b) => n + b.label.length * 12 + 16, 4) +
    (barBtns.length - 1) * 4 +
    (barRel ? 132 : 0);
  // 多选时条子贴着"两个框的外接矩形"上方，正好压在关系线弧顶那一带。
  // 注意 ShapePaint 的 x/y 已经是左上角（paintPage 里减过一半），不能再减一次。
  const barAt = (() => {
    if (!barBoxes.length) return null;
    const l = Math.min(...barBoxes.map((b) => b.x));
    const t = Math.min(...barBoxes.map((b) => b.y));
    const r = Math.max(...barBoxes.map((b) => b.x + b.w));
    const bot = Math.max(...barBoxes.map((b) => b.y + b.h));
    return quickBarAnchor(
      {
        left: pan.x + l * zoom,
        top: pan.y + t * zoom,
        width: (r - l) * zoom,
        height: (bot - t) * zoom,
      },
      size,
      { w: barW, h: 28 }
    );
  })();

  // ------------------------------------------------------------ 右键菜单（§3.1）
  // 点在主题上就给这一组选中的动作（多选时是整组），和快捷条同源；
  // 点在空白上只给画布级动作 —— 手上还留着选中项时把两套拼在一起，
  // 出来的就是"子主题 + 新建自由主题"这种没人能读懂的菜单（真机上折叠完再点空处就是这样）。
  const menuItems: MenuAction[] = menu
    ? keepActions(
        menu.onEmpty
          ? [
              {
                k: "float",
                label: "新建自由主题",
                tip: "在点击处放一个不挂在主树上的主题",
                run: () => addFloatingAt(menu.x, menu.y),
              },
              {
                k: "fit",
                label: "适应画布",
                tip: "把整张图缩放到刚好装进窗口",
                run: () => useUi.getState().fitZoom(),
              },
            ]
          : [
              ...actionsFor(picked),
              {
                k: "fit",
                label: "适应画布",
                tip: "把整张图缩放到刚好装进窗口",
                run: () => useUi.getState().fitZoom(),
              },
            ],
        menuEnabled
      )
    : [];
  // 定宽一列：变宽的菜单会在"折叠 / 展开"这种换字的动作上抖一下。
  const MENU_W = 148;
  const MENU_H = 8 + menuItems.length * 26;
  const menuAt =
    menu && menuItems.length
      ? {
          left: Math.max(4, Math.min(menu.sx, size.w - MENU_W - 4)),
          top: Math.max(4, Math.min(menu.sy, size.h - MENU_H - 4)),
        }
      : null;

  return (
    <div
      ref={wrapRef}
      onPointerDownCapture={onWrapPointerDown}
      // 右键自己弹菜单：浏览器的原生菜单会把右键平移打断，什么都不给又会让用户以为没做
      onContextMenu={onCanvasContextMenu}
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
          {/* 外框画在最底下：它是给一组主题围的圈，盖在内容上就把整组糊掉了 */}
          {paint.overlays.map((o) =>
            o.kind === "boundary" ? (
              <rect
                key={`bd-${o.id}`}
                x={o.x}
                y={o.y}
                width={o.w}
                height={o.h}
                rx={Math.min(o.rounding, o.w / 2, o.h / 2)}
                fill={o.fill}
                fillOpacity={0.35}
                stroke={o.line}
                strokeWidth={o.lineWidth}
                pointerEvents="none"
              />
            ) : null
          )}
          <g fill="none" strokeLinecap="round">
            {paint.connectors.map((c) => (
              <path
                key={c.id}
                d={c.d}
                stroke={lineOf.get(c.toId) ?? DEFAULTS.lineColor}
                strokeWidth={1.6}
              />
            ))}
            {axis
              ? [axis.d, axis.head].map((d, i) => (
                  <path key={`axis-${i}`} d={d} stroke={axis.line} strokeWidth={2} />
                ))
              : null}
            {grid
              ? grid.lines.map((l, i) => (
                  <path
                    key={`grid-${i}`}
                    d={`M ${l.x1} ${l.y1} L ${l.x2} ${l.y2}`}
                    stroke={grid.line}
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                ))
              : null}
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

          {/* 大括号与标注框压在主题之上（几何来自 paint.overlays，与导出同源） */}
          {paint.overlays.map((o) =>
            o.kind === "brace" ? (
              <path
                key={`brace-${o.id}`}
                d={o.d}
                fill="none"
                stroke={o.line}
                strokeWidth={o.lineWidth}
                strokeLinecap="round"
                pointerEvents="none"
              />
            ) : o.kind === "callout" ? (
              // 只剩引导线：泡本身在 paint.boxes 里（和主题同一套画法），
              // 于是它自动有了命中测试、选中框和就地改字，不必在这条路上再写一遍。
              <path
                key={`callout-${o.id}`}
                d={o.d}
                fill="none"
                stroke={o.line}
                strokeWidth={1}
                pointerEvents="none"
              />
            ) : null
          )}

          {/* 关系线压在主题之上（几何来自 paint.rels，与导出同源）：
              它常要从别的主题身上跨过去，画在框底下等于没画 */}
          {paint.rels.map((r) => (
            <g key={`rel-${r.id}`} pointerEvents="none">
              <path
                d={r.d}
                stroke={r.line}
                strokeWidth={r.lineWidth}
                strokeDasharray={r.dash}
                fill="none"
              />
              {r.text ? (
                <text x={r.lx} y={r.ly} fontSize={r.fontSize} textAnchor="middle" fill={r.line}>
                  {r.text}
                </text>
              ) : null}
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

          {drop?.mode === "gap" ? (
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
          ) : drop ? (
            // child 是实线"挂进来"，move 是虚线带淡底"整枝搬走"，两种意图不该长一个样
            <rect
              x={drop.x - 4}
              y={drop.y - 4}
              width={drop.w + 8}
              height={drop.h + 8}
              rx={8}
              fill={drop.mode === "move" ? ACCENT : "none"}
              fillOpacity={drop.mode === "move" ? 0.08 : undefined}
              stroke={ACCENT}
              strokeWidth={2 / zoom}
              strokeDasharray={drop.mode === "move" ? `${5 / zoom} ${4 / zoom}` : undefined}
              pointerEvents="none"
            />
          ) : null}

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
            background: "var(--zm-panel)",
            border: "1px solid var(--zm-border)",
            borderRadius: 6,
            boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
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
                color: "var(--zm-text)",
                borderRadius: 5,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              {b.label}
            </button>
          ))}
          {barRel && (
            <input
              value={relText()}
              placeholder="标注"
              title="关系线上的说明文字（回车或点到别处生效）"
              onChange={(e) => setRelDraft({ id: barRel.id, text: e.target.value })}
              onBlur={commitRelText}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRelText();
                if (e.key === "Escape") {
                  setRelDraft(null);
                  e.currentTarget.blur();
                }
              }}
              style={{
                width: 112,
                height: 24,
                border: "1px solid var(--zm-border)",
                borderRadius: 5,
                padding: "0 6px",
                fontSize: 12,
                color: "var(--zm-text)",
                background: "var(--zm-panel)",
                outline: "none",
              }}
            />
          )}
        </div>
      )}

      {menuAt && (
        <div
          ref={menuRef}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            position: "absolute",
            left: menuAt.left,
            top: menuAt.top,
            width: MENU_W,
            padding: "4px 0",
            boxSizing: "border-box",
            background: "var(--zm-panel)",
            border: "1px solid var(--zm-border)",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
            cursor: "default",
          }}
        >
          {menuItems.map((b) => (
            <button
              key={b.k}
              type="button"
              title={b.tip}
              onClick={() => {
                // 先收菜单再动手：动作里可能有 select/setEditing，反过来会让菜单停在原位
                setMenu(null);
                b.run();
              }}
              style={{
                display: "block",
                width: "100%",
                border: 0,
                background: "transparent",
                padding: "0 12px",
                height: 26,
                fontSize: 12,
                lineHeight: "26px",
                color: "var(--zm-text)",
                textAlign: "left",
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

      {/* AI 生成期间的画布锁：写路在 docStore.mutate 那里也关着，这里是让用户看得见。
          盖在最上层收走一切指针事件，生成完自己消失，不留可点的残渣。 */}
      {aiBusy && (
        <div
          data-testid="ai-lock"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(128, 128, 128, 0.28)",
            cursor: "progress",
            pointerEvents: "auto",
            fontSize: 13,
            color: "var(--zm-text)",
          }}
        >
          <span>AI 生成中…（画布已锁定）</span>
        </div>
      )}
    </div>
  );
}

export default MindCanvas;
