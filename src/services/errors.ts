/**
 * 错误码 → 用户可读文案（FE-06）。文案面向终端用户，平实简短。
 */
import { CloudError, ERROR_CODES } from './cloud.types'

const IS_RN = process.env.TARO_ENV === 'rn'

const MESSAGES: Record<number, string> = {
  [ERROR_CODES.BAD_PARAM]: '请求有误，请稍后再试',
  [ERROR_CODES.UNAUTHORIZED]: IS_RN ? '登录已失效，请重新登录' : '身份已失效，请重新打开小程序',
  [ERROR_CODES.FORBIDDEN]: '暂时没有权限',
  [ERROR_CODES.PHONE_REQUIRED]: '发布前请先绑定手机号',
  [ERROR_CODES.ADULT_REQUIRED]: '结灵子仅面向年满 18 周岁的用户',
  [ERROR_CODES.BANNED]: '账号因违反社区公约已被封禁',
  [ERROR_CODES.MUTED]: '账号禁言中，暂时不能发布',
  [ERROR_CODES.NOT_FOUND]: '内容不存在或已下架',
  [ERROR_CODES.CONFLICT]: '该手机号已绑定其他账号',
  [ERROR_CODES.TOO_MANY]: '操作太频繁，歇一会儿再试',
  [ERROR_CODES.SERVER]: '服务开小差了',
  [ERROR_CODES.NETWORK]: '网络不太好',
  [ERROR_CODES.NOT_READY]: '服务暂未就绪',
  [ERROR_CODES.CONSENT_REQUIRED]: '需同意协议后可用',
  [ERROR_CODES.LOGIN_REQUIRED]: '请先登录',
  [ERROR_CODES.AUTH_CODE_INVALID]: '验证码不正确或已过期',
  [ERROR_CODES.AUTH_BUSY]: '操作过于频繁，请稍后再试',
  [ERROR_CODES.WECHAT_UNAVAILABLE]: '微信登录暂不可用',
  [ERROR_CODES.AUTH_CANCELLED]: '已取消微信登录',
  [ERROR_CODES.AUTH_DENIED]: '微信授权被拒绝，可改用手机号登录',
  [ERROR_CODES.APPLE_UNAVAILABLE]: '通过 Apple 登录暂不可用'
}

export function errorCode (e: unknown): number {
  if (e instanceof CloudError) return e.code
  if (e && typeof e === 'object' && typeof (e as any).code === 'number') return (e as any).code
  return ERROR_CODES.NETWORK
}

export function errorMessage (e: unknown): string {
  return MESSAGES[errorCode(e)] || '网络不太好'
}

/**
 * 表单 / 绑定类操作的提示：参数错误与账号冲突时，云函数给的是面向用户的中文说明（如「昵称最多 16 个字」
 * 「该手机号已绑定其他账号」「手机号验证已失效，请重新获取」），直接透出；其余沿用通用映射。
 */
export function userFacingMessage (e: unknown): string {
  const c = errorCode(e)
  if ((c === ERROR_CODES.BAD_PARAM || c === ERROR_CODES.CONFLICT) && e instanceof CloudError && /^[\u4e00-\u9fa5]/.test(e.message)) return e.message
  return errorMessage(e)
}

/** 发布前需要补齐的资料（M1：据此弹手机号绑定 / 18+ 确认） */
export function needsPhone (e: unknown): boolean {
  return errorCode(e) === ERROR_CODES.PHONE_REQUIRED
}

export function needsAdultConfirm (e: unknown): boolean {
  return errorCode(e) === ERROR_CODES.ADULT_REQUIRED
}

export function isConsentRequired (e: unknown): boolean {
  return errorCode(e) === ERROR_CODES.CONSENT_REQUIRED
}

/** App 端：会话不存在 / 刷新失败（含 401 后仍失败）→ 需要重新登录 */
export function isLoginRequired (e: unknown): boolean {
  const c = errorCode(e)
  return c === ERROR_CODES.LOGIN_REQUIRED || (IS_RN && c === ERROR_CODES.UNAUTHORIZED)
}

/**
 * 登录页专用文案：认证类错误优先用具体提示（发码太频繁 / 验证码错误 / 需稍后再试），其余沿用通用映射。
 * 服务端给出的可读描述（如「手机号格式不正确」）只在参数错误时透出，避免把英文错误串直接展示给用户。
 */
export function authErrorMessage (e: unknown): string {
  const c = errorCode(e)
  if (c === ERROR_CODES.TOO_MANY) return '发送太频繁，请 60 秒后再试'
  // 参数错误 / 微信侧错误：CloudError 里已经是给用户看的中文文案时直接透出（如「未安装微信，请先用手机号登录」）
  if ((c === ERROR_CODES.BAD_PARAM || c === ERROR_CODES.WECHAT_UNAVAILABLE || c === ERROR_CODES.AUTH_CANCELLED || c === ERROR_CODES.AUTH_DENIED || c === ERROR_CODES.APPLE_UNAVAILABLE) &&
    e instanceof CloudError && /^[\u4e00-\u9fa5]/.test(e.message)) return e.message
  return errorMessage(e)
}

/** 用户主动取消（微信授权取消 / 切回 App 未完成）：页面只需静默收起加载态，不按错误提示 */
export function isAuthCancelled (e: unknown): boolean {
  return errorCode(e) === ERROR_CODES.AUTH_CANCELLED
}

/** 重试也不会成功的错误（参数 / 内容不存在 / 未同意 / 未登录）：进度补传队列遇到应直接丢弃，不阻塞后续补传 */
export function isNonRetryable (e: unknown): boolean {
  const c = errorCode(e)
  return c === ERROR_CODES.CONSENT_REQUIRED || c === ERROR_CODES.LOGIN_REQUIRED || c === ERROR_CODES.NOT_FOUND || c === ERROR_CODES.BAD_PARAM
}
