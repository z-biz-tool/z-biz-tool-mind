/**
 * 甘特投影（doc/复刻方案/00 §3.9）：时间条读的是同一份 `extras.task`（与看板共用）。
 *
 * 拖条只写两个字段：开始时间与工期（天）。写完就把整棵树交给 ganttSchedule 重算，
 * 这里不缓存任何"条的位置"，所以概要条（子条的包络）只能看不能拖 —— 它没有对应的字段。
 * ganttTicks 只给跨度不给起点，横轴原点要按同一公式复算一次，两者才不会错一格。
 */
import { useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Button, DatePicker, Empty, InputNumber, Segmented, Tooltip } from "antd";
import { ganttSchedule, ganttTicks, isWorkDay } from "../engine/projections.ts";
import type { GanttBar } from "../engine/projections.ts";
import { setCollapsed, updateExtras } from "../engine/tree.ts";
import { activeDoc, useDoc } from "../stores/docStore.ts";
import { DEFAULTS } from "../model/constants.ts";
import { newGanttOption } from "../model/factory.ts";
import type { GanttOption, Page, TaskData } from "../types/model.ts";

interface GanttViewProps {
  page: Page;
}

const DAY_MS = 86_400_000;
/** 左侧任务列宽度（px）：横轴滚动时它靠 sticky 固定在左边。 */
const LEFT_W = 230;
const ROW_H = 32;
const HEAD_H = 44;

/** extras.task 可能整个不存在（用户只画了导图没填任务），写时间时必须补齐必填字段。 */
const EMPTY_TASK: TaskData = { assignees: [], progress: 0, priority: "medium", status: "todo", tags: [] };

function patchTask(page: Page, id: string, patch: Partial<TaskData>): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return updateExtras(page, id, { task: { ...EMPTY_TASK, ...s.extras.task, ...patch } });
}

function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** DatePicker 给的是 "YYYY-MM-DD"，按本地时区解析成当天 0 点（`new Date(str)` 会按 UTC 差一天）。 */
function parseDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

type DragMode = "move" | "resize";

interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  offset: number;
  length: number;
}

export function GanttView({ page }: GanttViewProps) {
  const mutate = useDoc((s) => s.mutate);
  const select = useDoc((s) => s.select);
  const focusId = useDoc((s) => s.focusId);
  const selection = useDoc((s) => s.selection);
  const docGantt = useDoc((s) => activeDoc(s)?.gantt);

  // 名字别撞 tree.setCollapsed：局部 setter 会把要用的纯函数遮掉。
  const [scope, setScope] = useState<"folded" | "all">("folded");
  const [showToday, setShowToday] = useState(true);
  const [ghost, setGhost] = useState<{ id: string; offset: number; length: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // startDate 默认是 0（用户没设过），这里定一个"今天零点"并回填给引擎，
  // 否则每次重算都用新的 Date.now()，条和今天线会互相错位。
  const { opt, bars } = useMemo(() => {
    const base = docGantt ?? newGanttOption();
    const patched: GanttOption = {
      ...base,
      startDate: base.startDate || startOfToday(),
      unitWidth: base.unitWidth > 0 ? base.unitWidth : DEFAULTS.ganttUnitWidth,
    };
    return { opt: patched, bars: ganttSchedule(page, patched) };
  }, [page, docGantt]);

  const ticks = useMemo(() => ganttTicks(bars, opt), [bars, opt]);
  const originDays = useMemo(() => Math.floor(Math.min(0, ...bars.map((b) => b.offsetDays))), [bars]);
  const unit = ticks.unitWidth || DEFAULTS.ganttUnitWidth;
  const px = (offsetDays: number) => (offsetDays - originDays) * unit;

  // 折叠：ganttSchedule 会走完所有子孙，可见性由这一层按 extras.collapsed 过滤。
  const hidden = useMemo(() => {
    const out = new Set<string>();
    const walk = (id: string, hiding: boolean) => {
      const s = page.shapes[id];
      if (!s) return;
      if (hiding) out.add(id);
      const next = s.extras.collapsed ? true : hiding;
      for (const c of s.childIds) walk(c, next);
    };
    for (const c of page.shapes[page.rootId]?.childIds ?? []) walk(c, false);
    return out;
  }, [page]);

  const rows = useMemo(() => (scope === "folded" ? bars.filter((b) => !hidden.has(b.id)) : bars), [bars, hidden, scope]);

  const todayOffset = Math.round((startOfToday() - opt.startDate) / DAY_MS);
  const selId = focusId ?? selection[0] ?? null;
  const selBar = selId ? bars.find((b) => b.id === selId) : undefined;

  function commitDrag(d: DragState, days: number) {
    const offset = d.mode === "move" ? d.offset + days : d.offset;
    const length = d.mode === "resize" ? Math.max(0.25, d.length + days) : d.length;
    if (d.mode === "move" && days === 0) return;
    if (d.mode === "resize" && Math.abs(length - d.length) < 0.01) return;
    const label = d.mode === "resize" ? "调整任务工期" : "移动任务开始时间";
    const start = Math.round(opt.startDate + offset * DAY_MS);
    mutate(label, (p) => patchTask(p, d.id, { start, duration: length }));
  }

  /** 用原生 mouse 事件而不是 HTML5 dnd：拖条要按像素换天数，dataTransfer 给不了位移量。 */
  function onBarDown(e: ReactMouseEvent<HTMLElement>, bar: GanttBar, mode: DragMode) {
    if (e.button !== 0 || bar.isSummary) return;
    e.preventDefault();
    e.stopPropagation();
    const d: DragState = { id: bar.id, mode, startX: e.clientX, offset: bar.offsetDays, length: bar.lengthDays };
    dragRef.current = d;
    setGhost({ id: bar.id, offset: d.offset, length: d.length });
    const onMove = (ev: MouseEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const days = (ev.clientX - cur.startX) / unit;
      setGhost({
        id: cur.id,
        offset: cur.mode === "move" ? cur.offset + days : cur.offset,
        length: cur.mode === "resize" ? Math.max(0.25, cur.length + days) : cur.length,
      });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const cur = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      if (cur) commitDrag(cur, Math.round((ev.clientX - cur.startX) / unit));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function scrollToDay(offsetDays: number) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, LEFT_W + px(offsetDays) - el.clientWidth / 2), behavior: "smooth" });
  }

  // 刻度格数封顶：时间跨度被拉到几年以上时不画满网格（照样能横向滚动，只是尾部少了底纹）。
  const cellCount = Math.min(Math.max(1, ticks.days), 800);
  const major = Math.max(1, Math.round(opt.majorTick || 1));

  const dayCells = Array.from({ length: cellCount }, (_, i) => {
    const abs = originDays + i;
    const ms = opt.startDate + abs * DAY_MS;
    const work = isWorkDay(opt.startDate, abs, opt.workDay);
    const d = new Date(ms);
    return (
      <div
        key={i}
        style={{
          width: unit,
          flexShrink: 0,
          // 主刻度（majorTick 天一格）描重边，周初与月初再重一档
          borderRight: `1px solid ${abs % major === 0 ? "#c8c8c8" : d.getDate() === 1 ? "#9ecbff" : "#efefef"}`,
          background: abs === todayOffset ? "#fff1f0" : work ? "#ffffff" : "#f5f5f5",
          fontSize: 11,
          color: work ? "#595959" : "#bfbfbf",
          textAlign: "center",
          lineHeight: `${HEAD_H}px`,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
        title={d.toDateString()}
      >
        {d.getDate() === 1 ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getDate()} ${"日一二三四五六"[d.getDay()]}`}
      </div>
    );
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#ffffff" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid #eeeeee",
          flexWrap: "wrap",
        }}
      >
        <Segmented
          size="small"
          value={scope}
          onChange={(v) => setScope(v as "folded" | "all")}
          options={[
            { label: "只看展开", value: "folded" },
            { label: "显示全部任务", value: "all" },
          ]}
        />
        <Button size="small" type={showToday ? "primary" : "default"} onClick={() => setShowToday((v) => !v)}>
          今天线
        </Button>
        <Button size="small" onClick={() => scrollToDay(todayOffset)}>
          跳到今天
        </Button>
        <Button size="small" disabled={!selBar} onClick={() => selBar && scrollToDay(selBar.offsetDays)}>
          跳到选中项
        </Button>
        <span style={{ flex: 1 }} />
        <DatePicker
          size="small"
          placeholder={selBar ? "设置开始日期" : "先选中一个任务"}
          disabled={!selBar}
          onChange={(_, ds) => {
            const ms = parseDay(typeof ds === "string" ? ds : "");
            if (ms !== null && selBar) mutate("设置任务开始日期", (p) => patchTask(p, selBar.id, { start: ms }));
          }}
        />
        <InputNumber
          size="small"
          min={0.25}
          step={0.25}
          style={{ width: 96 }}
          placeholder="工期"
          disabled={!selBar}
          value={selBar ? Number(selBar.lengthDays.toFixed(2)) : null}
          onChange={(v) => {
            const days = typeof v === "number" && v > 0 ? v : null;
            if (days !== null && selBar && Math.abs(days - selBar.lengthDays) > 0.01) {
              mutate("设置任务工期", (p) => patchTask(p, selBar.id, { duration: days }));
            }
          }}
        />
        <span style={{ fontSize: 12, color: "#8c8c8c" }}>天</span>
      </div>

      <div style={{ padding: "4px 12px", fontSize: 12, color: "#8c8c8c", borderBottom: "1px solid #f5f5f5" }}>
        拖动时间条改开始时间，拖右端改工期；概要条是子任务的包络，不可拖。开始时间与工期写回主题的
        <code> extras.task</code>，看板与任务表看到的是同一份数据。
      </div>

      {rows.length === 0 ? (
        <Empty description="没有可排期的任务：给主题填开始时间，或按顺序自动推导" style={{ marginTop: 60 }} />
      ) : (
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div style={{ width: LEFT_W + ticks.total, position: "relative", minWidth: "100%" }}>
            {/* 表头：左上角那格同时粘在左和上 */}
            <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 5, height: HEAD_H }}>
              <div
                style={{
                  width: LEFT_W,
                  flexShrink: 0,
                  position: "sticky",
                  left: 0,
                  zIndex: 6,
                  background: "#fafafa",
                  borderRight: "1px solid #eeeeee",
                  borderBottom: "1px solid #e5e5e5",
                  fontSize: 12,
                  color: "#595959",
                  lineHeight: `${HEAD_H}px`,
                  paddingLeft: 10,
                }}
              >
                任务 / 负责人
              </div>
              <div style={{ display: "flex", borderBottom: "1px solid #e5e5e5" }}>{dayCells}</div>
            </div>

            {/* 非工作日底纹 + 今天线：一条覆盖层，不参与布局，避免每行都画一遍 */}
            <div style={{ position: "absolute", left: LEFT_W, top: HEAD_H, bottom: 0, width: ticks.total, pointerEvents: "none", zIndex: 1 }}>
              {Array.from({ length: cellCount }, (_, i) => {
                const abs = originDays + i;
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: i * unit,
                      top: 0,
                      bottom: 0,
                      width: unit,
                      background: isWorkDay(opt.startDate, abs, opt.workDay) ? undefined : "rgba(0,0,0,.035)",
                      borderRight: "1px solid rgba(0,0,0,.04)",
                    }}
                  />
                );
              })}
              {showToday && todayOffset >= originDays && todayOffset <= originDays + ticks.days ? (
                <div style={{ position: "absolute", left: px(todayOffset), top: 0, bottom: 0, width: 2, background: "#f5222d" }} />
              ) : null}
            </div>

            {rows.map((bar) => {
              // 拖动中用 ghost 的实时值画条，松手才落库 —— 所见即所拖，但撤销栈只有一条记录。
              const drag = ghost && ghost.id === bar.id ? ghost : null;
              const offsetDays = drag ? drag.offset : bar.offsetDays;
              const lengthDays = drag ? drag.length : bar.lengthDays;
              const shape = page.shapes[bar.id];
              const folded = Boolean(shape?.extras.collapsed);
              const active = selId === bar.id || selection.includes(bar.id);
              return (
                <div
                  key={bar.id}
                  onClick={() => select([bar.id], bar.id)}
                  style={{ display: "flex", height: ROW_H, position: "relative", zIndex: 2, background: active ? "#f2f6ff" : undefined }}
                >
                  <div
                    style={{
                      width: LEFT_W,
                      flexShrink: 0,
                      position: "sticky",
                      left: 0,
                      zIndex: 4,
                      background: active ? "#f2f6ff" : "#ffffff",
                      borderRight: "1px solid #eeeeee",
                      borderBottom: "1px solid #f5f5f5",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      paddingLeft: 6 + bar.depth * 14,
                      fontSize: 12,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{ width: 14, textAlign: "center", cursor: bar.isSummary ? "pointer" : "default", color: "#8c8c8c" }}
                      onClick={(e) => {
                        if (!bar.isSummary) return;
                        e.stopPropagation();
                        mutate(folded ? "展开分支" : "折叠分支", (p) => setCollapsed(p, bar.id, !folded));
                      }}
                    >
                      {bar.isSummary ? (folded ? "▸" : "▾") : "·"}
                    </span>
                    <span style={{ fontWeight: bar.isSummary ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis" }}>{bar.name}</span>
                    <span style={{ color: "#bfbfbf", flexShrink: 0 }}>{bar.assignees.join("、")}</span>
                  </div>
                  <div style={{ position: "relative", width: ticks.total, flexShrink: 0 }}>
                    {bar.milestone ? (
                      <div
                        title={`${bar.name}：里程碑`}
                        style={{
                          position: "absolute",
                          left: px(offsetDays) - 7,
                          top: ROW_H / 2 - 7,
                          width: 14,
                          height: 14,
                          background: "#722ed1",
                          transform: "rotate(45deg)",
                        }}
                      />
                    ) : (
                      <Tooltip title={bar.isSummary ? "概要条：由子任务包络出来，不可拖" : `${bar.name} ${bar.lengthDays} 天`}>
                        <div
                          style={{
                            position: "absolute",
                            left: px(offsetDays),
                            top: bar.isSummary ? 6 : 8,
                            width: Math.max(6, lengthDays * unit),
                            height: bar.isSummary ? 6 : ROW_H - 16,
                            borderRadius: bar.isSummary ? 1 : 4,
                            background: bar.isSummary ? "#8c8c8c" : "#5b8ff9",
                            cursor: bar.isSummary ? "default" : "grab",
                            overflow: "hidden",
                            boxShadow: ghost?.id === bar.id ? "0 0 0 2px rgba(91,143,249,.35)" : undefined,
                          }}
                          onMouseDown={(e) => onBarDown(e, bar, "move")}
                        >
                          {/* 已完成部分：进度写在 extras.task.progress */}
                          <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, bar.progress)}%`, background: "rgba(0,0,0,.22)" }} />
                          {!bar.isSummary ? (
                            <span style={{ position: "absolute", right: 4, top: 0, fontSize: 10, lineHeight: `${ROW_H - 16}px`, color: "#ffffff" }}>
                              {Math.round(lengthDays * 100) / 100}d
                            </span>
                          ) : null}
                          {!bar.isSummary ? (
                            <span
                              onMouseDown={(e) => onBarDown(e, bar, "resize")}
                              style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 7, cursor: "col-resize", background: "rgba(255,255,255,.45)" }}
                            />
                          ) : null}
                        </div>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default GanttView;
