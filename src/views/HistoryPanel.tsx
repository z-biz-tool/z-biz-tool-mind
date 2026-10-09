/**
 * 历史版本 / 自动保存 / 回收站（对标亿图的"历史版本"面板）。
 *
 * 这三样是同一种东西的三种来源：都是"盘上另一份字节 + 一个时间戳"，所以共用一份 store
 * （stores/recentStore.ts）和同一套行渲染。分三个分页是因为它们的失效时机不同：
 * 保存只影响历史版本，删文件只影响回收站，自动保存是定时器在写。
 *
 * 面板不接业务 props：要恢复哪份文件、恢复完落到哪儿，全部问 docStore 与 useRecent 自己取。
 * 外壳按其它面板的习惯把当前页传进来也照收不误（下面那个可选 props 就是为此），但不使用它。
 */
import { useEffect, useState } from "react";
import { Alert, Button, Modal, Popconfirm, Tabs, message } from "antd";
import { BackupRow, EmptyState, ListSkeleton, SectionTitle } from "../_shared/index.ts";
import { QUOTA } from "../model/constants.ts";
import type { BackupEntry } from "../services/native.ts";
import { native } from "../services/native.ts";
import { useDoc } from "../stores/docStore.ts";
import { useRecent } from "../stores/recentStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { humanSize, timestampName } from "../utils/id.ts";
import type { Page } from "../types/model.ts";

interface HistoryPanelProps {
  page?: Page;
}

/**
 * native.ts 里的 fromBase64 是模块私有的（只有 Rust 侧的 base64 传输需要它）。
 * 恢复历史版本时 backupRestore 不给 target 就只回 contentBase64，这里就地解一次 ——
 * 不复用 target 那条路是刻意的：给 target 就等于覆盖写盘，见 confirmRestore 的说明。
 */
function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function baseName(p: string): string {
  const seg = p.split(/[\\/]/).pop() ?? p;
  return seg.replace(/\.emmx$/i, "") || p;
}

export function HistoryPanel(_props?: HistoryPanelProps) {
  const backups = useRecent((s) => s.backups);
  const trash = useRecent((s) => s.trash);
  const autosave = useRecent((s) => s.autosave);
  const storeError = useRecent((s) => s.error);
  const refreshBackups = useRecent((s) => s.refreshBackups);
  const refreshTrash = useRecent((s) => s.refreshTrash);
  const refreshAutosave = useRecent((s) => s.refreshAutosave);
  const deleteBackup = useRecent((s) => s.deleteBackup);
  const restoreTrash = useRecent((s) => s.restoreTrash);
  const purgeTrash = useRecent((s) => s.purgeTrash);
  const clearAutosave = useRecent((s) => s.clearAutosave);

  const path = useDoc((s) => s.path);
  // 回收站留几天归选项里的 backupKeepDays 管；0/缺值退回配额默认，别把"留 0 天"当成"全清"。
  const keepDays = useSettings((s) => s.settings.save.backupKeepDays) || QUOTA.trashKeepDays;
  const openBytes = useDoc((s) => s.openBytes);

  const [pending, setPending] = useState<BackupEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [msgApi, msgHolder] = message.useMessage();

  useEffect(() => {
    let alive = true;
    void (async () => {
      // 三个列表各自刷新：refreshAll 不含 backupList，抄它的"并发"反而少一个来源。
      await Promise.all([refreshBackups(path ?? undefined), refreshTrash(), refreshAutosave()]);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
    // path 变了要重查：新文档没历史、打开另一份要按它自己的路径筛。
  }, [path, refreshBackups, refreshTrash, refreshAutosave]);

  async function doRestore(entry: BackupEntry) {
    setPending(null);
    setBusy(true);
    try {
      const r = await native.backupRestore(entry.id);
      if (!r.contentBase64) {
        msgApi.error("服务侧没有把字节交回来，无法就地恢复。");
        return;
      }
      const ok = await openBytes(decodeBase64(r.contentBase64), null, `${entry.title}（恢复）`);
      if (ok) msgApi.success(`已恢复为「${entry.title}（恢复）」，原文件没动，确认无误后再另存。`);
      else msgApi.error(useDoc.getState().error ?? "这一份快照解析失败。");
    } catch (e) {
      msgApi.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadAutosave(itemPath: string) {
    setBusy(true);
    try {
      const bytes = await native.fileReadBytes(itemPath);
      const ok = await openBytes(bytes, null, `${baseName(itemPath)}（自动保存）`);
      if (!ok) msgApi.error(useDoc.getState().error ?? "这份自动保存快照解析失败。");
    } catch (e) {
      msgApi.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function purgeOldTrash() {
    try {
      // store 里只有 purgeBackup（清的是历史版本），回收站的按时清理没有对应 action，只能直连 native；
      // 因此这里必须自己补一次 refreshTrash，否则列表还在显示刚被删掉的行。
      const n = await native.trashPurgeOlderThan(keepDays);
      await refreshTrash();
      msgApi.success(
        n ? `已清理 ${n} 项超过 ${keepDays} 天的回收站条目` : "没有超期的回收站条目"
      );
    } catch (e) {
      msgApi.error(e instanceof Error ? e.message : String(e));
    }
  }

  const body = !ready ? (
    <ListSkeleton rows={5} />
  ) : (
    <Tabs
      size="small"
      items={[
        {
          key: "backup",
          label: `历史版本 ${backups.length}`,
          children: (
            <div>
              {path ? (
                <SectionTitle
                  extra={<RefreshButton onClick={() => void refreshBackups(path ?? undefined)} />}
                >
                  {baseName(path)}
                </SectionTitle>
              ) : (
                <SectionTitle extra={<RefreshButton onClick={() => void refreshBackups()} />}>
                  未存盘的新文档 · 显示全部
                </SectionTitle>
              )}
              {backups.length === 0 ? (
                <EmptyState
                  title="还没有历史版本"
                  description={`每次存盘（以及覆盖写之前）都会留一份，最多 ${QUOTA.historyMax} 份。要让这里有内容，先去 选项 → 保存 打开“每次保存都留一份”。`}
                />
              ) : (
                backups.map((e) => (
                  <BackupRow
                    key={e.id}
                    entry={e}
                    onRestore={setPending}
                    onDelete={(x) => void deleteBackup(x.id)}
                  />
                ))
              )}
            </div>
          ),
        },
        {
          key: "autosave",
          label: `自动保存 ${autosave.length}`,
          children: (
            <div>
              <SectionTitle
                extra={
                  <Popconfirm
                    title={`删掉自动保存目录里的全部 ${autosave.length} 份快照？`}
                    description="一键就能删空，所以问一句：清掉之后崩溃就没有可恢复的那一份了，找不回来。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void clearAutosave()}
                  >
                    <Button size="small" danger disabled={autosave.length === 0}>
                      清空快照
                    </Button>
                  </Popconfirm>
                }
              >
                定时器写出来的快照
              </SectionTitle>
              {autosave.length === 0 ? (
                <EmptyState
                  title="没有自动保存快照"
                  description="去 选项 → 保存 里打开“自动保存”，并按分钟设好间隔；崩溃后能从这一份接着做。"
                />
              ) : (
                autosave.map((a) => (
                  <div key={a.path} className="zm-row">
                    <div className="zm-row-body">
                      <div className="zm-row-title">{baseName(a.path)}</div>
                      <div className="zm-row-meta">
                        <span>{timestampName(new Date(a.modifiedAt))}</span>
                        <span>{humanSize(a.size)}</span>
                        <span className="zm-path">{a.path}</span>
                      </div>
                    </div>
                    <div className="zm-row-actions">
                      <button
                        type="button"
                        className="zm-btn"
                        disabled={busy}
                        onClick={() => void loadAutosave(a.path)}
                      >
                        载入
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          ),
        },
        {
          key: "trash",
          label: `回收站 ${trash.length}`,
          children: (
            <div>
              <SectionTitle
                extra={
                  <Button
                    size="small"
                    disabled={trash.length === 0}
                    onClick={() => void purgeOldTrash()}
                  >
                    清理 {keepDays} 天前
                  </Button>
                }
              >
                被删掉的文件
              </SectionTitle>
              {trash.length === 0 ? (
                <EmptyState
                  title="回收站是空的"
                  description={`删除的脑图在这儿留 ${keepDays} 天。`}
                />
              ) : (
                trash.map((t) => (
                  <div key={t.id} className="zm-row">
                    <div className="zm-row-body">
                      <div className="zm-row-title">{t.title}</div>
                      <div className="zm-row-meta">
                        <span>{timestampName(new Date(t.createdAt))}</span>
                        <span>{humanSize(t.size)}</span>
                        <span className="zm-path">{t.docPath}</span>
                      </div>
                    </div>
                    <div className="zm-row-actions">
                      <button
                        type="button"
                        className="zm-btn"
                        onClick={() => void restoreTrash(t.id)}
                      >
                        放回原处
                      </button>
                      <Popconfirm
                        title="彻底删除？"
                        description="不再保留，无法找回。"
                        okText="彻底删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void purgeTrash(t.id)}
                      >
                        <button type="button" className="zm-btn zm-btn-ghost">
                          彻底删除
                        </button>
                      </Popconfirm>
                    </div>
                  </div>
                ))
              )}
            </div>
          ),
        },
      ]}
    />
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        padding: "0 2px",
      }}
    >
      {msgHolder}
      {storeError ? (
        <Alert type="error" showIcon message={storeError} style={{ margin: 8, fontSize: 12 }} />
      ) : null}
      {body}

      {/*
        确认框用受控 Modal 而不是 Modal.confirm：antd v6 的类型里 Modal 只剩
        info/success/error/warning（静态 confirm 被降级，运行时还在但 d.ts 里没有），
        useModal 给的 HookAPI 同样不带 confirm。用受控 Modal 既不违反"禁 @ts-ignore"，
        也正好放得下那段长说明。
      */}
      <Modal
        title="恢复这一份历史版本？"
        open={pending !== null}
        okText="就地恢复"
        cancelText="取消"
        confirmLoading={busy}
        onCancel={() => setPending(null)}
        onOk={() => {
          if (pending) void doRestore(pending);
        }}
      >
        {pending ? (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div>
              {pending.title} · {timestampName(new Date(pending.createdAt))} ·{" "}
              {humanSize(pending.size)}
            </div>
            <div style={{ marginTop: 8, color: "var(--zm-text-2)", fontSize: 12 }}>
              恢复只把这份快照读进当前画布，并另起一个"（恢复）"标题，不覆盖盘上的原文件。
              直接覆盖写会当场丢掉你现在还没保存的改动，而且撤销栈活不过重新打开 ——
              一旦发现恢复错了，连"撤销回上一份"这条退路都没有。确认无误后再用另存为落盘。
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="zm-btn zm-btn-ghost" onClick={onClick}>
      刷新
    </button>
  );
}

export default HistoryPanel;
