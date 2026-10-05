/**
 * 数据源选择（FE-06）：业务服务只通过 getClient() 访问云端。
 * - TARO_APP_DATA_SOURCE=cloud：真实 CloudBase；须写在 .env / .env.local / .env.<mode> 文件中（Taro 只注入文件里的 TARO_APP_ 变量，shell 环境变量无效）（按平台后缀 cloud.weapp / cloud.h5 / cloud.rn）
 * - 其他（默认）：mock 数据源。后端集合与云函数（BE-04/05/07+）部署后改 .env 即可切换，业务层不改。
 * 构建时 process.env 被替换为常量，未选中的实现会被移除，不进入主包。
 */
/* eslint-disable import/no-commonjs */
import type { CloudClient } from './cloud.types'

export const DATA_SOURCE: 'cloud' | 'mock' = process.env.TARO_APP_DATA_SOURCE === 'cloud' ? 'cloud' : 'mock'

let client: CloudClient | null = null

export function getClient (): CloudClient {
  if (!client) {
    client = process.env.TARO_APP_DATA_SOURCE === 'cloud'
      ? require('./cloud').cloud
      : require('./mock/client').mockCloud
  }
  return client as CloudClient
}

/** 测试用：注入替身 */
export function setClient (c: CloudClient | null) {
  client = c
}
