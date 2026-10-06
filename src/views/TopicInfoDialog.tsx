/**
 * 主题附注、超链接与标签（亿图右键里那几项）。
 *
 * 只在按"确定"时写一次 mutate：备注是逐字输入的，每敲一个字进一次撤销栈，
 * 用户按一次 Ctrl+Z 就只退掉半个字，撤销栈也会瞬间几百层深。
 * 清空即删除：note 与 hyperlink 写回 undefined、labels 写回空数组，
 * emmx 那边就不会再落 <Comment>/<HyperLink>/<Labels>。
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

/** emmx 用分号存标签，所以中英文的逗号、顿号、分号都当分隔符；用户敲回车打字时不会撞车。 */
function parseLabels(raw: string): string[] {
  const out: string[] = [];
  for (const p of raw.split(/[，,、;；]/)) {
    const v = p.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

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
  const [labels, setLabels] = useState("");

  useEffect(() => {
    if (!open || !shape) return;
    setNote(shape.extras.note ?? "");
    setKind(shape.extras.hyperlink?.kind ?? "web");
    setTarget(shape.extras.hyperlink?.target ?? "");
    setLabels((shape.extras.labels ?? []).join("，"));
  }, [open, shape]);

  const commit = () => {
    if (!id) return false;
    const link: Hyperlink | undefined = target.trim()
      ? { kind, target: target.trim(), label: shape?.extras.hyperlink?.label }
      : undefined;
    const tags = parseLabels(labels);
    const ok = mutate("编辑附注", (p) =>
      updateExtras(p, id, {
        note: note.trim() || undefined,
        hyperlink: link,
        labels: tags.length ? tags : undefined,
      })
    );
    if (ok) onClose();
    return ok;
  };

  return (
    <Modal
      open={open}
      title={shape ? `附注：${plainText(shape.text)}` : "附注"}
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
          <div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>标签</div>
            <Input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="多个标签用逗号隔开，如：原型，待评审"
            />
          </div>
          <div style={{ fontSize: 12, color: "#888" }}>
            链接留空即清除；带备注或链接的主题左下角会出角标，有标签的在框底画出标签条。
          </div>
        </div>
      )}
    </Modal>
  );
}

export default TopicInfoDialog;
