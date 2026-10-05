export default definePageConfig({
  navigationBarTitleText: '每日一题',
  // RN：关掉 Taro 的页面级 ScrollView，由 Screen 自己滚动（FE-RN-06）
  disableScroll: process.env.TARO_ENV === 'rn'
})
