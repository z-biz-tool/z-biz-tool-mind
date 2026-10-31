/**
 * 会员态的前端镜像。
 *
 * **真相在 Rust 侧**（src-tauri/src/license.rs）：验签、字段校验、「是不是会员」
 * 的判定全在那儿，本 store 只是缓存 + 一次回读。
 *
 * 为什么前端不能再判一遍：兑换码的验签密钥只以内置公钥的形式编译在二进制里，
 * 前端拿到的 license.json 是用户可写的普通文件 —— 前端若拿它当判据，
 * 用户改一行 JSON 就绕过了整道闸门。所以前端只读 `license_status()` 的结果，
 * 并且**每次读都由 Rust 重新验签**（不是读完就信）。
 *
 * 浏览器模式（`vite dev`）恒为免费档，见 services/native.ts 的 FREE_LICENSE。
 */
import { create } from "zustand";
import { native, type LicenseStatus } from "../services/native.ts";

/** 还没读回来时的初始态。按免费档算：闸门宁松勿紧，但也不能假装是会员。 */
const UNKNOWN: LicenseStatus = {
  active: false,
  state: "free",
  tier: "free",
  issued: "",
  redeemedAt: "",
  reason: "",
};

interface LicenseStore {
  status: LicenseStatus;
  /** 正在读状态（启动那次）。 */
  loading: boolean;
  /** 正在兑换（防重复点提交）。 */
  redeeming: boolean;
  /** 兑换失败的中文整句，直接展示；成功后清空。 */
  error: string | null;
  refresh: () => Promise<void>;
  /** 兑换一张兑换码。失败抛错（Rust 侧的中文整句），成功后回读状态。 */
  redeem: (code: string) => Promise<void>;
}

export const useLicense = create<LicenseStore>((set, get) => ({
  status: UNKNOWN,
  loading: false,
  redeeming: false,
  error: null,

  async refresh() {
    // 已经在兑换流程里就别插队：兑换自己会回读，
    // 这时插一次读会把刚生效的会员态用一次旧结果盖掉。
    if (get().redeeming) return;
    set({ loading: true });
    try {
      set({ status: await native.licenseStatus() });
    } catch (e) {
      // 走到这里只可能是 **IPC 断了**，不是"验签没过" ——
      // Rust 侧验签失败返回的是 Ok(invalid_status)，会正常 set 进来。
      //
      // 所以这里**保留上一次的状态**，而不是清成免费档：
      // 一次通信抖动不该把已经验证过的会员踢回去拦住保存。启动那次的初值本来就是
      // UNKNOWN（免费档），所以"从没读到过"的用户仍然是免费档，方向没有放松。
      console.warn("会员状态读取失败，沿用上一次的会员态：", e);
    } finally {
      set({ loading: false });
    }
  },

  async redeem(code) {
    const trimmed = code.trim();
    if (!trimmed) {
      set({ error: "请输入兑换码。" });
      return;
    }
    if (get().redeeming) return;
    set({ redeeming: true, error: null });
    try {
      const status = await native.licenseRedeem(trimmed);
      set({ status, error: null });
    } catch (e) {
      // Rust 侧的 Err 是完整中文句子，直接展示；不是的话才退回字符串化。
      // **不清空已有会员态**：兑换一张坏码不该让原本有效的会员消失。
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      set({ redeeming: false });
    }
  },
}));

/** 是不是可用的会员。闸门判定统一走这里，别在别处再比一次 state。 */
export function isMember(): boolean {
  return useLicense.getState().status.active;
}
