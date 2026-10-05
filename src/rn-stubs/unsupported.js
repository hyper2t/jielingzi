/**
 * 未链接原生模块的 JS 空实现（FE-RN-02）。metro.config.js 把 STUBBED_MODULES 里的包重定向到这里。
 *
 * 一个可以无限往下取属性、可调用、可 new 的代理：
 * - 任意属性（含 default、命名导出、常量如 ResizeMode.CONTAIN、BarCodeScanner.Constants.BarCodeType）都返回同类代理，
 *   保证 Taro-RN 在模块加载阶段的 import / 解构 / 读常量不会抛错；
 * - 调用返回 resolved Promise（开发期在控制台告警一次），对应的 Taro API（如 getLocation、setClipboardData）等于静默不可用；
 * - new 返回空对象；then / toJSON / Symbol 属性返回 undefined，避免被当成 thenable 或在序列化时递归。
 */
/* eslint-disable import/no-commonjs */
var warned = {}

function warn (name) {
  if (warned[name] || typeof __DEV__ === 'undefined' || !__DEV__) return
  warned[name] = true
  console.warn('[rn-stubs] ' + name + ' 在本 App 中不可用：对应原生模块未链接（见 docs/ops/app-sdk-list.md）')
}

function makeStub (name) {
  var target = function unsupportedNativeModule () {}
  var proxy = new Proxy(target, {
    get: function (_t, prop) {
      if (prop === '__esModule') return true
      if (prop === 'default') return proxy
      if (prop === 'then' || prop === 'toJSON' || typeof prop === 'symbol') return undefined
      if (prop === 'toString' || prop === 'valueOf') return function () { return '[unsupported native module ' + name + ']' }
      return makeStub(name + '.' + String(prop))
    },
    apply: function () {
      warn(name)
      return Promise.resolve(undefined)
    },
    construct: function () {
      warn(name)
      return {}
    }
  })
  return proxy
}

module.exports = makeStub('unsupported-native-module')
