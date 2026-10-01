/**
 * 微信登录能力（FE-L05）：react-native-wechat-lib@3.0.4（微信 Open SDK Android 6.8.20 / iOS 2.0）。
 *
 * 约定（docs/mvp/prompts/rn-login.md 决策 L8）：
 * - 懒初始化：App 启动不碰 SDK；只有用户已同意、且页面确实要用（登录页 / 设置页账号区）时才 registerApp(TARO_APP_WX_APP_ID, TARO_APP_WX_UNIVERSAL_LINK)。
 * - 只用 sendAuthRequest('snsapi_userinfo', state) 取 code，不调 sns/userinfo，不采集昵称头像；code 交给云函数 user.wechatAppLogin / bindWechat。
 * - state 为本地随机串，回调里 state 不一致视为失败。
 * - 三类失败分别映射：未安装 / 未配置 / SDK 出错 → WECHAT_UNAVAILABLE；用户取消（-2）→ AUTH_CANCELLED；用户拒绝（-4）→ AUTH_DENIED。
 * - 3.0.4 的 sendAuthRequest 只在收到微信回调时才 resolve/reject：微信未安装、未 registerApp、拉起失败时会永远挂起，
 *   所以这里先自查安装状态，再加「切回 App 后宽限期无回调 → 视为取消」与总超时两道保险。
 * - iOS（NA-L03）：微信 SDK 2.x 必须带 Universal Link 注册，所以 iOS 要求 TARO_APP_WX_UNIVERSAL_LINK 也已配置才算可用；
 *   回跳由 ios/taroDemo/AppDelegate.mm 处理（URL Scheme 经 RCTLinkingManager → 本库；Universal Link 手动转发给 WXApi）。
 *
 * 原生侧：Android（NA-L01）android/app/src/main/java/cn/jielingzi/app/wxapi/WXEntryActivity.java + Manifest <queries>；
 * iOS（NA-L03）Podfile 的 WechatOpenSDK-XCFramework、Info.plist URL Scheme / LSApplicationQueriesSchemes、entitlements applinks、
 * 官网 .well-known/apple-app-site-association（scripts/rn/ios-native-check.mjs 校验与 .env 一致）；
 * 依赖清单见 docs/ops/app-sdk-list.md §2。
 */
import { NativeModules, Platform } from 'react-native'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { isConsented } from '@/store/user'
import { onAppHide, onAppShow } from '@/utils/app-lifecycle'

export interface WechatAuthResult { code: string, state: string }

/** 开放平台移动应用 AppID（Repository Variables 注入，见 config/client-env.js）；为空表示尚未配置 → 不显示微信登录 */
export const WX_APP_ID = process.env.TARO_APP_WX_APP_ID || ''
export const WX_UNIVERSAL_LINK = process.env.TARO_APP_WX_UNIVERSAL_LINK || ''
/** 只申请授权 scope，拿 code 即止 */
export const WX_SCOPE = 'snsapi_userinfo'
/** 从拉起微信到收到回调的总超时 */
export const AUTH_TIMEOUT_MS = 90 * 1000
/** 切回 App 后等待微信回调的宽限期（Android 上回调经 WXEntryActivity 在毫秒级到达） */
export const RESUME_GRACE_MS = 3 * 1000

/** react-native-wechat-lib 的子集（其余分享 / 支付接口本 App 不用） */
export interface WechatSdk {
  registerApp: (appId: string, universalLink?: string) => Promise<boolean>
  isWXAppInstalled: () => Promise<boolean>
  sendAuthRequest: (scope: string | string[], state?: string) => Promise<WechatAuthResp>
}

export interface WechatAuthResp { errCode: number, errStr?: string, code?: string, state?: string }

/** 微信 Open SDK 错误码（BaseResp.ErrCode） */
export const WX_ERR = { OK: 0, COMM: -1, USER_CANCEL: -2, SENT_FAILED: -3, AUTH_DENIED: -4, UNSUPPORT: -5 } as const

let sdk: WechatSdk | null | undefined
let registered: Promise<boolean> | null = null

/** 懒加载：库在 import 时读取 WeChat.registerApp，未链接时先检查，避免红屏。 */
function loadSdk (): WechatSdk | null {
  if (sdk !== undefined) return sdk
  if (!NativeModules?.WeChat && !NativeModules?.WechatLib) {
    console.warn('[wechat] 原生模块未链接，微信登录不可用；请重新构建并安装 App')
    sdk = null
    return sdk
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-wechat-lib')
    sdk = mod && typeof mod.registerApp === 'function' && typeof mod.isWXAppInstalled === 'function' && typeof mod.sendAuthRequest === 'function' ? (mod as WechatSdk) : null
  } catch (e) {
    console.warn('[wechat] SDK 加载失败，微信登录不可用', e)
    sdk = null
  }
  return sdk
}

/** 测试用：注入 SDK 替身并重置注册状态；传 undefined 恢复为真实 require */
export function __setWechatSdkForTest (s: WechatSdk | null | undefined): void {
  sdk = s
  registered = null
}

/** 配置层面是否支持（不触碰 SDK）：AppID 已配置，且 Android；或 iOS 且 Universal Link 已配置（SDK 2.x 注册必需） */
export function isWechatConfigured (): boolean {
  if (!WX_APP_ID) return false
  if (Platform.OS === 'android') return true
  return Platform.OS === 'ios' && !!WX_UNIVERSAL_LINK
}

/** registerApp 只做一次；失败允许下次重试 */
function ensureRegistered (s: WechatSdk): Promise<boolean> {
  if (!registered) {
    registered = Promise.resolve()
      .then(() => s.registerApp(WX_APP_ID, WX_UNIVERSAL_LINK))
      .then(ok => ok !== false)
      .catch(e => {
        registered = null
        throw e
      })
  }
  return registered
}

/**
 * 是否可以显示「微信登录 / 绑定微信」：已配置 && 用户已同意 && SDK 可用 && registerApp 成功 && 本机装了微信。
 * 未同意时不会初始化 SDK（决策 L8）。
 */
export async function isWechatLoginAvailable (): Promise<boolean> {
  if (!isWechatConfigured() || !isConsented()) return false
  const s = loadSdk()
  if (!s) return false
  try {
    if (!(await ensureRegistered(s))) return false
    return !!(await s.isWXAppInstalled())
  } catch (e) {
    console.warn('[wechat] 能力探测失败', e)
    return false
  }
}

/** 32 位随机十六进制串（RN 无 crypto.getRandomValues；state 只用于防串包，不是密钥） */
export function randomState (): string {
  let out = ''
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

function unavailable (msg: string): CloudError {
  return new CloudError(ERROR_CODES.WECHAT_UNAVAILABLE, msg)
}

/** 把 react-native-wechat-lib 的 WechatError（code = 微信 errCode）映射成用户可读的 CloudError */
export function mapWechatError (e: unknown): CloudError {
  if (e instanceof CloudError) return e
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
  if (code === WX_ERR.USER_CANCEL) return new CloudError(ERROR_CODES.AUTH_CANCELLED, '已取消微信登录')
  if (code === WX_ERR.AUTH_DENIED) return new CloudError(ERROR_CODES.AUTH_DENIED, '微信授权被拒绝，可改用手机号登录')
  if (code === WX_ERR.UNSUPPORT) return unavailable('当前微信版本不支持授权登录，请升级微信或用手机号登录')
  return unavailable('微信登录失败，请重试或用手机号登录')
}

/**
 * 等待微信回调，同时监听前后台：用户切到微信后再切回 App，宽限期内仍无回调 → 视为取消（微信被手动划掉 / 未完成授权）；
 * 总时长超过 AUTH_TIMEOUT_MS 也按取消处理。
 */
function waitForResp (pending: Promise<WechatAuthResp>): Promise<WechatAuthResp> {
  return new Promise<WechatAuthResp>((resolve, reject) => {
    let settled = false
    let wentBackground = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let totalTimer: ReturnType<typeof setTimeout> | null = null
    let offHide = () => undefined as void
    let offShow = () => undefined as void
    const finish = (err: unknown, resp?: WechatAuthResp) => {
      if (settled) return
      settled = true
      if (totalTimer) clearTimeout(totalTimer)
      if (graceTimer) clearTimeout(graceTimer)
      offHide()
      offShow()
      if (err) reject(err)
      else resolve(resp as WechatAuthResp)
    }
    offHide = onAppHide(() => { wentBackground = true })
    offShow = onAppShow(() => {
      if (!wentBackground || settled || graceTimer) return
      graceTimer = setTimeout(() => finish(new CloudError(ERROR_CODES.AUTH_CANCELLED, '微信没有返回结果，请重试')), RESUME_GRACE_MS)
    })
    totalTimer = setTimeout(() => finish(new CloudError(ERROR_CODES.AUTH_CANCELLED, '微信授权超时，请重试')), AUTH_TIMEOUT_MS)
    pending.then(resp => finish(undefined, resp), err => finish(err))
  })
}

/**
 * 拉起微信授权，成功返回 { code, state }（state 已校验）。调用方：features/auth/session.ts signInWithWechat / 设置页绑定微信。
 * 前置：用户已同意（否则 CONSENT_REQUIRED）。
 */
export async function requestWechatAuth (): Promise<WechatAuthResult> {
  if (!isWechatConfigured()) throw unavailable('微信登录暂未开放，请先用手机号登录')
  if (!isConsented()) throw new CloudError(ERROR_CODES.CONSENT_REQUIRED, '需同意协议后可用')
  const s = loadSdk()
  if (!s) throw unavailable('微信登录暂不可用，请先用手机号登录')
  const ok = await ensureRegistered(s).catch(() => false)
  if (!ok) throw unavailable('微信登录初始化失败，请重试或用手机号登录')
  const installed = await s.isWXAppInstalled().catch(() => false)
  if (!installed) throw unavailable('未安装微信，请先用手机号登录')

  const state = randomState()
  let resp: WechatAuthResp
  try {
    resp = await waitForResp(s.sendAuthRequest(WX_SCOPE, state))
  } catch (e) {
    throw mapWechatError(e)
  }
  if (!resp || resp.errCode !== WX_ERR.OK || !resp.code) throw mapWechatError({ code: resp?.errCode })
  if (resp.state !== state) throw unavailable('微信返回的校验信息不一致，请重试')
  return { code: resp.code, state }
}
