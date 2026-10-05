'use strict'
/**
 * M4 测试夹具：圈子 / 成员关系 / 邀请码的种子文档，配合 createFakeDb({ data, unique })。
 *   const db = createFakeDb({ data: { circles: [circleDoc()], memberships: [memberDoc('circle-mindful', 'acct-a')] }, unique: CIRCLE_UNIQUE })
 */
let seq = 0

const DAY = 24 * 3600 * 1000

/** 与 collections.js 的唯一索引一致（fakeDb 据此模拟唯一冲突） */
const CIRCLE_UNIQUE = {
  circles: ['slug'],
  memberships: [['circleId', '_openid']],
  invites: ['code'],
}

/** 官方圈子；_id 默认 circle-<slug>，方便测试里直接引用 */
function circleDoc(o = {}) {
  const slug = o.slug || `c${++seq}`
  return {
    _id: `circle-${slug}`,
    slug,
    name: '静观练习',
    desc: '冥想、正念、内观的日常练习与困惑',
    cover: `circle:${slug}`,
    rules: ['说具体：做法、时长、当时的感受，少下结论。'],
    memberCount: 0,
    topicCount: 0,
    sort: 1,
    status: 'open',
    ...o,
  }
}

/** 成员关系（invitedBy 默认 null = 运维直接加入） */
function memberDoc(circleId, accountId, o = {}) {
  return { circleId, _openid: accountId, joinedAt: 1, invitedBy: null, inviteCode: null, role: 'member', ...o }
}

/**
 * 邀请码：owner 为 null 表示官方码（运维签发，不占名额）。默认「刚签发、7 天后过期、未使用、未退名额」。
 * now 是「当前时间」，用来推算 createdAt / expiresAt。
 */
function inviteDoc(code, circleId, owner, { now = Date.now(), ...o } = {}) {
  return {
    code,
    circleId,
    _openid: owner,
    official: owner === null,
    createdAt: now,
    expiresAt: now + 7 * DAY,
    usedBy: null,
    usedAt: null,
    refunded: false,
    ...o,
  }
}

module.exports = { CIRCLE_UNIQUE, circleDoc, memberDoc, inviteDoc, DAY }
