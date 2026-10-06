/**
 * 查找与替换侧栏（Ribbon「查找」/ Ctrl+F，挂在外壳的 aside 里，不是对话框）。
 *
 * 为什么是侧栏：亿图搜的时候还要看着图改 —— 模态对话框会把画布盖住，
 * "第 3 / 共 12 处"这个信息就失去了意义，用户没法确认自己跳到哪儿了。
 *
 * 命中表（engine/search.findMatches）每次渲染现算，不缓存：
 * 缓存要在"改树""改折叠""改查询"三处失效，漏一处就出现"搜到了但跳不过去"，
 * 而这一页的主题数量级（几百）里现算一次正则的成本读不出来。
 */
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button, Input, Switch, message } from "antd";
import { EmptyState, SectionTitle } from "../_shared/index.ts";
import { findMatches, matchCount, replaceAll, revealShape, stepIndex } from "../engine/search.ts";
import type { Match } from "../engine/search.ts";
import { updateExtras, updateText } from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { plainText } from "../types/model.ts";
import type { Page } from "../types/model.ts";

interface SearchPanelProps {
  /** 当前活动页：外壳传的就是 activePage，查找只在这一页里跳（亿图也是每页各搜各的）。 */
  page: Page;
}

export function SearchPanel({ page }: SearchPanelProps) {
  const query = useUi((s) => s.searchQuery);
  const inNote = useUi((s) => s.inNote);
  const caseSensitive = useUi((s) => s.caseSensitive);
  const wholeWord = useUi((s) => s.wholeWord);
  const activeMatch = useUi((s) => s.activeMatch);
  const setSearch = useUi((s) => s.setSearch);
  const setActiveMatch = useUi((s) => s.setActiveMatch);

  const mutate = useDoc((s) => s.mutate);
  const patchPage = useDoc((s) => s.patchPage);
  const select = useDoc((s) => s.select);

  const [replacement, setReplacement] = useState("");
  const [msgApi, msgHolder] = message.useMessage();

  const opts = useMemo(
    () => ({ caseSensitive, wholeWord, inNote }),
    [caseSensitive, wholeWord, inNote]
  );
  const matches = useMemo(() => findMatches(page, query, opts), [page, query, opts]);

  /** 按主题聚合：命中若干次的主题只占一行，行尾给这一枝的命中数。 */
  const grouped = useMemo(() => {
    const order: string[] = [];
    for (const m of matches) if (!order.includes(m.shapeId)) order.push(m.shapeId);
    return order.map((id) => {
      const s = page.shapes[id];
      return { id, count: matchCount(matches, id), text: s ? plainText(s.text) : "" };
    });
  }, [matches, page]);

  function goTo(index: number) {
    const m = matches[index];
    if (!m) return;
    setActiveMatch(index);
    select([m.shapeId], m.shapeId);
    // 折叠的祖先要展开，否则跳过去看不见 —— 但这里用的是 patchPage 而不是 mutate：
    // 展开折叠确实是文档状态（extras.collapsed 会落进 .emmx），可"进不进撤销栈"是业务决定。
    // 用户按 Ctrl+Z 想撤的是他改过的内容，不是"我搜过一次"；亿图的查找正是展开分支却不留历史。
    // 判据用引用相等：revealShape 什么都没展开时原样返回同一个 page，那种情况下不该写 present。
    const revealed = revealShape(page, m.shapeId);
    if (revealed !== page) patchPage((p) => revealShape(p, m.shapeId));
  }

  function step(dir: 1 | -1) {
    if (!matches.length) return;
    const next = stepIndex(activeMatch, matches.length, dir);
    if (next >= 0) goTo(next);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  }

  /** 单个替换：engine/search.ts 只提供 replaceAll，这一处按 Match 的偏移就地拼一次。 */
  function replaceOne(m: Match) {
    mutate("替换", (p) => {
      const s = p.shapes[m.shapeId];
      if (!s) return p;
      if (m.field === "note") {
        const note = s.extras.note ?? "";
        return updateExtras(p, m.shapeId, {
          note: note.slice(0, m.start) + replacement + note.slice(m.start + m.length),
        });
      }
      const text = plainText(s.text);
      return updateText(
        p,
        m.shapeId,
        text.slice(0, m.start) + replacement + text.slice(m.start + m.length)
      );
    });
    // 走 updateText 就意味着这一枝的段内混排没了 —— 和 replaceAll 同一个已知取舍，不再另开一条富文本 diff。
    setActiveMatch(-1);
  }

  function replaceCurrentOrAll(all: boolean) {
    if (!query) return;
    if (!all) {
      const m = matches[activeMatch];
      if (!m) {
        msgApi.info("先按 Enter 定位一个命中，再替换当前这一处。");
        return;
      }
      replaceOne(m);
      return;
    }
    let count = 0;
    const ok = mutate("替换", (p) => {
      const r = replaceAll(p, query, replacement, opts);
      count = r.count;
      return r.page;
    });
    if (!ok) return;
    // 命中表整个变了，游标归零让用户重新 Enter 定位；猜一个可能已错位的下标不如不猜。
    setActiveMatch(-1);
    msgApi.success(count ? `已替换 ${count} 处` : "没有匹配到的内容");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {msgHolder}
      <div
        style={{
          padding: 10,
          borderBottom: "1px solid var(--zm-border)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <Input
          size="small"
          autoFocus
          allowClear
          placeholder="查找内容"
          value={query}
          onChange={(e) => setSearch({ searchQuery: e.target.value })}
          onKeyDown={onKey}
        />
        <div
          style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, flexWrap: "wrap" }}
        >
          <SwitchLine label="备注" checked={inNote} onChange={(v) => setSearch({ inNote: v })} />
          <SwitchLine
            label="区分大小写"
            checked={caseSensitive}
            onChange={(v) => setSearch({ caseSensitive: v })}
          />
          <SwitchLine
            label="全词"
            checked={wholeWord}
            onChange={(v) => setSearch({ wholeWord: v })}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Button size="small" disabled={!matches.length} onClick={() => step(-1)}>
            上一个
          </Button>
          <Button size="small" disabled={!matches.length} onClick={() => step(1)}>
            下一个
          </Button>
          <span style={{ fontSize: 12, color: "var(--zm-text-2)", marginLeft: "auto" }}>
            {query === "" ? "输入要查找的文字" : posLabel(activeMatch, matches.length)}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Input
            size="small"
            placeholder="替换为"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              replaceCurrentOrAll(false);
            }}
          />
          <Button size="small" disabled={query === ""} onClick={() => replaceCurrentOrAll(false)}>
            替换
          </Button>
          <Button size="small" disabled={query === ""} onClick={() => replaceCurrentOrAll(true)}>
            全部
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {query === "" ? (
          <EmptyState
            title="查找"
            description="Enter 跳到下一个命中，Shift+Enter 回到上一个；命中所在主题会被选中。"
          />
        ) : matches.length === 0 ? (
          <EmptyState
            title={`没有「${query}」`}
            description="换关键词，或把上面的“备注 / 全词 / 区分大小写”组合调一下。"
          />
        ) : (
          <>
            <SectionTitle>
              命中 {matches.length} 处 · {grouped.length} 个主题
            </SectionTitle>
            {grouped.map((g) => {
              const first = matches.findIndex((m) => m.shapeId === g.id);
              const on = activeMatch >= 0 && matches[activeMatch]?.shapeId === g.id;
              return (
                <div
                  key={g.id}
                  className="zm-row"
                  style={on ? { background: "var(--zm-hover)" } : undefined}
                >
                  <div className="zm-row-body">
                    <button type="button" className="zm-link" onClick={() => goTo(first)}>
                      {g.text === "" ? "（空主题）" : g.text}
                    </button>
                    <div className="zm-row-meta">
                      <span className="zm-tag">{g.count} 处</span>
                      <span className="zm-path">{matches[first]?.preview ?? ""}</span>
                    </div>
                  </div>
                  <div className="zm-row-actions">
                    <button
                      type="button"
                      className="zm-btn zm-btn-ghost"
                      onClick={() => goTo(first)}
                    >
                      定位
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function posLabel(active: number, total: number): string {
  if (total === 0) return "共 0 处";
  return active < 0 ? `共 ${total} 处 · 未定位` : `第 ${active + 1} / 共 ${total}`;
}

/** 三个开关挤在一行：侧栏只有 320px，各占一行会把命中列表顶出可视区。 */
function SwitchLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
      <Switch size="small" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

export default SearchPanel;
