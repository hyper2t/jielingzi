import { CloudError, ERROR_CODES, normalizePage, unwrap, withRuleWhere } from '@/services/cloud.types'

describe('cloud.types', () => {
  it('私有集合必须带身份', () => {
    expect(withRuleWhere('users', {}, '{openid}')).toEqual({ _openid: '{openid}' })
    expect(() => withRuleWhere('users', {}, null)).toThrow(CloudError)
  })

  it('分页归一', () => {
    expect(normalizePage()).toEqual({ page: 1, size: 20, skip: 0 })
    expect(normalizePage(3, 500)).toEqual({ page: 3, size: 100, skip: 200 })
  })

  it('unwrap 按 code 抛错', () => {
    expect(unwrap({ code: 0, data: 1 }, 'me', 'x')).toBe(1)
    expect(() => unwrap({ code: 40101, data: null, msg: '未登录' }, 'me', 'x')).toThrow(expect.objectContaining({ code: ERROR_CODES.UNAUTHORIZED }))
  })
})

describe('cloud.weapp', () => {
  const OLD = process.env

  function setup (envId: string) {
    jest.resetModules()
    process.env = { ...OLD, TARO_APP_CLOUD_ENV_ID: envId }
    const get = jest.fn(() => Promise.resolve({ data: Array.from({ length: 21 }, (_, i) => ({ _id: String(i) })) }))
    const q: any = { where: jest.fn(() => q), field: jest.fn(() => q), orderBy: jest.fn(() => q), skip: jest.fn(() => q), limit: jest.fn(() => q), get }
    const cloudApi = {
      init: jest.fn(),
      database: () => ({ collection: jest.fn(() => q) }),
      callFunction: jest.fn(() => Promise.resolve({ result: { code: 0, data: { openid: 'o1', isNew: false } } }))
    }
    require('@tarojs/taro').default.cloud = cloudApi
    const mod = require('@/services/cloud.weapp')
    return { mod, cloudApi, q }
  }

  afterEach(() => { process.env = OLD })

  it('init 读取 .env 中的 envId，且只初始化一次', async () => {
    const { mod, cloudApi } = setup('env-from-dotenv')
    await mod.cloud.init()
    await mod.cloud.init()
    expect(cloudApi.init).toHaveBeenCalledTimes(1)
    expect(cloudApi.init).toHaveBeenCalledWith({ env: 'env-from-dotenv', traceUser: false })
  })

  it('未配置 envId 时 init 失败', async () => {
    const { mod } = setup('')
    await expect(mod.cloud.init()).rejects.toThrow('TARO_APP_CLOUD_ENV_ID')
  })

  it('db.query 带规则条件与分页，并判断 hasMore', async () => {
    const { mod, q } = setup('e')
    const res = await mod.cloud.db.query('users', { where: { lastActiveAt: 1 }, page: 2, orderBy: [['createdAt', 'asc']], field: { settings: false } })
    expect(q.where).toHaveBeenCalledWith({ lastActiveAt: 1, _openid: '{openid}' })
    expect(q.skip).toHaveBeenCalledWith(20)
    expect(q.limit).toHaveBeenCalledWith(21)
    expect(res.list).toHaveLength(20)
    expect(res.hasMore).toBe(true)
  })

  it('fn.call 传 action 并解包', async () => {
    const { mod, cloudApi } = setup('e')
    const id = await mod.cloud.identity()
    expect(cloudApi.callFunction).toHaveBeenCalledWith({ name: 'user', data: { action: 'login', platform: 'weapp' } })
    expect(id).toEqual({ uid: 'o1', anonymous: false })
  })
})
