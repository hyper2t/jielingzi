'use strict'
/**
 * 邀请码的生成与规范化（M4）：云函数 community 与运维脚本（scripts/ops/circles.mjs）共用。
 * 前端有同算法的 TypeScript 实现（src/features/circle/rules.ts），两边读同一份 fixture：tests/fixtures/invite-code.json。
 */
const { randomInt } = require('node:crypto')
const { badParam } = require('./errors')
const { INVITE_RULES } = require('./config')

/**
 * 规范化：去空白 / 连字符 → 大写 → O→0、I/L→1；必须恰好 8 位且都在字母表内，否则 40001。
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeInviteCode(raw) {
  if (typeof raw !== 'string') throw badParam('code 必须是字符串')
  const code = raw.replace(/[\s\-\u2010-\u2015\u2212]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  if (code.length !== INVITE_RULES.codeLength) throw badParam(`邀请码为 ${INVITE_RULES.codeLength} 位`)
  for (const ch of code) if (!INVITE_RULES.alphabet.includes(ch)) throw badParam('邀请码含有不支持的字符')
  return code
}

/**
 * 随机码；默认用 crypto，单测 / 脚本可注入 random（[0,1)）得到确定性序列。
 * @param {{ random?: () => number }} [opts]
 * @returns {string}
 */
function generateInviteCode(opts = {}) {
  const { alphabet, codeLength } = INVITE_RULES
  const pick = typeof opts.random === 'function' ? () => Math.min(alphabet.length - 1, Math.floor(opts.random() * alphabet.length)) : () => randomInt(alphabet.length)
  let code = ''
  for (let i = 0; i < codeLength; i++) code += alphabet[pick()]
  return code
}

module.exports = { normalizeInviteCode, generateInviteCode }
