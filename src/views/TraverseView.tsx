/**
 * 浏览 / 演讲投影（doc/复刻方案/00 §3.10）：一次只看一个主题。
 *
 * 序列就是 traverseSequence()（可见子树前序，和大纲行序一模一样），
 * 所以"浏览到第 3 个"和"大纲第 3 行"、"画布选中第 3 个主题"永远是同一个 id ——
 * 这是 P-1 的验收点：三处之间来回跳不需要任何同步代码。
 * 游标按 id 存而不是按下标存：折叠或改树之后下标会漂移，id 不会。
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Progress, Tag, Tooltip } from "antd";
import { traverseFocus, traverseSequence } from "../engine/projections.ts";
import { ancestors, branchIndex, children, levelOf, setCollapsed } from "../engine/tree.ts";
import { accentAt, defaultPalette } from "../engine/style.ts";
import { useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { plainText } from "../types/model.ts";
import type { Page } from "../types/model.ts";

interface TraverseViewProps {
  page: Page;
}

const PALETTE = defaultPalette();

export function TraverseView({ page }: TraverseViewProps) {
  const seq = useMemo(() => traverseSequence(page), [page]);
  const focusId = useDoc((s) => s.focusId);
  const select = useDoc((s) => s.select);
  const mutate = useDoc((s) => s.mutate);
  const setProjection = useUi((s) => s.setProjection);
  const displayLevels = useUi((s) => s.displayLevels);
  const [cursor, setCursor] = useState<string | null>(null);

  const atCursor = cursor && seq.includes(cursor) ? cursor : null;
  const id = atCursor ?? (focusId && seq.includes(focusId) ? focusId : (seq[0] ?? ""));
  const ix = id ? seq.indexOf(id) : -1;
  const shape = id ? page.shapes[id] : undefined;
  const path = useMemo(() => (id ? ancestors(page, id).reverse() : []), [page, id]);
  const kids = useMemo(() => (id ? children(page, id) : []), [page, id]);
  const branchId = id ? traverseFocus(page, id) : page.rootId;
  const color = accentAt(PALETTE, branchIndex(page, id || page.rootId));

  function go(dir: 1 | -1) {
    const next = seq[Math.max(0, Math.min(seq.length - 1, ix + dir))];
    if (!next || next === id) return;
    setCursor(next);
    select([next], next);
  }

  function jumpTo(target: string, toMap = false) {
    setCursor(target);
    select([target], target);
    if (toMap) setProjection("mindmap");
  }

  useEffect(() => {
    // 故意不写依赖数组：闭包要读到最新的 seq/id，每次渲染重挂一次的成本远低于把依赖列全后漏挂。
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Enter") {
        // 回车 = "就讲这个，回到画布"：遍历的终点永远是画布
        jumpTo(id, true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const hiddenBranches = useMemo(
    () => Object.values(page.shapes).filter((s) => s.extras.collapsed && s.childIds.length > 0).length,
    [page]
  );

  if (!shape) {
    return <Empty description="本页没有可遍历的主题" style={{ marginTop: 60 }} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#f5f6f8" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#ffffff", borderBottom: "1px solid #eeeeee" }}>
        <Button size="small" disabled={ix <= 0} onClick={() => go(-1)}>
          上一个
        </Button>
        <Button size="small" disabled={ix >= seq.length - 1} onClick={() => go(1)}>
          下一个
        </Button>
        <span style={{ fontSize: 12, color: "#8c8c8c" }}>
          {ix + 1} / {seq.length}
        </span>
        <Tooltip title="折叠起来的分支不在这个序列里（§3.10「隐藏未遍历内容」）">
          <span>
            <Button
              size="small"
              disabled={hiddenBranches === 0}
              onClick={() =>
                mutate("展开全部分支", (p) =>
                  Object.values(p.shapes).reduce((acc, s) => (s.extras.collapsed ? setCollapsed(acc, s.id, false) : acc), p)
                )
              }
            >
              展开全部{hiddenBranches ? `（${hiddenBranches}）` : ""}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={`把超过「显示层级 ${displayLevels} 级」的分支都折起来，只讲前几层`}>
          <span>
            <Button
              size="small"
              onClick={() =>
                mutate("按显示层级折叠", (p) =>
                  Object.values(p.shapes).reduce(
                    (acc, s) => (s.childIds.length > 0 && levelOf(p, s.id) >= displayLevels ? setCollapsed(acc, s.id, true) : acc),
                    p
                  )
                )
              }
            >
              只留 {displayLevels} 级
            </Button>
          </span>
        </Tooltip>
        <span style={{ flex: 1 }} />
        <Button size="small" type="primary" onClick={() => jumpTo(id, true)}>
          回到导图
        </Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div
          style={{
            maxWidth: 760,
            width: "100%",
            background: "#ffffff",
            borderRadius: 10,
            padding: "32px 36px",
            borderTop: `4px solid ${color}`,
            boxShadow: "0 2px 12px rgba(0,0,0,.06)",
          }}
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12, color: "#8c8c8c", marginBottom: 14 }}>
            {path.map((p) => (
              <Tag key={p} style={{ cursor: "pointer" }} onClick={() => jumpTo(p)}>
                {plainText(page.shapes[p]?.text ?? { paragraphs: [], characters: [] }) || "（空）"}
              </Tag>
            ))}
            {path.length === 0 ? <Tag>中心主题</Tag> : null}
          </div>
          <div style={{ fontSize: id === page.rootId ? 32 : 26, fontWeight: 600, color: "#262626", lineHeight: 1.5, wordBreak: "break-word" }}>
            {plainText(shape.text) || "（空主题）"}
          </div>
          {shape.extras.note ? (
            <div style={{ marginTop: 18, whiteSpace: "pre-wrap", fontSize: 13, color: "#595959", background: "#fafafa", borderRadius: 6, padding: "10px 12px" }}>
              {shape.extras.note}
            </div>
          ) : null}

          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 8 }}>下一层（{kids.length}）</div>
            {kids.length === 0 ? (
              <span style={{ fontSize: 13, color: "#bfbfbf" }}>这一支讲完了</span>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {kids.map((k) => (
                  <Tag key={k.id} color="blue" style={{ cursor: "pointer" }} onClick={() => jumpTo(k.id)}>
                    {plainText(k.text) || "（空）"}
                  </Tag>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginTop: 26 }}>
            <Progress percent={seq.length ? Math.round(((ix + 1) / seq.length) * 100) : 0} size="small" strokeColor={color} />
            <div style={{ fontSize: 12, color: "#bfbfbf" }}>
              当前分支：{plainText(page.shapes[branchId]?.text ?? { paragraphs: [], characters: [] }) || "中心主题"} · 空格 / → 下一个，← 上一个，回车回到导图
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TraverseView;
