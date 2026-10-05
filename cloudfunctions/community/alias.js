'use strict'
/**
 * 匿名代号（PRD P2，如「竹影」）：前台匿名发布时显示「匿名·竹影」。
 * 只用自然意象（docs/prd/wording.md：不用宗教 / 玄学意象），两字为主；连续碰撞后追加数字扩大空间。
 * 唯一性由调用方保证（profiles.anonAlias 唯一索引 + 写入前查重 + 冲突重试，见 profile.js）。
 */
const ALIAS_FIRST = Object.freeze([
  '竹', '松', '云', '石', '溪', '月', '山', '风', '雨', '雪', '林', '泉', '叶', '星', '晨', '暮', '苔', '兰', '荷', '梅',
  '桐', '枫', '柳', '杉', '岚', '川', '湖', '汀', '禾', '麦', '茶', '砚', '纸', '灯', '舟', '帆', '鹤', '雁', '鹿', '萤',
])
const ALIAS_SECOND = Object.freeze([
  '影', '语', '声', '客', '行', '眠', '听', '望', '歌', '光', '痕', '息', '径', '岸', '亭', '庐', '居', '窗', '桥', '渡',
  '野', '间', '边', '音', '色', '烟', '露', '谷', '原', '洲',
])

/** 两字组合用尽前的尝试次数；之后追加 2 位数字，再之后 3 位 */
const PLAIN_ATTEMPTS = 4
const SHORT_SUFFIX_ATTEMPTS = 8

/**
 * @param {() => number} random [0, 1)
 * @param {number} attempt 第几次尝试（0 起）：0–3 两字；4–7 两字 + 两位数；之后两字 + 三位数
 */
function generateAlias(random = Math.random, attempt = 0) {
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))]
  const base = pick(ALIAS_FIRST) + pick(ALIAS_SECOND)
  if (attempt < PLAIN_ATTEMPTS) return base
  if (attempt < SHORT_SUFFIX_ATTEMPTS) return base + String(10 + Math.floor(random() * 90))
  return base + String(100 + Math.floor(random() * 900))
}

module.exports = { generateAlias, ALIAS_FIRST, ALIAS_SECOND, PLAIN_ATTEMPTS }
