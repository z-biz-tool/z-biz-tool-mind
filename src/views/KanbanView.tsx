/**
 * 看板投影（doc/复刻方案/00 §3.7）：卡片 = 主题，列 = 主分支（或状态泳道）。
 *
 * 关键约定：看板上没有任何一份自己的数据。卡片上的负责人、进度、优先级、状态
 * 全部住在 `shape.extras.task` 里（TaskData 被看板和甘特共用，§3.5 表），
 * 所以拖拽落点只有两种写法：改列 = 树上 moveShape，改状态 = updateExtras，
 * 两者都必须过 mutate 提交撤销栈 —— 回到画布必须能看到同样的结果（P-1）。
 */
import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import { Alert, Button, Empty, Progress, Segmented, Tag, Tooltip } from "antd";
import { kanbanBoard, kanbanByStatus, kanbanColumnGuard } from "../engine/projections.ts";
import type { KanbanCard } from "../engine/projections.ts";
import { accentAt, defaultPalette } from "../engine/style.ts";
import { insertChild, moveShape, updateExtras } from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import type { Page, TaskData, TaskStatus } from "../types/model.ts";

interface KanbanViewProps {
  page: Page;
}

const PALETTE = defaultPalette();
const DAY_MS = 86_400_000;

/** extras.task 可能整个不存在，写回时要补齐必填字段，否则甘特与任务表会读到半截对象。 */
const EMPTY_TASK: TaskData = { assignees: [], progress: 0, priority: "medium", status: "todo", tags: [] };

const STATUS_LABEL: Record<TaskStatus, string> = { todo: "未开始", doing: "进行中", done: "已完成" };
const STATUS_NEXT: Record<TaskStatus, TaskStatus> = { todo: "doing", doing: "done", done: "todo" };
const PRIORITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

function patchTask(page: Page, id: string, patch: Partial<TaskData>): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return updateExtras(page, id, { task: { ...EMPTY_TASK, ...s.extras.task, ...patch } });
}

function fmtDay(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Column {
  key: string;
  title: string;
  color: string;
  cards: KanbanCard[];
  progress: number;
}

export function KanbanView({ page }: KanbanViewProps) {
  const mutate = useDoc((s) => s.mutate);
  const select = useDoc((s) => s.select);
  const selection = useDoc((s) => s.selection);
  const [lane, setLane] = useState<"branch" | "status">("branch");
  const [dragging, setDragging] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const guard = kanbanColumnGuard(page);

  const columns = useMemo<Column[]>(() => {
    if (lane === "status") {
      return kanbanByStatus(page).map((l, i) => ({
        key: l.status,
        title: STATUS_LABEL[l.status],
        color: accentAt(PALETTE, i),
        cards: l.cards,
        progress: l.cards.length
          ? Math.round(l.cards.reduce((sum, c) => sum + c.progress, 0) / l.cards.length)
          : 0,
      }));
    }
    return kanbanBoard(page).map((col, i) => ({
      key: col.id,
      title: col.name,
      color: accentAt(PALETTE, i),
      cards: col.cards,
      progress: col.progress,
    }));
  }, [page, lane]);

  function onDrop(e: DragEvent<HTMLDivElement>, col: Column) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragging;
    setDragging(null);
    setOverKey(null);
    if (!id || !page.shapes[id]) return;
    if (lane === "status") {
      // 泳道模式：列就是状态，落点只改 extras.task.status，树的结构一个字节都不动。
      if ((page.shapes[id].extras.task?.status ?? "todo") === col.key) return;
      mutate("卡片转状态", (p) => patchTask(p, id, { status: col.key as TaskStatus }));
      return;
    }
    // 分支模式：列就是主分支，换列 = 树上换父（P-1：所有投影都从同一棵树重算）。
    if (page.shapes[id].parentId === col.key) return;
    mutate("卡片换列", (p) => moveShape(p, id, col.key));
  }

  function cycleStatus(card: KanbanCard) {
    const next = STATUS_NEXT[card.status];
    mutate("卡片转状态", (p) => patchTask(p, card.id, { status: next }));
  }

  function addCard(col: Column) {
    if (lane === "status") {
      // 泳道列不对应树节点：新卡片挂到中心主题，状态落在当前泳道。
      mutate("新建看板卡片", (p) => {
        const r = insertChild(p, page.rootId, "新卡片");
        return r.id ? patchTask(r.page, r.id, { status: col.key as TaskStatus }) : r.page;
      });
      return;
    }
    mutate("新建看板卡片", (p) => insertChild(p, col.key, "新卡片").page);
  }

  const today = Date.now();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#f5f6f8" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#ffffff", borderBottom: "1px solid #eeeeee" }}>
        <Segmented
          size="small"
          value={lane}
          onChange={(v) => setLane(v as "branch" | "status")}
          options={[
            { label: "按主分支分列", value: "branch" },
            { label: "按状态分列", value: "status" },
          ]}
        />
        <span style={{ color: "#8c8c8c", fontSize: 12 }}>拖动卡片换列；点状态标签在 未开始 / 进行中 / 已完成 之间循环</span>
        {lane === "branch" ? (
          <Button
            size="small"
            disabled={!guard.ok}
            onClick={() => mutate("新建看板列", (p) => insertChild(p, page.rootId, "新列").page)}
          >
            新建列
          </Button>
        ) : null}
      </div>

      {/* 配额是一等公民（P-4）：列数超限时不新建列，但已存在的卡片照样能看能拖。 */}
      {!guard.ok ? <Alert type="warning" showIcon banner message={guard.reason ?? "看板列数已达上限"} /> : null}

      {columns.length === 0 ? (
        <Empty description="看板还没有列：先在导图里建主分支" style={{ marginTop: 60 }} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 10, padding: 12, overflowX: "auto", alignItems: "stretch" }}>
          {columns.map((col) => (
            <div
              key={col.key}
              onDragOver={(e) => {
                e.preventDefault();
                setOverKey(col.key);
              }}
              onDragLeave={() => setOverKey((k) => (k === col.key ? null : k))}
              onDrop={(e) => onDrop(e, col)}
              style={{
                width: 260,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                background: overKey === col.key ? "#e8f1ff" : "#ffffff",
                border: "1px solid " + (overKey === col.key ? col.color : "#ebebeb"),
                borderRadius: 8,
                maxHeight: "100%",
              }}
            >
              <div style={{ padding: "10px 12px 6px", borderTop: `3px solid ${col.color}`, borderRadius: "8px 8px 0 0" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <b style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{col.title}</b>
                  <span style={{ fontSize: 12, color: "#8c8c8c" }}>{col.cards.length}</span>
                </div>
                <Progress percent={col.progress} size="small" showInfo={false} strokeColor={col.color} />
              </div>
              <div style={{ flex: 1, minHeight: 60, overflowY: "auto", padding: "0 8px 8px" }}>
                {col.cards.map((card) => {
                  const note = page.shapes[card.id]?.extras.note?.trim();
                  const overdue = Boolean(card.due && card.due < today - DAY_MS / 2 && card.status !== "done");
                  return (
                    <div
                      key={card.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", card.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragging(card.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOverKey(null);
                      }}
                      onClick={() => select([card.id], card.id)}
                      style={{
                        background: "#ffffff",
                        border: "1px solid " + (selection.includes(card.id) || dragging === card.id ? col.color : "#ebebeb"),
                        borderRadius: 6,
                        padding: "8px 9px",
                        marginBottom: 8,
                        cursor: "grab",
                        opacity: dragging === card.id ? 0.45 : 1,
                        boxShadow: "0 1px 2px rgba(0,0,0,.05)",
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 500, color: "#262626", wordBreak: "break-word" }}>{card.title}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                        <Tooltip title={`当前：${STATUS_LABEL[card.status]}（点击切换）`}>
                          <Tag
                            style={{ marginInlineEnd: 0, cursor: "pointer" }}
                            color={card.status === "done" ? "green" : card.status === "doing" ? "blue" : "default"}
                            onClick={(e) => {
                              e.stopPropagation();
                              cycleStatus(card);
                            }}
                          >
                            {STATUS_LABEL[card.status]}
                          </Tag>
                        </Tooltip>
                        <Tag style={{ marginInlineEnd: 0 }} color={card.priority === "high" ? "red" : undefined}>
                          {PRIORITY_LABEL[card.priority] ?? card.priority}
                        </Tag>
                        {/* 注释不在 TaskData 里，是主题自身的 extras.note —— 看板只当"有内容"的标记用 */}
                        {note ? (
                          <Tooltip title={note}>
                            <span>≡</span>
                          </Tooltip>
                        ) : null}
                        {card.subCount > 0 ? <span style={{ fontSize: 11, color: "#8c8c8c" }}>{card.subCount} 子卡</span> : null}
                        {card.tags.map((t) => (
                          <Tag key={t} style={{ marginInlineEnd: 0 }} variant="filled">
                            {t}
                          </Tag>
                        ))}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                        <span style={{ fontSize: 12, color: "#595959", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {card.assignees.join("、") || "未指派"}
                        </span>
                        {card.due ? <span style={{ fontSize: 11, color: overdue ? "#d4380d" : "#8c8c8c" }}>{fmtDay(card.due)}</span> : null}
                      </div>
                      <Progress percent={card.progress} size="small" style={{ marginTop: 2 }} />
                    </div>
                  );
                })}
                <Button size="small" type="text" block onClick={() => addCard(col)} style={{ color: "#8c8c8c" }}>
                  ＋ 新建卡片
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default KanbanView;
