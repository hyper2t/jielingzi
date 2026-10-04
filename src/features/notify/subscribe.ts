/**
 * 订阅消息授权（FE-M6-03，m6-plan D14 / D17）：**只在用户刚完成一个主动操作之后**请求一次，
 * 用户拒绝、次数用完、接口报错一律静默——它是「以后还能提醒你」的可选项，不是本次操作的一部分。
 *
 * - 只有微信小程序有 `Taro.requestSubscribeMessage`：H5 / App 直接跳过（不算错误，也不打日志）。
 * - 模板 ID 还没申请下来，所以这里从环境变量读（`TARO_APP_WX_MP_PROMPT_TEMPLATE_ID`）；
 *   **缺配置就整个跳过**，等模板到位只需补 env，不必改代码。
 * - 一次授权 = 一次发送额度，所以每条链路只在成功路径上调用一次，不重试、不进状态机。
 */
import Taro from '@tarojs/taro'

type Env = Record<string, string | undefined>
export type SubscribeResult = 'requested' | 'skipped' | 'failed'

/** 与云端 `WX_MP_*_TEMPLATE_ID` 同名前缀：小程序端要拿同一个模板 ID 去请求订阅 */
export const SUBSCRIBE_TEMPLATE_ENV = 'TARO_APP_WX_MP_PROMPT_TEMPLATE_ID'

export function subscribeTemplateId(env: Env = process.env as Env): string {
  const raw = env[SUBSCRIBE_TEMPLATE_ENV]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 平台支持且模板 ID 到位才请求（供调用方决定要不要显示相关说明，目前界面不依赖它） */
export function canRequestSubscribe(opts: { env?: Env; taro?: unknown } = {}): boolean {
  const env = opts.env ?? (process.env as Env)
  const taro: any = 'taro' in opts ? opts.taro : Taro
  return env.TARO_ENV === 'weapp' && !!subscribeTemplateId(env) && typeof taro?.requestSubscribeMessage === 'function'
}

/**
 * 发起一次订阅请求。不抛错：任何异常都转成 'failed'，调用方可以安全地 `void requestSubscribe()`。
 * @param opts.taro 注入 Taro（测试用）；@param opts.templateId 覆盖模板 ID（测试用）
 */
export async function requestSubscribe(opts: { env?: Env; taro?: any; templateId?: string } = {}): Promise<SubscribeResult> {
  const env = opts.env ?? (process.env as Env)
  const taro = 'taro' in opts ? opts.taro : Taro
  const templateId = (opts.templateId ?? subscribeTemplateId(env)).trim()
  if (!canRequestSubscribe({ env, taro })) return 'skipped'
  try {
    await taro.requestSubscribeMessage({ tmplIds: [templateId] })
    return 'requested'
  } catch (e) {
    return 'failed'
  }
}
