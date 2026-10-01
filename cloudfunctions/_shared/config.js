'use strict'
/**
 * 业务配置（PRD §5 / §8）。前端展示用的同名常量见 src/constants/community.ts，改动需两边同步。
 */

/** 每日上限（PRD T4）。key 为 guard 的 action 名；日期按北京时间（UTC+8）切分 */
const DAILY_LIMITS = Object.freeze({
  createTopic: 2,
  createReply: 20,
  answerPrompt: 1,
  report: 30,
  createInvite: 5,
  updateProfile: 20,
})

/** 字数规则（PRD T1 / T2 / P1） */
const TEXT_RULES = Object.freeze({
  topicTitle: { min: 5, max: 40 },
  topicBody: { min: 50, max: 10000 },
  reply: { min: 1, max: 5000 },
  /** 少于该字数的回复标记 short，前端默认折叠 */
  shortReply: 30,
  nickname: { min: 2, max: 16 },
  bio: { max: 80 },
  goal: { max: 40 },
})

/** 练习方式预置列表（PRD P1；措辞规范见 docs/prd/wording.md）。id 入库，label 仅展示 */
const PRACTICES = Object.freeze([
  { id: 'meditation', label: '冥想' },
  { id: 'mindfulness', label: '正念' },
  { id: 'vipassana', label: '内观' },
  { id: 'taichi', label: '太极' },
  { id: 'zhanzhuang', label: '站桩' },
  { id: 'qigong', label: '传统养生功法' },
  { id: 'yoga', label: '瑜伽' },
  { id: 'breathing', label: '呼吸练习' },
  { id: 'calligraphy', label: '书法静心' },
  { id: 'tea', label: '茶道静心' },
  { id: 'reading', label: '经典阅读' },
  { id: 'other', label: '其他' },
])
const PRACTICE_IDS = PRACTICES.map((p) => p.id)

/** 练习档案的其余规则（PRD P1）：练习方式最多选几项、练习年限范围 */
const PROFILE_RULES = Object.freeze({
  practicesMax: 5,
  years: { min: 0, max: 80 },
})

/**
 * 预置头像（PRD P1 头像）：profiles.avatar 存 'preset:<id>'。图片由 tools/gen-icons.js 生成到 src/assets/avatars/。
 * 自定义头像上传随 M2 图片机审（BE-M2-02 mediaCheckAsync）一起上线：未经机审的图片不展示（PRD §3 / §9 内容先审后发）。
 */
const AVATAR_PRESETS = Object.freeze(['leaf', 'sprout', 'mountain', 'waves', 'moon', 'sun', 'cloud', 'trees', 'flower', 'wind', 'feather', 'bird'])

/** 昵称不可包含（防冒充平台 / 管理员，社区公约「伤害他人 · 冒充」） */
const RESERVED_NICKNAME_WORDS = Object.freeze(['结灵子', '官方', '管理员', '客服', '系统', '审核'])

/** 当前协议版本（用户协议 / 隐私政策 / 社区公约一起计版本）：users.consentVersion；协议更新时改这里并重新征得同意 */
const CONSENT_VERSION = 'v0.1'

/** 角色（users.role，仅 scripts/ops/set-role.mjs 可改） */
const ROLES = Object.freeze(['user', 'mod', 'admin'])

/** 北京时间日期 YYYY-MM-DD（频控、打卡兜底用；打卡以客户端本地日期为准） */
function cnDate(now) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

module.exports = { DAILY_LIMITS, TEXT_RULES, PRACTICES, PRACTICE_IDS, PROFILE_RULES, AVATAR_PRESETS, RESERVED_NICKNAME_WORDS, CONSENT_VERSION, ROLES, cnDate }
