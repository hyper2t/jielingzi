/**
 * 远程字体子集加载（FE-02）
 * - 小程序：Taro.loadFontFace（global: true，基础库 2.10+），失败回落系统衬线（CSS 字体栈中的 serif）
 * - H5：FontFace API
 * - RN：此处直接跳过。安装包未打包字体前 font-title / font-body 用系统字体（utils/tw.rn.ts 的 RN_FONT_FAMILY），
 *   v1.1 原生打包步骤见 docs/ops/rn-dev-client.md「字体」
 * 字体 CDN 目录读 .env 的 TARO_APP_FONT_BASE_URL；未配置时不加载，直接使用降级字体，不影响渲染（不白屏）。
 * 注意：页面渲染不等待字体，加载成功后由系统自动重绘。
 */
import Taro from '@tarojs/taro'

export const FONTS = [
  { family: 'Source Han Serif SC', file: 'source-han-serif-heavy-subset.woff2' },
  { family: 'LXGW WenKai', file: 'lxgw-wenkai-subset.woff2' }
] as const

export type FontFamily = typeof FONTS[number]['family']
export type FontStatus = 'idle' | 'loading' | 'loaded' | 'fallback'

const status: Record<string, FontStatus> = {}
const TIMEOUT_MS = 8000

export function getFontStatus (family: FontFamily): FontStatus {
  return status[family] || 'idle'
}

function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('font timeout')), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

function loadOne (family: string, url: string): Promise<void> {
  if (process.env.TARO_ENV === 'h5') {
    const FontFaceCtor = (globalThis as any).FontFace
    const doc = (globalThis as any).document
    if (!FontFaceCtor || !doc?.fonts) return Promise.reject(new Error('FontFace unsupported'))
    const face = new FontFaceCtor(family, `url("${url}")`, { display: 'swap' })
    return face.load().then((f: any) => { doc.fonts.add(f) })
  }
  return new Promise((resolve, reject) => {
    Taro.loadFontFace({
      global: true,
      family,
      source: `url("${url}")`,
      success: () => resolve(),
      fail: (e) => reject(e)
    } as Taro.loadFontFace.Option)
  })
}

/** 应用启动时调用一次；永不抛错，失败只记录降级状态 */
export async function loadFonts (baseUrl: string | undefined = process.env.TARO_APP_FONT_BASE_URL): Promise<Record<string, FontStatus>> {
  if (process.env.TARO_ENV === 'rn') return { ...status }
  await Promise.all(FONTS.map(async ({ family, file }) => {
    if (!baseUrl) { status[family] = 'fallback'; return }
    if (status[family] === 'loaded' || status[family] === 'loading') return
    status[family] = 'loading'
    try {
      await withTimeout(loadOne(family, `${baseUrl.replace(/\/$/, '')}/${file}`), TIMEOUT_MS)
      status[family] = 'loaded'
    } catch (e) {
      status[family] = 'fallback'
      console.warn(`[font] ${family} 加载失败，使用系统字体`, e)
    }
  }))
  return { ...status }
}
