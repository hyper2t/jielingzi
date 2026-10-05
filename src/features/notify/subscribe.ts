/**
 * 订阅消息授权（FE-M6-03，m6-plan D14 / D17）：**只在用户刚完成一个主动操作之后**请求一次，
 * 用户拒绝、次数用完、接口报错一律静默——它是「以后还能提醒你」的可选项，不是本次操作的一部分。
 *
 * - 只有微信小程序有 `Taro.requestSubscribeMessage`：H5 / App 直接跳过（不算错误，也不打日志）。
 * - 模板 ID 从环境变量读（`TARO_APP_WX_MP_PROMPT_TEMPLATE_ID`），**缺配置就整个跳过**。
 * - 读构建期的值必须写成 `process.env.TARO_APP_*` 成员表达式：Taro 靠 DefinePlugin 做静态替换，
 *   `process.env[key]` 这类动态写法替换不到，小程序产物里只会留下没人提供的 `process.env`
 *   （同 `config/client-env.js` 记的白屏教训）。测试要注入替身时显式传 env，那条路才走方括号读取。
 * - 一次授权 = 一次发送额度，所以每条链路只在成功路径上调用一次，不重试、不进状态机。
 */
import Taro from '@tarojs/taro'

type Env = Record<string, string | undefined>
export type SubscribeResult = 'requested' | 'skipped' | 'failed'

/** 与云端 `WX_MP_*_TEMPLATE_ID` 同名前缀：小程序端要拿同一个模板 ID 去请求订阅 */
export const SUBSCRIBE_TEMPLATE_ENV = 'TARO_APP_WX_MP_PROMPT_TEMPLATE_ID'

/** 未注入 env 时读构建期替换好的成员表达式；注入了就用方括号读那份替身 */
function readTemplateId(env?: Env): string | undefined {
  return env === undefined ? process.env.TARO_APP_WX_MP_PROMPT_TEMPLATE_ID : env[SUBSCRIBE_TEMPLATE_ENV]
}

function readTaroEnv(env?: Env): string | undefined {
  return env === undefined ? process.env.TARO_ENV : env.TARO_ENV
}

export function subscribeTemplateId(env?: Env): string {
  const raw = readTemplateId(env)
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 平台支持且模板 ID 到位才请求（供调用方决定要不要显示相关说明，目前界面不依赖它） */
export function canRequestSubscribe(opts: { env?: Env; taro?: unknown } = {}): boolean {
  const env = opts.env
  const taro: any = 'taro' in opts ? opts.taro : Taro
  return readTaroEnv(env) === 'weapp' && !!subscribeTemplateId(env) && typeof taro?.requestSubscribeMessage === 'function'
}

/**
 * 发起一次订阅请求。不抛错：任何异常都转成 'failed'，调用方可以安全地 `void requestSubscribe()`。
 * @param opts.taro 注入 Taro（测试用）；@param opts.templateId 覆盖模板 ID（测试用）；@param opts.report 授权结果回调（D09b 额度记账），它抛错也仍算请求成功
 */
export async function requestSubscribe(opts: { env?: Env; taro?: any; templateId?: string; report?: (granted: boolean) => Promise<unknown> } = {}): Promise<SubscribeResult> {
  const env = opts.env
  const taro = 'taro' in opts ? opts.taro : Taro
  const templateId = (opts.templateId ?? readTemplateId(env) ?? '').trim()
  if (!canRequestSubscribe({ env, taro })) return 'skipped'
  try {
    const res: any = await taro.requestSubscribeMessage({ tmplIds: [templateId] })
    // 微信按模板 ID 逐项回 'accept' / 'reject' / 'ban'；没有回包（含测试替身）时按 accept 处理。
    const state = res && typeof res === 'object' ? res[templateId] : undefined
    const accepted = state === undefined || state === 'accept'
    if (opts.report) {
      try { await opts.report(accepted) } catch (e) { /* 记账失败不该把授权说成失败 */ }
    }
    return 'requested'
  } catch (e) {
    return 'failed'
  }
}
