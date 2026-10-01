/**
 * 内容安全常量（M2）。权威定义在 cloudfunctions/_shared/config.js（REPORT_REASONS / PUNISH_DAYS），
 * 两边必须一致——src/constants/__tests__/community.test.ts 会比对。
 */
export const REPORT_REASONS = [
  { id: 'religion', label: '宗教活动 / 个人崇拜' },
  { id: 'medical', label: '疗效承诺 / 劝人停药' },
  { id: 'money', label: '金钱往来 / 推销' },
  { id: 'diversion', label: '站外引流（微信号 / 二维码等）' },
  { id: 'abuse', label: '人身攻击 / 骚扰' },
  { id: 'porn', label: '色情低俗' },
  { id: 'illegal', label: '违法有害信息' },
  { id: 'privacy', label: '泄露他人隐私 / 冒充他人' },
  { id: 'spam', label: '刷屏 / 广告' },
  { id: 'other', label: '其他' }
] as const

export type ReportReasonId = typeof REPORT_REASONS[number]['id']

/** 处罚时长（天）：禁言 1–30；封禁不传天数 = 永久 */
export const PUNISH_DAYS = { mute: { min: 1, max: 30 }, ban: { min: 1, max: 3650 } } as const

/** 审核页的禁言时长选项（天） */
export const MUTE_DAY_OPTIONS = [1, 3, 7, 30] as const

/** 举报补充说明上限（与云函数 moderation.report 的 note 规则一致） */
export const REPORT_NOTE_MAX = 200
