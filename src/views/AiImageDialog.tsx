/**
 * 「AI 绘图」对话框（第二步：像素级生图）。
 *
 * 与「AI 生成图」（结构化图）并存互补：结构图管逻辑，像素图管观感。
 * 兜底纪律（CEO 裁定）：生图网关是自建服务不保证在线 ——
 * 未配置/不可达/超时都留在面板里给一句能照着改的话，UI 不灰不崩不静默。
 *
 * 不锁画布：FLUX 55~140s/张，锁 2 分钟不可接受 —— 生成期间用户可继续编辑，
 * 完成后图像作为一个新主题落进画布（mutate 一步提交，与生成期间的编辑不冲突）。
 */
import { useState } from "react";
import { Alert, Button, Input, Modal, Segmented, message } from "antd";
import { runAiImageDraw, IMAGE_SIZES, type ImageSize } from "../services/ai.ts";
import type { AiFailure } from "../services/aiFailure.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { useUi } from "../stores/uiStore.ts";

const SIZE_LABELS: Record<ImageSize, string> = {
  "1024x1024": "方形",
  "1024x576": "横版",
  "576x1024": "竖版",
};

interface AiImageDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AiImageDialog({ open, onClose }: AiImageDialogProps) {
  const [text, setText] = useState("");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<AiFailure | null>(null);
  const settings = useSettings((s) => s.settings);

  const configured = Boolean(settings.advanced.imageEndpoint.trim() && settings.advanced.imageModel.trim());

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setElapsed(0);
    const t0 = Date.now();
    // 计时器：生图可能 2 分钟，给用户一个"还活着"的信号
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const r = await runAiImageDraw(text, size);
      if (r.ok) {
        message.success(r.message);
        onClose();
      } else if (r.failure) {
        setFailure(r.failure);
      } else {
        message.warning(r.message);
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
      title="AI 绘图"
      width={480}
      footer={null}
      onCancel={onClose}
      mask={{ closable: !busy }}
      keyboard={!busy}
    >
      <p style={{ margin: "0 0 8px" }}>
        描述想要的图像（插画/示意图/封面…），生成后作为一个新主题落到画布上，可拖动、随文档保存。
      </p>
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例如：一张扁平风格插画，太阳从云后升起，暖色调"
        rows={3}
        maxLength={1000}
        disabled={busy}
        autoFocus
      />
      <div style={{ margin: "10px 0 12px", display: "flex", alignItems: "center", gap: 12 }}>
        <Segmented
          size="small"
          value={size}
          onChange={(v) => setSize(v as ImageSize)}
          options={IMAGE_SIZES.map((s) => ({ label: SIZE_LABELS[s], value: s }))}
          disabled={busy}
        />
        {!configured && (
          <span style={{ fontSize: 12, color: "#d4380d" }}>
            图像服务未配置 —— 仍可生成，会引导你先填配置
          </span>
        )}
      </div>

      {failure && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
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

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button type="primary" loading={busy} disabled={!text.trim()} onClick={() => void run()}>
          {busy ? `生成中… ${elapsed}s` : "生成"}
        </Button>
      </div>
      <p style={{ margin: "12px 0 0", color: "var(--zm-text-2)", fontSize: 12 }}>
        自建生图服务冷启动可能需要 1~2 分钟，属正常现象；生成期间可继续编辑画布其他内容。
      </p>
    </Modal>
  );
}
