/** M3 services/community.ts：话题 / 回复读写的前置拦截、字段映射、缓存与话题流版本（mock 数据源） */
import { mockControl } from '@/services/mock/client'
import * as community from '@/services/community'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { useUserStore } from '@/store/user'
import { markRulesRead } from '@/features/consent/rules'
import type { Profile } from '@/types/models'
import Taro from '@tarojs/taro'

jest.mock('@/hooks/requestCache', () => {
  const actual = jest.requireActual('@/hooks/requestCache')
  return { ...actual, invalidate: jest.fn(actual.invalidate) }
})
// eslint-disable-next-line import/first
import { invalidate } from '@/hooks/requestCache'

const LIN: Profile = { nickname: '林然', avatar: 'preset:leaf', practices: ['mindfulness'], years: 3, goal: '', bio: '', anonAlias: '竹影', badges: [], updatedAt: 1 }
const BODY = '静坐时总是走神，试了数呼吸也很难坚持，想听听大家的经验。'.repeat(3)
const INPUT = { title: '静坐走神怎么办', body: BODY, tags: ['冥想'], anon: false }
const calls = (action: string) => mockControl.calls.filter(c => c.action === action)

function signIn () {
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: { phoneVerified: true, adult: true, role: 'user', bannedUntil: null, mutedUntil: null } })
  mockControl.setAccount({ adult: true, phoneVerified: true })
  mockControl.setProfile(LIN)
  markRulesRead()
}
const seed = (o: Record<string, unknown> = {}) => {
  mockControl.seedTopics([{ title: '一个话题', body: BODY, ...o } as any])
  return mockControl.topics[mockControl.topics.length - 1].id
}

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  ;(Taro as any).__storage.clear()
  useUserStore.setState({ consent: 'unknown', adult: 'unknown', account: null })
  jest.clearAllMocks()
})

describe('读：未满足条件不发请求', () => {
  it.each(['unknown', 'declined'] as const)('consent=%s：全部返回空，不请求云端', async (c) => {
    useUserStore.setState({ consent: c, adult: 'confirmed' })
    expect(community.canReadCommunity()).toBe(false)
    await expect(community.listTopics()).resolves.toEqual({ list: [], total: 0, hasMore: false })
    await expect(community.getTopic('x')).resolves.toBeNull()
    await expect(community.listReplies('x')).resolves.toEqual({ list: [], total: 0, hasMore: false })
    expect(mockControl.calls).toEqual([])
  })

  it('已同意但未确认 18+：同样不请求（云端读要求 18+，否则 40303）', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'unknown', account: null })
    expect(community.canReadCommunity()).toBe(false)
    await expect(community.listTopics()).resolves.toMatchObject({ list: [] })
    await expect(community.getTopic('x')).resolves.toBeNull()
    expect(mockControl.calls).toEqual([])
  })

  it('云端账号已确认 18+（换机 / 重装）也算：本机未确认不影响', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'unknown', account: { phoneVerified: false, adult: true, role: 'user', bannedUntil: null, mutedUntil: null } })
    mockControl.setAccount({ adult: true })
    expect(community.canReadCommunity()).toBe(true)
    await community.listTopics()
    expect(calls('listTopics')).toHaveLength(1)
  })
})

describe('读：字段映射与分页参数', () => {
  it('listTopics：每项加 _id = id，带 page / size，透传 total / hasMore', async () => {
    signIn()
    seed({ title: 'A' }); seed({ title: 'B' })
    const r = await community.listTopics(1, 1)
    expect(calls('listTopics')[0].data).toEqual({ page: 1, size: 1 })
    expect(r.list).toHaveLength(1)
    expect(r.list[0]._id).toBe(r.list[0].id)
    expect(r.total).toBe(2)
    expect(r.hasMore).toBe(true)
    const r2 = await community.listTopics(2, 1)
    expect(r2.hasMore).toBe(false)
    expect(r2.list[0].id).not.toBe(r.list[0].id)
  })

  it('默认分页大小：话题流 20、回复 30', async () => {
    signIn()
    const id = seed()
    await community.listTopics()
    await community.listReplies(id)
    expect(calls('listTopics')[0].data).toEqual({ page: 1, size: community.FEED_PAGE_SIZE })
    expect(calls('listReplies')[0].data).toEqual({ topicId: id, page: 1, size: community.REPLY_PAGE_SIZE })
    expect([community.FEED_PAGE_SIZE, community.REPLY_PAGE_SIZE]).toEqual([20, 30])
  })

  it('getTopic 返回详情；listReplies 每项加 _id', async () => {
    signIn()
    const id = seed({ title: '详情标题' })
    mockControl.seedReplies([{ topicId: id, body: '一条足够长的回复内容，用来确保它不会被当作简短回复折叠起来。', authorName: '松声' }])
    await expect(community.getTopic(id)).resolves.toMatchObject({ id, title: '详情标题', body: BODY })
    const r = await community.listReplies(id)
    expect(r.list).toHaveLength(1)
    expect(r.list[0]._id).toBe(r.list[0].id)
  })

  it('云端错误原样抛出（话题不存在 → 40401）', async () => {
    signIn()
    await expect(community.getTopic('nope')).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND })
  })
})

describe('写：先 assertCanWrite，再请求', () => {
  it.each(['unknown', 'declined'] as const)('consent=%s：createTopic / createReply / deleteMine 被拦截且不发请求', async (c) => {
    useUserStore.setState({ consent: c })
    const v = community.getFeedVersion()
    await expect(community.createTopic(INPUT)).rejects.toMatchObject({ code: ERROR_CODES.CONSENT_REQUIRED })
    await expect(community.createReply({ topicId: 't', body: '回复', anon: false })).rejects.toBeInstanceOf(CloudError)
    await expect(community.deleteMine('topic', 't')).rejects.toMatchObject({ code: ERROR_CODES.CONSENT_REQUIRED })
    expect(mockControl.calls).toEqual([])
    expect(community.getFeedVersion()).toBe(v)
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('写：成功后刷新', () => {
  it('createTopic：返回 ok + 话题 + 剩余额度；话题流版本 +1', async () => {
    signIn()
    const v = community.getFeedVersion()
    const r = await community.createTopic(INPUT)
    expect(r.status).toBe('ok')
    expect(r.topic.title).toBe(INPUT.title)
    expect(r.remaining).toBe(1)
    expect(community.getFeedVersion()).toBe(v + 1)
  })

  it('createTopic 云端拒绝（机审 / 额度）：抛错，不动话题流版本', async () => {
    signIn()
    const v = community.getFeedVersion()
    await expect(community.createTopic({ ...INPUT, body: `${BODY}[reject]` })).rejects.toMatchObject({ code: ERROR_CODES.BAD_PARAM })
    await community.createTopic(INPUT)
    await community.createTopic(INPUT)
    await expect(community.createTopic(INPUT)).rejects.toMatchObject({ code: 42901 })
    expect(community.getFeedVersion()).toBe(v + 2)
  })

  it('机审待复核：status = pending', async () => {
    signIn()
    const r = await community.createTopic({ ...INPUT, body: `${BODY}[review]` })
    expect(r.status).toBe('pending')
    expect(r.topic.pending).toBe(true)
  })

  it('createReply：失效该话题的详情缓存 + 话题流版本 +1（回复数变了）', async () => {
    signIn()
    const id = seed()
    const v = community.getFeedVersion()
    const r = await community.createReply({ topicId: id, body: '这是一条足够长的回复，用来确认回复成功之后缓存会被正确失效。', anon: false })
    expect(r.status).toBe('ok')
    expect(r.reply.topicId).toBe(id)
    expect(invalidate).toHaveBeenCalledWith(community.topicKey(id))
    expect(community.getFeedVersion()).toBe(v + 1)
  })

  it('deleteMine(topic)：失效详情缓存；deleteMine(reply)：不失效话题，但话题流版本 +1；幂等 changed=false', async () => {
    signIn()
    mockControl.seedTopics([{ title: '我的话题', body: BODY, mine: true } as any])
    const id = mockControl.topics[0].id
    const v = community.getFeedVersion()
    await expect(community.deleteMine('topic', id)).resolves.toEqual({ changed: true })
    expect(invalidate).toHaveBeenCalledWith(community.topicKey(id))
    await expect(community.deleteMine('topic', id)).resolves.toEqual({ changed: false })
    expect(community.getFeedVersion()).toBe(v + 2)

    mockControl.seedTopics([{ title: '别人的话题', body: BODY, authorName: '松声' } as any])
    const tid = mockControl.topics[mockControl.topics.length - 1].id
    mockControl.seedReplies([{ topicId: tid, body: '我的回复', mine: true }])
    const rid = mockControl.replies[0].id
    ;(invalidate as jest.Mock).mockClear()
    await community.deleteMine('reply', rid)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('deleteMine 别人的内容：40401，不动话题流版本', async () => {
    signIn()
    const id = seed({ authorName: '松声' })
    const v = community.getFeedVersion()
    await expect(community.deleteMine('topic', id)).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND })
    expect(community.getFeedVersion()).toBe(v)
  })
})

describe('topicKey', () => {
  it('每个话题一个缓存 key', () => {
    expect(community.topicKey('a')).toBe('topic:a')
    expect(community.topicKey('a')).not.toBe(community.topicKey('b'))
  })
})
