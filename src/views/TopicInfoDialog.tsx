/**
 * 主题附注与超链接（亿图右键里那两项）。
 *
 * 只在按"确定"时写一次 mutate：备注是逐字输入的，每敲一个字进一次撤销栈，
 * 用户按一次 Ctrl+Z 就只退掉半个字，撤销栈也会瞬间几百层深。
 * 清空即删除：note 与 hyperlink 写回 undefined，emmx 那边就不会再落 <Comment>/<HyperLink>。
 */
import { useEffect, useState } from "react";
import { Input, Modal, Select } from "antd";
import { updateExtras } from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { plainText, type Hyperlink, type Page } from "../types/model.ts";

const KINDS: { value: Hyperlink["kind"]; label: string }[] = [
  { value: "web", label: "网页" },
  { value: "file", label: "文件" },
  { value: "topic", label: "主题" },
  { value: "email", label: "邮件" },
];

export function TopicInfoDialog({ page, onClose }: { page?: Page | null; onClose: () => void }) {
  const dialog = useUi((s) => s.dialog);
  const open = dialog === "topicInfo";
  const selection = useDoc((s) => s.selection);
  const mutate = useDoc((s) => s.mutate);
  const id = selection.length === 1 ? selection[0] : null;
  const shape = id && page ? (page.shapes[id] ?? null) : null;

  const [note, setNote] = useState("");
  const [kind, setKind] = useState<Hyperlink["kind"]>("web");
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!open || !shape) return;
    setNote(shape.extras.note ?? "");
    setKind(shape.extras.hyperlink?.kind ?? "web");
    setTarget(shape.extras.hyperlink?.target ?? "");
  }, [open, shape]);

  const commit = () => {
    if (!id) return false;
    const link: Hyperlink | undefined = target.trim()
      ? { kind, target: target.trim(), label: shape?.extras.hyperlink?.label }
      : undefined;
    const ok = mutate("编辑备注与超链接", (p) =>
      updateExtras(p, id, { note: note.trim() || undefined, hyperlink: link })
    );
    if (ok) onClose();
    return ok;
  };

  return (
    <Modal
      open={open}
      title={shape ? `附注与超链接：${plainText(shape.text)}` : "附注与超链接"}
      okText="确定"
      cancelText="取消"
      onOk={commit}
      onCancel={onClose}
      okButtonProps={{ disabled: !shape }}
      width={460}
    >
      {!shape ? (
        <div style={{ color: "#888" }}>先在画布上选中一个主题（只能单选）。</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>备注</div>
            <Input.TextArea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="留空表示没有备注"
            />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Select
              value={kind}
              onChange={(v: Hyperlink["kind"]) => setKind(v)}
              options={KINDS}
              style={{ width: 96 }}
            />
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={kind === "topic" ? "目标主题 id" : "https://…"}
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ fontSize: 12, color: "#888" }}>
            链接留空即清除；带链接的主题左下角会出一个箭头角标。
          </div>
        </div>
      )}
    </Modal>
  );
}

export default TopicInfoDialog;
