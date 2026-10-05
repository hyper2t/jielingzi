/**
 * 验收：项目中实际用到的 Tailwind 类，在 twrnc（RN）下全部可解析、无警告。
 * 做法：用 tailwind 本身从 src 扫出会生成 CSS 的类名集合，再逐个交给 tw.rn。
 *
 * 注意：twrnc 在 Jest 里默认静音（helpers.warn 按 process.env.JEST_WORKER_ID 判断），
 * 之前这条用例因此形同虚设，真机上 block / inline-flex / min-h-screen 一直在刷警告。
 * 这里在加载 tw.rn 前临时去掉 JEST_WORKER_ID，让 twrnc 照常 console.warn。
 */
import fs from 'fs'
import path from 'path'

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', constants: { reactNativeVersion: { major: 0, minor: 70, patch: 15 } } },
  Dimensions: { get: () => ({ width: 375, height: 812, scale: 3, fontScale: 1 }) },
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 375, height: 812 })
}))

const root = path.resolve(__dirname, '../../..')

function walk (dir: string, out: string[] = []): string[] {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, out) } else if (/\.tsx?$/.test(e.name)) out.push(p)
  })
  return out
}

async function usedClasses (): Promise<string[]> {
  const postcss = require('postcss')
  const tailwind = require('tailwindcss')
  const config = require(path.join(root, 'tailwind.config.js'))
  const files = walk(path.join(root, 'src')).filter(f => !f.endsWith('.rn.ts'))
  const res = await postcss([tailwind({ ...config, content: files })]).process('@tailwind utilities;', { from: undefined })
  const set = new Set<string>()
  res.root.walkRules((rule: any) => {
    rule.selectors.forEach((s: string) => {
      const m = s.match(/^\.((?:\\.|[^\s:>+~.])+)/)
      if (m) set.add(m[1].replace(/\\/g, ''))
    })
  })
  return Array.from(set).sort()
}

type TwModule = typeof import('@/utils/tw.rn')

/** 去掉 JEST_WORKER_ID 后加载模块（twrnc 的静音开关在模块加载时定型），用完恢复 */
function loadUnmuted<T> (load: () => T): T {
  const id = process.env.JEST_WORKER_ID
  delete process.env.JEST_WORKER_ID
  try { return load() } finally { if (id !== undefined) process.env.JEST_WORKER_ID = id }
}

jest.setTimeout(60000)

describe('twrnc 兼容', () => {
  let mod: TwModule
  let warn: jest.SpyInstance

  beforeAll(() => {
    mod = loadUnmuted(() => require('@/utils/tw.rn'))
  })
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })

  it('twrnc 警告没有被 Jest 静音（否则本文件全部用例无效）', () => {
    mod.tw('not-a-real-utility-xyz')
    expect(warn).toHaveBeenCalled()
  })

  it('所有已用类在 RN 下无警告', async () => {
    const classes = await usedClasses()
    expect(classes.length).toBeGreaterThan(30)
    const bad: string[] = []
    classes.forEach(c => {
      warn.mockClear()
      mod.tw(c)
      if (warn.mock.calls.length) bad.push(`${c}: ${warn.mock.calls[0].join(' ')}`)
    })
    expect(bad).toEqual([])
  })

  it('阴影令牌映射为 RN shadow + elevation', () => {
    expect(mod.tw('shadow-float').style).toMatchObject({ elevation: 6, shadowOpacity: 0.14 })
    expect(mod.tw('bg-brand p-4').style).toMatchObject({ backgroundColor: '#578A6B', paddingTop: 16 })
  })

  it('网页专用类：改写或丢弃，不产生警告', () => {
    expect(mod.tw('inline-flex whitespace-nowrap block inline-block').style).toEqual({ display: 'flex' })
    expect(mod.tw('fixed inset-0').style).toMatchObject({ position: 'absolute', top: 0, left: 0 })
    expect(mod.tw('truncate').style).toEqual({ overflow: 'hidden' })
    expect(mod.tw('!inline hover:bg-ink sm:p-4 md:flex transition duration-150 cursor-pointer select-none').style).toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  it('视口尺寸类读 Dimensions；min-h-screen 丢弃（页面根节点 flex-1 已铺满）', () => {
    expect(mod.tw('w-screen').style).toEqual({ width: 375 })
    expect(mod.tw('h-screen').style).toEqual({ height: 812 })
    const root = mod.tw('flex flex-col flex-1 min-h-screen bg-paper').style as any
    expect(root.minHeight).toBeUndefined()
    expect(root.backgroundColor).toBe('#F7F8F2')
    expect(warn).not.toHaveBeenCalled()
  })

  it('任意值 em / vh 换算为 px', () => {
    expect(mod.tw('max-w-[34em]').style).toEqual({ maxWidth: 544 })
    expect(mod.tw('h-[50vh]').style).toEqual({ height: 406 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('字体：iOS 默认用 System，不引用未打包的字体名', () => {
    expect(mod.tw('font-title').style).toEqual({ fontFamily: 'System' })
    expect(mod.tw('font-body font-bold').style).toEqual({ fontFamily: 'System', fontWeight: 'bold' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('字体：Android 默认 serif / sans-serif；TARO_APP_RN_FONTS=bundled 时按 PostScript 名引用', () => {
    const android = () => ({
      Platform: { OS: 'android', constants: { reactNativeVersion: { major: 0, minor: 70, patch: 15 } } },
      Dimensions: { get: () => ({ width: 360, height: 780, scale: 3, fontScale: 1 }) },
      useColorScheme: () => 'light',
      useWindowDimensions: () => ({ width: 360, height: 780 })
    })
    // 顶部 jest.mock 的 react-native 已实例化在 mock registry 里，isolateModules 仍会复用它，必须 resetModules 再 doMock
    jest.resetModules()
    jest.doMock('react-native', android)
    const m1: TwModule = loadUnmuted(() => require('@/utils/tw.rn'))
    expect(m1.tw('font-title').style).toEqual({ fontFamily: 'serif' })
    expect(m1.tw('font-body').style).toEqual({ fontFamily: 'sans-serif' })
    expect(m1.tw('w-screen').style).toEqual({ width: 360 })

    const prev = process.env.TARO_APP_RN_FONTS
    process.env.TARO_APP_RN_FONTS = 'bundled'
    try {
      jest.resetModules()
      jest.doMock('react-native', android)
      const m2: TwModule = loadUnmuted(() => require('@/utils/tw.rn'))
      expect(m2.tw('font-title').style).toEqual({ fontFamily: 'SourceHanSerifSC-Heavy' })
      expect(m2.tw('font-body').style).toEqual({ fontFamily: 'LXGWWenKai-Regular' })
    } finally {
      if (prev === undefined) delete process.env.TARO_APP_RN_FONTS
      else process.env.TARO_APP_RN_FONTS = prev
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('同一组类名只解析一次（缓存）', () => {
    expect(mod.tw('p-4 bg-paper').style).toBe(mod.tw('p-4 bg-paper').style)
  })
})
