/**
 * CloudBase 配置：只从 .env（TARO_APP_ 前缀）读取，代码中不出现 envId 字面量。
 */
export const cloudConfig = {
  envId: process.env.TARO_APP_CLOUD_ENV_ID || '',
  region: process.env.TARO_APP_CLOUD_REGION || '',
  accessKey: process.env.TARO_APP_CLOUD_ACCESS_KEY || ''
}

export function assertEnvId (): string {
  if (!cloudConfig.envId) {
    throw new Error('[cloud] 未配置 TARO_APP_CLOUD_ENV_ID，请复制 .env.example 为 .env 并填写')
  }
  return cloudConfig.envId
}
