/**
 * 生成并校验官网的 AASA(apple-app-site-association,iOS Universal Link 用)。
 *
 * 仓库里的 public/.well-known/apple-app-site-association 只保留 Team ID 占位(APPLE_TEAM_ID),
 * 发布时由本脚本用 .env 的 APPLE_TEAM_ID 替换后写到 dist/,并做完整性校验。
 * (scripts/rn/ios-native-check.mjs 也依赖这个占位约定。)
 *
 *   node scripts/prepare-aasa.mjs --team-id ABCDE12345 \
 *        [--src public/.well-known/apple-app-site-association] \
 *        [--out dist/.well-known/apple-app-site-association] \
 *        [--universal-link https://jielingzi.cn/app/]
 *
 * 格式为 iOS 13+ 的 appIDs + components(Podfile 最低版本为 13.0,无需兼容旧的 appID + paths)。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLACEHOLDER = 'APPLE_TEAM_ID'
export const BUNDLE_ID = 'com.jielingzi.app'
const TEAM_ID_RE = /^[A-Z0-9]{10}$/

/** 用真实 Team ID 替换模板里的占位符。 */
export function renderAasa (template, teamId) {
  const id = String(teamId || '').trim()
  if (!TEAM_ID_RE.test(id)) throw new Error(`APPLE_TEAM_ID 必须是 10 位大写字母/数字(当前:${id ? JSON.stringify(id) : '空'})`)
  if (!template.includes(PLACEHOLDER)) throw new Error(`模板里没有找到占位符 ${PLACEHOLDER}`)
  return template.split(PLACEHOLDER).join(id)
}

/** 把 AASA 的 components 里的路径模式(支持 * 和 ?)转成正则。 */
function patternToRegExp (pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`)
}

/**
 * 校验渲染后的 AASA,返回错误列表(空数组表示通过)。
 * @param {string} text 渲染后的文件内容
 * @param {{ universalLink?: string }} [opts] 传入 Universal Link 时,额外检查其路径被 components 覆盖
 */
export function validateAasa (text, { universalLink } = {}) {
  const errors = []
  let json
  try { json = JSON.parse(text) } catch (e) { return [`不是合法 JSON:${e.message}`] }

  if (text.includes(PLACEHOLDER)) errors.push(`仍含有占位符 ${PLACEHOLDER}`)
  const details = json && json.applinks && json.applinks.details
  if (!Array.isArray(details) || !details.length) return [...errors, 'applinks.details 必须是非空数组']

  const patterns = []
  for (const [i, d] of details.entries()) {
    const ids = Array.isArray(d.appIDs) ? d.appIDs : []
    if (!ids.length) errors.push(`details[${i}].appIDs 必须是非空数组`)
    for (const id of ids) {
      if (!new RegExp(`^[A-Z0-9]{10}\\.${BUNDLE_ID.replace(/\./g, '\\.')}$`).test(id)) errors.push(`details[${i}].appIDs 含有不符合 <TeamID>.${BUNDLE_ID} 的值:${id}`)
    }
    if (!Array.isArray(d.components) || !d.components.length) errors.push(`details[${i}].components 必须是非空数组`)
    for (const c of d.components || []) if (typeof c['/'] === 'string') patterns.push(c['/'])
  }

  if (universalLink) {
    let path = null
    try { path = new URL(universalLink).pathname } catch (e) { errors.push(`universal-link 不是合法 URL:${universalLink}`) }
    if (path !== null && !patterns.some((p) => patternToRegExp(p).test(path) && patternToRegExp(p).test(`${path}x`))) {
      errors.push(`components 没有覆盖 Universal Link 路径 ${path}(现有:${patterns.join(', ') || '无'})`)
    }
  }
  return errors
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`未知参数:${a}`)
    out[a.slice(2)] = argv[++i]
  }
  return out
}

function main () {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const a = parseArgs(process.argv.slice(2))
  const src = resolve(root, a.src || 'public/.well-known/apple-app-site-association')
  const out = resolve(root, a.out || 'dist/.well-known/apple-app-site-association')
  try {
    const rendered = renderAasa(readFileSync(src, 'utf8').replace(/\r\n/g, '\n'), a['team-id'])
    const errors = validateAasa(rendered, { universalLink: a['universal-link'] })
    if (errors.length) { for (const e of errors) console.error(`[aasa] 错误:${e}`); process.exit(1) }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, rendered)
    console.log(`[aasa] 已生成 ${out}(Team ID 已替换,校验通过)`)
  } catch (e) {
    console.error(`[aasa] 错误:${e.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
