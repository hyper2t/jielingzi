/**
 * 埋点基础。事件名、字段、口径待 PM 确认，确认后只需改 TrackEvents 定义。TODO(business)：补业务事件。
 *
 * 原则：
 * - 只带业务字段，不采集设备型号、位置、昵称等信息；用户身份由上报通道自带的 OPENID 标识（小程序 We分析）
 * - 未同意协议时不上报（与「未同意不写任何云端数据」一致）
 * - 上报失败静默，不影响业务
 * 通道：小程序 wx.reportEvent（需在 We分析后台预先配置同名事件与字段）；H5 / RN 暂只在开发环境打印。
 */
import Taro from '@tarojs/taro'
import { isConsented } from '@/store/user'

export interface TrackEvents {
  app_open: { scene?: number }
  page_view: { page: string }
  // ---- 登录体系（App 端） ----
  login: { method: 'phone' | 'wechat' | 'apple', is_new: boolean, merged: boolean }
  logout: Record<string, never>
  bind_phone: { merged: boolean }
  bind_wechat: { merged: boolean }
  bind_apple: { merged: boolean }
  delete_account: Record<string, never>
  // ---- M1 首次进入 / 练习档案（只记事件，不记内容） ----
  adult_confirm: { result: 'confirmed' | 'declined' }
  profile_save: { created: boolean }
}

export type TrackEventName = keyof TrackEvents
type Primitive = string | number | boolean

export type Transport = (name: string, props: Record<string, Primitive>) => void

const weappTransport: Transport = (name, props) => {
  const report = (Taro as any).reportEvent
  if (typeof report === 'function') report(name, props)
}

const devTransport: Transport = (name, props) => {
  if (process.env.NODE_ENV !== 'production') console.log('[track]', name, props)
}

let transport: Transport = process.env.TARO_ENV === 'weapp' ? weappTransport : devTransport

/** 测试 / 切换通道 */
export function setTransport (t: Transport) {
  transport = t
}

function clean (props: object): Record<string, Primitive> {
  const out: Record<string, Primitive> = {}
  Object.entries(props).forEach(([k, v]) => {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  })
  return out
}

export function track<N extends TrackEventName> (name: N, props: TrackEvents[N]): boolean {
  if (!isConsented()) return false
  try {
    transport(name, clean(props))
    return true
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.warn('[track] 上报失败', name, e)
    return false
  }
}
