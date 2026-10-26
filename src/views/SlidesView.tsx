/**
 * 幻灯片投影（doc/复刻方案/00 §3.8）：一条主分支 = 一页，前两级要点进正文。
 *
 * 页面列表是 slideDeck() 现算的，不在模型里另存一份"幻灯片"结构 ——
 * 否则改一次导图就要同步两套真相。放映态只是同一个投影的全屏渲染，
 * 它不改文档，所以只碰 useDoc 的选中态，一次 mutate 都没有。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Tag, Tooltip } from "antd";
import { slideDeck } from "../engine/projections.ts";
import { accentAt, defaultPalette } from "../engine/style.ts";
import { branchIndex, updateExtras } from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import type { Page } from "../types/model.ts";

interface SlidesViewProps {
  page: Page;
}

const PALETTE = defaultPalette();

export function SlidesView({ page }: SlidesViewProps) {
  const mutate = useDoc((s) => s.mutate);
  const deck = useMemo(() => slideDeck(page), [page]);
  const select = useDoc((s) => s.select);
  const theme = useSettings((s) => s.settings.general.theme);
  const [ix, setIx] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** 放映态跳过隐藏页；编辑态照常全部列出 —— 隐藏的那页要能取消隐藏，藏起来就找不回了。 */
  const playDeck = useMemo(() => deck.filter((s) => !s.hidden), [deck]);
  const viewDeck = playing ? playDeck : deck;
  const total = viewDeck.length;
  // 删分支之后页码可能越界：每次渲染重新夹一次，不做多余的 setState。
  const safeIx = Math.max(0, Math.min(ix, total - 1));
  const current = viewDeck[safeIx];
  const lastSelected = useRef<string | null>(null);
  /** 备注编辑走受控草稿：键是页 id，翻页自动回到该页已存的内容。 */
  const [notesDraft, setNotesDraft] = useState<{ id: string; text: string } | null>(null);

  const step = useCallback(
    (dir: 1 | -1) => setIx(Math.max(0, Math.min(total - 1, safeIx + dir))),
    [safeIx, total]
  );

  // 换页带着选中走：切回画布投影时停在刚看过的那一枝上。
  useEffect(() => {
    if (!current || lastSelected.current === current.id) return;
    lastSelected.current = current.id;
    select([current.id], current.id);
  }, [current, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Escape") {
        setPlaying(false);
      } else if (e.key === "Home") {
        setIx(0);
      } else if (e.key === "End") {
        setIx(Math.max(0, total - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, total]);

  // 放映也是业务规则的一部分：中心主题没有内容时不给放映（§3.8 硬限制）。
  const playable = (playDeck[0]?.title.trim() ?? "") !== "" && playDeck.length > 1;

  const notesValue = notesDraft?.id === current?.id ? notesDraft.text : current?.notes ?? "";
  const commitNotes = () => {
    if (!current || notesDraft?.id !== current.id) return;
    if (notesDraft.text !== (current.notes ?? "")) {
      const text = notesDraft.text;
      mutate("编辑演讲备注", (p) => updateExtras(p, current.id, { note: text }));
    }
    setNotesDraft(null);
  };
  const toggleHide = () => {
    if (!current || current.id === page.rootId) return;
    mutate(current.hidden ? "取消隐藏幻灯片" : "隐藏幻灯片", (p) =>
      updateExtras(p, current.id, { slideHidden: !current.hidden })
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--zm-bg)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "var(--zm-panel)",
          borderBottom: "1px solid var(--zm-border)",
        }}
      >
        <Button size="small" disabled={safeIx <= 0} onClick={() => step(-1)}>
          上一页
        </Button>
        <Button size="small" disabled={safeIx >= total - 1} onClick={() => step(1)}>
          下一页
        </Button>
        <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
          {safeIx + 1} / {total}
        </span>
        <span style={{ flex: 1 }} />
        <Tooltip title={current && current.id !== page.rootId ? "" : "封面页不能隐藏"}>
          <Button size="small" disabled={!current || current.id === page.rootId} onClick={toggleHide}>
            {current?.hidden ? "取消隐藏" : "隐藏本页"}
          </Button>
        </Tooltip>
        <Tooltip title={playable ? "" : "中心主题没有内容，无法放映"}>
          <Button size="small" type="primary" disabled={!playable} onClick={() => setPlaying(true)}>
            放映
          </Button>
        </Tooltip>
      </div>

      {deck.length <= 1 ? (
        <Empty description="一页 = 一条主分支：先在导图里加主分支" style={{ marginTop: 60 }} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          {current ? (
            <div
              style={{
                maxWidth: 860,
                margin: "0 auto",
                background: "var(--zm-panel)",
                borderRadius: 8,
                padding: "28px 32px",
                minHeight: 380,
                borderTop: `4px solid ${accentAt(PALETTE, branchIndex(page, current.id))}`,
                boxShadow: "var(--zm-shadow)",
              }}
            >
              <div style={{ fontSize: 24, fontWeight: 600, color: "var(--zm-text)" }}>{current.title || "（未命名页）"}</div>
              <div style={{ marginTop: 18 }}>
                {current.bullets.length === 0 ? (
                  <span style={{ color: "var(--zm-text-2)" }}>本页没有要点</span>
                ) : (
                  current.bullets.map((b) => (
                    <button
                      type="button"
                      key={b.id}
                      onClick={() => select([b.id], b.id)}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                        width: "100%",
                        border: "none",
                        background: "transparent",
                        textAlign: "left",
                        cursor: "pointer",
                        paddingLeft: b.level === 0 ? 0 : 24,
                        fontSize: b.level === 0 ? 16 : 14,
                        fontWeight: b.level === 0 ? 500 : 400,
                        color: b.level === 0 ? "var(--zm-text)" : "var(--zm-text-2)",
                        lineHeight: "30px",
                      }}
                    >
                      <span>{b.level === 0 ? "•" : "–"}</span>
                      <span>{b.text}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {current ? (
            <div style={{ maxWidth: 860, margin: "12px auto 0", background: "rgba(250,173,20,.12)", borderRadius: 6, padding: "8px 14px" }}>
              <div style={{ marginBottom: 2 }}>
                <Tag color="gold">备注</Tag>
                <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
                  直接编辑，失焦保存 —— 与画布的「附注」是同一份数据
                </span>
              </div>
              <Input.TextArea
                key={current.id}
                autoSize={{ minRows: 1, maxRows: 6 }}
                variant="borderless"
                value={notesValue}
                onChange={(e) => setNotesDraft({ id: current.id, text: e.target.value })}
                onBlur={commitNotes}
                placeholder="这一页的演讲备注…"
                style={{ background: "transparent", padding: 0, fontSize: 13 }}
              />
            </div>
          ) : null}

          <div style={{ maxWidth: 860, margin: "16px auto 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {deck.map((s, i) => (
              <button
                type="button"
                key={s.id}
                onClick={() => setIx(i)}
                title={s.title}
                aria-current={i === safeIx ? "page" : undefined}
                style={{
                  width: 84,
                  height: 52,
                  padding: 4,
                  fontSize: 11,
                  overflow: "hidden",
                  cursor: "pointer",
                  textAlign: "left",
                  borderRadius: 4,
                  background: "var(--zm-panel)",
                  color: "var(--zm-text)",
                  opacity: s.hidden ? 0.55 : 1,
                  border: i === safeIx ? "2px solid var(--zm-accent)" : s.hidden ? "1px dashed var(--zm-border)" : "1px solid var(--zm-border)",
                }}
              >
                {i + 1}. {s.title}
                {s.hidden ? <Tag style={{ marginInlineStart: 4, fontSize: 10, lineHeight: "16px" }}>隐藏</Tag> : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {playing ? (
        <div
          onClick={() => step(1)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: theme === "light" ? "#ffffff" : "#111318",
            color: theme === "light" ? "#262626" : "#f0f0f0",
            display: "flex",
            flexDirection: "column",
            padding: "6vh 8vw",
          }}
        >
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <div style={{ fontSize: 40, fontWeight: 700, marginBottom: 28 }}>{current?.title || "（未命名页）"}</div>
            {current?.bullets.map((b) => (
              <div
                key={b.id}
                style={{
                  fontSize: b.level === 0 ? 22 : 18,
                  fontWeight: b.level === 0 ? 500 : 400,
                  opacity: b.level === 0 ? 1 : 0.75,
                  paddingLeft: b.level === 0 ? 0 : 36,
                  lineHeight: "44px",
                }}
              >
                {b.level === 0 ? "• " : "– "}
                {b.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 12 }}>
            <span style={{ fontSize: 13, opacity: 0.6 }}>点击或 → 下一页 · Esc 退出放映</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 13, opacity: 0.6 }}>
              {safeIx + 1} / {total}
            </span>
            <Button size="small" onClick={(e) => { e.stopPropagation(); setPlaying(false); }}>
              退出
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default SlidesView;
