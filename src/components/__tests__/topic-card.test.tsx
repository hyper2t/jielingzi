/** FE-M3-01 TopicCard + Toggle：卡片内容 / 匿名脱敏 / 状态标 / 点击；开关的读屏文案与禁用 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import { TopicCard, Toggle } from '@/components'
import { FEATURED_BADGE, PENDING_BADGE } from '@/components/TopicCard'
import type { TopicSummary } from '@/types/models'

const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); return r }
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))

const NOW = new Date('2026-10-01T12:00:00+08:00').getTime()
const TOPIC: TopicSummary = {
  id: 't1',
  circle: null,
  title: '静坐走神怎么办',
  excerpt: '静坐时总是走神，试了数呼吸也很难坚持…',
  tags: ['冥想', '呼吸'],
  anon: false,
  author: { name: '松声', avatar: 'preset:leaf', practices: ['mindfulness'], years: 3, badges: [] },
  replyCount: 3,
  createdAt: NOW - 5 * 60000,
  lastReplyAt: NOW - 60000,
  featured: false,
  images: [],
  folded: false,
  pending: false
}

describe('TopicCard', () => {
  it('作者 / 发帖时间 / 标题 / 摘要 / 标签 / 回复数；读屏文案含标题与回复数', () => {
    const r = render(<TopicCard topic={TOPIC} now={NOW} />)
    const t = texts(r)
    expect(t).toEqual(expect.arrayContaining(['松声', '静坐走神怎么办', '静坐时总是走神，试了数呼吸也很难坚持…', '#冥想', '#呼吸', '3 条回复']))
    expect(t.some(x => x.includes('5 分钟前'))).toBe(true)
    expect(hosts(r, n => n.props.ariaLabel === '话题：静坐走神怎么办，3 条回复')).toHaveLength(1)
    expect(t).not.toContain(FEATURED_BADGE)
    expect(t).not.toContain(PENDING_BADGE)
    expect(r.toJSON()).toMatchSnapshot()
  })

  it('匿名：显示「匿名·代号」，不出现昵称', () => {
    const r = render(<TopicCard topic={{ ...TOPIC, anon: true, author: { ...TOPIC.author, name: '竹影' } }} now={NOW} />)
    const t = texts(r)
    expect(t).toContain('匿名·竹影')
    expect(t).not.toContain('松声')
  })

  it('显示所属圈子名，并纳入读屏文案', () => {
    const r = render(<TopicCard topic={{ ...TOPIC, circle: { id: 'circle-mindful', name: '静观练习' } }} now={NOW} />)
    expect(texts(r)).toContain('静观练习')
    expect(hosts(r, n => n.props.ariaLabel === '话题：静坐走神怎么办，3 条回复，静观练习')).toHaveLength(1)
  })

  it('精选 / 审核中状态标；摘要为空（折叠）时不渲染摘要；无标签不渲染标签行', () => {
    const r = render(<TopicCard topic={{ ...TOPIC, featured: true, pending: true, excerpt: '', tags: [] }} now={NOW} />)
    const t = texts(r)
    expect(t).toEqual(expect.arrayContaining([FEATURED_BADGE, PENDING_BADGE]))
    expect(t.some(x => x.startsWith('#'))).toBe(false)
    expect(t.filter(x => x.includes('静坐时'))).toHaveLength(0)
  })

  it('点击触发 onClick', () => {
    const onClick = jest.fn()
    const r = render(<TopicCard topic={TOPIC} now={NOW} onClick={onClick} />)
    act(() => { hosts(r, n => typeof n.props.onClick === 'function')[0].props.onClick() })
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Toggle', () => {
  const root = (r: ReactTestRenderer) => hosts(r, n => n.props.ariaRole === 'switch')[0]

  it('读屏读作「标签，已开启 / 已关闭」；点击取反回调', () => {
    const onChange = jest.fn()
    const r = render(<Toggle on={false} label='匿名发布' onChange={onChange} />)
    expect(root(r).props.ariaLabel).toBe('匿名发布，已关闭')
    expect(root(r).props.accessibilityState).toEqual({ checked: false, disabled: false })
    act(() => { root(r).props.onClick() })
    expect(onChange).toHaveBeenLastCalledWith(true)
    act(() => { r.update(<Toggle on label='匿名发布' onChange={onChange} />) })
    expect(root(r).props.ariaLabel).toBe('匿名发布，已开启')
    act(() => { root(r).props.onClick() })
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('disabled：点击不回调', () => {
    const onChange = jest.fn()
    const r = render(<Toggle on={false} label='匿名发布' onChange={onChange} disabled />)
    expect(root(r).props.accessibilityState).toEqual({ checked: false, disabled: true })
    act(() => { root(r).props.onClick() })
    expect(onChange).not.toHaveBeenCalled()
  })
})
