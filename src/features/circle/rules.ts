/**
 * 邀请码输入规则（FE-M4-00）：与 cloudfunctions/_shared/invite-code.js 同算法，
 * 两端共读 tests/fixtures/invite-code.json，避免规范化与错误提示漂移。
 */
import { INVITE_RULES } from '@/constants/community'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'

const stripFormatting = (raw: string): string => raw
  .replace(/[\s\-\u2010-\u2015\u2212]/g, '')
  .toUpperCase()
  .replace(/O/g, '0')
  .replace(/[IL]/g, '1')

/** 邀请码规范化：移除空白 / 连字符，大写并替换易混字符；校验 8 位 Crockford base32。 */
export function normalizeInviteCode (raw: unknown): string {
  if (typeof raw !== 'string') throw new CloudError(ERROR_CODES.BAD_PARAM, 'code 必须是字符串')
  const code = stripFormatting(raw)
  if (code.length !== INVITE_RULES.codeLength) throw new CloudError(ERROR_CODES.BAD_PARAM, `邀请码为 ${INVITE_RULES.codeLength} 位`)
  for (const ch of code) {
    if (!INVITE_RULES.alphabet.includes(ch)) throw new CloudError(ERROR_CODES.BAD_PARAM, '邀请码含有不支持的字符')
  }
  return code
}

/** 输入 / 展示格式：允许部分内容，做与规范化相同的清洗，再每 4 位加一个空格。 */
export function formatInviteCode (raw: string): string {
  const compact = stripFormatting(raw)
  return compact.replace(/(.{4})(?=.)/g, '$1 ')
}
