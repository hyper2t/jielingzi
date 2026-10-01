/**
 * 社区业务常量（前端展示 / 表单校验用）。权威定义在 cloudfunctions/_shared/config.js，
 * 两边必须一致——src/constants/__tests__/community.test.ts 会比对。
 */
export const DAILY_LIMITS = {
  createTopic: 2,
  createReply: 20,
  answerPrompt: 1,
  report: 30,
  createInvite: 5,
  updateProfile: 20,
  /** 上传图片（头像等） */
  uploadImage: 10
} as const

export const TEXT_RULES = {
  topicTitle: { min: 5, max: 40 },
  topicBody: { min: 50, max: 10000 },
  reply: { min: 1, max: 5000 },
  /** 少于该字数的回复默认折叠 */
  shortReply: 30,
  nickname: { min: 2, max: 16 },
  bio: { max: 80 },
  goal: { max: 40 }
} as const

export const PRACTICES = [
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
  { id: 'other', label: '其他' }
] as const

export type PracticeId = typeof PRACTICES[number]['id']

/** 练习档案的其余规则（PRD P1）：练习方式最多选几项、练习年限范围 */
export const PROFILE_RULES = {
  practicesMax: 5,
  years: { min: 0, max: 80 }
} as const

/**
 * 预置头像 id：profiles.avatar 存 'preset:<id>'，图片见 src/assets/avatars（tools/gen-icons.js 生成）。
 * 自定义头像上传随 M2 图片机审一起上线（未经机审的图片不展示，PRD §3 / §9）。
 */
export const AVATAR_PRESETS = ['leaf', 'sprout', 'mountain', 'waves', 'moon', 'sun', 'cloud', 'trees', 'flower', 'wind', 'feather', 'bird'] as const
export type AvatarPreset = typeof AVATAR_PRESETS[number]

/** 昵称不可包含（防冒充平台 / 管理员） */
export const RESERVED_NICKNAME_WORDS = ['结灵子', '官方', '管理员', '客服', '系统', '审核'] as const

/** 当前协议版本（用户协议 / 隐私政策 / 社区公约一起计版本），与云函数 CONSENT_VERSION 一致 */
export const CONSENT_VERSION = 'v0.1'

/**
 * 措辞禁用词（docs/prd/wording.md §2 替换表「不用」列中无歧义的词）：界面文案与种子数据不得出现；内容机审词库见 M2。
 * 不收录需看语境的词：老师（仅禁平台认证意义）、功法（「传统养生功法」是练习方式名称）、打坐（可用）。
 */
export const BANNED_UI_WORDS = [
  '修行', '修炼', '修持', '法门', '同修', '道友', '师兄', '师父', '上师',
  '开示', '讲法', '传法', '共修', '法会', '禅修营', '闭关',
  '功德', '福报', '业力', '加持', '灌顶', '皈依', '供养', '开光'
] as const
