/**
 * 小程序端 CloudBase 接入：wx.cloud（Taro.cloud），身份由 OPENID 自动识别，免登录。
 * 私有集合查询使用 `_openid: '{openid}'` 占位符，由云端替换为当前用户，无需先拿 openid。
 */
import Taro from '@tarojs/taro'
import { assertEnvId } from './cloud.config'
import {
  CloudClient, CloudError, CloudIdentity, ERROR_CODES, FnResponse,
  normalizePage, unwrap, withRuleWhere
} from './cloud.types'

let initPromise: Promise<void> | null = null
let identityCache: CloudIdentity | null = null

function ensureCloud () {
  if (!Taro.cloud) throw new CloudError(ERROR_CODES.NOT_READY, '当前基础库不支持云开发，请使用 2.2.3 及以上版本')
  return Taro.cloud
}

function database () {
  return ensureCloud().database()
}

function toCloudError (e: any): CloudError {
  if (e instanceof CloudError) return e
  return new CloudError(ERROR_CODES.NETWORK, e?.errMsg || e?.message || '网络异常')
}

export const cloud: CloudClient = {
  platform: 'weapp',

  init () {
    if (!initPromise) {
      initPromise = Promise.resolve().then(() => {
        const env = assertEnvId()
        // traceUser 关闭：开启后未同意用户的浏览也会记入云开发「用户访问记录」，与「未同意不写云端」不符（FE-22 / 隐私指引）
        ensureCloud().init({ env, traceUser: false })
      })
      initPromise.catch(() => { initPromise = null })
    }
    return initPromise
  },

  async identity () {
    if (identityCache) return identityCache
    const { openid } = await cloud.fn.call('user', 'login', { platform: 'weapp' })
    identityCache = { uid: openid, anonymous: false }
    return identityCache
  },

  storage: {
    async upload (localPath, cloudPath) {
      await cloud.init()
      try {
        const res: any = await ensureCloud().uploadFile({ cloudPath, filePath: localPath } as any)
        if (!res || !res.fileID) throw new CloudError(ERROR_CODES.NETWORK, '上传失败')
        return res.fileID as string
      } catch (e) {
        throw toCloudError(e)
      }
    }
  },

  db: {
    async query (collection, opts = {}) {
      await cloud.init()
      const { page, size, skip } = normalizePage(opts.page, opts.size)
      try {
        let q: any = database().collection(collection)
          .where(withRuleWhere(collection, opts.where, '{openid}'))
        if (opts.field) q = q.field(opts.field)
        ;(opts.orderBy || []).forEach(([k, dir]) => { q = q.orderBy(k, dir) })
        // 多取 1 条判断 hasMore，避免额外 count 调用
        const res = await q.skip(skip).limit(size + 1).get()
        const data = res.data as any[]
        return { list: data.slice(0, size), page, size, hasMore: data.length > size }
      } catch (e) {
        throw toCloudError(e)
      }
    },

    async get (collection, id) {
      const res = await cloud.db.query(collection, { where: { _id: id } as any, size: 1 })
      return res.list[0] || null
    }
  },

  fn: {
    async call (name, action, ...rest) {
      await cloud.init()
      let res: any
      try {
        res = await ensureCloud().callFunction({ name, data: { action, ...(rest[0] || {}) } } as any)
      } catch (e) {
        throw toCloudError(e)
      }
      return unwrap(res.result as FnResponse<any>, name, action)
    }
  }
}

export function initCloud () {
  return cloud.init().catch(e => console.error('[cloud] init 失败', e))
}

export * from './cloud.types'
