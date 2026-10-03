import * as fs from 'fs'
import * as path from 'path'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { formatInviteCode, normalizeInviteCode } from '../rules'

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../tests/fixtures/invite-code.json'), 'utf8')) as {
  valid: Array<{ input: string, expected: string }>
  invalid: Array<{ input: string, message: string }>
}

describe('邀请码规范化（与云函数共享 fixture）', () => {
  it.each(fixture.valid)('$input → $expected', ({ input, expected }) => {
    expect(normalizeInviteCode(input)).toBe(expected)
  })

  it.each(fixture.invalid)('$input → $message', ({ input, message }) => {
    try {
      normalizeInviteCode(input)
      throw new Error('expected normalizeInviteCode to reject input')
    } catch (e) {
      expect(e).toBeInstanceOf(CloudError)
      expect(e).toMatchObject({ code: ERROR_CODES.BAD_PARAM, message })
    }
  })

  it('非字符串用与云函数相同的错误码 / 文案拒绝', () => {
    expect(() => normalizeInviteCode(null)).toThrow(expect.objectContaining({ code: ERROR_CODES.BAD_PARAM, message: 'code 必须是字符串' }))
  })

  it('输入中自动清洗大小写、易混字符与分隔符，并每 4 位加空格', () => {
    expect(formatInviteCode('  abcd-2345  ')).toBe('ABCD 2345')
    expect(formatInviteCode('ooii')).toBe('0011')
    expect(formatInviteCode('ab c')).toBe('ABC')
    expect(formatInviteCode('')).toBe('')
  })
})
