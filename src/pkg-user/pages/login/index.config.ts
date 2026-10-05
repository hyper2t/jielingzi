export default definePageConfig({
  navigationBarTitleText: '登录',
  // RN：关掉 Taro 的页面级 ScrollView，由 Screen 自己滚动（FE-RN-06）；小程序不注册此页
  disableScroll: process.env.TARO_ENV === 'rn'
})
