import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkIosNative, plistStrings } from './ios-native-check.mjs'

const plist = (schemes, queries = ['weixin', 'weixinULAPI', 'weixinURLParamsAPI']) => `<plist><dict>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array>${schemes.map(s => `<string>${s}</string>`).join('')}</array></dict></array>
<key>LSApplicationQueriesSchemes</key><array>${queries.map(s => `<string>${s}</string>`).join('')}</array>
</dict></plist>`
const ent = (host, apple = true) => `<plist><dict><key>com.apple.developer.associated-domains</key><array><string>applinks:${host}</string></array>${apple ? '<key>com.apple.developer.applesignin</key><array><string>Default</string></array>' : ''}</dict></plist>`
const env = { TARO_APP_WX_APP_ID: 'wx123', TARO_APP_WX_UNIVERSAL_LINK: 'https://a.example.com/app/' }

test('plistStrings 取 key 后第一个数组', () => {
  assert.deepEqual(plistStrings(plist(['wx1', 'wx2']), 'CFBundleURLSchemes'), ['wx1', 'wx2'])
  assert.deepEqual(plistStrings('<plist/>', 'X'), [])
})

test('entitlements 缺少通过 Apple 登录能力：报错（与微信配置无关）', () => {
  const r = checkIosNative({ env: {}, infoPlist: '', entitlements: ent('a.example.com', false), aasa: null })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /applesignin/)
})

test('全部一致：无错误；AASA 已填 Team ID 无提示', () => {
  const r = checkIosNative({ env, infoPlist: plist(['wx123']), entitlements: ent('a.example.com'), aasa: '{"appID":"AB12CD34EF.cn.x"}' })
  assert.deepEqual(r, { errors: [], warnings: [] })
})

test('未配置 AppID：只提示', () => {
  const r = checkIosNative({ env: {}, infoPlist: '', entitlements: null, aasa: null })
  assert.equal(r.errors.length, 0)
  assert.equal(r.warnings.length, 1)
})

test('URL Scheme / 白名单 / 域名不一致都报错', () => {
  const r = checkIosNative({ env, infoPlist: plist(['wx999'], ['weixin']), entitlements: ent('b.example.com'), aasa: '{}' })
  assert.equal(r.errors.length, 4)
  assert.match(r.errors[0], /CFBundleURLSchemes/)
  assert.match(r.errors[3], /applinks:a\.example\.com/)
})

test('Universal Link 缺失 / 非 https / 不以 / 结尾', () => {
  assert.match(checkIosNative({ env: { TARO_APP_WX_APP_ID: 'wx123' }, infoPlist: plist(['wx123']), entitlements: null, aasa: null }).errors[0], /必须配置/)
  assert.match(checkIosNative({ env: { ...env, TARO_APP_WX_UNIVERSAL_LINK: 'http://a.example.com/app/' }, infoPlist: plist(['wx123']), entitlements: ent('a.example.com'), aasa: '{}' }).errors[0], /https/)
  assert.match(checkIosNative({ env: { ...env, TARO_APP_WX_UNIVERSAL_LINK: 'https://a.example.com/app' }, infoPlist: plist(['wx123']), entitlements: ent('a.example.com'), aasa: '{}' }).errors[0], /结尾/)
})

test('AASA 仍是占位且没有 APPLE_TEAM_ID：提示而非错误；有 APPLE_TEAM_ID 则不提示', () => {
  const r = checkIosNative({ env, infoPlist: plist(['wx123']), entitlements: ent('a.example.com'), aasa: '{"appID":"APPLE_TEAM_ID.cn.x"}' })
  assert.equal(r.errors.length, 0)
  assert.match(r.warnings[0], /APPLE_TEAM_ID/)
  const ok = checkIosNative({ env: { ...env, APPLE_TEAM_ID: 'AB12CD34EF' }, infoPlist: plist(['wx123']), entitlements: ent('a.example.com'), aasa: '{"appID":"APPLE_TEAM_ID.cn.x"}' })
  assert.deepEqual(ok, { errors: [], warnings: [] })
})
