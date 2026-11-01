/**
 * 「AI 看图」对话框（第三步：多模态理解）。
 *
 * 前两步的分工到这里闭环：结构图管逻辑、像素图管观感、看图管「读懂」——
 * 把画布上的图（AI 生成的、手插的、截图的）变成可编辑的导图节点。
 *
 * 兜底纪律与 AI 绘图一致：未配置/没图/图坏/生成失败都留在面板里给一句能照着改的话，
 * UI 不灰不崩不静默。视觉推理 5~30 秒，比生图短得多，按钮上显示已等待秒数即可。
 */
import { useState } from "react";
import { Alert, Button, Input, Modal, Segmented, message } from "antd";
import { runAiVision, VISION_VERB_LABEL, type VisionVerb } from "../services/ai.ts";
import type { AiFailure } from "../services/aiFailure.ts";
import { useUi } from "../stores/uiStore.ts";

const VERB_ORDER: VisionVerb[] = ["toOutline", "extractText", "describe"];

interface AiVisionDialogProps {
  open: boolean;
  onClose: () => void;
  /** 发起看图时选中的主题（面板标题里带出来，让用户知道在读哪张图）。 */
  shapeId: string;
  topicText: string;
  hasImage: boolean;
}

export function AiVisionDialog({
  open,
  onClose,
  shapeId,
  topicText,
  hasImage,
}: AiVisionDialogProps) {
  const [verb, setVerb] = useState<VisionVerb>("toOutline");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<AiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async () => {
    if (busy || !shapeId) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    setElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const r = await runAiVision(shapeId, verb, extra);
      if (r.ok) {
        message.success(r.message);
        onClose();
      } else if (r.failure) {
        setFailure(r.failure);
      } else {
        setNotice(r.message);
      }
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  };

  const goFix = () => {
    useUi.getState().openDialog("options");
    onClose();
  };

  const fixLabel = (f: AiFailure) =>
    f.focus === "apiKey" ? "去填密钥" : f.focus === "model" ? "去改模型名" : "去改接口地址";

  return (
    <Modal
      open={open}
      title="AI 看图"
      width={480}
      footer={null}
      onCancel={onClose}
      mask={{ closable: !busy }}
      keyboard={!busy}
    >
      <p style={{ margin: "0 0 8px" }}>
        读懂选中主题上的图片{topicText ? <>（主题「{topicText}」）</> : null}，结果作为子主题落回这根枝上。
      </p>
      {!hasImage && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          title="这个主题上没有图片"
          description="先插入图片（或用「AI 绘图」生成一张），再用看图。"
        />
      )}
      <Segmented
        size="small"
        value={verb}
        onChange={(v) => setVerb(v as VisionVerb)}
        options={VERB_ORDER.map((v) => ({ label: VISION_VERB_LABEL[v], value: v }))}
        disabled={busy}
      />
      <Input.TextArea
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        placeholder="附加要求（可空）：例如「只关注左侧流程」「用英文输出」"
        rows={2}
        maxLength={300}
        disabled={busy}
        style={{ marginTop: 10 }}
        autoFocus
      />

      {failure && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 10 }}
          title={failure.message}
          description={failure.hint || undefined}
          action={
            failure.focus === "none" ? undefined : (
              <Button size="small" onClick={goFix}>
                {fixLabel(failure)}
              </Button>
            )
          }
          closable
          onClose={() => setFailure(null)}
        />
      )}
      {notice && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 10 }}
          title={notice}
          closable
          onClose={() => setNotice(null)}
        />
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          type="primary"
          loading={busy}
          disabled={!shapeId || !hasImage}
          onClick={() => void run()}
        >
          {busy ? `识别中… ${elapsed}s` : "开始识别"}
        </Button>
      </div>
    </Modal>
  );
}
