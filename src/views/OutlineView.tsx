/**
 * 大纲投影（doc/复刻方案/00 §3.6）：一条树的第二个投影，也是唯一"以文字为主"的那一个。
 *
 * 为什么必须可编辑、而不是只读列表：亿图里批量录入主题靠的就是大纲面板 ——
 * Tab / Shift+Tab / Enter 与"粘贴一段缩进文本"都比回画布点鼠标快得多。
 * 这两条路径都只调 engine/outline.ts 的原语（P-3 文本⇄树同构），
 * 于是大纲粘贴、批量录入、Markdown 导入、OCR、AI 插入共用同一套缩进规则。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { Alert, Button, Empty, Input, Modal, Segmented, Tooltip } from "antd";
import { insertOutline } from "../engine/outline.ts";
import type { InsertMode } from "../engine/outline.ts";
import { outlineRows } from "../engine/projections.ts";
import { accentAt } from "../engine/style.ts";
import { usePalette } from "../stores/usePalette.ts";
import { branchIndex, demote, insertSibling, promote, removeShape, setCollapsed, updateText } from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import type { Page } from "../types/model.ts";

interface OutlineViewProps {
  page: Page;
}

/** 一层的缩进像素；行左缘的色条也按它内缩，保证"缩进 = 层级"读得出来。 */
const INDENT = 20;

/** 只有"多行"或"首行带缩进"才走大纲解析；普通单词要保持浏览器原生粘贴，别打断输入法。 */
function isIndentedBlock(raw: string): boolean {
  if (raw.trim() === "") return false;
  return /[\r\n]/.test(raw) || /^\s+\S/.test(raw);
}

/** Markdown 特征：行首列表符 / 井号 / 引用 / 任务框 —— 命中就交给 outline.ts 的 markdown 分支。 */
function looksLikeMarkdown(raw: string): boolean {
  return /(?:^|\n)[ \t]*(?:[-*+]\s|#{1,6}\s|>\s|\[[ xX]\]|\d+[.)]\s)/.test(raw);
}

export function OutlineView({ page }: OutlineViewProps) {
  const rows = useMemo(() => outlineRows(page), [page]);
  // 行左缘的色条要跟画布同一支同色：色板来自文档自己的 theme.xml，不是写死的那十色。
  const palette = usePalette();
  const mutate = useDoc((s) => s.mutate);
  const select = useDoc((s) => s.select);
  const setEditing = useDoc((s) => s.setEditing);
  const selection = useDoc((s) => s.selection);
  const focusId = useDoc((s) => s.focusId);
  /** 当前在打字的那一行；结构性操作（回车新增、升降级）之后由代码显式移动它。 */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 受控输入的即时值。撤销栈里同一标签 + coalesceMs 已经把连打字并成一条，但输入框自己仍要有值。 */
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [batch, setBatch] = useState<{ open: boolean; text: string; mode: InsertMode }>({
    open: false,
    text: "",
    mode: "appendChildren",
  });
  const rowRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // §3.6 明示风险：含双向链接的主题在大纲里改文字可能让链接失效 —— 提示，但不拦编辑。
  const hasBiLinks = useMemo(
    () => Object.values(page.shapes).some((s) => (s.extras.biLinks?.length ?? 0) > 0),
    [page]
  );

  useEffect(() => {
    setDraft(null);
    if (!activeId) return;
    const el = rowRefs.current[activeId];
    if (el && typeof document !== "undefined" && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [activeId]);

  /**
   * 插入锚点：正在编辑的行 > 画布选中 > 中心主题。
   * 三个来源都可能是上个文档/上次撤销留下的 id —— 不校验就挂在幽灵节点上，
   * 对话框明明写着"插入位置：中心主题"却插不进任何东西。
   */
  const anchorId = [activeId, focusId, selection[0]].find((id) => id && page.shapes[id]) ?? page.rootId;

  function commitText(id: string, text: string) {
    // 每敲一个字符都要 mutate（唯一写入口），靠 coalesceMs 把连续打字并成一条撤销记录。
    mutate("编辑大纲文字", (p) => updateText(p, id, text), { coalesceMs: 700 });
  }

  function focusRow(id: string | null) {
    setActiveId(id);
    if (id) {
      select([id], id);
      setEditing(id);
    }
  }

  /** Tab 降级 / Shift+Tab 升级。先在当前页上试一次，不合法就不提交（否则撤销栈会多出空记录）。 */
  function changeLevel(id: string, dir: 1 | -1) {
    const probe = dir === 1 ? demote(page, id) : promote(page, id);
    if (!probe.ok) return;
    const label = dir === 1 ? "大纲降级" : "大纲升级";
    mutate(label, (p) => (dir === 1 ? demote(p, id) : promote(p, id)).page);
  }

  function addSibling(id: string) {
    let created = "";
    mutate("大纲新增同级", (p) => {
      const r = insertSibling(p, id, "after", "");
      created = r.id;
      return r.page;
    });
    if (created) focusRow(created);
  }

  function removeRow(id: string, index: number) {
    if (!page.shapes[id]?.parentId) return; // 中心主题不可删（tree.removeShape 也会拒绝）
    const nextActive = rows[index - 1]?.id ?? page.rootId;
    mutate("删除主题", (p) => removeShape(p, id));
    focusRow(nextActive);
  }

  /** 一段缩进文本 → 一整枝。三种入口（粘贴、批量对话框、Markdown）共用这一条路径。 */
  function insertBlock(id: string, text: string, mode: InsertMode, label: string) {
    let first = "";
    const markdown = looksLikeMarkdown(text);
    mutate(label, (p) => {
      const r = insertOutline(p, id, text, mode, markdown);
      first = r.ids[0] ?? "";
      return r.page;
    });
    if (first) focusRow(first);
    setBatch((b) => ({ ...b, open: false, text: "" }));
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>, id: string) {
    const raw = e.clipboardData.getData("text/plain");
    if (!isIndentedBlock(raw)) return;
    e.preventDefault();
    const first = raw.split(/[\r\n]+/).find((l) => l.trim() !== "") ?? "";
    // 整块比当前行更深（首行自带缩进）= 往当前行里插一枝；与当前行齐平 = 往后接同级。
    insertBlock(id, raw, /^\s/.test(first) ? "appendChildren" : "afterSibling", "粘贴大纲");
  }

  function onRowKey(e: KeyboardEvent<HTMLInputElement>, id: string, index: number) {
    if (e.key === "Tab") {
      e.preventDefault();
      changeLevel(id, e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      addSibling(id);
    } else if (e.key === "Backspace" && e.currentTarget.value === "") {
      e.preventDefault();
      removeRow(id, index);
    } else if (e.key === "ArrowUp" && !e.shiftKey) {
      const prev = rows[index - 1]?.id;
      if (prev) {
        e.preventDefault();
        focusRow(prev);
      }
    } else if (e.key === "ArrowDown" && !e.shiftKey) {
      const next = rows[index + 1]?.id;
      if (next) {
        e.preventDefault();
        focusRow(next);
      }
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
      setActiveId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#ffffff" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          borderBottom: "1px solid #eeeeee",
          flexWrap: "wrap",
        }}
      >
        <Button size="small" onClick={() => setBatch((b) => ({ ...b, open: true }))}>
          批量添加
        </Button>
        <Tooltip title="每行一个主题；行首 Tab 缩进一级。也可在行内直接粘贴一段带缩进的文本或 Markdown。">
          <span style={{ color: "#8c8c8c", fontSize: 12 }}>Tab 降级 · Shift+Tab 升级 · Enter 同级 · 上下键换行</span>
        </Tooltip>
      </div>

      {hasBiLinks ? (
        <Alert
          type="warning"
          showIcon
          banner
          message="本文档含双向链接：在大纲里改写相关主题文字可能使链接失效。"
          style={{ fontSize: 12 }}
        />
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 0 24px" }}>
        {rows.length === 0 ? (
          <Empty description="本页没有主题" style={{ marginTop: 40 }} />
        ) : (
          rows.map((row, i) => {
            const color = accentAt(palette, branchIndex(page, row.id));
            const value = draft && draft.id === row.id ? draft.text : row.text;
            return (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingLeft: 10 + row.level * INDENT,
                  paddingRight: 12,
                  background: focusId === row.id || selection.includes(row.id) ? "#f2f6ff" : undefined,
                  borderLeft: `3px solid ${row.level === 0 ? color : "transparent"}`,
                }}
              >
                <span
                  style={{ width: 16, textAlign: "center", cursor: row.hasChildren ? "pointer" : "default", color: "#8c8c8c" }}
                  title={row.hasChildren ? (row.collapsed ? "展开分支" : "折叠分支") : undefined}
                  onClick={() => {
                    if (!row.hasChildren) return;
                    const label = row.collapsed ? "展开分支" : "折叠分支";
                    mutate(label, (p) => setCollapsed(p, row.id, !row.collapsed));
                    // 与画布同一条规则：手动折叠要把它从关系线的揭示表里摘掉，否则绘制层永远当展开算。
                    if (!row.collapsed) useUi.getState().removeReveal(page.id, row.id);
                  }}
                >
                  {row.hasChildren ? (row.collapsed ? "▸" : "▾") : "·"}
                </span>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: row.level === 0 ? color : `transparent`,
                    borderBottom: `2px solid ${color}`,
                    flexShrink: 0,
                  }}
                />
                <input
                  ref={(el) => {
                    rowRefs.current[row.id] = el;
                  }}
                  value={value}
                  spellCheck={false}
                  placeholder={row.level === 0 ? "中心主题" : "子主题"}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: row.level === 0 ? 15 : 13,
                    fontWeight: row.level <= 1 ? 600 : 400,
                    padding: "5px 2px",
                    color: "#333333",
                  }}
                  onFocus={() => focusRow(row.id)}
                  onChange={(e) => {
                    setDraft({ id: row.id, text: e.target.value });
                    commitText(row.id, e.target.value);
                  }}
                  onBlur={() => setDraft(null)}
                  onKeyDown={(e) => onRowKey(e, row.id, i)}
                  onPaste={(e) => onPaste(e, row.id)}
                />
                {row.hiddenCount > 0 ? (
                  <span
                    title={`已折叠 ${row.hiddenCount} 个子主题`}
                    style={{ fontSize: 11, color: "#ffffff", background: color, borderRadius: 9, padding: "0 6px" }}
                  >
                    +{row.hiddenCount}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <Modal
        title="批量添加主题"
        open={batch.open}
        okText="插入"
        cancelText="取消"
        onCancel={() => setBatch((b) => ({ ...b, open: false }))}
        onOk={() => {
          if (batch.text.trim() === "") return;
          insertBlock(anchorId, batch.text, batch.mode, "批量添加主题");
        }}
      >
        <Segmented
          size="small"
          value={batch.mode}
          onChange={(v) => setBatch((b) => ({ ...b, mode: v as InsertMode }))}
          options={[
            { label: "作为子主题", value: "appendChildren" },
            { label: "作为同级", value: "afterSibling" },
          ]}
          style={{ marginBottom: 10 }}
        />
        <Input.TextArea
          rows={8}
          value={batch.text}
          onChange={(e) => setBatch((b) => ({ ...b, text: e.target.value }))}
          placeholder={"每行一个主题\n\tTab 缩进一级\n\tShift+Tab 上升一级\n支持直接粘贴 Markdown 列表"}
        />
        <div style={{ color: "#8c8c8c", fontSize: 12, marginTop: 8 }}>
          插入位置：{page.shapes[anchorId] ? rows.find((r) => r.id === anchorId)?.text || "（折叠中）" : "中心主题"}
        </div>
      </Modal>
    </div>
  );
}

export default OutlineView;
