import { setTransport, track } from '@/utils/track'
import { useUserStore } from '@/store/user'

describe('track', () => {
  const sent: Array<[string, object]> = []
  beforeAll(() => setTransport((n, p) => { sent.push([n, p]) }))
  beforeEach(() => { sent.length = 0 })

  it('未同意时不上报', () => {
    useUserStore.getState().setConsent('declined')
    expect(track('page_view', { page: 'home' })).toBe(false)
    useUserStore.getState().setConsent('unknown')
    expect(track('page_view', { page: 'home' })).toBe(false)
    expect(sent).toEqual([])
  })

  it('同意后上报，只保留基础类型字段', () => {
    useUserStore.getState().setConsent('agreed')
    track('login', { method: 'phone', is_new: true, merged: false, extra: { nested: 1 } } as any)
    expect(sent).toEqual([['login', { method: 'phone', is_new: true, merged: false }]])
  })

  it('通道异常不影响业务', () => {
    useUserStore.getState().setConsent('agreed')
    setTransport(() => { throw new Error('x') })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(track('page_view', { page: 'x' })).toBe(false)
    warn.mockRestore()
  })
})
