/**
 * 「AI 改图」对话框（第四步：图生图）。
 *
 * 与「AI 看图」正好相反：看图是**图 → 文字**，改图是**图 + 要求 → 新图**。
 * 两者都只对"这根枝上真的挂着图"的主题开放。
 *
 * 兜底纪律与前几步一致：未配置/没图/图坏/网关不在线都留在面板里给一句
 * 能照着改的话，UI 不灰不崩不静默。改图可能两三分钟，按钮上显示已等待秒数。
 */
import { useState } from "react";
import { Alert, Button, Input, Modal, Radio, Tooltip, message } from "antd";
import {
  runAiImageEdit,
  EDIT_DENOISE_PRESETS,
  DEFAULT_EDIT_DENOISE_KEY,
  type EditDenoiseKey,
} from "../services/ai.ts";
import type { AiFailure } from "../services/aiFailure.ts";
import { useUi } from "../stores/uiStore.ts";

interface AiEditImageDialogProps {
  open: boolean;
  onClose: () => void;
  /** 发起改图时选中的主题。 */
  shapeId: string;
  topicText: string;
  hasImage: boolean;
}

export function AiEditImageDialog({
  open,
  onClose,
  shapeId,
  topicText,
  hasImage,
}: AiEditImageDialogProps) {
  const [text, setText] = useState("");
  const [strength, setStrength] = useState<EditDenoiseKey>(DEFAULT_EDIT_DENOISE_KEY);
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
      const r = await runAiImageEdit(shapeId, text, strength);
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
      title="AI 改图"
      width={480}
      footer={null}
      onCancel={onClose}
      mask={{ closable: !busy }}
      keyboard={!busy}
    >
      <p style={{ margin: "0 0 8px" }}>
        按一句要求重画选中主题上的图片{topicText ? <>（主题「{topicText}」）</> : null}
        ，新图会原地替换原图，可撤销。
      </p>
      {!hasImage && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          title="这个主题上没有图片"
          description="先插入图片（或用「AI 绘图」生成一张），再改图。"
        />
      )}
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例如：改成夜晚的街道，路灯亮着，冷色调"
        rows={3}
        maxLength={500}
        disabled={busy}
        autoFocus
      />

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>改动力度</div>
        <Radio.Group
          value={strength}
          onChange={(e) => setStrength(e.target.value as EditDenoiseKey)}
          disabled={busy}
          size="small"
        >
          {EDIT_DENOISE_PRESETS.map((p) => (
            <Radio key={p.key} value={p.key}>
              <Tooltip title={p.tip}>
                <span>{p.label}</span>
              </Tooltip>
            </Radio>
          ))}
        </Radio.Group>
      </div>

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
          disabled={!shapeId || !hasImage || !text.trim()}
          onClick={() => void run()}
        >
          {busy ? `改图中… ${elapsed}s` : "开始改图"}
        </Button>
      </div>
      <p style={{ margin: "12px 0 0", color: "var(--zm-text-2)", fontSize: 12 }}>
        改图与生图用同一个图像服务，可能需要 1~3 分钟；改图期间可继续编辑画布其他内容。
      </p>
    </Modal>
  );
}
