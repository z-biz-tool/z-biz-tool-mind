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
import { Button, Checkbox, Input, Segmented, message } from "antd";
import { EmptyState, SectionTitle } from "../_shared/index.ts";
import {
  findMatches,
  findMatchesDoc,
  hiddenMatchCount,
  hiddenMatchCountDoc,
  matchCount,
  replaceAll,
  replaceAllDoc,
  revealShape,
  stepIndex,
} from "../engine/search.ts";
import type { DocMatch } from "../engine/search.ts";
import { updateExtras, updateText } from "../engine/tree.ts";
import { activeDoc, useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { plainText } from "../types/model.ts";
import type { Page } from "../types/model.ts";

interface SearchPanelProps {
  /** 当前活动页：范围选"只搜当前页"时用它，选"所有页"时它只用来判断要不要切页。 */
  page: Page;
}

export function SearchPanel({ page }: SearchPanelProps) {
  const query = useUi((s) => s.searchQuery);
  const inText = useUi((s) => s.inText);
  const inNote = useUi((s) => s.inNote);
  const inLabel = useUi((s) => s.inLabel);
  const includeHidden = useUi((s) => s.includeHidden);
  const allPages = useUi((s) => s.searchAllPages);
  const caseSensitive = useUi((s) => s.caseSensitive);
  const wholeWord = useUi((s) => s.wholeWord);
  const activeMatch = useUi((s) => s.activeMatch);
  const setSearch = useUi((s) => s.setSearch);
  const setActiveMatch = useUi((s) => s.setActiveMatch);

  const doc = useDoc((s) => activeDoc(s));
  const mutate = useDoc((s) => s.mutate);
  const mutateDoc = useDoc((s) => s.mutateDoc);
  const patchPage = useDoc((s) => s.patchPage);
  const select = useDoc((s) => s.select);
  const switchPage = useDoc((s) => s.switchPage);

  const [replacement, setReplacement] = useState("");
  const [msgApi, msgHolder] = message.useMessage();

  const opts = useMemo(
    () => ({ caseSensitive, wholeWord, inText, inNote, inLabel, includeHidden }),
    [caseSensitive, wholeWord, inText, inNote, inLabel, includeHidden]
  );
  /** 命中表统一成带 pageId 的形状：单页搜索时所有行都挂在当前页上。 */
  const matches = useMemo<DocMatch[]>(() => {
    if (!query) return [];
    if (allPages && doc) return findMatchesDoc(doc, query, opts);
    return findMatches(page, query, opts).map((m) => ({ ...m, pageId: page.id }));
  }, [allPages, doc, page, query, opts]);
  /** 被折叠藏起来的命中数：搜不到时要靠它区分"真没有"和"看不见"。 */
  const hiddenLeft = useMemo(
    () =>
      query === ""
        ? 0
        : allPages && doc
          ? hiddenMatchCountDoc(doc, query, opts)
          : hiddenMatchCount(page, query, opts),
    [allPages, doc, page, query, opts]
  );

  /** 按主题聚合：命中若干次的主题只占一行，行尾给这一枝的命中数。 */
  const grouped = useMemo(() => {
    const order: string[] = [];
    for (const m of matches) {
      const key = `${m.pageId}:${m.shapeId}`;
      if (!order.includes(key)) order.push(key);
    }
    return order.map((key) => {
      const [pageId, id] = key.split(":");
      const inShape = matches.filter((m) => m.pageId === pageId && m.shapeId === id);
      const p = doc?.pages.find((x) => x.id === pageId) ?? (pageId === page.id ? page : undefined);
      const s = p?.shapes[id];
      return {
        pageId,
        pageName: p?.name ?? "",
        id,
        count: matchCount(inShape, id),
        text: s ? plainText(s.text) : "",
        first: matches.indexOf(inShape[0]),
      };
    });
  }, [matches, doc, page]);

  function pageOf(id: string): Page | undefined {
    return id === page.id ? page : doc?.pages.find((p) => p.id === id);
  }

  function goTo(index: number) {
    const m = matches[index];
    if (!m) return;
    setActiveMatch(index);
    // 跨页命中要先切过去：switchPage 会把选中重置成新页根主题，所以 select 必须在它后面。
    if (m.pageId !== page.id) switchPage(m.pageId);
    select([m.shapeId], m.shapeId);
    // 折叠的祖先要展开，否则跳过去看不见 —— 但这里用的是 patchPage 而不是 mutate：
    // 展开折叠确实是文档状态（extras.collapsed 会落进 .emmx），可"进不进撤销栈"是业务决定。
    // 用户按 Ctrl+Z 想撤的是他改过的内容，不是"我搜过一次"；亿图的查找正是展开分支却不留历史。
    // 判据用引用相等：revealShape 什么都没展开时原样返回同一个 page，那种情况下不该写 present。
    const target = pageOf(m.pageId);
    if (target && revealShape(target, m.shapeId) !== target) {
      patchPage((p) => revealShape(p, m.shapeId));
    }
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

  /** 单个替换：engine/search.ts 只提供整页替换，这一处按 Match 的偏移就地拼一次。 */
  function replaceOne(m: DocMatch) {
    // 标签和评论的命中只用来定位：它们是结构化字段，改一个字符就可能把角标颜色、作者、时间一起改坏。
    if (m.field === "label" || m.field === "comment") {
      msgApi.info("标签和评论的命中只做定位，要改请用主题信息面板里的对应入口。");
      return;
    }
    if (m.pageId !== page.id) switchPage(m.pageId);
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
    // 范围是"所有页"时走文档级写入口：一次撤销要能整批撤回，而不是每页一条历史。
    const ok =
      allPages && doc
        ? mutateDoc("替换", (d) => {
            const r = replaceAllDoc(d, query, replacement, opts);
            count = r.count;
            return r.doc;
          })
        : mutate("替换", (p) => {
            const r = replaceAll(p, query, replacement, opts);
            count = r.count;
            return r.page;
          });
    if (!ok) return;
    // 命中表整个变了，游标归零让用户重新 Enter 定位；猜一个可能已错位的下标不如不猜。
    setActiveMatch(-1);
    // 0 处命中不是"成功"：什么都没改，别用 success 的绿勾让用户以为替换发生过。
    if (!count) {
      msgApi.warning("没有匹配到的内容，什么也没改。");
      return;
    }
    msgApi.success(`已替换 ${count} 处`);
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Segmented
            size="small"
            options={[
              { label: "当前页", value: "page" },
              { label: "所有页", value: "doc" },
            ]}
            value={allPages ? "doc" : "page"}
            onChange={(v) => setSearch({ searchAllPages: v === "doc" })}
          />
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, flexWrap: "wrap" }}
        >
          <Check label="正文" checked={inText} onChange={(v) => setSearch({ inText: v })} />
          <Check label="备注·评论" checked={inNote} onChange={(v) => setSearch({ inNote: v })} />
          <Check label="标签" checked={inLabel} onChange={(v) => setSearch({ inLabel: v })} />
          <Check
            label="含隐藏"
            checked={includeHidden}
            onChange={(v) => setSearch({ includeHidden: v })}
          />
          <Check
            label="区分大小写"
            checked={caseSensitive}
            onChange={(v) => setSearch({ caseSensitive: v })}
          />
          <Check label="全词" checked={wholeWord} onChange={(v) => setSearch({ wholeWord: v })} />
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
            description={
              hiddenLeft > 0
                ? `另有 ${hiddenLeft} 处藏在折叠起来的分支里，勾上“含隐藏”再搜一次。`
                : "换关键词，或把上面的“正文 / 备注·评论 / 标签 / 全词”组合调一下。"
            }
          />
        ) : (
          <>
            <SectionTitle>
              {`命中 ${matches.length} 处 · ${grouped.length} 个主题`}
              {hiddenLeft > 0 ? ` · 另有 ${hiddenLeft} 处被折叠藏住` : ""}
            </SectionTitle>
            {grouped.map((g) => {
              const on =
                activeMatch >= 0 &&
                matches[activeMatch]?.shapeId === g.id &&
                matches[activeMatch]?.pageId === g.pageId;
              return (
                <div
                  key={`${g.pageId}:${g.id}`}
                  className="zm-row"
                  style={on ? { background: "var(--zm-hover)" } : undefined}
                >
                  <div className="zm-row-body">
                    <button type="button" className="zm-link" onClick={() => goTo(g.first)}>
                      {g.text === "" ? "（空主题）" : g.text}
                    </button>
                    <div className="zm-row-meta">
                      {allPages ? <span className="zm-tag">{g.pageName}</span> : null}
                      <span className="zm-tag">{g.count} 处</span>
                      <span className="zm-path">{matches[g.first]?.preview ?? ""}</span>
                    </div>
                  </div>
                  <div className="zm-row-actions">
                    <button
                      type="button"
                      className="zm-btn zm-btn-ghost"
                      onClick={() => goTo(g.first)}
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

/** 六个开关压成两行：侧栏只有 320px，各占一行会把命中列表顶出可视区。 */
function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Checkbox
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      style={{ fontSize: 12 }}
    >
      {label}
    </Checkbox>
  );
}

export default SearchPanel;
