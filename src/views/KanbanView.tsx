/**
 * 看板投影（doc/复刻方案/00 §3.7）：卡片 = 主题，列 = 主分支（或状态泳道）。
 *
 * 关键约定：看板上没有任何一份自己的数据。卡片上的负责人、进度、优先级、状态
 * 全部住在 `shape.extras.task` 里（TaskData 被看板和甘特共用，§3.5 表），
 * 所以拖拽落点只有两种写法：改列 = 树上 moveShape，改状态 = updateExtras，
 * 两者都必须过 mutate 提交撤销栈 —— 回到画布必须能看到同样的结果（P-1）。
 * 卡片菜单是全应用唯一的任务字段编辑口：优先级 / 进度 / 日期 / 里程碑都从这儿改。
 */
import { useMemo, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { Alert, App as AntdApp, Button, Dropdown, Empty, Input, Modal, Progress, Segmented, Select, Tag, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  filterCards,
  kanbanBoard,
  kanbanByStatus,
  kanbanColumnGuard,
  sortCards,
  type KanbanCard,
  type KanbanSortKey,
} from "../engine/projections.ts";
import { accentAt, defaultPalette } from "../engine/style.ts";
import { descendants, duplicateShape, insertChild, moveShape, removeShape, updateExtras, updateText } from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { type Page, type TaskData, type TaskPriority, type TaskStatus } from "../types/model.ts";
import { shortcutLabel } from "../utils/shortcuts.ts";

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
const PROGRESS_STEPS = [0, 25, 50, 75, 100];

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

/** DatePicker 的 dateString 按本地时区解析成当天 0 点（`new Date(str)` 会按 UTC 差一天）。 */
function parseDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Dropdown 里的输入控件不能让点击冒泡把菜单关掉。 */
function stopProp(e: ReactMouseEvent) {
  e.stopPropagation();
}

/**
 * 菜单里的日期小输入框：非受控 + 以当前值为 key。受控的话敲到 "2026-" 这种
 * 还解析不出来的前缀会被 value 弹回去，一个字都输不进去；key 让落库后的
 * 重渲染重挂一个带新默认值的框，敲错时 key 不变、继续敲。
 */
function DateField({
  label,
  value,
  placeholder,
  onSet,
}: {
  label: string;
  value?: string;
  placeholder: string;
  onSet: (ms: number | null) => void;
}) {
  const v = value ?? "";
  return (
    <span onClick={stopProp} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {label}
      <Input
        size="small"
        style={{ width: 110 }}
        key={v}
        defaultValue={v}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (!raw) {
            onSet(null);
            return;
          }
          const ms = parseDay(raw);
          if (ms !== null) onSet(ms);
        }}
      />
    </span>
  );
}

interface Column {
  key: string;
  title: string;
  color: string;
  cards: KanbanCard[];
  progress: number;
  /** 状态泳道没有对应的树节点：重命名 / 删除列只对分支列开放。 */
  isStatusLane: boolean;
}

export function KanbanView({ page }: KanbanViewProps) {
  const { modal } = AntdApp.useApp();
  const mutate = useDoc((s) => s.mutate);
  const select = useDoc((s) => s.select);
  const selection = useDoc((s) => s.selection);
  const setProjection = useUi((s) => s.setProjection);
  const [lane, setLane] = useState<"branch" | "status">("branch");
  const [dragging, setDragging] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<KanbanSortKey>("manual");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [filterText, setFilterText] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const guard = kanbanColumnGuard(page);

  const allColumns = useMemo<Column[]>(() => {
    if (lane === "status") {
      return kanbanByStatus(page).map((l, i) => ({
        key: l.status,
        title: STATUS_LABEL[l.status],
        color: accentAt(PALETTE, i),
        cards: l.cards,
        progress: l.cards.length
          ? Math.round(l.cards.reduce((sum, c) => sum + c.progress, 0) / l.cards.length)
          : 0,
        isStatusLane: true,
      }));
    }
    return kanbanBoard(page).map((col, i) => ({
      key: col.id,
      title: col.name,
      color: accentAt(PALETTE, i),
      cards: col.cards,
      progress: col.progress,
      isStatusLane: false,
    }));
  }, [page, lane]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const col of allColumns) for (const c of col.cards) for (const t of c.tags) set.add(t);
    return [...set];
  }, [allColumns]);

  const columns = useMemo(
    () =>
      allColumns.map((col) => ({
        ...col,
        cards: sortCards(filterCards(col.cards, { text: filterText, tag: filterTag ?? undefined }), sortKey, sortDir),
      })),
    [allColumns, filterText, filterTag, sortKey, sortDir]
  );

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

  /**
   * 与画布同一条口径：叶子卡片直接删（编辑主循环 + 撤销一步可回），
   * 带子卡片的才打断；删列永远确认 —— 它带走的是整枝，不是一张卡。
   */
  function removeCard(card: KanbanCard) {
    if (card.subCount === 0) {
      mutate("删除卡片", (p) => removeShape(p, card.id));
      return;
    }
    const gone = descendants(page, card.id).length + 1;
    modal.confirm({
      title: `删除卡片「${card.title || "（空主题）"}」整枝？`,
      content: `会一并删掉这一枝里的 ${gone} 个主题；删除后按 ${shortcutLabel("undo")} 可撤销。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      focusable: { autoFocusButton: "cancel" },
      onOk: () => mutate("删除卡片", (p) => removeShape(p, card.id)),
    });
  }

  function removeColumn(col: Column) {
    const gone = descendants(page, col.key).length + 1;
    modal.confirm({
      title: `删除看板列「${col.title}」？`,
      content: `这一列里的 ${col.cards.length} 张卡片会随整枝一起删掉（共 ${gone} 个主题）；删除后按 ${shortcutLabel("undo")} 可撤销。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      focusable: { autoFocusButton: "cancel" },
      onOk: () => mutate("删除看板列", (p) => removeShape(p, col.key)),
    });
  }

  /** 卡片菜单：任务字段的唯一编辑口（画布与甘特都只读这份 extras.task）。 */
  const cardMenu = (card: KanbanCard): MenuProps => ({
    items: [
      {
        key: "pri",
        label: "优先级",
        children: (["low", "medium", "high"] as TaskPriority[]).map((p) => ({
          key: `pri-${p}`,
          label: PRIORITY_LABEL[p],
        })),
      },
      {
        key: "prog",
        label: "进度",
        children: PROGRESS_STEPS.map((v) => ({ key: `prog-${v}`, label: `${v}%` })),
      },
      { key: "milestone", label: card.milestone ? "取消里程碑" : "设为里程碑" },
      {
        key: "start",
        label: (
          <DateField
            label="开始"
            value={page.shapes[card.id]?.extras.task?.start ? fmtDay(page.shapes[card.id].extras.task!.start) : ""}
            placeholder="YYYY-MM-DD"
            onSet={(ms) => mutate("设置任务开始日期", (p) => patchTask(p, card.id, { start: ms ?? undefined }))}
          />
        ),
      },
      {
        key: "finish",
        label: (
          <DateField
            label="截止"
            value={card.due ? fmtDay(card.due) : ""}
            placeholder="YYYY-MM-DD"
            onSet={(ms) => mutate("设置任务截止日期", (p) => patchTask(p, card.id, { finish: ms ?? undefined }))}
          />
        ),
      },
      { type: "divider" },
      {
        key: "locate",
        label: "在导图中定位",
      },
      { key: "dup", label: "复制卡片" },
      { key: "del", label: "删除卡片", danger: true },
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      if (key.startsWith("pri-")) {
        mutate("设置任务优先级", (p) => patchTask(p, card.id, { priority: key.slice(4) as TaskPriority }));
      } else if (key.startsWith("prog-")) {
        mutate("设置任务进度", (p) => patchTask(p, card.id, { progress: Number(key.slice(5)) }));
      } else if (key === "milestone") {
        mutate("切换里程碑", (p) => patchTask(p, card.id, { milestone: !card.milestone }));
      } else if (key === "locate") {
        setProjection("mindmap");
        select([card.id], card.id);
      } else if (key === "dup") {
        mutate("复制卡片", (p) => duplicateShape(p, card.id).page);
      } else if (key === "del") {
        removeCard(card);
      }
    },
  });

  /** 列头菜单：泳道没有树节点，重命名 / 删除只给分支列。 */
  const columnMenu = (col: Column): MenuProps => ({
    items: [
      { key: "rename", label: "重命名列", disabled: col.isStatusLane },
      { key: "del", label: "删除列", danger: true, disabled: col.isStatusLane },
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      if (key === "rename") setRenaming({ id: col.key, name: col.title });
      else if (key === "del") removeColumn(col);
    },
  });

  const today = Date.now();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--zm-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--zm-panel)", borderBottom: "1px solid var(--zm-border)", flexWrap: "wrap" }}>
        <Segmented
          size="small"
          value={lane}
          onChange={(v) => setLane(v as "branch" | "status")}
          options={[
            { label: "按主分支分列", value: "branch" },
            { label: "按状态分列", value: "status" },
          ]}
        />
        <Segmented
          size="small"
          value={sortKey}
          onChange={(v) => setSortKey(v as KanbanSortKey)}
          options={[
            { label: "手动", value: "manual" },
            { label: "标题", value: "title" },
            { label: "截止日", value: "due" },
            { label: "优先级", value: "priority" },
          ]}
        />
        {sortKey !== "manual" ? (
          <Button
            size="small"
            onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}
            title={sortDir === 1 ? "升序" : "降序"}
          >
            {sortDir === 1 ? "升序" : "降序"}
          </Button>
        ) : null}
        <Input
          size="small"
          allowClear
          style={{ width: 150 }}
          placeholder="筛选：标题或标签"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        {allTags.length ? (
          <Select
            size="small"
            allowClear
            placeholder="按标签"
            style={{ minWidth: 110 }}
            value={filterTag}
            onChange={(v) => setFilterTag(v ?? null)}
            options={allTags.map((t) => ({ value: t, label: t }))}
          />
        ) : null}
        <span style={{ color: "var(--zm-text-2)", fontSize: 12 }}>拖卡片换列；右键卡片改任务字段</span>
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
      {!guard.ok ? <Alert type="warning" showIcon banner title={guard.reason ?? "看板列数已达上限"} /> : null}

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
                background: overKey === col.key ? "var(--zm-hover)" : "var(--zm-panel)",
                border: "1px solid " + (overKey === col.key ? col.color : "var(--zm-border)"),
                borderRadius: 8,
                maxHeight: "100%",
              }}
            >
              <div style={{ padding: "10px 12px 6px", borderTop: `3px solid ${col.color}`, borderRadius: "8px 8px 0 0" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <Dropdown menu={columnMenu(col)} trigger={["contextMenu", "click"]}>
                    <b style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "context-menu" }}>
                      {col.title}
                    </b>
                  </Dropdown>
                  <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>{col.cards.length}</span>
                </div>
                <Progress percent={col.progress} size="small" showInfo={false} strokeColor={col.color} />
              </div>
              <div style={{ flex: 1, minHeight: 60, overflowY: "auto", padding: "0 8px 8px" }}>
                {col.cards.map((card) => {
                  const note = page.shapes[card.id]?.extras.note?.trim();
                  const start = page.shapes[card.id]?.extras.task?.start;
                  const overdue = Boolean(card.due && card.due < today - DAY_MS / 2 && card.status !== "done");
                  return (
                    <Dropdown key={card.id} menu={cardMenu(card)} trigger={["contextMenu"]}>
                      <div
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
                          background: "var(--zm-panel)",
                          border: "1px solid " + (selection.includes(card.id) || dragging === card.id ? col.color : "var(--zm-border)"),
                          borderRadius: 6,
                          padding: "8px 9px",
                          marginBottom: 8,
                          cursor: "grab",
                          opacity: dragging === card.id ? 0.45 : 1,
                          boxShadow: "0 1px 2px rgba(0,0,0,.05)",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--zm-text)", wordBreak: "break-word" }}>{card.title}</div>
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
                          {card.milestone ? (
                            <Tag style={{ marginInlineEnd: 0 }} color="purple">
                              里程碑
                            </Tag>
                          ) : null}
                          {/* 注释不在 TaskData 里，是主题自身的 extras.note —— 看板只当"有内容"的标记用 */}
                          {note ? (
                            <Tooltip title={note}>
                              <span>≡</span>
                            </Tooltip>
                          ) : null}
                          {card.subCount > 0 ? <span style={{ fontSize: 11, color: "var(--zm-text-2)" }}>{card.subCount} 子卡</span> : null}
                          {card.tags.map((t) => (
                            <Tag key={t} style={{ marginInlineEnd: 0 }} variant="filled">
                              {t}
                            </Tag>
                          ))}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                          <span style={{ fontSize: 12, color: "var(--zm-text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {card.assignees.join("、") || "未指派"}
                          </span>
                          {(start || card.due) && (
                            <span style={{ fontSize: 11, color: overdue ? "#d4380d" : "var(--zm-text-2)" }}>
                              {start ? fmtDay(start).slice(5) : ""}
                              {start && card.due ? " ~ " : ""}
                              {card.due ? fmtDay(card.due) : ""}
                            </span>
                          )}
                        </div>
                        <Progress percent={card.progress} size="small" style={{ marginTop: 2 }} />
                      </div>
                    </Dropdown>
                  );
                })}
                <Button size="small" type="text" block onClick={() => addCard(col)} style={{ color: "var(--zm-text-2)" }}>
                  ＋ 新建卡片
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        title="重命名列"
        open={!!renaming}
        onCancel={() => setRenaming(null)}
        onOk={() => {
          if (!renaming) return;
          const name = renaming.name.trim();
          if (name) mutate("重命名看板列", (p) => updateText(p, renaming.id, name));
          setRenaming(null);
        }}
        okText="确定"
        cancelText="取消"
        width={360}
      >
        <Input
          value={renaming?.name ?? ""}
          autoFocus
          onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
          onPressEnter={() => {
            if (renaming) {
              const name = renaming.name.trim();
              if (name) mutate("重命名看板列", (p) => updateText(p, renaming.id, name));
              setRenaming(null);
            }
          }}
        />
      </Modal>
    </div>
  );
}

export default KanbanView;
