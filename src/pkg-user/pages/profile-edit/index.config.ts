export default definePageConfig({
  navigationBarTitleText: '编辑档案',
  // RN：关掉 Taro 的页面级 ScrollView，由 Screen 自己滚动（FE-RN-06）；小程序 / H5 不受影响
  disableScroll: process.env.TARO_ENV === 'rn'
})
