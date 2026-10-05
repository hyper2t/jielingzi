/** FE-M1-04：AuthorBadge 实名 / 匿名 / 已注销 / 本人四种形态 + Avatar 预置头像映射 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'

// 图片 mock 全部是同一个桩值；这里给每个头像不同的值，断言才有意义
jest.mock('@/assets/avatars', () => {
  const ids = ['leaf', 'sprout', 'mountain', 'waves', 'moon', 'sun', 'cloud', 'trees', 'flower', 'wind', 'feather', 'bird']
  return { AVATARS: Object.fromEntries(ids.map(id => [id, `${id}.png`])), AVATAR_DEFAULT: 'default.png', AVATAR_ANON: 'anon.png' }
})
import { AuthorBadge, authorName, Avatar, avatarSrc, presetId, ANON_PREFIX, DELETED_NAME, SELF_TAG } from '@/components'
import { AVATARS, AVATAR_ANON, AVATAR_DEFAULT } from '@/assets/avatars'
import type { AuthorView } from '@/types/models'

const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); return r }
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const images = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Image').map(n => n.props.src)

const LIN: AuthorView = { name: '林然', avatar: 'preset:leaf', practices: ['mindfulness'], years: 3, badges: ['senior'] }

describe('AuthorBadge', () => {
  it('实名：档案头像 + 昵称 + 资深标识 + 练习方式 · 年限 · 时间', () => {
    const r = render(<AuthorBadge author={LIN} meta='10-01' />)
    expect(texts(r)).toEqual(['林然', '资深练习者', '正念  练习 3 年 · 10-01'])
    expect(images(r)).toEqual([AVATARS.leaf])
    expect(r.toJSON()).toMatchSnapshot()
  })

  it('匿名：匿名头像 +「匿名·代号」，不显示任何档案信息（即使接口带了）', () => {
    const r = render(<AuthorBadge author={{ ...LIN, name: '竹影', anon: true }} meta='10-01' />)
    expect(texts(r)).toEqual([`${ANON_PREFIX}竹影`, '10-01'])
    expect(images(r)).toEqual([AVATAR_ANON])
    expect(r.toJSON()).toMatchSnapshot()
  })

  it('本人发布显示「我」；匿名也只是本人可见的标签', () => {
    const r = render(<AuthorBadge author={{ name: '竹影', isSelf: true }} anon size='sm' />)
    expect(texts(r)).toEqual([`${ANON_PREFIX}竹影`, SELF_TAG])
    expect(hosts(r, n => n.props.ariaLabel === `${ANON_PREFIX}竹影（我）`)).toHaveLength(1)
  })

  it('已注销用户：默认头像，不显示档案与标识', () => {
    const r = render(<AuthorBadge author={{ ...LIN, deleted: true }} />)
    expect(texts(r)).toEqual([DELETED_NAME])
    expect(images(r)).toEqual([AVATAR_DEFAULT])
  })

  it('authorName：空昵称回落「练习者」', () => {
    expect(authorName({ name: '  ' })).toBe('练习者')
    expect(authorName({ name: '竹影' }, true)).toBe('匿名·竹影')
    expect(authorName({ name: 'x', deleted: true }, true)).toBe(DELETED_NAME)
  })
})

describe('Avatar', () => {
  it('preset:<id> → 预置头像；未知 / 空 → 默认；anon → 匿名头像', () => {
    expect(avatarSrc('preset:moon')).toBe(AVATARS.moon)
    expect(avatarSrc('preset:nope')).toBe(AVATAR_DEFAULT)
    expect(avatarSrc('cloud://x/y.png')).toBe(AVATAR_DEFAULT)
    expect(avatarSrc(null)).toBe(AVATAR_DEFAULT)
    expect(avatarSrc('preset:moon', true)).toBe(AVATAR_ANON)
    expect(presetId('preset:toString')).toBeNull()
    const r = render(<Avatar avatar='preset:sun' size='xl' />)
    expect(images(r)).toEqual([AVATARS.sun])
  })
})
