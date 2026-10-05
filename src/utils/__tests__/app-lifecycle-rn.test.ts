/**
 * RN 端前后台切换（app-lifecycle.rn.ts）：AppState 替身验证 active / background / inactive 的映射与去重。
 */
jest.mock('react-native', () => {
  const handlers: Array<(s: string) => void> = []
  return {
    __esModule: true,
    __handlers: handlers,
    AppState: {
      currentState: 'active',
      addEventListener: jest.fn((_type: string, cb: (s: string) => void) => {
        handlers.push(cb)
        return { remove: jest.fn() }
      })
    }
  }
}, { virtual: true })

import { AppState } from 'react-native'
import { onAppHide, onAppShow, __emitAppStateForTest } from '../app-lifecycle.rn'

const handlers: Array<(s: string) => void> = (jest.requireMock('react-native') as any).__handlers
const emit = (s: string) => handlers.forEach(h => h(s))

test('只绑定一次 AppState；background / inactive → hide 一次，active → show 一次', () => {
  const log: string[] = []
  const offShow = onAppShow(() => log.push('show'))
  const offHide = onAppHide(() => log.push('hide'))
  onAppHide(() => log.push('hide2'))
  expect((AppState.addEventListener as jest.Mock)).toHaveBeenCalledTimes(1)
  expect((AppState.addEventListener as jest.Mock).mock.calls[0][0]).toBe('change')

  emit('inactive')
  emit('background')
  expect(log).toEqual(['hide', 'hide2'])
  emit('active')
  emit('active')
  expect(log).toEqual(['hide', 'hide2', 'show'])

  offShow()
  offHide()
  __emitAppStateForTest('background')
  __emitAppStateForTest('active')
  expect(log).toEqual(['hide', 'hide2', 'show', 'hide2'])
})

test('回调抛错不影响其他回调', () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  const log: string[] = []
  onAppHide(() => { throw new Error('boom') })
  onAppHide(() => log.push('ok'))
  __emitAppStateForTest('background')
  expect(log).toEqual(['ok'])
  expect(error).toHaveBeenCalled()
  error.mockRestore()
})
