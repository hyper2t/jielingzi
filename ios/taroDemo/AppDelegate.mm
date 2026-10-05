#import "AppDelegate.h"

#import <React/RCTBridge.h>
#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import <React/RCTRootView.h>

#import <React/RCTAppSetupUtils.h>
#import <objc/message.h>

#if RCT_NEW_ARCH_ENABLED
#import <React/CoreModulesPlugins.h>
#import <React/RCTCxxBridgeDelegate.h>
#import <React/RCTFabricSurfaceHostingProxyRootView.h>
#import <React/RCTSurfacePresenter.h>
#import <React/RCTSurfacePresenterBridgeAdapter.h>
#import <ReactCommon/RCTTurboModuleManager.h>

#import <react/config/ReactNativeConfig.h>

static NSString *const kRNConcurrentRoot = @"concurrentRoot";

@interface AppDelegate () <RCTCxxBridgeDelegate, RCTTurboModuleManagerDelegate> {
  RCTTurboModuleManager *_turboModuleManager;
  RCTSurfacePresenterBridgeAdapter *_bridgeAdapter;
  std::shared_ptr<const facebook::react::ReactNativeConfig> _reactNativeConfig;
  facebook::react::ContextContainer::Shared _contextContainer;
}
@end
#endif

@interface AppDelegate () {
  __weak RCTBridge *_appBridge;
}
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  RCTAppSetupPrepareApp(application);

  RCTBridge *bridge = [self.reactDelegate createBridgeWithDelegate:self launchOptions:launchOptions];
  _appBridge = bridge;

#if RCT_NEW_ARCH_ENABLED
  _contextContainer = std::make_shared<facebook::react::ContextContainer const>();
  _reactNativeConfig = std::make_shared<facebook::react::EmptyReactNativeConfig const>();
  _contextContainer->insert("ReactNativeConfig", _reactNativeConfig);
  _bridgeAdapter = [[RCTSurfacePresenterBridgeAdapter alloc] initWithBridge:bridge contextContainer:_contextContainer];
  bridge.surfacePresenter = _bridgeAdapter.surfacePresenter;
#endif

  NSDictionary *initProps = [self prepareInitialProps];
  UIView *rootView = [self.reactDelegate createRootViewWithBridge:bridge moduleName:@"taroDemo" initialProperties:initProps];

  if (@available(iOS 13.0, *)) {
    rootView.backgroundColor = [UIColor systemBackgroundColor];
  } else {
    rootView.backgroundColor = [UIColor whiteColor];
  }

  self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
  UIViewController *rootViewController = [self.reactDelegate createRootViewController];
  rootViewController.view = rootView;
  self.window.rootViewController = rootViewController;
  [self.window makeKeyAndVisible];
  [super application:application didFinishLaunchingWithOptions:launchOptions];
  return YES;
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feture is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
  // Switch this bool to turn on and off the concurrent root
  return true;
}
- (NSDictionary *)prepareInitialProps
{
  NSMutableDictionary *initProps = [NSMutableDictionary new];
#ifdef RCT_NEW_ARCH_ENABLED
  initProps[kRNConcurrentRoot] = @([self concurrentRootEnabled]);
#endif
  return initProps;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

#pragma mark - 外部回跳（微信登录 NA-L03）

/**
 * URL Scheme 回跳（wx<AppID>://oauth?code=...，未配置 / 未验证 Universal Link 时微信走这条）：
 * RCTLinkingManager 发出 RCTOpenURLNotification，react-native-wechat-lib 的 WechatLib 模块监听它并调用 [WXApi handleOpenURL:delegate:]。
 * super 由 EXAppDelegateWrapper 转发给 ExpoAppDelegate（Expo 模块订阅者）。
 */
- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options
{
  BOOL handled = [RCTLinkingManager application:application openURL:url options:options];
  return [super application:application openURL:url options:options] || handled;
}

/**
 * Universal Link 回跳（https://<域名>/app/<AppID>/oauth?...，微信 SDK 2.x 的默认方式，也包括 registerApp 后的 SDK 自检）。
 * react-native-wechat-lib 3.0.4 只处理 URL Scheme，这里先交给 WXApi，delegate 用该库的模块实例（它实现了 WXApiDelegate，
 * onResp 里 resolve JS 侧 sendAuthRequest 的 Promise）。用运行时调用而不 import WXApi.h，避免与该库自带的同名头文件冲突。
 * 模块只在 JS 已 registerApp（家长同意且进入登录页）后才存在，所以 lazilyLoadIfNecessary:NO —— 不因回跳提前初始化 SDK（决策 L8）。
 */
- (BOOL)handleWechatUniversalLink:(NSUserActivity *)userActivity
{
  if (![userActivity.activityType isEqualToString:NSUserActivityTypeBrowsingWeb]) return NO;
  Class wxApi = NSClassFromString(@"WXApi");
  SEL selector = NSSelectorFromString(@"handleOpenUniversalLink:delegate:");
  id module = [_appBridge moduleForName:@"WechatLib" lazilyLoadIfNecessary:NO];
  if (wxApi == nil || module == nil || ![wxApi respondsToSelector:selector]) return NO;
  return ((BOOL (*)(id, SEL, NSUserActivity *, id))objc_msgSend)(wxApi, selector, userActivity, module);
}

- (BOOL)application:(UIApplication *)application
    continueUserActivity:(NSUserActivity *)userActivity
      restorationHandler:(void (^)(NSArray<id<UIUserActivityRestoring>> *_Nullable))restorationHandler
{
  if ([self handleWechatUniversalLink:userActivity]) return YES;
  BOOL handled = [RCTLinkingManager application:application continueUserActivity:userActivity restorationHandler:restorationHandler];
  return [super application:application continueUserActivity:userActivity restorationHandler:restorationHandler] || handled;
}

#if RCT_NEW_ARCH_ENABLED

#pragma mark - RCTCxxBridgeDelegate

- (std::unique_ptr<facebook::react::JSExecutorFactory>)jsExecutorFactoryForBridge:(RCTBridge *)bridge
{
  _turboModuleManager = [[RCTTurboModuleManager alloc] initWithBridge:bridge
                                                             delegate:self
                                                            jsInvoker:bridge.jsCallInvoker];
  return RCTAppSetupDefaultJsExecutorFactory(bridge, _turboModuleManager);
}

#pragma mark RCTTurboModuleManagerDelegate

- (Class)getModuleClassFromName:(const char *)name
{
  return RCTCoreModulesClassProvider(name);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const std::string &)name
                                                      jsInvoker:(std::shared_ptr<facebook::react::CallInvoker>)jsInvoker
{
  return nullptr;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const std::string &)name
                                                     initParams:
                                                         (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return nullptr;
}

- (id<RCTTurboModule>)getModuleInstanceFromClass:(Class)moduleClass
{
  return RCTAppSetupDefaultModuleFromClass(moduleClass);
}

#endif

@end
