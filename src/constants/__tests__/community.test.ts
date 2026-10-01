import * as fs from 'fs'
import * as path from 'path'
import { AVATAR_PRESETS, BANNED_UI_WORDS, CONSENT_VERSION, DAILY_LIMITS, PRACTICES, PROFILE_RULES, RESERVED_NICKNAME_WORDS, TEXT_RULES } from '@/constants/community'
import { AVATARS } from '@/assets/avatars'
import { PUNISH_DAYS, REPORT_REASONS } from '@/constants/moderation'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const backend = require('../../../cloudfunctions/_shared/config.js')

describe('社区常量与云函数 _shared/config.js 一致', () => {
  it('额度 / 字数 / 练习方式', () => {
    expect(DAILY_LIMITS).toEqual(backend.DAILY_LIMITS)
    expect(TEXT_RULES).toEqual(backend.TEXT_RULES)
    expect(PRACTICES).toEqual(backend.PRACTICES)
  })

  it('档案规则 / 预置头像 / 昵称保留词 / 协议版本（M1）', () => {
    expect(PROFILE_RULES).toEqual(backend.PROFILE_RULES)
    expect(AVATAR_PRESETS).toEqual(backend.AVATAR_PRESETS)
    expect(RESERVED_NICKNAME_WORDS).toEqual(backend.RESERVED_NICKNAME_WORDS)
    expect(CONSENT_VERSION).toBe(backend.CONSENT_VERSION)
    // 每个预置头像都有生成好的图片（tools/gen-icons.js）
    expect(Object.keys(AVATARS).sort()).toEqual([...AVATAR_PRESETS].sort())
  })

  it('举报原因 / 处罚时长（M2）', () => {
    expect(REPORT_REASONS).toEqual(backend.REPORT_REASONS)
    expect(PUNISH_DAYS).toEqual(backend.PUNISH_DAYS)
  })
})

/** 措辞规范（PRD §3）：src 下的界面文案不得出现禁用词（注释与本常量定义除外） */
describe('界面措辞扫描', () => {
  const root = path.resolve(__dirname, '../..')
  const files: string[] = []
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!['__tests__', '__snapshots__', 'rn-stubs'].includes(e.name)) walk(p) } else if (/\.(tsx?|scss)$/.test(e.name)) files.push(p)
  })
  walk(root)
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it.each(files.filter(f => !f.endsWith(path.join('constants', 'community.ts'))).map(f => [path.relative(root, f), f]))('%s', (_rel, f) => {
    const code = strip(fs.readFileSync(f, 'utf8'))
    for (const w of BANNED_UI_WORDS) expect(code.includes(w) ? w : null).toBeNull()
  })
})
