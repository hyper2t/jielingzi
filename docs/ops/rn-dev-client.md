# App 联调：开发客户端（Taro Playground 已不能直接运行本 App）

## 结论

- **Taro Playground 只能跑「降级模式」**：本 App 的 Android / iOS 工程里有自己的原生模块（`react-native-track-player` 播放、`react-native-wechat-lib` 微信登录），Playground 这个壳应用里没有它们。
  2026-09-29 之前的 bundle 在 iOS Playground 上会在启动时直接崩（见下方「故障现象」）；现在 JS 侧已改为按原生模块是否存在懒加载：
  Playground 里能起、能浏览、能手机号登录、能播放（expo-av 兜底：无锁屏 / 通知栏控制、无微信登录、后台播放不保证），Metro 日志里会有一条 `[player] 安装包内没有 react-native-track-player 原生模块` 的 warn。
- **验证真实功能（锁屏控制、后台播放、微信登录、原生权限）必须用自己的安装包**，即「开发客户端」：由 CI 构建的 **debug APK**，启动时能连上 Metro 就走热更新，连不上就用内置的 JS bundle。
- iOS 的开发客户端需要 Mac + Xcode（或以后在 CI 上做签名分发）；在此之前 iOS 只能用 Playground 降级模式看 UI。

## 故障现象（记录，便于以后对号入座）

`npm run dev:rn` 后 Playground 加载 bundle 即报：

```
Invariant Violation: `new NativeEventEmitter()` requires a non-null argument.
Invariant Violation: Failed to call into JavaScript module method AppRegistry.runApplication(). Module has not been registered as callable.
```

原因：`react-native-track-player` 在 iOS 上 import 时执行 `new NativeEventEmitter(NativeModules.TrackPlayerModule)`，壳应用里该原生模块为空，RN 的 iOS 非空断言直接抛错；入口 `index.js` 顶部就 import 了它，于是整个 bundle 初始化失败，`AppRegistry` 从未注册组件，后面两条是连带错误。Android 上同一处不抛错，但一到 `setupPlayer` 就会失败。
修法：`index.js` 与 `src/features/player/engine/engine.rn.ts` 只在 `NativeModules.TrackPlayerModule` 存在时 `require` RNTP，否则用 `engine.expo-av.ts`（`expo-av` 是 Taro-RN 自带依赖，正式包和 Playground 里都有）。微信 SDK 本来就是懒加载的（`features/auth/wechat.rn.ts`），未配置 AppID 时不会被 require。

### 2026-09-30：能起了，但 Metro 刷 twrnc 警告 + iOS 红框 `Unrecognized font family "Source Han Serif SC"`

```
WARN  `vh` CSS unit requires configuration with `useDeviceContext()`
WARN  `screen` unknown or invalid utility          ← min-h-screen（components/Screen）
WARN  `inline-flex` / `whitespace-nowrap` / `block` / `inline-block` unknown or invalid utility   ← FilterChips / AlbumMini / 家长中心横滑行
ERROR Unrecognized font family 'Source Han Serif SC'   ← font-title（仅 iOS 报错，Android 静默回落）
```

都是**警告级**（App 照常运行），但每次渲染都打一遍，日志没法看；字体那条在 iOS 上是红框。
原因：`src/utils/tw.rn.ts` 把网页 Tailwind 类原样交给 twrnc，twrnc 不认 `block` / `inline-*` / `whitespace-*` / `*-screen`（100vh）这些纯网页概念；
`font-title` / `font-body` 解析出的 `"Source Han Serif SC"` / `"LXGW WenKai"` 是网页端远程加载的字体（`utils/font.ts`），安装包里没有。
之前 `src/utils/__tests__/tw.rn.test.ts` 没拦住，是因为 twrnc 在 Jest 里自动静音（按 `JEST_WORKER_ID` 判断），用例形同虚设。
修法：
- `tw.rn.ts` 先把类名规范化再交给 twrnc：`inline-flex→flex`、`fixed→absolute`、`truncate→overflow-hidden`、`[Nem]`→px、`w-screen`/`h-screen` 读 `Dimensions`、`min-h-screen` 丢弃（页面根节点 `flex-1` 已铺满），
  `block` / `inline*` / `whitespace-*` / `transition*` / `hover:` 等直接丢弃；结果按类名串缓存，同一组类只解析一次。
- 横滑一行（分龄胶囊、家长中心）的 inline 写法收进 `src/utils/layout.ts` 的 `HSCROLL`：小程序 / H5 维持 `inline-flex + white-space: nowrap`，RN 用 `flex-row`（此前 RN 上这些子项其实是竖着排的）。
- 字体见下方「字体」。
- 测试改为加载 twrnc 前临时去掉 `JEST_WORKER_ID`，现在任何一个已用类触发 twrnc 警告都会让 `jest src/utils` 失败。

## 拿到 Android 开发客户端

1. GitHub → Actions → **App Android** → Run workflow → `variant` 选 **debug** → 等构建完成。
2. 下载 artifact `android-debug` 里的 `jielingzi-<版本>-<构建号>-devclient.apk`，装到手机（允许安装未知来源）。
   有正式 keystore Secrets 时 debug 包也用正式签名（NA-L02），微信开放平台按签名放行，微信登录回调在开发客户端里也能收到。
3. 什么时候要重新拿一个：改了 `android/**`、带原生代码的依赖（`package.json` 里新增 / 升级原生库）、`react-native.config.js`、`package.json` 的 `expo.autolinking`、`metro.config.js` 的 stub 列表。**纯 JS / 样式 / 配置改动不用**，Metro 热更新即可。

## 连接 Metro（热更新）

1. 电脑上 `npm run dev:rn`（Taro 的 Metro 监听 8081；打印的二维码是给 Playground 的，开发客户端不用扫）。
2. 手机连上 Metro，二选一：
   - **USB**：`%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe reverse tcp:8081 tcp:8081`，然后打开 App（或在 App 里摇一摇 → Reload）。
   - **同一 Wi-Fi**：打开 App → 摇一摇 → Settings → *Debug server host & port for device* → 填 `<电脑局域网 IP>:8081` → 返回 → Reload。Windows 防火墙需放行 8081（node）。
3. 看到 Metro 终端出现 `BUNDLE ./index.js` 进度即已连上；之后保存文件自动刷新。没有连上时 App 会静默使用内置 bundle，不报错——如果改动「不生效」，先确认这一点。

## 环境变量

开发客户端内置 bundle 的 `TARO_APP_*` 来自 CI 的 Secrets / Variables；连上 Metro 后以电脑上 `.env` 为准（`config/client-env.js`）。
`TARO_APP_DATA_SOURCE=cloud` 才会真的访问云开发，否则是内置 mock 数据（登录页验证码固定 `123456`，微信登录 mock 报 50201）。
`TARO_APP_RN_FONTS=bundled` 只有在安装包真的打进了字体文件时才能设（见下），Playground 与现在的 CI 包都不要设。

## 字体

网页端（小程序 / H5）标题用思源宋体 Heavy、正文用霞鹜文楷，都是运行时从 CDN 加载子集（`src/utils/font.ts`）。RN 没有这条路，只能用安装包里有的字体，
iOS 引用不存在的 `fontFamily` 会直接红框 `Unrecognized font family`（Android 静默回落）。iOS 预装字体里没有中文衬线体（宋体-简 Songti SC 是「可下载字体」，不预装）。

- **现状（默认）**：`tw.rn.ts` 里 `font-title` / `font-body` 在 iOS 解析为 `System`（PingFang SC），Android 解析为 `serif` / `sans-serif`
  （Android 8+ 的 `serif` 会命中系统自带的 Noto Serif CJK，即思源宋体；国产 ROM 换过系统字体的机器可能是黑体）。Playground 与当前 CI 包都是这个样子。
- **要在 App 里也用品牌字体（v1.1 原生打包）**，按下面做，做完在 CI 的 Variables 里加 `TARO_APP_RN_FONTS=bundled`：
  1. 准备子集字体（与网页端同一份字符集，OFL 许可可随包分发），文件名用 PostScript 名：
     `assets/fonts/SourceHanSerifSC-Heavy.otf`、`assets/fonts/LXGWWenKai-Regular.ttf`；
     Android 的 RN 字体查找是按文件名 + 样式后缀（`ReactFontManager`：`<family>_bold.ttf` 等），标题几乎都是 `font-bold`，所以**再复制一份** `SourceHanSerifSC-Heavy_bold.otf`、`LXGWWenKai-Regular_bold.ttf`（否则加粗文字会退回系统字体）。
  2. `react-native.config.js` 加 `assets: ['./assets/fonts']`，执行 `npx react-native-asset`：
     Android 复制到 `android/app/src/main/assets/fonts/`，iOS 写入 `ios/taroDemo/Info.plist` 的 `UIAppFonts` 并加进 Xcode 工程资源。
  3. 重新构建安装包（Actions → App Android / App iOS），`tw.rn.ts` 检测到 `TARO_APP_RN_FONTS=bundled` 才会输出这两个字体名。
  4. 真机确认：iOS 不再红框；Android 标题 / 正文字形变了。Playground 永远拿不到这些字体，仍是系统字体。
