import Taro from '@tarojs/taro'
import { getFontStatus, loadFonts } from '@/utils/font'

describe('loadFonts', () => {
  it('未配置 CDN 时直接降级，不抛错', async () => {
    const s = await loadFonts('')
    expect(Object.values(s)).toEqual(['fallback', 'fallback'])
    expect(Taro.loadFontFace).not.toHaveBeenCalled()
  })

  it('加载失败时降级', async () => {
    ;(Taro.loadFontFace as jest.Mock).mockImplementation((o: any) => o.fail({ errMsg: 'fail' }))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await loadFonts('https://cdn.example.com/fonts/')
    expect(getFontStatus('LXGW WenKai')).toBe('fallback')
    warn.mockRestore()
  })

  it('加载成功', async () => {
    ;(Taro.loadFontFace as jest.Mock).mockImplementation((o: any) => o.success())
    await loadFonts('https://cdn.example.com/fonts')
    expect(getFontStatus('Source Han Serif SC')).toBe('loaded')
    expect(Taro.loadFontFace).toHaveBeenLastCalledWith(expect.objectContaining({
      global: true, source: 'url("https://cdn.example.com/fonts/lxgw-wenkai-subset.woff2")'
    }))
  })
})
