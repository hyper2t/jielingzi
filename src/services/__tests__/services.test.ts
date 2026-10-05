import Taro from '@tarojs/taro'
import { mockControl } from '@/services/mock/client'
import * as me from '@/services/me'
import { errorMessage, isConsentRequired } from '@/services/errors'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { DATA_SOURCE, getClient } from '@/services/client'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'

const setConsent = (c: 'agreed' | 'declined' | 'unknown') => useUserStore.getState().setConsent(c)

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  ;(Taro as any).__storage.clear()
  useSettingsStore.setState({ settings: {} })
  setConsent('unknown')
})

describe('数据源', () => {
  it('默认 mock，接口与真实端一致', async () => {
    expect(DATA_SOURCE).toBe('mock')
    expect(getClient().platform).toBe('weapp')
    const r = await getClient().db.query('users')
    expect(r.list).toHaveLength(1)
  })

  it('mock 与后端一致：updateSettings 空入参返回 40001', async () => {
    await expect(getClient().fn.call('user', 'updateSettings', {})).rejects.toMatchObject({ code: ERROR_CODES.BAD_PARAM })
  })
})

describe('同意拦截（未同意时不发出任何云端写请求）', () => {
  it('login 把云端已保存的设置恢复到本地（换机 / 重装 / 清缓存后不丢）', async () => {
    mockControl.setRemoteSettings({ theme: 'dark' })
    setConsent('agreed')
    await me.login()
    expect(useSettingsStore.getState().settings).toMatchObject({ theme: 'dark' })
  })

  it('refreshRemoteSettings：未同意不发请求；已同意失败静默沿用本地', async () => {
    setConsent('declined')
    await me.refreshRemoteSettings()
    expect(mockControl.calls).toEqual([])
    setConsent('agreed')
    useSettingsStore.getState().patch({ theme: 'light' })
    mockControl.failTimes = 1
    await expect(me.refreshRemoteSettings()).resolves.toBeUndefined()
    expect(useSettingsStore.getState().settings).toMatchObject({ theme: 'light' })
  })

  it.each(['unknown', 'declined'] as const)('consent=%s：写入被拦截，本地设置照常生效', async (c) => {
    setConsent(c)
    await expect(me.updateSettings({ theme: 'x' })).rejects.toMatchObject({ code: ERROR_CODES.CONSENT_REQUIRED })
    await expect(me.login()).rejects.toThrow(CloudError)
    await me.setSettings({ theme: 'y' })
    expect(useSettingsStore.getState().settings).toMatchObject({ theme: 'y' })
    expect(mockControl.calls).toEqual([])
  })

  it('同意后 setSettings 同步云端', async () => {
    setConsent('agreed')
    await me.setSettings({ theme: 'z' })
    expect(mockControl.calls.map(c => `${c.name}.${c.action}`)).toEqual(['user.updateSettings'])
    expect(mockControl.calls[0].data).toEqual({ theme: 'z' })
  })

  it('同意动作本身不拦截，成功后状态为 agreed', async () => {
    await me.consent()
    expect(useUserStore.getState().consent).toBe('agreed')
    expect(mockControl.calls.map(c => c.action)).toEqual(['consent'])
  })

  it('同意失败时保持原状态', async () => {
    mockControl.failTimes = 1
    await expect(me.consent()).rejects.toThrow()
    expect(useUserStore.getState().consent).toBe('unknown')
  })
})

describe('errors', () => {
  it('错误码映射', () => {
    expect(errorMessage(new CloudError(42901, 'x'))).toBe('操作太频繁，歇一会儿再试')
    expect(errorMessage(new Error('?'))).toBe('网络不太好')
    expect(errorMessage(new CloudError(ERROR_CODES.CONSENT_REQUIRED, ''))).toBe('需同意协议后可用')
    expect(isConsentRequired(new CloudError(ERROR_CODES.CONSENT_REQUIRED, ''))).toBe(true)
  })
})
