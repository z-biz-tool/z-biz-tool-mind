/**
 * 权益与配额判定（doc/复刻方案/00 §0.3 P-4、§3.16）。
 *
 * 复刻把"免费版能干什么"当业务规则实现，而不是散在各处的 if：
 * 所有数字都从 model/constants.ts 的 QUOTA 取，理由文案照抄 MindMaster 自己的提示语气，
 * 这样以后调整档位只需要改 constants，界面不需要跟着找一圈硬编码。
 */
import type { DocumentModel } from "../types/model.ts";
import { ILLEGAL_TITLE_CHARS, QUOTA } from "../model/constants.ts";
import { activeDoc, useDoc } from "../stores/docStore.ts";
import { useQuota } from "../stores/quotaStore.ts";

export function canSave(doc: DocumentModel): { ok: boolean; reason: string } {
  // 名额数的是 saved.json 里"真的落过盘"的那些。这里曾经是拿最近列表去重近似的，
  // 而 recentTouch 在打开文档时就调了 —— 于是"打开过 10 份"变成"一个都存不了"（01 A-13）。
  const used = new Set(useQuota.getState().saved);
  // 已在盘上的那份不重复占名额。比 docGuid 而不是比对象引用：
  // 快照式撤销每提交一次就换一个新 doc 对象，引用比对必然失配。
  const open = useDoc.getState();
  const current = activeDoc(open);
  if (open.path && current?.properties.docGuid === doc.properties.docGuid) used.delete(open.path);
  if (used.size >= QUOTA.freeMaxFiles) {
    return {
      ok: false,
      reason: `免费版本可保存最大文件个数为${QUOTA.freeMaxFiles}个文件，当前已保存 ${used.size} 个，请删除不需要的文件或升级会员。`,
    };
  }
  return { ok: true, reason: "" };
}

/** 点数换算按 aiCharsPerPoint 向上取整：用户看到的是整点，不是 0.7 点这种小数目。 */
export function canGenerate(chars: number, points: number, used: number): { ok: boolean; need: number; reason: string } {
  const c = Number.isFinite(chars) && chars > 0 ? chars : 0;
  const need = Math.ceil(c / QUOTA.aiCharsPerPoint);
  const left = points - used;
  if (need > left) {
    return {
      ok: false,
      need,
      reason: `AI 点数不足：本次 ${c} 字约需 ${need} 点，剩余 ${Math.max(0, left)} 点。开通创意资源会员可免点数使用全部 AI 能力。`,
    };
  }
  return { ok: true, need, reason: "" };
}

/** 文件智能解析的字数闸门（50–4500 字，实测文案区间）。 */
export function clampParseWords(n: number): { ok: boolean; reason: string } {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (count < QUOTA.parseWordMin) {
    return {
      ok: false,
      reason: `待解析的文字太少：智能解析一次至少需要 ${QUOTA.parseWordMin} 字，当前 ${count} 字。`,
    };
  }
  if (count > QUOTA.parseWordMax) {
    return {
      ok: false,
      reason: `超出单次解析上限：最多 ${QUOTA.parseWordMax} 字，当前 ${count} 字，请拆分成若干段后再解析。`,
    };
  }
  return { ok: true, reason: "" };
}

/** 社区发布标题：非法字符照 ILLEGAL_TITLE_CHARS 原文判，长度按 publishTitleMax。 */
export function publishTitleOk(title: string): { ok: boolean; reason: string } {
  const t = title.trim();
  if (!t) return { ok: false, reason: "标题不能为空。" };
  const bad = ILLEGAL_TITLE_CHARS.filter((c) => t.includes(c));
  if (bad.length) return { ok: false, reason: `标题不能包含以下字符：${bad.join(" ")}。` };
  if (t.length > QUOTA.publishTitleMax) {
    return { ok: false, reason: `标题最长 ${QUOTA.publishTitleMax} 个字符，当前 ${t.length} 个。` };
  }
  return { ok: true, reason: "" };
}

/** 分享有效期档位：0 在这套产品里是"永久"，不是"立刻过期"。 */
export function shareExpireLabel(days: number): string {
  return Number.isFinite(days) && days > 0 ? `${days} 天后失效` : "永久有效";
}
