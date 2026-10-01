/**
 * 小程序产物冒烟（Node 里模拟 wx 环境）：加载 dist 的 runtime/taro/vendors/common/app 与全部页面，触发 onLoad 并打印 setData。
 * 用途：开发者工具白屏时先跑这个，判断是产物问题（这里会抛错）还是工具缓存问题（这里正常 → 清缓存重编译）。
 * 用法：node scripts/ops/weapp-smoke.cjs [dist]
 */
const fs = require('fs'), path = require('path'), vm = require('vm')
const root = path.resolve(process.argv[2] || 'dist')
const noop = () => {}
const sys = { platform: 'devtools', windowWidth: 375, windowHeight: 667, statusBarHeight: 20, pixelRatio: 2, SDKVersion: '3.5.0', version: '8.0.0', language: 'zh_CN', system: 'iOS 16', model: 'iPhone', screenWidth: 375, screenHeight: 667, safeArea: { top: 20, bottom: 667, left: 0, right: 375, width: 375, height: 647 }, theme: 'light' }
const storage = new Map()
const wx = new Proxy({
  getSystemInfoSync: () => sys, getSystemInfo: (o) => o && o.success && o.success(sys), getWindowInfo: () => sys, getDeviceInfo: () => sys, getAppBaseInfo: () => sys, getSystemSetting: () => ({}), getAppAuthorizeSetting: () => ({}),
  getMenuButtonBoundingClientRect: () => ({ top: 24, bottom: 56, left: 281, right: 368, width: 87, height: 32 }),
  getStorageSync: (k) => storage.has(k) ? storage.get(k) : '', setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: (k) => storage.delete(k), clearStorageSync: () => storage.clear(),
  getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 0 }),
  getNetworkType: (o) => o && o.success && o.success({ networkType: 'wifi' }), onNetworkStatusChange: noop, offNetworkStatusChange: noop,
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }), getLaunchOptionsSync: () => ({ path: 'pages/index/index', scene: 1001, query: {} }), getEnterOptionsSync: () => ({ path: 'pages/index/index', scene: 1001, query: {} }),
  canIUse: () => true, nextTick: (f) => setTimeout(f, 0), getUpdateManager: () => ({ onCheckForUpdate: noop, onUpdateReady: noop, onUpdateFailed: noop }),
  cloud: { init: noop, callFunction: () => Promise.resolve({ result: {} }) },
  getBackgroundAudioManager: () => ({}), createInnerAudioContext: () => ({}), onAppShow: noop, onAppHide: noop, onError: noop, onUnhandledRejection: noop, onPageNotFound: noop, onThemeChange: noop,
  setNavigationBarTitle: noop, setNavigationBarColor: noop, showToast: noop, hideToast: noop, showLoading: noop, hideLoading: noop, reportAnalytics: noop, reportEvent: noop, getLogManager: () => ({ log: noop, info: noop, warn: noop, debug: noop }), getRealtimeLogManager: () => ({ info: noop, warn: noop, error: noop }),
  env: { USER_DATA_PATH: '/tmp' }
}, { get (t, k) { if (k in t) return t[k]; console.log('[wx miss]', String(k)); return undefined } })
const pages = [], apps = [], loaded = new Set()
const ctx = {
  wx, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Symbol, Object, Array, Map, Set, WeakMap, WeakSet, Date, Math, JSON, Reflect, Proxy, Error, TypeError, RegExp, String, Number, Boolean, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, globalThis: undefined,
  App: (o) => { apps.push(o); ctx.__app = o }, Page: (o) => { pages.push(o) }, Component: (o) => { pages.push(o) }, getApp: () => ctx.__appInst || {}, getCurrentPages: () => [], require: (p) => { const rel = p.replace(/^(\.\.\/)+/,'').replace(/^\.\//,'').replace(/\.js$/,'')+'.js'; if (!loaded.has(rel)) load(rel); return {} }, module: undefined, exports: undefined, define: undefined, requirePlugin: noop,
  __wxConfig: { envVersion: 'develop', platform: 'devtools' }
}
ctx.global = ctx; ctx.self = ctx; ctx.window = undefined
vm.createContext(ctx)
function load (rel) {
  if (loaded.has(rel)) return; loaded.add(rel)
  const p = path.join(root, rel)
  const code = fs.readFileSync(p, 'utf8')
  try { vm.runInContext(code, ctx, { filename: rel }) ; console.log('loaded', rel) } catch (e) { console.log('THROW in', rel, '::', e && e.message, '\n', String(e && e.stack).split('\n').filter(l => /^\s+at /.test(l)).slice(0,8).join('\n')) }
}
for (const f of ['runtime.js', 'taro.js', 'vendors.js', 'common.js', 'app.js']) load(f)
// launch app
try {
  const a = apps[0]
  if (a && a.onLaunch) { a.onLaunch({ path: 'pages/index/index', query: {}, scene: 1001 }); console.log('app.onLaunch ok') }
} catch (e) { console.log('THROW in app.onLaunch ::', e && e.message, '\n', String(e && e.stack).split('\n').filter(l => /^\s+at /.test(l)).slice(0,8).join('\n')) }
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(d + '/' + e.name) : (e.name === 'index.js' ? [d + '/' + e.name] : []))
const allPages = [...walk('pages'), ...walk('pkg-user')]
console.log('page files:', allPages.join(', '))
for (const pg of allPages) load(pg)
console.log('pages registered:', pages.length)
// try onLoad each page
pages.forEach((pg, i) => {
  try {
    const inst = Object.assign({}, pg, { setData: (d, cb) => { const s = JSON.stringify(d); console.log('  setData page', i, 'len', s.length, /\u5bb6\u957f\u4e2d\u5fc3|家长中心/.test(s) ? 'has 家长中心' : '', s.slice(0, 300)); cb && cb() }, route: 'p' + i, selectComponent: () => null, createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: noop }) }) }), getTabBar: noop, __route__: 'p' + i })
    pg.onLoad && pg.onLoad.call(inst, {})
    pg.onShow && pg.onShow.call(inst)
    console.log('page', i, 'onLoad ok')
  } catch (e) { console.log('THROW page', i, '::', e && e.message, '\n', String(e && e.stack).split('\n').filter(l => /^\s+at /.test(l)).slice(0,8).join('\n')) }
})
process.on('uncaughtException', e => console.log('UNCAUGHT ::', e.message, '\n', String(e.stack).split('\n').filter(l => /^\s+at /.test(l)).slice(0,8).join('\n')))
process.on('unhandledRejection', e => console.log('UNHANDLED ::', e && e.message))
setTimeout(() => console.log('done'), 1500)
