/**
 * CloudBase 环境 ID 解析（运维脚本共用）。
 *
 * cloudbaserc.json 的 envId 写的是 tcb CLI 模板 "{{env.TARO_APP_CLOUD_ENV_ID}}"——只有 tcb CLI 部署时会替换。
 * 本地脚本直接 JSON.parse 拿到的是模板原文，拿它调 OpenAPI（DescribeSecurityRule …）或 tcb.init 都会失败。
 * 统一在这里解析：模板 → 取 env 中的同名变量；字面量 → 原样返回；都拿不到时报错并提示该填哪个变量。
 */
const TEMPLATE_RE = /^\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/

/**
 * @param {unknown} rawEnvId cloudbaserc.json 的 envId
 * @param {Record<string, string | undefined>} [env] 已合并 .env 与 process.env 的变量表
 * @returns {string}
 */
export function resolveEnvId (rawEnvId, env = {}) {
  const raw = typeof rawEnvId === 'string' ? rawEnvId.trim() : ''
  const m = TEMPLATE_RE.exec(raw)
  const key = m ? m[1] : 'TARO_APP_CLOUD_ENV_ID'
  const id = (m ? String(env[key] || '') : raw).trim()
  if (!id || id.includes('{{')) {
    throw new Error(`无法确定 CloudBase 环境 ID（cloudbaserc.json envId = ${raw || '空'}）：请在 .env 中填写 ${key}`)
  }
  return id
}

/**
 * 腾讯云 API 地域（X-TC-Region / SCF Region）：只接受 ap-<城市> 形态；
 * 常见误填 cn-shanghai（不是合法地域，API 会报 InvalidParameterValue X-TC-Region）按城市名映射为 ap-shanghai；
 * 空 / 无法识别时回落 ap-shanghai。
 * @param {unknown} raw  如 TCB_REGION / TARO_APP_CLOUD_REGION
 */
export function normalizeRegion (raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (/^ap-[a-z]+(-[a-z]+)?$/.test(s)) return s
  const m = /^cn-([a-z]+)$/.exec(s)
  if (m) return `ap-${m[1]}`
  return 'ap-shanghai'
}
