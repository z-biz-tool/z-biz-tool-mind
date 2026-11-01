/**
 * 「AI 生成图」对话框（工具栏入口）。
 *
 * 一句话 → 结构化图。落图、配额、画布锁、配置预检全在 services/ai.ts 的
 * runAiDiagram —— 这里只负责收集描述和转述结果，与 AiTopicDialog 同一条分工：
 * 再写一条自己的生成流程，锁和配额就会各说各话。
 *
 * 失败留在面板里（可照着改）而不是一条三秒就消失的 toast：
 * 「密钥失效」这类错误用户是要照着改的 —— 同一条理由见 AiTopicDialog。
 */
import { useState } from "react";
import { Alert, Button, Input, Modal, message } from "antd";
import { runAiDiagram } from "../services/ai.ts";
import type { AiFailure } from "../services/aiFailure.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { useUi } from "../stores/uiStore.ts";

interface AiDiagramDialogProps {
  open: boolean;
  onClose: () => void;
}

const EXAMPLES = [
  "一个网站登录流程：输入账号密码 → 前端校验 → 请求后端 → 验证通过进首页，失败提示错误",
  "一份产品发布会的时间线：宣布开场 → 产品演示 → 价格公布 → 媒体问答",
  "公司组织架构：总经理下设产品部、研发部、市场部，研发部下分前端组和后端组",
];

export function AiDiagramDialog({ open, onClose }: AiDiagramDialogProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AiFailure | null>(null);
  const quota = useSettings((s) => s.settings.quota);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const r = await runAiDiagram(text);
      if (r.ok) {
        message.success(r.message);
        onClose();
      } else if (r.failure) {
        setFailure(r.failure);
      } else {
        message.warning(r.message);
      }
    } finally {
      setBusy(false);
    }
  };

  /** 把用户送到该改的那一栏（与 AiTopicDialog.goFix 同一动作）。 */
  const goFix = () => {
    useUi.getState().openDialog("options");
    onClose();
  };

  const fixLabel = (f: AiFailure) =>
    f.focus === "apiKey" ? "去填密钥" : f.focus === "model" ? "去改模型名" : "去改接口地址";

  const left = Math.max(0, quota.aiPoints - quota.aiUsed);

  return (
    <Modal
      open={open}
      title="AI 生成图"
      width={480}
      footer={null}
      onCancel={onClose}
      mask={{ closable: !busy }}
      keyboard={!busy}
    >
      <p style={{ margin: "0 0 8px" }}>
        描述你要的图，AI 生成一份**可以编辑**的结构图（流程图 / 架构图 / 时间线 / 组织架构…）。
      </p>
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例如：一个登录流程，输入账号密码后校验，通过进首页，失败提示错误"
        rows={4}
        maxLength={2000}
        disabled={busy}
        autoFocus
      />
      <div style={{ margin: "8px 0 12px", color: "var(--zm-text-2)", fontSize: 12 }}>
        试试：
        {EXAMPLES.map((ex, i) => (
          <span key={i}>
            <a
              onClick={() => !busy && setText(ex)}
              style={{ cursor: "pointer", marginRight: 8 }}
            >
              {`示例${i + 1}`}
            </a>
          </span>
        ))}
        <span style={{ marginLeft: 8 }}>可用 AI 点数：{left} / {quota.aiPoints}</span>
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
          生成
        </Button>
      </div>
      <p style={{ margin: "12px 0 0", color: "var(--zm-text-2)", fontSize: 12 }}>
        生成会替换当前画布的内容（可撤销）；生成的图和手画的完全一样：能改字、能拖动、能加节点。
      </p>
    </Modal>
  );
}
