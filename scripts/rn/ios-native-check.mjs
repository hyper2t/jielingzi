/**
 * iOS 原生配置与 .env 的一致性校验（NA-L03）。
 *
 * 微信登录在 iOS 上有三处必须一致，改了一处忘了另外两处时构建能过、上线后微信授权却回不到 App：
 *   1. TARO_APP_WX_APP_ID          ↔ ios/taroDemo/Info.plist 的 CFBundleURLSchemes（URL Scheme 回跳）
 *   2. TARO_APP_WX_UNIVERSAL_LINK  ↔ ios/taroDemo/taroDemo.entitlements 的 applinks:<域名>（Universal Link 回跳）
 *   3. Universal Link 以 https:// 开头、以 / 结尾（微信开放平台要求）
 * 另外检查官网 AASA 文件（website/public/.well-known/apple-app-site-association）：仓库里保留 Team ID 占位，
 * 由 website/scripts/deploy.sh 在部署时用 .env 的 APPLE_TEAM_ID 替换；两者都没有时给出提示。
 * 通过 Apple 登录（NA-L04）：entitlements 必须有 com.apple.developer.applesignin = Default，否则真机点按钮直接报错 1000。
 *
 * scripts/rn/bundle.mjs --platform ios 会调用；--strict（CI）时有 error 则失败。
 *   node scripts/rn/ios-native-check.mjs            # 手动检查
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const AASA_PLACEHOLDER = 'APPLE_TEAM_ID'

function readEnvFile (root) {
  const out = {}
  const f = join(root, '.env')
  if (!existsSync(f)) return out
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** plist 里某个 key 之后第一个 <array> 的所有 <string> */
export function plistStrings (xml, key) {
  const i = xml.indexOf(`<key>${key}</key>`)
  if (i < 0) return []
  const rest = xml.slice(i)
  const start = rest.indexOf('<array>')
  const end = rest.indexOf('</array>')
  if (start < 0 || end < start) return []
  return [...rest.slice(start, end).matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1].trim())
}

/**
 * @param {{ env: Record<string,string|undefined>, infoPlist: string, entitlements: string|null, aasa: string|null }} input
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkIosNative ({ env, infoPlist, entitlements, aasa }) {
  const errors = []
  const warnings = []
  const appId = (env.TARO_APP_WX_APP_ID || '').trim()
  const link = (env.TARO_APP_WX_UNIVERSAL_LINK || '').trim()

  if (entitlements && !plistStrings(entitlements, 'com.apple.developer.applesignin').includes('Default')) {
    errors.push('entitlements 缺少 com.apple.developer.applesignin = Default（通过 Apple 登录）')
  }

  if (!appId) {
    warnings.push('未配置 TARO_APP_WX_APP_ID：iOS / Android 都不显示微信登录')
    return { errors, warnings }
  }
  const schemes = plistStrings(infoPlist, 'CFBundleURLSchemes')
  if (!schemes.includes(appId)) errors.push(`Info.plist 的 CFBundleURLSchemes（${schemes.join(', ') || '空'}）不含 TARO_APP_WX_APP_ID=${appId}`)
  const queries = plistStrings(infoPlist, 'LSApplicationQueriesSchemes')
  for (const s of ['weixin', 'weixinULAPI', 'weixinURLParamsAPI']) {
    if (!queries.includes(s)) errors.push(`Info.plist 的 LSApplicationQueriesSchemes 缺少 ${s}`)
  }

  if (!link) {
    errors.push('iOS 微信登录必须配置 TARO_APP_WX_UNIVERSAL_LINK（微信 SDK 2.x registerApp 需要）')
    return { errors, warnings }
  }
  let url = null
  try { url = new URL(link) } catch (e) { /* 下面报错 */ }
  if (!url || url.protocol !== 'https:') errors.push(`TARO_APP_WX_UNIVERSAL_LINK 必须是 https 地址：${link}`)
  else {
    if (!link.endsWith('/')) errors.push(`TARO_APP_WX_UNIVERSAL_LINK 必须以 / 结尾（微信开放平台要求）：${link}`)
    if (!entitlements) errors.push('缺少 ios/taroDemo/taroDemo.entitlements')
    else {
      const domains = plistStrings(entitlements, 'com.apple.developer.associated-domains')
      if (!domains.includes(`applinks:${url.host}`)) errors.push(`entitlements 的 associated-domains（${domains.join(', ') || '空'}）不含 applinks:${url.host}`)
    }
    if (!aasa) warnings.push('官网缺少 website/public/.well-known/apple-app-site-association（Universal Link 无法生效）')
    else if (aasa.includes(AASA_PLACEHOLDER) && !/^[A-Z0-9]{10}$/.test((env.APPLE_TEAM_ID || '').trim())) {
      warnings.push(`未配置 APPLE_TEAM_ID（10 位），官网 AASA 部署时无法替换占位 ${AASA_PLACEHOLDER}，Universal Link 不会生效`)
    }
  }
  return { errors, warnings }
}

export function runIosNativeCheck (root = ROOT) {
  const read = p => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null)
  return checkIosNative({
    env: { ...readEnvFile(root), ...process.env },
    infoPlist: read('ios/taroDemo/Info.plist') || '',
    entitlements: read('ios/taroDemo/taroDemo.entitlements'),
    aasa: read('website/public/.well-known/apple-app-site-association')
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, warnings } = runIosNativeCheck()
  for (const w of warnings) console.warn(`[ios-native-check] 提示：${w}`)
  for (const e of errors) console.error(`[ios-native-check] 错误：${e}`)
  if (!errors.length) console.log('[ios-native-check] iOS 微信登录原生配置与 .env 一致')
  process.exit(errors.length ? 1 : 0)
}
