'use strict'
/**
 * 轻量参数校验。规则示例：
 *   { albumId: { type: 'id' }, page: { type: 'int', min: 1, default: 1, optional: true } }
 * 类型：string | id | int | number | boolean | enum
 * 默认拒绝未声明的字段（防止客户端夹带字段写库）。
 */
const { badParam } = require('./errors')

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function checkOne(key, value, rule) {
  switch (rule.type) {
    case 'string':
    case 'id': {
      if (typeof value !== 'string') throw badParam(`${key} 必须是字符串`)
      const v = rule.trim === false ? value : value.trim()
      if (rule.type === 'id' && !ID_RE.test(v)) throw badParam(`${key} 格式错误`)
      if (rule.minLen != null && v.length < rule.minLen) throw badParam(`${key} 长度不能少于 ${rule.minLen}`)
      if (rule.maxLen != null && v.length > rule.maxLen) throw badParam(`${key} 长度不能超过 ${rule.maxLen}`)
      if (rule.pattern && !rule.pattern.test(v)) throw badParam(`${key} 格式错误`)
      return v
    }
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw badParam(`${key} 必须是数字`)
      if (rule.type === 'int' && !Number.isInteger(value)) throw badParam(`${key} 必须是整数`)
      if (rule.min != null && value < rule.min) throw badParam(`${key} 不能小于 ${rule.min}`)
      if (rule.max != null && value > rule.max) throw badParam(`${key} 不能大于 ${rule.max}`)
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw badParam(`${key} 必须是布尔值`)
      return value
    case 'enum':
      if (!rule.values.some((x) => x === value)) throw badParam(`${key} 取值必须是 ${rule.values.join('/')}`)
      return value
    default:
      throw new Error(`未知校验类型 ${rule.type}`)
  }
}

/**
 * @param {Record<string, unknown>} input
 * @param {Record<string, any>} schema
 * @param {{ allowUnknown?: boolean }} [opts]
 * @returns {Record<string, any>} 仅包含 schema 中声明且有值（或有默认值）的字段
 */
function validate(input, schema, opts = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  if (!opts.allowUnknown) {
    const unknown = Object.keys(src).filter((k) => !(k in schema))
    if (unknown.length) throw badParam(`不支持的参数：${unknown.join(',')}`)
  }
  const out = {}
  for (const [key, rule] of Object.entries(schema)) {
    const value = src[key]
    if (value === undefined || value === null) {
      if (rule.default !== undefined) out[key] = rule.default
      else if (!rule.optional) throw badParam(`${key} 必填`)
      continue
    }
    out[key] = checkOne(key, value, rule)
  }
  return out
}

/** 分页参数：page≥1，size 1..maxSize（默认 20，上限 50） */
function pageSchema(maxSize = 50) {
  return {
    page: { type: 'int', min: 1, max: 10000, default: 1 },
    size: { type: 'int', min: 1, max: maxSize, default: 20 },
  }
}

module.exports = { validate, pageSchema, ID_RE }
