/**
 * H5 端 CloudBase 接入：@cloudbase/js-sdk，仅匿名登录（MVP 只做构建自测，不发布）。
 * 匿名身份存 localStorage，清缓存后数据会丢失，页面需提示（FE-24）。
 * SDK 按需动态加载，不进入首屏 chunk。
 */
import { assertEnvId, cloudConfig } from './cloud.config'
import {
  CloudClient, CloudError, CloudIdentity, ERROR_CODES, FnResponse,
  normalizePage, unwrap, withRuleWhere
} from './cloud.types'

let appPromise: Promise<any> | null = null
let uid: string | null = null

function getApp (): Promise<any> {
  if (!appPromise) {
    appPromise = (async () => {
      const mod: any = await import('@cloudbase/js-sdk')
      const cloudbase = mod.default || mod
      const app = cloudbase.init({
        env: assertEnvId(),
        ...(cloudConfig.region ? { region: cloudConfig.region } : {}),
        ...(cloudConfig.accessKey ? { accessKey: cloudConfig.accessKey } : {})
      })
      const auth = app.auth({ persistence: 'local' })
      let state = await auth.getLoginState()
      if (!state) {
        await auth.signInAnonymously({})
        state = await auth.getLoginState()
      }
      uid = state?.user?.uid || null
      return app
    })()
    appPromise.catch(() => { appPromise = null })
  }
  return appPromise
}

function toCloudError (e: any): CloudError {
  if (e instanceof CloudError) return e
  return new CloudError(ERROR_CODES.NETWORK, e?.message || '网络异常')
}

export const cloud: CloudClient = {
  storage: {
    async upload (localPath, cloudPath, file) {
      try {
        const app = await getApp()
        // H5：chooseImage 给的是 blob URL，js-sdk 需要原始 File 对象
        const res = await app.uploadFile({ cloudPath, filePath: file || localPath })
        if (!res || !res.fileID) throw new CloudError(ERROR_CODES.NETWORK, '上传失败')
        return res.fileID as string
      } catch (e) {
        throw toCloudError(e)
      }
    }
  },

  platform: 'h5',

  async init () {
    await getApp()
  },

  async identity (): Promise<CloudIdentity> {
    await getApp()
    return { uid, anonymous: true }
  },

  db: {
    async query (collection, opts = {}) {
      const app = await getApp().catch(e => { throw toCloudError(e) })
      const { page, size, skip } = normalizePage(opts.page, opts.size)
      try {
        let q: any = app.database().collection(collection).where(withRuleWhere(collection, opts.where, uid))
        if (opts.field) q = q.field(opts.field)
        ;(opts.orderBy || []).forEach(([k, dir]) => { q = q.orderBy(k, dir) })
        const res = await q.skip(skip).limit(size + 1).get()
        if (res.code) throw new CloudError(ERROR_CODES.SERVER, res.message || res.code)
        const data = (res.data || []) as any[]
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
      const app = await getApp().catch(e => { throw toCloudError(e) })
      let res: any
      try {
        res = await app.callFunction({ name, data: { action, ...(rest[0] || {}) } })
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
