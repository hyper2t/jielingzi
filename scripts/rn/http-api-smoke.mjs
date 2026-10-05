/**
 * CloudBase HTTP API 冒烟（BE-RN-01 / BE-RN-03 配套）：不依赖任何 SDK，用 fetch 复现 App 端 cloud.rn.ts 的全部请求路径。
 *
 *   node scripts/rn/http-api-smoke.mjs            # 人读输出
 *   node scripts/rn/http-api-smoke.mjs --json     # 机器可读
 *   node scripts/rn/http-api-smoke.mjs --strict   # 任何一步失败（含 403 规则未放开）都以退出码 2 结束
 *
 * 步骤：
 *   1. Publishable Key 调 user.whoami（免身份动作，期望 200 / code 0；403 EXCEED_AUTHORITY = 安全规则未把 user 设为 "auth != null"）
 *      TODO(business)：有公开读函数后，在这里补一步「Publishable Key 直接调公开函数」
 *   2. Publishable Key 调 user.login（期望被拒：40101 或网关 401/403，绝不能建号）
 *   3. 匿名登录 POST /auth/v1/signin/anonymously（x-device-id 随机）→ access_token / refresh_token / expires_in / sub
 *   4. access_token 调 user.login（期望 code 0 且 openid == sub）、user.whoami（记录 loginType）
 *   5. refresh_token 换新 token（期望 200、refresh_token 轮换、sub 不变），旧 refresh_token 再用一次（期望失败）
 *   6. GET /auth/v1/user/me
 *   7. user.deleteAccount 删掉本次冒烟创建的匿名用户（连 account_links 别名一起删），不在库里留测试数据
 *   8. 自定义登录链路（Phase 0 spike，docs/mvp/plans/rn-login-spike.md）：Publishable Key 调 user.whoami / user.wechatAppLogin（假 code，
 *      期望 50201 而非 40101 / 50000）；用 .env 的自定义登录私钥本地签票据 → POST /auth/v1/signin/with/provider → user.whoami 看
 *      customUserId 是否可见 → user.login 的 accountId 必须等于票据里的 customUserId → 清理。没配私钥时该组步骤记为跳过。
 *      （--no-custom 跳过；--custom-id <id> 指定 customUserId，默认随机 smoke-xxxx）
 * 读取 .env 的 TARO_APP_CLOUD_ENV_ID / TARO_APP_CLOUD_ACCESS_KEY（第 8 步另读 CLOUDBASE_CUSTOM_LOGIN_JSON[/_KEY_ID]）；不需要管理员密钥。
 * 输出脱敏（token 只显示前 8 位）。退出码：0 全部符合预期；1 执行失败（网络 / 配置）；2 --strict 下有不符合预期的步骤。
 */
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchWithEnvProxy } from '../lib/fetch-proxy.mjs'
import { createTicketSigner, loadCustomLoginCredentials } from '../lib/custom-login.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const asJson = process.argv.includes('--json')
const strict = process.argv.includes('--strict')
const noCustom = process.argv.includes('--no-custom')
const customIdArg = (() => { const i = process.argv.indexOf('--custom-id'); return i > -1 ? process.argv[i + 1] : null })()

function loadEnv() {
  const out = {}
  const f = join(ROOT, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return { ...out, ...process.env }
}

const mask = (t) => (typeof t === 'string' && t.length > 12 ? `${t.slice(0, 8)}…(${t.length})` : t)

async function call(base, path, { method = 'POST', bearer, headers = {}, body } = {}) {
  const started = Date.now()
  const res = await fetchWithEnvProxy(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, body: json, ms: Date.now() - started }
}

const fnCode = (r) => (r.body && typeof r.body.code === 'number' ? r.body.code : r.body && r.body.result && typeof r.body.result.code === 'number' ? r.body.result.code : undefined)
const fnData = (r) => (r.body && r.body.result ? r.body.result.data : r.body ? r.body.data : undefined)

async function main() {
  const env = loadEnv()
  const envId = env.TARO_APP_CLOUD_ENV_ID
  const pk = env.TARO_APP_CLOUD_ACCESS_KEY
  if (!envId || !pk) throw new Error('.env 缺少 TARO_APP_CLOUD_ENV_ID / TARO_APP_CLOUD_ACCESS_KEY')
  const base = `https://${envId}.api.tcloudbasegateway.com`
  const steps = []
  const record = (name, ok, detail, hint) => { steps.push({ name, ok, detail, hint }); return ok }

  // 1. Publishable Key 可达 user 的免身份动作
  const pkWho = await call(base, '/v1/functions/user', { bearer: pk, body: { action: 'whoami' } })
  record('1 Publishable Key 调 user.whoami', pkWho.status === 200 && fnCode(pkWho) === 0,
    { status: pkWho.status, code: fnCode(pkWho) ?? pkWho.body?.code, ms: pkWho.ms },
    pkWho.status === 403 ? '控制台 → 云函数 → 权限控制：user 的规则设为 "auth != null"（scripts/ops/security-rules.mjs --apply）' : undefined)

  // 2. 公钥不能建号 / 读私有数据
  const pkLogin = await call(base, '/v1/functions/user', { bearer: pk, body: { action: 'login', platform: 'app' } })
  const pkBlocked = pkLogin.status === 401 || pkLogin.status === 403 || fnCode(pkLogin) === 40101
  record('2 Publishable Key 调 user.login 被拒', pkBlocked, { status: pkLogin.status, code: fnCode(pkLogin) ?? pkLogin.body?.code })

  // 3. 匿名登录
  const deviceId = randomUUID()
  const login = await call(base, '/auth/v1/signin/anonymously', { bearer: pk, headers: { 'x-device-id': deviceId }, body: {} })
  const s = login.body || {}
  const loginOk = login.status === 200 && typeof s.access_token === 'string' && typeof s.refresh_token === 'string' && typeof s.sub === 'string'
  record('3 匿名登录', loginOk, { status: login.status, expires_in: s.expires_in, scope: s.scope, sub: mask(s.sub), access_token: mask(s.access_token), ms: login.ms },
    login.status === 200 ? undefined : '控制台 → 身份认证 → 登录方式：开启匿名登录（或 tcb env login set -e <envId> --anonymous-login true）')
  if (!loginOk) return finish(steps)

  // 4. 带 token 调函数
  const uLogin = await call(base, '/v1/functions/user', { bearer: s.access_token, body: { action: 'login' } })
  record('4a access_token 调 user.login 且 openid == sub', uLogin.status === 200 && fnCode(uLogin) === 0 && fnData(uLogin)?.openid === s.sub,
    { status: uLogin.status, code: fnCode(uLogin) ?? uLogin.body?.code, openidMatches: fnData(uLogin)?.openid === s.sub, isNew: fnData(uLogin)?.isNew, ms: uLogin.ms },
    uLogin.status === 403 ? '控制台 → 云函数 → 权限控制：user 的规则设为 "auth != null"（允许匿名用户）' : undefined)
  const whoAnon = await call(base, '/v1/functions/user', { bearer: s.access_token, body: { action: 'whoami' } })
  const wa = fnData(whoAnon) || {}
  record('4b 匿名会话 user.whoami（source=web、anonymous、有账号）', whoAnon.status === 200 && fnCode(whoAnon) === 0 && wa.source === 'web' && wa.anonymous === true && wa.account === true,
    { status: whoAnon.status, source: wa.source, loginType: wa.loginType, anonymous: wa.anonymous, account: wa.account })

  // 5. 刷新
  const refreshed = await call(base, '/auth/v1/token', { bearer: pk, body: { grant_type: 'refresh_token', refresh_token: s.refresh_token } })
  const r = refreshed.body || {}
  record('5a refresh_token 换新 token（轮换、sub 不变）', refreshed.status === 200 && typeof r.access_token === 'string' && r.refresh_token && r.refresh_token !== s.refresh_token && r.sub === s.sub,
    { status: refreshed.status, rotated: r.refresh_token !== s.refresh_token, sameSub: r.sub === s.sub, expires_in: r.expires_in })
  const reuse = await call(base, '/auth/v1/token', { bearer: pk, body: { grant_type: 'refresh_token', refresh_token: s.refresh_token } })
  record('5b 旧 refresh_token 复用被拒', reuse.status >= 400, { status: reuse.status, error: reuse.body?.error || reuse.body?.error_code })

  // 6. whoami
  const me = await call(base, '/auth/v1/user/me', { method: 'GET', bearer: r.access_token || s.access_token })
  record('6 GET /auth/v1/user/me', me.status === 200 && me.body?.sub === s.sub, { status: me.status, name: me.body?.name, groups: me.body?.groups?.map((g) => g.id) })

  // 7. 清理：每次冒烟都会 user.login 出一个新匿名用户，用 deleteAccount 连 account_links 别名一起删掉，不留测试数据
  const del = await call(base, '/v1/functions/user', { bearer: r.access_token || s.access_token, body: { action: 'deleteAccount', confirm: 'DELETE' } })
  record('7 注销测试账号（user.deleteAccount，连别名一起删）', del.status === 200 && fnCode(del) === 0 && fnData(del)?.removed?.user >= 1 && fnData(del)?.removed?.links >= 1, { status: del.status, code: fnCode(del) ?? del.body?.code, removed: fnData(del)?.removed },
    fnCode(del) === 40001 ? '云函数 user 还没部署 deleteAccount（tcb fn deploy user）' : undefined)

  if (!noCustom) await customLoginSteps({ base, pk, env, envId, record })
  return finish(steps)
}

/** 第 8 组：自定义登录 spike（微信登录的服务端链路，去掉微信那一跳） */
async function customLoginSteps({ base, pk, env, envId, record }) {
  // 8a/8b：Publishable Key 能到达 user 的免身份动作
  const who = await call(base, '/v1/functions/user', { bearer: pk, body: { action: 'whoami' } })
  record('8a Publishable Key 调 user.whoami（免身份动作可达）', who.status === 200 && fnCode(who) === 0 && fnData(who)?.account === false && fnData(who)?.publishableKey === true,
    { status: who.status, code: fnCode(who) ?? who.body?.code, loginType: fnData(who)?.loginType, anonymous: fnData(who)?.anonymous, publishableKey: fnData(who)?.publishableKey },
    fnCode(who) === 40001 ? '云函数 user 还没部署 whoami（tcb fn deploy user）' : who.status === 403 ? '安全规则：user 需为 "auth != null"' : undefined)
  const wxl = await call(base, '/v1/functions/user', { bearer: pk, body: { action: 'wechatAppLogin', code: 'smoke-invalid-code-0000' } })
  record('8b Publishable Key 调 user.wechatAppLogin（假 code → 50201）', wxl.status === 200 && fnCode(wxl) === 50201,
    { status: wxl.status, code: fnCode(wxl) ?? wxl.body?.code, msg: wxl.body?.msg },
    fnCode(wxl) === 40001 ? '云函数 user 还没部署 wechatAppLogin' : fnCode(wxl) === 50000 ? '函数内部错误，查看 user 函数日志' : undefined)

  // 8c：本地签票据
  const { credentials, reason } = loadCustomLoginCredentials(env)
  if (!credentials) {
    record('8c 自定义登录票据（跳过：未配置私钥）', true, { skipped: true, reason })
    return
  }
  const customUserId = customIdArg || `smoke-${randomUUID().replace(/-/g, '').slice(0, 12)}`
  let ticket
  try {
    const signTicket = createTicketSigner({ envId, credentials, proxy: env.HTTPS_PROXY || env.https_proxy })
    ticket = signTicket(customUserId, { refresh: 3600 * 1000, expire: Date.now() + 10 * 60 * 1000 })
  } catch (e) {
    record('8c 本地签发自定义登录票据', false, { error: e.message }, '检查 CLOUDBASE_CUSTOM_LOGIN_JSON / _KEY_ID 是否与控制台一致')
    return
  }
  record('8c 本地签发自定义登录票据', typeof ticket === 'string' && ticket.includes('/@@/'), { keyId: ticket.split('/@@/')[0], customUserId, ticket: mask(ticket) })

  // 8d：票据换会话
  const sign = await call(base, '/auth/v1/signin/with/provider', { bearer: pk, body: { provider_id: 'custom', provider_token: ticket } })
  const c = sign.body || {}
  const signOk = sign.status === 200 && typeof c.access_token === 'string' && typeof c.sub === 'string'
  record('8d POST /auth/v1/signin/with/provider（provider_id=custom）', signOk,
    { status: sign.status, sub: mask(c.sub), expires_in: c.expires_in, error: c.error || c.error_code, description: c.error_description },
    sign.status === 200 ? undefined : '控制台 → 身份认证 → 登录方式：开启自定义登录，且私钥 ID 与 .env 一致（更换私钥后旧私钥 2 小时内失效）')
  if (!signOk) return

  // 8e：云函数里看得到什么
  const who2 = await call(base, '/v1/functions/user', { bearer: c.access_token, body: { action: 'whoami' } })
  const shape = fnData(who2) || {}
  record('8e 自定义登录会话调 user.whoami（记录 loginType / customUserId 是否可见；不建号）', who2.status === 200 && fnCode(who2) === 0 && shape.uid === true && shape.account === false,
    { status: who2.status, code: fnCode(who2) ?? who2.body?.code, source: shape.source, loginType: shape.loginType, customUserIdVisible: shape.customUserId, uidVisible: shape.uid, subEqualsCustomUserId: c.sub === customUserId, accountCreated: shape.account })

  // 8f：accountId 必须等于票据里的 customUserId（v2 实测：会话 uid 就是 customUserId，账号层经 acc: 链接识别），且是首次建号
  const login = await call(base, '/v1/functions/user', { bearer: c.access_token, body: { action: 'login', platform: 'app' } })
  const d = fnData(login) || {}
  record('8f user.login：accountId == customUserId 且 isNew', login.status === 200 && fnCode(login) === 0 && d.accountId === customUserId && d.isNew === true,
    { status: login.status, code: fnCode(login) ?? login.body?.code, accountId: d.accountId === customUserId ? 'matches' : mask(d.accountId), isNew: d.isNew, identities: d.identities },
    fnCode(login) === 40101 ? '函数里既看不到 customUserId、uid 也不等于 customUserId 且无 acc: 链接 → 只能走 wechatAppLogin 的 linkToken 路径（见 docs/mvp/plans/rn-login-spike.md）' : undefined)

  // 8h：清理（账号存在时用 deleteAccount 连别名一起删）
  if (fnCode(login) === 0) {
    const del = await call(base, '/v1/functions/user', { bearer: c.access_token, body: { action: 'deleteAccount', confirm: 'DELETE' } })
    record('8h 清理测试账号（user.deleteAccount）', del.status === 200 && fnCode(del) === 0 && fnData(del)?.removed?.user >= 1, { status: del.status, code: fnCode(del) ?? del.body?.code, removed: fnData(del)?.removed })
  } else {
    record('8h 清理（无账号可删）', true, { skipped: true })
  }
}

function finish(steps) {
  const failed = steps.filter((s) => !s.ok)
  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, steps }, null, 2))
  } else {
    for (const s of steps) {
      console.log(`${s.ok ? '✔' : '✘'} ${s.name}  ${JSON.stringify(s.detail)}`)
      if (!s.ok && s.hint) console.log(`    ↳ ${s.hint}`)
    }
    console.log(failed.length ? `\n${failed.length} 步不符合预期` : '\n全部符合预期')
  }
  process.exit(failed.length && strict ? 2 : 0)
}

main().catch((e) => {
  console.error('[rn:smoke] 执行失败：', e.message || e)
  process.exit(1)
})
