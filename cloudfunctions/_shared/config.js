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
  /** 兑换邀请码：每次尝试都计数（含失败），防猜码（M4） */
  redeemInvite: 10,
  updateProfile: 20,
  /** 上传图片（头像等，BE-M2-02） */
  uploadImage: 10,
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

/** 话题的其余规则（PRD T1）：标签最多几个、每个标签的字数；列表摘要长度（与前端 src/constants/community.ts 一致） */
const TOPIC_RULES = Object.freeze({
  tagsMax: 3,
  tag: { min: 1, max: 12 },
  excerptLen: 80,
  /** 慢话题冷静期小时数（D11）：createTopic({ slow: true }) 后这段时间内不开放回复，固定 24h，暂不做自定义时长 */
  slowHours: 24,
})

/**
 * 邀请码与圈子（PRD G1–G3，docs/prd/m4-plan.md §4；前端同名常量见 src/constants/community.ts）。
 * alphabet 是 Crockford base32（去掉 I L O U，避免口头 / 手输混淆）；输入规范化时 O→0、I/L→1。
 */
const INVITE_RULES = Object.freeze({
  /** 新用户初始名额（users.inviteQuota 首次使用时懒初始化） */
  initialQuota: 3,
  /** 邀请码有效期（天） */
  ttlDays: 7,
  codeLength: 8,
  alphabet: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
  /** 「我的邀请码」最多返回条数 */
  listMax: 50,
})

/** 官方圈子的字段长度（种子脚本与 getCircle 共用） */
const CIRCLE_RULES = Object.freeze({
  nameMax: 12,
  descMax: 60,
  rulesMax: 5,
  ruleMax: 60,
})

/**
 * 每日一题（PRD W3，docs/prd/m6-plan.md D6–D10）：题目录入长度、答案字数、答案分页与匿名默认值。
 * 前端同名常量见 src/constants/community.ts（一致性由 src/constants/__tests__/community.test.ts 校验，FE-M6-00 补齐）。
 */
const PROMPT_RULES = Object.freeze({
  /** 题目正文字数上限（运营录入时校验，云函数只读不校验） */
  textMax: 120,
  /** 答案字数：太短的答案在列表里没有阅读价值 */
  answer: { min: 5, max: 500 },
  /** 答案列表单页上限 */
  listMax: 50,
  /** 默认匿名：作答未显式选择时按匿名处理（D9，用户可切实名） */
  defaultAnon: true,
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

/** 举报原因（PRD S2，与前端 src/constants/moderation.ts 一致）；id 入库，label 仅展示 */
const REPORT_REASONS = Object.freeze([
  { id: 'religion', label: '宗教活动 / 个人崇拜' },
  { id: 'medical', label: '疗效承诺 / 劝人停药' },
  { id: 'money', label: '金钱往来 / 推销' },
  { id: 'diversion', label: '站外引流（微信号 / 二维码等）' },
  { id: 'abuse', label: '人身攻击 / 骚扰' },
  { id: 'porn', label: '色情低俗' },
  { id: 'illegal', label: '违法有害信息' },
  { id: 'privacy', label: '泄露他人隐私 / 冒充他人' },
  { id: 'spam', label: '刷屏 / 广告' },
  { id: 'other', label: '其他' },
])
/** 同一目标被不同用户举报达到该数量时自动折叠（BE-M2-03，PRD S2「达阈值自动折叠」） */
const REPORT_FOLD_THRESHOLD = 3
/** 处罚时长上限（天）：禁言 1–30（社区公约「禁言 1–30 天」）；封禁不传天数 = 永久 */
const PUNISH_DAYS = Object.freeze({ mute: { min: 1, max: 30 }, ban: { min: 1, max: 3650 } })

/** 角色（users.role，仅 scripts/ops/set-role.mjs 可改） */
const ROLES = Object.freeze(['user', 'mod', 'admin'])

/** 北京时间日期 YYYY-MM-DD（频控、打卡兜底用；打卡以客户端本地日期为准） */
function cnDate(now) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

module.exports = { DAILY_LIMITS, TEXT_RULES, TOPIC_RULES, INVITE_RULES, CIRCLE_RULES, PROMPT_RULES, PRACTICES, PRACTICE_IDS, PROFILE_RULES, AVATAR_PRESETS, RESERVED_NICKNAME_WORDS, CONSENT_VERSION, REPORT_REASONS, REPORT_FOLD_THRESHOLD, PUNISH_DAYS, ROLES, cnDate }
