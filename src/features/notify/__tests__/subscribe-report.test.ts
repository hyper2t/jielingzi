/**
 * D09b：requestSubscribe 要把「用户到底同不同意」上报给云端记账。
 * 只盯三件事——accept 才 +1、reject 也要把 openid 记上（granted=false）、记账失败不许说成授权失败。
 */
import { SUBSCRIBE_TEMPLATE_ENV, requestSubscribe } from '@/features/notify/subscribe'

const TID = 'tpl-report-test'
const env = { TARO_ENV: 'weapp', [SUBSCRIBE_TEMPLATE_ENV]: TID } as Record<string, string>
const taro = (reply: unknown) => ({ requestSubscribeMessage: async () => reply })

describe('requestSubscribe 的 report 回调（D09b）', () => {
  it('微信回 accept → 上报 true', async () => {
    const seen: boolean[] = []
    const r = await requestSubscribe({ env, taro: taro({ [TID]: 'accept' }), report: async (g) => { seen.push(g) } })
    expect(r).toBe('requested')
    expect(seen).toEqual([true])
  })

  it('微信回 reject → 上报 false（不加额度，但 openid 仍被记下）', async () => {
    const seen: boolean[] = []
    await requestSubscribe({ env, taro: taro({ [TID]: 'reject' }), report: async (g) => { seen.push(g) } })
    expect(seen).toEqual([false])
  })

  it('替身没回包 → 按 accept 处理，兼容只写了 async 空的桩', async () => {
    const seen: boolean[] = []
    await requestSubscribe({ env, taro: taro({}), report: async (g) => { seen.push(g) } })
    expect(seen).toEqual([true])
  })

  it('report 抛错 → 仍返回 requested，不外抛', async () => {
    const r = await requestSubscribe({
      env,
      taro: taro({ [TID]: 'accept' }),
      report: async () => { throw new Error('网关抖动') },
    })
    expect(r).toBe('requested')
  })

  it('缺模板 ID → skipped，且一次 report 都不调', async () => {
    const seen: boolean[] = []
    const r = await requestSubscribe({ env: { TARO_ENV: 'weapp' } as Record<string, string>, taro: taro({}), report: async (g) => { seen.push(g) } })
    expect(r).toBe('skipped')
    expect(seen).toEqual([])
  })
})
