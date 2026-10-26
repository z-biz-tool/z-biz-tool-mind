/**
 * 选中主题上的 AI 助手对话框（画布快捷条 / 右键菜单「AI 助手」入口）。
 *
 * 入口只有一个：runAiOnTopic 在 services/ai.ts 里管配置检查、配额、锁和落树，
 * 这里只负责挑动词和转述结果 —— 再写一条自己的生成流程，锁和配额就会各说各话。
 * 精简/再生成是替换语义（会摘掉原子主题），按钮说明里写明，撤销一步可回。
 */
import { useMemo, useState } from "react";
import { Alert, Button, Modal, message } from "antd";
import { AI_VERB_LABEL, runAiOnTopic, type AiVerb } from "../services/ai.ts";
import { activePage, useDoc } from "../stores/docStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { isTopic, plainText } from "../types/model.ts";

const VERBS: readonly { verb: AiVerb; tip: string }[] = [
  { verb: "subtopics", tip: "为这个主题生成 5~8 个子主题" },
  { verb: "expand", tip: "从新的角度补充 4~6 个子主题，不与已有内容重复" },
  { verb: "condense", tip: "把已有子内容提炼成 3~5 个关键点（替换原子主题）" },
  { verb: "regen", tip: "丢开原有内容重新生成 5~8 个子主题（替换原子主题）" },
];

interface AiTopicDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AiTopicDialog({ open, onClose }: AiTopicDialogProps) {
  const page = useDoc((s) => activePage(s));
  const selection = useDoc((s) => s.selection);
  const focusId = useDoc((s) => s.focusId);
  const quota = useSettings((s) => s.settings.quota);
  const [busy, setBusy] = useState<AiVerb | null>(null);

  // 锚点只认真主题：标注泡/外框/概要进了"子主题"语义就是一棵亿图读不懂的树，
  // 画布入口在 actionsFor 里已经挡过一次，这里再挡是因为选中可能换人。
  const anchor = useMemo(() => {
    if (!page) return null;
    const ids = focusId && selection.includes(focusId) ? [focusId, ...selection] : selection;
    for (const id of ids) {
      const s = page.shapes[id];
      if (s && isTopic(s.type)) return s;
    }
    return null;
  }, [page, selection, focusId]);

  const run = async (verb: AiVerb) => {
    if (!anchor || busy) return;
    setBusy(verb);
    try {
      const r = await runAiOnTopic(anchor.id, verb);
      if (r.ok) message.success(r.message);
      else message.warning(r.message);
      if (r.ok) onClose();
    } finally {
      setBusy(null);
    }
  };

  const left = Math.max(0, quota.aiPoints - quota.aiUsed);

  return (
    <Modal
      open={open}
      title="AI 助手"
      width={440}
      footer={null}
      onCancel={onClose}
      mask={{ closable: !busy }}
      keyboard={!busy}
    >
      {anchor ? (
        <>
          <p style={{ margin: "0 0 4px" }}>
            对「{plainText(anchor.text) || "（无标题）"}」
            {anchor.childIds.length ? `（已有 ${anchor.childIds.length} 个子主题）` : ""}
          </p>
          <p style={{ margin: "0 0 12px", color: "var(--zm-text-2)", fontSize: 12 }}>
            可用 AI 点数：{left} / {quota.aiPoints}
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {VERBS.map(({ verb, tip }) => (
              <Button
                key={verb}
                block
                disabled={busy !== null}
                loading={busy === verb}
                onClick={() => void run(verb)}
                style={{ textAlign: "left", height: "auto", padding: "8px 12px" }}
              >
                <div style={{ fontWeight: 600 }}>{AI_VERB_LABEL[verb]}</div>
                <div style={{ fontWeight: 400, fontSize: 12, color: "var(--zm-text-2)" }}>{tip}</div>
              </Button>
            ))}
          </div>
          <p style={{ margin: "12px 0 0", color: "var(--zm-text-2)", fontSize: 12 }}>
            生成期间画布会暂时锁定，完成后自动恢复；结果不满意可直接撤销。
          </p>
        </>
      ) : (
        <Alert type="info" showIcon title="先在画布里选中一个主题，再用 AI 助手。" />
      )}
    </Modal>
  );
}
