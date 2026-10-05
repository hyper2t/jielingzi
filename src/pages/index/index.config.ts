export default definePageConfig({
  navigationBarTitleText: '首页',
  // 话题流下拉刷新（小程序 / H5）；RN 没有页面级下拉，回到首页时按话题流版本自动刷新
  enablePullDownRefresh: process.env.TARO_ENV !== 'rn',
  // RN：关掉 Taro 的页面级 ScrollView，由 Screen 自己滚动（FE-RN-06，见 components/Screen/Body.rn.tsx）；小程序 / H5 不受影响
  disableScroll: process.env.TARO_ENV === 'rn'
})
