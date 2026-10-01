# App（React Native）第三方 SDK 与权限清单

> 用途：① 应用商店 / 备案 / 隐私政策里的「第三方 SDK 目录」；② 每次加原生依赖前对照，避免把用不到的能力打进安装包。
> 对应任务 FE-RN-02（原生模板去模板化）。维护原则：**这里没写的原生模块，不允许出现在安装包里**。

## 1. 身份与数据（先说结论）

- 账号：App **不使用匿名登录**；首页免登录，云端同步与「设置」前需登录：
  - 手机号验证码登录：云开发身份认证内置短信（`POST /auth/v1/verification` → `/verify` → `/signin|/signup`）。手机号只经过腾讯云身份认证服务；App 本地只保存脱敏显示（`138****8000`）；业务库 `users` 里不存手机号，只存 HMAC 哈希（`phoneHash`，用于后台实名与小程序 / App 同号识别，不可逆推号码）。
  - 微信登录（Android / iOS 均已接入 SDK；配置 `TARO_APP_WX_APP_ID`（iOS 另需 `TARO_APP_WX_UNIVERSAL_LINK`）后按钮才显示）：微信开放平台移动应用 → `user.wechatAppLogin` 换自定义登录票据；服务端用 unionid 与小程序账号合并。采集：微信 openid / unionid（不取昵称、头像）。SDK 只在用户同意协议后、且进入登录页 / 设置页账号区时才 `registerApp`。
  - 通过 Apple 登录（仅 iOS 13+，NA-L04 / BE-L09，审核指南 4.8）：系统 AuthenticationServices 授权 → `user.appleLogin` 校验 identityToken 换自定义登录票据。采集：Apple 用户标识 `sub`（不申请邮箱、姓名）。注销账号时重新授权一次并撤销 Apple 授权（审核指南 5.1.1(v)）。
  - 会话：access_token 2 h + refresh_token（30 天滚动），存 AsyncStorage（`auth_session`）；退出登录 `POST /auth/v1/revoke`；注销 `user.deleteAccount` + `DELETE /auth/v1/user/me`。
- 设备标识：仅一个**安装时随机生成的 UUID**（`x-device-id`，存 AsyncStorage，身份认证接口要求），不读取 IMEI / Android ID / IDFA / MAC。
- 上传到云端的数据：设置、同意时间、18+ 确认时间、手机号哈希（不存号码）、用户主动填写的练习档案（昵称、预置头像、练习方式、年限、目标、介绍；系统分配匿名代号），全部挂在账号（accountId）下；`user.deleteAccount` 连账号与 `_shared/owned.js` 登记的业务集合一起删（档案删除；话题 / 回复保留但解除归属）。
- 无广告、无第三方统计 / 推送 / 支付 / 分享 SDK。

## 2. 安装包内的原生模块

| 模块 | 版本 | 来源 / 许可 | 用途 | 采集的数据 |
| --- | --- | --- | --- | --- |
| react-native | 0.70.15 | Meta / MIT | 运行时（Hermes 引擎） | 无 |
| expo（expo-modules-core、expo-constants、expo-asset、expo-file-system、expo-font、expo-keep-awake、expo-av、expo-camera） | 47.x | Expo / MIT | Taro-RN 运行时依赖：资源加载、字体、屏幕常亮、音视频框架 | 无。`expo-camera` / `expo-av` 的录制能力 **不调用**，但它们的 JS 在 Taro 运行时中被 eager import，无法从链接中排除（见 §4）；对应权限在清单合并期剔除 |
| react-native-track-player | 4.1.x | doublesymmetry / Apache-2.0 | 音频播放、后台播放、锁屏 / 通知栏控制、音频焦点。JS 侧按 `NativeModules.TrackPlayerModule` 是否存在懒加载（`engine.rn.ts`）：Taro Playground 等没有该原生模块的壳应用里自动降级为 expo-av 播放（仅联调，见 `docs/ops/rn-dev-client.md`） | 无 |
| @react-native-async-storage/async-storage | 1.17.x | MIT | 本地存储（设置、缓存、进度队列） | 仅本机 |
| @react-native-community/netinfo | 9.3.x | MIT | 网络状态（离线提示、进度补传时机） | 无 |
| react-native-device-info | 10.x | MIT | 系统版本 / 机型（关于页与错误日志），**不读取唯一设备标识** | 系统版本、机型 |
| react-native-gesture-handler | 2.8.x | MIT | 手势（Taro 组件） | 无 |
| react-native-safe-area-context | 4.4.x | MIT | 安全区 | 无 |
| react-native-screens | 3.18.x | MIT | 页面栈 | 无 |
| react-native-root-siblings | 4.x | MIT | 全局 Toast / Modal（Taro API） | 无 |
| @bam.tech/react-native-image-resizer | 3.x | MIT | Taro 图片 API 依赖（被 @tarojs/taro-rn eager import，不能排除；本 App 不调用） | 无 |
| @react-navigation/* | 6.x | MIT | 路由（由 @tarojs/router-rn 使用） | 无 |
| Flipper（仅 debug 构建） | 0.125.0 | Meta / MIT | 调试；release 不包含 | — |
| react-native-wechat-lib（**已接入，Android + iOS**） | 3.0.4（RN 0.70 兼容；Android 内含 `com.tencent.mm.opensdk:wechat-sdk-android:6.8.20`；iOS 微信 SDK 由 Podfile 的官方 pod `WechatOpenSDK-XCFramework` 提供） | little-snow-fox / MIT，内含微信 Open SDK（腾讯） | 仅「微信登录」授权（`sendAuthRequest('snsapi_userinfo')` 取 code），不用分享 / 支付；`features/auth/wechat.rn.ts` 懒加载，家长未同意前不初始化 | 微信 Open SDK 会读取设备信息用于安全校验（以微信官方隐私说明为准）；需在隐私政策第三方 SDK 目录列出。原生侧：Android `wxapi/WXEntryActivity.java`、Manifest `<queries>` + `WXEntryActivity`、`proguard-rules.pro` keep；iOS（NA-L03）`Info.plist` URL Scheme / `LSApplicationQueriesSchemes`、entitlements `applinks:`、`AppDelegate.mm` 转发 Universal Link、官网 AASA（`scripts/rn/ios-native-check.mjs` 校验）。官方 pod 含支付代码，审核问到时说明未使用。运行期开关：`TARO_APP_WX_APP_ID`（为空 → 按钮不显示、SDK 不加载） |
| @invertase/react-native-apple-authentication（**已接入，仅 iOS 链接**） | 2.5.1 | Invertase / Apache-2.0；只包装系统 AuthenticationServices，无第三方服务端 | 「通过 Apple 登录」（NA-L04）：`features/auth/apple.rn.ts` 懒加载，`requestedScopes: []`（不取邮箱 / 姓名），nonce 防重放；按钮用系统 `ASAuthorizationAppleIDButton`（`AppleSignInButton.rn.tsx`） | 无额外数据采集（系统组件）。entitlements `com.apple.developer.applesignin`；`react-native.config.js` 里 Android 置 `null`（不引入 Kotlin 实现） |

## 3. 未链接 / 显式排除的模块

| 模块 | 排除方式 | 原因 |
| --- | --- | --- |
| expo-location、expo-sensors、expo-brightness、expo-barcode-scanner、expo-image-picker | `package.json` → `expo.autolinking.exclude` | 定位、传感器、亮度、扫码、相册：本 App 不使用 |
| @react-native-community/geolocation、@react-native-camera-roll/camera-roll、@react-native-clipboard/clipboard、react-native-syan-image-picker、react-native-webview、react-native-maps | `react-native.config.js` → `dependencies[x].platforms = null`；JS 侧由 `metro.config.js` 重定向到 `src/rn-stubs/unsupported.js` | Taro-RN 的可选 peer 依赖，本 App 不使用；即使以后被写进 dependencies 也不会链接 |

## 4. 权限（Android）

`android/app/src/main/AndroidManifest.xml` 只声明：

| 权限 | 用途 |
| --- | --- |
| INTERNET | 访问云开发 HTTP API、音频 CDN |
| ACCESS_NETWORK_STATE | 网络状态（netinfo） |
| FOREGROUND_SERVICE、WAKE_LOCK（及 RNTP 所需的 mediaPlayback 前台服务类型权限，均由 react-native-track-player 的清单合并进来，以其版本为准） | 后台播放前台服务 |

以下权限来自依赖库的清单，合并时用 `tools:node="remove"` 剔除：CAMERA、RECORD_AUDIO、READ/WRITE_EXTERNAL_STORAGE、READ_MEDIA_IMAGES/VIDEO、ACCESS_COARSE/FINE/BACKGROUND_LOCATION、VIBRATE。
`MODIFY_AUDIO_SETTINGS`（expo-av）属于普通权限、不弹窗，保留。

微信登录另有一条 **`<queries><package android:name="com.tencent.mm"/></queries>`**（包可见性声明，不是权限、不弹窗）：Android 11+ 默认看不到其他应用，声明后 SDK 才能判断微信是否已安装并拉起它；只声明微信一个包，不申请 `QUERY_ALL_PACKAGES`。

iOS `Info.plist`：`UIBackgroundModes = [audio]`；保留 `NSCameraUsageDescription` / `NSMicrophoneUsageDescription`（文案已说明 App 不请求这些权限）——因为 expo-camera / expo-av 的二进制仍被链接，缺少描述会被 App Store 审核机器人拦下（ITMS-90683）。

## 5. 网络访问对象

| 域名 | 用途 |
| --- | --- |
| `https://<envId>.api.tcloudbasegateway.com` | 云开发 HTTP API（认证 + 云函数） |
| 云存储 / CDN 域名 | TODO(business)：业务静态资源 |

## 6. 变更流程

1. 新增原生依赖：先在本表登记版本、许可、用途、数据采集，再 `yarn add`。
2. 运行 `npm run build:rn:android`（bundle 体积阈值 3 MB）和 CI `App Android` 工作流，检查合并后的清单：
   `cd android && ./gradlew :app:processReleaseMainManifest`，产物 `android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml`，`grep uses-permission` 对照 §4。
3. 隐私政策「第三方 SDK」章节与本表保持一致（`src/features/consent/agreements.ts` 与官网隐私政策）。
