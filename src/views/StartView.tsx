/**
 * 开始页（对标亿图脑图的落地页：新建 + 最近文件）。
 *
 * 它只负责"把人领进一个文档"：读文档、写文档、脏检查一律不碰。
 * "打开"这条按钮自己弹选择框，拿到**真路径**再交给外壳的 onOpen —— 传一个空串当
 * "该你自己弹选择框"的暗号是最容易长出来的那种 bug：它一路走进 openPath，
 * 最后落在用户脸上的是一句"读取文件失败"，没人看得出起点是这里。
 * 反过来"要不要先问保存"仍然归外壳（Shell 手里才有脏标记和 Ctrl+O 那一份快捷键），
 * 所以这里不判 dirtyOf，选了路径就交出去。
 */
import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
import { EmptyState, ListSkeleton, RecentRow, SectionTitle } from "../_shared/index.ts";
import { IMPORT_EXTENSIONS } from "../engine/import/index.ts";
import { QUOTA } from "../model/constants.ts";
import { native, pickOpenPath } from "../services/native.ts";
import { useRecent } from "../stores/recentStore.ts";

interface StartViewProps {
  onNew: () => void;
  /** 拿到一个**确定的路径**再回调；外壳只管"读这个路径"，不参与选文件。 */
  onOpen: (path: string) => void;
  onImport: () => void;
}

/** 选择框只收 .emmx：其余格式走"导入"那条按钮，两条路径的错误文案不一样，合在一起没法解释。 */
const EMMX_FILTER = [{ name: "亿图脑图文件", extensions: ["emmx"] }];

export function StartView({ onNew, onOpen, onImport }: StartViewProps) {
  const recent = useRecent((s) => s.recent);
  const storeError = useRecent((s) => s.error);
  const refreshRecent = useRecent((s) => s.refreshRecent);
  const removeRecent = useRecent((s) => s.removeRecent);
  const deleteFile = useRecent((s) => s.deleteFile);
  const togglePin = useRecent((s) => s.togglePin);
  const clearRecent = useRecent((s) => s.clearRecent);
  /** 首屏骨架屏自己记账：refreshRecent 不置 loading（只有 refreshAll 会），借 store 的 loading 会一直 false。 */
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await refreshRecent();
      const list = useRecent.getState().recent;
      // 只在桌面模式查"文件还在不在"：浏览器里的 fileExists 只认本标签页选过的句柄，
      // 拿 localStorage 的最近列表去查会得到一整屏"已丢失"的假警报。
      // 单个查询失败当"还在"处理 —— 虚警比漏警难解释，用户会以为我们把文件弄丢了。
      const flags = native.available
        ? await Promise.all(list.map((it) => native.fileExists(it.path).catch(() => true)))
        : list.map(() => true);
      if (!alive) return;
      const map: Record<string, boolean> = {};
      list.forEach((it, i) => {
        map[it.path] = flags[i] !== true;
      });
      setMissing(map);
      setReady(true);
    })();
    // 只查一次：这一页活着的期间文件被挪走不值得实时盯，重新挂载再重查。
    return () => {
      alive = false;
    };
  }, [refreshRecent]);

  const missingCount = recent.filter((it) => missing[it.path]).length;

  async function removeItem(path: string) {
    await removeRecent(path);
    setNotice(`已从最近列表移除：${path}`);
  }

  // 删除失败时 store 已经把原生错误写进 storeError，这里不再叠一句"删除失败"。
  async function deleteItem(path: string) {
    if (await deleteFile(path))
      setNotice(
        `已删除文件，${QUOTA.trashKeepDays} 天内可在“历史与备份 → 回收站”放回原处：${path}`
      );
  }

  async function clearAll() {
    if (recent.length === 0) return;
    await clearRecent();
    setNotice(`最近文件列表已清空（上限本来就是 ${QUOTA.recentMax} 条）`);
  }

  async function pickAndOpen() {
    // 先拿到真路径再交给外壳，而不是传一个 "" 让外壳猜"这是让我自己弹选择框"：
    // 空串会一路走进 openPath，最后变成"读取文件失败"那种读不出原因的报错。
    const path = await pickOpenPath({ title: "打开脑图", filters: EMMX_FILTER });
    if (path) onOpen(path);
  }

  async function reveal(item: { path: string }) {
    // revealInFolder 在浏览器模式里是"必然失败"的命令，失败文案要读得出原因，不能抛进控制台。
    try {
      await native.revealInFolder(item.path);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "18px 22px 32px",
        background: "var(--zm-bg)",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--zm-text)" }}>开始</div>
      <div style={{ fontSize: 12, color: "var(--zm-text-2)", marginTop: 2 }}>
        新建一个脑图，或者接着上次打开的那份继续。
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0 18px" }}>
        <Button type="primary" onClick={onNew}>
          新建空白脑图
        </Button>
        <Button onClick={() => void pickAndOpen()}>打开 .emmx</Button>
        <Button onClick={onImport} title={`可导入 ${IMPORT_EXTENSIONS.join(" ")}`}>
          从 XMind · Markdown · OPML 导入
        </Button>
      </div>

      <SectionTitle
        extra={
          <button
            type="button"
            className="zm-btn zm-btn-ghost"
            disabled={recent.length === 0}
            onClick={() => void clearAll()}
          >
            清空
          </button>
        }
      >
        最近文件
      </SectionTitle>

      {storeError || notice ? (
        <Alert
          type={storeError ? "error" : "info"}
          showIcon
          message={storeError ?? notice ?? ""}
          onClose={() => setNotice(null)}
          closable={!storeError}
          style={{ margin: "0 0 8px", fontSize: 12 }}
        />
      ) : null}

      {/* 整表提示只说数量，路径逐行标：用户要处理的是"具体哪一条"，一排路径堆在顶上读不出来。 */}
      {ready && missingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${missingCount} 个最近文件在原位置找不到了（可能被移动或重命名）。点开仍会尝试读取，失败时给原生错误。`}
          style={{ margin: "0 0 8px", fontSize: 12 }}
        />
      ) : null}

      {!ready ? (
        <ListSkeleton rows={6} />
      ) : recent.length === 0 ? (
        <EmptyState
          title="还没有打开过脑图"
          description={`亿图的最近文件最多留 ${QUOTA.recentMax} 条，存满后按打开时间淘汰最旧的一条，被固定住的那些不参与淘汰；点“新建空白脑图”开始第一条。`}
          action={
            <Button type="primary" onClick={onNew}>
              新建空白脑图
            </Button>
          }
        />
      ) : (
        <div
          style={{
            background: "var(--zm-panel)",
            border: "1px solid var(--zm-border)",
            borderRadius: 6,
          }}
        >
          {recent.map((item) => (
            <div key={item.path}>
              <RecentRow
                item={item}
                onOpen={(it) => onOpen(it.path)}
                onRemove={(it) => void removeItem(it.path)}
                onPin={(it) => void togglePin(it.path)}
                onReveal={native.available ? (it) => void reveal(it) : undefined}
                onDelete={missing[item.path] ? undefined : (it) => void deleteItem(it.path)}
              />
              {missing[item.path] ? (
                <div className="zm-row-meta" style={{ padding: "0 12px 8px" }}>
                  <span className="zm-tag">文件已不在原位置</span>
                  <span>重新定位后请用“打开 .emmx”选一次，列表会按新路径记下。</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default StartView;
