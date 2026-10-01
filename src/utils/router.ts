/**
 * 路由常量与跳转封装。页面内禁止手写 URL，统一走这里。
 * 影响端：小程序 / H5 / RN（Taro 路由 API 三端一致）
 * 新增页面：app.config.ts 注册 → 这里加 ROUTES / RouteParams → 页面里用 navigate()。
 */
import Taro from '@tarojs/taro'

export const ROUTES = {
  // 主包 tabBar
  index: '/pages/index/index',
  practice: '/pages/practice/index',
  mine: '/pages/mine/index',
  // pkg-community（M3/M4 补齐：topicNew、circle、joinCircle、invites…）
  topic: '/pkg-community/pages/topic/index',
  // pkg-practice（M5/M6 补齐：timerDone、calendar、prompt…）
  timer: '/pkg-practice/pages/timer/index',
  // pkg-user
  settings: '/pkg-user/pages/settings/index',
  agreement: '/pkg-user/pages/agreement/index',
  /** 18+ 确认（首次进入第 2 步；发布 / 编辑档案前按需进入） */
  adult: '/pkg-user/pages/adult/index',
  profileEdit: '/pkg-user/pages/profile-edit/index',
  // pkg-admin（仅 mod / admin，FE-M2-02）
  adminQueue: '/pkg-admin/pages/queue/index',
  /** App 专用登录页（app.config.ts 只在 RN 注册） */
  login: '/pkg-user/pages/login/index'
} as const

export type RouteName = keyof typeof ROUTES

/** 各页面入参（只放可序列化的简单值） */
export interface RouteParams {
  index: undefined
  practice: undefined
  mine: undefined
  topic: { id: string }
  timer: { minutes?: number }
  settings: undefined
  /** mode=gate：首次发布前的社区公约阅读（底部「我已阅读并遵守」，FE-M2-03） */
  agreement: { type: 'user' | 'privacy' | 'rules', mode?: 'gate' }
  /** returnTo：确认后回到的页面（不传则返回上一页）；reason：顶部提示（如「发起话题」） */
  adult: { returnTo?: RouteName, reason?: string }
  profileEdit: undefined
  adminQueue: undefined
  /** reason：页面顶部提示（如「同步数据」）；returnTo：登录成功后 redirect 到的路由名（不传则返回上一页）；mode=bind：给已登录账号绑定手机号 */
  login: { reason?: string, returnTo?: RouteName, mode?: 'login' | 'bind' }
}

export const TAB_ROUTES: RouteName[] = ['index', 'practice', 'mine']

type ParamValue = string | number | boolean | undefined | null

export function buildUrl<K extends RouteName> (name: K, params?: RouteParams[K]): string {
  const path = ROUTES[name]
  if (!params) return path
  const query = Object.entries(params as Record<string, ParamValue>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return query ? `${path}?${query}` : path
}

/** 解析页面参数（Taro.getCurrentInstance().router.params 已解码一次，这里再兜底解码） */
export function parseParams<K extends RouteName> (raw: Record<string, string | undefined> = {}): Partial<NonNullable<RouteParams[K]>> {
  const out: Record<string, string> = {}
  Object.keys(raw).forEach(k => {
    const v = raw[k]
    if (v === undefined || k === '$taroTimestamp') return
    try { out[k] = decodeURIComponent(v) } catch { out[k] = v }
  })
  return out as Partial<NonNullable<RouteParams[K]>>
}

type NavArgs<K extends RouteName> = RouteParams[K] extends undefined ? [] : [RouteParams[K]]

export function navigate<K extends RouteName> (name: K, ...args: NavArgs<K>) {
  if (TAB_ROUTES.includes(name)) return Taro.switchTab({ url: ROUTES[name] })
  return Taro.navigateTo({ url: buildUrl(name, args[0] as RouteParams[K]) })
}

export function redirect<K extends RouteName> (name: K, ...args: NavArgs<K>) {
  if (TAB_ROUTES.includes(name)) return Taro.switchTab({ url: ROUTES[name] })
  return Taro.redirectTo({ url: buildUrl(name, args[0] as RouteParams[K]) })
}

export function relaunch<K extends RouteName> (name: K, ...args: NavArgs<K>) {
  return Taro.reLaunch({ url: buildUrl(name, args[0] as RouteParams[K]) })
}

/** 返回上一页；没有上一页（分享直达等）时回首页 */
export function back () {
  if (Taro.getCurrentPages().length > 1) return Taro.navigateBack()
  return Taro.switchTab({ url: ROUTES.index })
}
