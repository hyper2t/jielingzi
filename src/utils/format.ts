/**
 * 格式化工具（时间、时长）。
 */

function pad2 (n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 毫秒 → 播放时间「3:12」/「1:02:03」；负数与非法值按 0 处理 */
export function formatClock (ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/** 秒 → 总时长「共 1小时20分」用的中文：「1小时20分」「25分钟」「不到1分钟」 */
export function formatTotalDuration (seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  if (s < 60) return '不到1分钟'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h === 0) return `${m}分钟`
  return m === 0 ? `${h}小时` : `${h}小时${m}分`
}

/** 进度比例 0–1 */
export function progressRatio (position: number, duration: number): number {
  if (!duration || duration <= 0) return 0
  return Math.min(1, Math.max(0, position / duration))
}

/**
 * markdown 转纯文本：不引入 markdown 渲染，只去掉标记符号，保留段落换行。
 */
export function stripMarkdown (md?: string): string {
  if (!md) return ''
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
