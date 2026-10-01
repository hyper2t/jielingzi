const path = require('path')
const { mergeConfig } = require('metro-config')
const { getMetroConfig } = require('@tarojs/rn-supporter')

/**
 * 不链接进 App 的原生模块（FE-RN-02，清单见 docs/ops/app-sdk-list.md）：
 * Taro-RN 会在启动时 import 它们，其中 expo 系列的 JS 在原生模块缺失时 import 即抛错，
 * 所以在 metro 解析阶段把这些包（含子路径）统一指向空实现 src/rn-stubs/unsupported.js。
 * 原生侧的排除：package.json expo.autolinking.exclude（expo 模块）+ react-native.config.js（RN CLI 模块）。
 */
const STUBBED_MODULES = [
  'expo-location',
  'expo-sensors',
  'expo-brightness',
  'expo-barcode-scanner',
  'expo-image-picker',
  '@react-native-community/geolocation',
  '@react-native-camera-roll/camera-roll',
  '@react-native-clipboard/clipboard',
  'react-native-syan-image-picker',
  'react-native-webview'
]
const STUB_FILE = path.resolve(__dirname, 'src/rn-stubs/unsupported.js')

function isStubbed (moduleName) {
  return STUBBED_MODULES.some(m => moduleName === m || moduleName.startsWith(`${m}/`))
}

module.exports = (async function () {
  const taroConfig = await getMetroConfig()
  const taroResolve = taroConfig.resolver && taroConfig.resolver.resolveRequest
  return mergeConfig(taroConfig, {
    // https://facebook.github.io/metro/docs/configuration
    resolver: {
      resolveRequest (context, moduleName, platform) {
        if (isStubbed(moduleName)) return { type: 'sourceFile', filePath: STUB_FILE }
        if (taroResolve) return taroResolve(context, moduleName, platform)
        return context.resolveRequest(context, moduleName, platform)
      }
    }
  })
})()
