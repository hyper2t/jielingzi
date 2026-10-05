'use strict'
/**
 * 自建机审词库（BE-M2-01，docs/prd/wording.md §3 内容机审重点）。与微信 msgSecCheck 叠加，取更严的结论：
 *   reject（不予发布）> review（落库，待人工复核，不对他人展示）> pass
 * 原则（mvp-plan 风险表）：拿不准的一律 review 进人工，只有明确违规（站外引流、劝人停药等）直接 reject，减少误杀。
 * 匹配同时作用于原文与「去掉空白 / 分隔符 / 零宽字符」的紧凑文本，防「微 信」「加·v」之类拆字规避。
 * 只返回命中的分类与词，不记录原文。QA 样本集：tests/cloudfunctions/fixtures/moderation-samples.json（QA-M2-01）。
 * 维护：改词后跑 yarn test:functions 看命中率与误杀率；邪教 / 违法组织名单按监管口径由运营补充到 illegal.words。
 */

const CATEGORIES = Object.freeze({
  religion: {
    label: '宗教活动组织',
    review: ['皈依', '灌顶', '法会', '开光', '供养', '受戒', '拜师', '传法', '共修'],
  },
  medical: {
    label: '疗效 / 医疗承诺',
    review: ['治愈', '根治', '包好', '包治', '排毒', '发功', '治病', '药到病除', '代替药物', '停药', '断药'],
    reject: ['劝你停药', '可以停药', '不用吃药了', '别吃药', '不要吃药', '不用去医院', '不要去医院', '别去医院', '包治百病', '能治癌', '根治癌'],
  },
  mystic: {
    label: '神秘能力',
    review: ['开天眼', '天眼开', '通灵', '隔空', '预言', '附体', '算命', '改命'],
  },
  money: {
    label: '资金往来',
    review: ['随喜', '捐款', '转账', '打款', '收徒', '学费', '收款码', '付费课程', '私聊报价'],
  },
  abuse: {
    label: '辱骂',
    review: ['傻逼', '傻b', '煞笔', '去死', '滚蛋', '废物', '脑残', '贱人', '弱智'],
  },
  illegal: {
    label: '违法 / 邪教组织',
    // 名单按监管口径由运营维护（docs/prd/wording.md §3）；命中直接 reject 并在 mod_logs 留痕
    reject: [],
  },
})

/** 站外引流（PRD 合规红线 / 社区公约「站外引流」）：微信号、QQ、手机号、二维码、加群 → reject；网址 → review */
const DIVERSION = Object.freeze([
  { word: '微信号', re: /(微信|威信|薇信|v信|vx|wx|weixin|wechat|加v|加微|➕v|\+v)(号|id)?[:：]?[a-z][-_a-z0-9]{5,19}/i },
  { word: '微信号', re: /(微信|威信|薇信|v信|vx|wx|加v|加微)(号|id)?[:：]?\d{6,11}/i },
  { word: 'QQ', re: /(qq|扣扣|企鹅|q群)(号|群)?[:：]?\d{5,11}/i },
  { word: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { word: '二维码', re: /二维码|扫码加|扫一扫加|扫码进/ },
  { word: '加群', re: /(加|进|拉你进|入)(我的?|个|下)?(微信群|qq群|群聊|交流群)/i },
])
const URL_RE = /(https?:\/\/|www\.)\S+/i

/** 去掉空白、常见分隔符与零宽字符，全角转半角、小写 */
function compact(text) {
  return String(text)
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u200b-\u200f\u2060\ufeff·•._\-—~～|/\\*、，,。'"“”‘’]/g, '')
    .toLowerCase()
}

/**
 * @param {string} text
 * @returns {Array<{ category: string, word: string, verdict: 'review' | 'reject' }>}
 */
function scanText(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const raw = text.toLowerCase()
  const tight = compact(text)
  const hits = []
  const push = (category, word, verdict) => {
    if (!hits.some((h) => h.category === category && h.word === word)) hits.push({ category, word, verdict })
  }
  for (const [category, def] of Object.entries(CATEGORIES)) {
    for (const w of def.reject || []) if (raw.includes(w) || tight.includes(w)) push(category, w, 'reject')
    for (const w of def.review || []) if (raw.includes(w) || tight.includes(w)) push(category, w, 'review')
  }
  for (const d of DIVERSION) if (d.re.test(raw) || d.re.test(tight)) push('diversion', d.word, 'reject')
  if (URL_RE.test(text)) push('diversion', '网址', 'review')
  return hits
}

const RANK = { pass: 0, review: 1, reject: 2 }
/** 取更严的结论 */
function stricter(a, b) {
  return RANK[b] > RANK[a] ? b : a
}
function verdictOf(hits) {
  return (hits || []).reduce((v, h) => stricter(v, h.verdict), 'pass')
}

module.exports = { WORD_CATEGORIES: CATEGORIES, scanText, verdictOf, stricter, compactText: compact }
