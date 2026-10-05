import Taro from '@tarojs/taro'
import { buildUrl, navigate, parseParams, ROUTES } from '@/utils/router'
import appConfig from '../../app.config'

describe('router', () => {
  it('拼接并编码参数，忽略空值', () => {
    expect(buildUrl('login', { reason: 'a 1', returnTo: undefined })).toBe('/pkg-user/pages/login/index?reason=a%201')
    expect(buildUrl('index')).toBe('/pages/index/index')
  })

  it('解析参数', () => {
    expect(parseParams<'login'>({ reason: 'a%201', $taroTimestamp: '1' })).toEqual({ reason: 'a 1' })
  })

  it('tab 页走 switchTab，其余 navigateTo', () => {
    navigate('mine')
    expect(Taro.switchTab).toHaveBeenCalledWith({ url: ROUTES.mine })
    navigate('agreement', { type: 'user' })
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/agreement/index?type=user' })
  })

  it('ROUTES 与 app.config 页面一一对应（登录页只在 App 注册）', () => {
    const pagesOf = (c: any) => [
      ...c.pages,
      ...c.subPackages.flatMap((p: any) => p.pages.map((pg: string) => `${p.root}/${pg}`))
    ].map((p: string) => `/${p}`).sort()
    const cfg: any = appConfig
    const APP_ONLY: string[] = [ROUTES.login]
    expect(Object.values(ROUTES).filter(r => !APP_ONLY.includes(r)).sort()).toEqual(pagesOf(cfg))
    expect(cfg.tabBar.list.map((t: any) => `/${t.pagePath}`)).toEqual([ROUTES.index, ROUTES.practice, ROUTES.mine])

    const old = process.env.TARO_ENV
    process.env.TARO_ENV = 'rn'
    try {
      jest.isolateModules(() => {
        const rn: any = require('../../app.config').default
        expect(pagesOf(rn)).toEqual(Object.values(ROUTES).sort())
      })
    } finally {
      process.env.TARO_ENV = old
    }
  })
})
