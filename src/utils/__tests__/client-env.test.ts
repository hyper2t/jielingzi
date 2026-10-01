/**
 * 守卫：src 里引用的每个 process.env.TARO_APP_* 都必须在 config/client-env.js 里有默认值。
 * 否则 .env 没写这个变量时，小程序产物里会残留 process.env.XXX，启动即 ReferenceError（白屏，只剩 tabBar）。
 */
import * as fs from 'fs'
import * as path from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CLIENT_ENV_DEFAULTS, clientEnv, assertNoSecretInClientEnv } = require('../../../config/client-env')

const SRC = path.resolve(__dirname, '../..')

function walk (dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') walk(p, out)
    } else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

describe('client env defaults', () => {
  it('src 中引用的 TARO_APP_* 变量都有默认值', () => {
    const used = new Set<string>()
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(/process\.env\.(TARO_APP_[A-Z0-9_]+)/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(0)
    const missing = [...used].filter(k => !(k in CLIENT_ENV_DEFAULTS))
    expect(missing).toEqual([])
  })

  it('转成 Taro config.env 格式（JSON 字面量），数据源默认 mock', () => {
    const env = clientEnv()
    expect(env.TARO_APP_DATA_SOURCE).toBe('"mock"')
    expect(env.TARO_APP_CLOUD_ENV_ID).toBe('""')
    Object.values(env).forEach(v => expect(() => JSON.parse(v as string)).not.toThrow())
  })

  it('默认值里没有任何像密钥的变量名', () => {
    expect(() => assertNoSecretInClientEnv('', CLIENT_ENV_DEFAULTS)).not.toThrow()
  })
})

describe('assertNoSecretInClientEnv（BE-RN-05）', () => {
  const os = require('os')
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-env-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('.env* 里带 TARO_APP_ 前缀的 API_KEY / SECRET 变量名会让构建失败（不看值）', () => {
    fs.writeFileSync(path.join(dir, '.env'), '# 注释\nTARO_APP_CLOUD_ENV_ID=abc\nCLOUDBASE_API_KEY=admin\nCLOUDBASE_SECRET_KEY=s\n')
    expect(() => assertNoSecretInClientEnv(dir, {})).not.toThrow()
    fs.writeFileSync(path.join(dir, '.env.local'), 'TARO_APP_CLOUD_API_KEY=\n')
    expect(() => assertNoSecretInClientEnv(dir, {})).toThrow(/TARO_APP_CLOUD_API_KEY（\.env\.local）/)
    fs.writeFileSync(path.join(dir, '.env.local'), 'export TARO_APP_TTS_SECRET=x\n')
    expect(() => assertNoSecretInClientEnv(dir, {})).toThrow(/TARO_APP_TTS_SECRET/)
  })

  it('进程环境变量同样检查；不存在的目录只查环境变量', () => {
    expect(() => assertNoSecretInClientEnv(path.join(dir, 'missing'), { TARO_APP_CLOUD_ENV_ID: 'a', ALIYUN_ACCESS_KEY_SECRET: 'b' })).not.toThrow()
    expect(() => assertNoSecretInClientEnv(path.join(dir, 'missing'), { TARO_APP_ADMIN_TOKEN: 't' })).toThrow(/TARO_APP_ADMIN_TOKEN（process\.env）/)
  })

  it('真实仓库的 .env* 里没有带前缀的密钥（TARO_APP_CLOUD_API_KEY 已改名 CLOUDBASE_API_KEY）', () => {
    expect(() => assertNoSecretInClientEnv(path.resolve(SRC, '..'), {})).not.toThrow()
  })
})
