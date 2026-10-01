/**
 * RN CLI 自动链接（Android settings.gradle / iOS Podfile 的 use_native_modules!）配置。
 *
 * 只有根 package.json 里直接声明的依赖才会被链接。Taro-RN 依赖的一批原生模块（定位、相册、剪贴板、WebView 等）
 * 本 App 用不到，即使以后有人运行 upgradePeerdeps 把它们写进 dependencies，这里也保证不会被链接进安装包
 * （对应 JS 侧由 metro.config.js 重定向到 src/rn-stubs/unsupported.js；expo 模块的排除见 package.json 的 expo.autolinking.exclude）。
 * 完整清单与理由：docs/ops/app-sdk-list.md（FE-RN-02）。
 */
const unlinked = {
  platforms: { android: null, ios: null }
}

/**
 * 微信 Open SDK（FE-L05 / NA-L01 / NA-L03）：Android（WXEntryActivity + Manifest <queries>）与 iOS 都走自动链接。
 * iOS 注意：react-native-wechat-lib 3.0.4 的 podspec 只编译桥接源码、不链接它自带的 libWeChatSDK.a，
 * 微信 SDK 本体由 ios/Podfile 里的官方 pod 'WechatOpenSDK-XCFramework' 提供；
 * Universal Link 回调由 AppDelegate.mm 手动转发给 WXApi（该库只处理 URL Scheme）。
 */
module.exports = {
  dependencies: {
    '@react-native-community/geolocation': unlinked,
    '@react-native-camera-roll/camera-roll': unlinked,
    '@react-native-clipboard/clipboard': unlinked,
    'react-native-syan-image-picker': unlinked,
    'react-native-webview': unlinked,
    'react-native-maps': unlinked,
    // 通过 Apple 登录（NA-L04）只在 iOS 用：不链接它的 Android（Kotlin）实现，避免给 Android 构建引入 Kotlin 插件
    '@invertase/react-native-apple-authentication': { platforms: { android: null } }
  }
}
