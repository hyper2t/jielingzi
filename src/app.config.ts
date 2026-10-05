/**
 * 路由、分包与 tabBar
 * - 主包：tabBar 页；其余按使用频率拆分包，preloadRule 预下载
 * - 路径与 src/utils/router.ts 的 ROUTES 保持一致
 * - tabBar 图标由 tools/gen-icons.js 从 Lucide 导出到 src/assets/tabbar（构建时 copy）
 * - App 专用页（登录）只在 RN 注册：TARO_ENV 由 CLI（weapp / h5）或 @tarojs/rn-supporter（rn）在读取本文件前设置
 * 分包规划见 docs/prd/README.md §6：pkg-community（话题 / 圈子）、pkg-practice（练习工具）、pkg-user（账号）
 */
const RN_ONLY_PAGES = process.env.TARO_ENV === 'rn' ? ['pages/login/index'] : []

export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/practice/index',
    'pages/mine/index'
  ],
  subPackages: [
    {
      root: 'pkg-community',
      // M3：话题详情（topic）、发起话题（topic-new）；M4：圈子列表 / 详情、加入圈子、邀请码；M6：站内消息（messages）
      pages: ['pages/topic/index', 'pages/topic-new/index', 'pages/circles/index', 'pages/circle/index', 'pages/join-circle/index', 'pages/invites/index', 'pages/messages/index']
    },
    {
      root: 'pkg-practice',
      // M5：冥想计时；个人打卡热力图随主包练习 Tab 渲染。M6：每日一题
      pages: ['pages/timer/index', 'pages/prompt/index']
    },
    {
      root: 'pkg-user',
      pages: [
        'pages/settings/index',
        'pages/agreement/index',
        // M1：18+ 确认、编辑档案（docs/prd/README.md §6；adult-confirm / profile-edit）
        'pages/adult/index',
        'pages/profile-edit/index',
        ...RN_ONLY_PAGES
      ]
    },
    {
      // 审核（FE-M2-02）：入口只对 mod / admin 显示，云端再校验
      root: 'pkg-admin',
      pages: ['pages/queue/index']
    }
  ],
  preloadRule: {
    'pages/index/index': { network: 'all', packages: ['pkg-community'] },
    'pages/practice/index': { network: 'all', packages: ['pkg-practice'] },
    // 消息入口在「我的」里，所以「我的」也预下载 pkg-community（FE-M6-03）
    'pages/mine/index': { network: 'all', packages: ['pkg-user', 'pkg-community'] }
  },
  window: {
    backgroundColor: '#F7F8F2',
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#F7F8F2',
    navigationBarTitleText: '结灵子',
    navigationBarTextStyle: 'black',
    // 自定义导航（NavBar 组件）
    navigationStyle: 'custom'
  },
  tabBar: {
    // 色值 = tailwind ink.soft / brand.dark / paper.light（docs/prd/README.md §2）
    color: '#5B665F',
    selectedColor: '#456F55',
    backgroundColor: '#FDFDFA',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/index/index',
        text: '首页',
        iconPath: 'assets/tabbar/home.png',
        selectedIconPath: 'assets/tabbar/home-active.png'
      },
      {
        pagePath: 'pages/practice/index',
        text: '练习',
        iconPath: 'assets/tabbar/practice.png',
        selectedIconPath: 'assets/tabbar/practice-active.png'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.png',
        selectedIconPath: 'assets/tabbar/mine-active.png'
      }
    ]
  }
})
