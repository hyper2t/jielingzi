/** BE-M2-02 / FE-M1-03：上传头像（选图 → 存储 → setAvatar 机审）、审核中状态、云文件头像显示、审核页图片复核 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import type { Profile } from '@/types/models'
import ProfileEdit, { AVATAR_PENDING_HINT, AVATAR_SUBMITTED, AVATAR_UPLOAD } from '@/pkg-user/pages/profile-edit/index'
import AdminQueue, { MEDIA_TITLE } from '@/pkg-admin/pages/queue/index'
import { cloudFileSrc } from '@/components/Avatar'
import { mockCloud, mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const click = (r: ReactTestRenderer, label: string) => act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })
const STATUS = { phoneVerified: true, adult: true, bannedUntil: null, mutedUntil: null }
const LIN: Profile = { nickname: '林然', avatar: 'preset:leaf', practices: [], years: null, goal: '', bio: '', anonAlias: '竹影', badges: [], updatedAt: 1 }

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: { ...STATUS, role: 'user' } })
  mockControl.setAccount({ adult: true })
  jest.clearAllMocks()
})

describe('上传头像', () => {
  it('选图 → 传到 uploads/avatar/<年月>/ → setAvatar；提示已提交审核，显示审核中；审核通过后生效', async () => {
    mockControl.setProfile(LIN)
    const r = render(<ProfileEdit />)
    await flush()
    click(r, AVATAR_UPLOAD)
    await flush()
    expect(Taro.chooseImage).toHaveBeenCalledWith(expect.objectContaining({ count: 1, sizeType: ['compressed'] }))
    const up = mockControl.calls.find(c => c.name === 'storage')?.data as { cloudPath: string }
    expect(up.cloudPath).toMatch(/^uploads\/avatar\/\d{6}\/[a-z0-9]+\.jpg$/)
    const set = mockControl.calls.find(c => c.action === 'setAvatar')?.data as { fileID: string }
    expect(set.fileID).toBe(`cloud://mock-env.mock-bucket/${up.cloudPath}`)
    expect(Taro.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: AVATAR_SUBMITTED }))
    expect(texts(r)).toContain(AVATAR_PENDING_HINT)
    // 小程序端 Image 直接用 cloud:// fileID
    expect(hosts(r, n => n.type === 'Image').some(n => n.props.src === set.fileID)).toBe(true)
    mockControl.settleAvatar('pass')
    expect(mockControl.profile).toMatchObject({ avatar: set.fileID, avatarPending: null })
  })

  it('取消选图什么都不做；超过 2MB 提示且不上传', async () => {
    const r = render(<ProfileEdit />)
    await flush()
    ;(Taro.chooseImage as jest.Mock).mockRejectedValueOnce({ errMsg: 'chooseImage:fail cancel' })
    click(r, AVATAR_UPLOAD)
    await flush()
    expect(mockControl.calls.filter(c => c.name === 'storage' || c.action === 'setAvatar')).toHaveLength(0)
    ;(Taro.chooseImage as jest.Mock).mockResolvedValueOnce({ tempFilePaths: ['wxfile://big.jpg'], tempFiles: [{ path: 'wxfile://big.jpg', size: 3 * 1024 * 1024 }] })
    click(r, AVATAR_UPLOAD)
    await flush()
    expect(texts(r)).toContain('图片不能超过 2MB')
    expect(mockControl.calls.filter(c => c.name === 'storage')).toHaveLength(0)
  })

  it('云文件头像：小程序原样，其他端换成存储公网地址；不是云文件返回 null', () => {
    const id = 'cloud://env-1.6a69-env-1-1301/uploads/avatar/202610/a.jpg'
    expect(cloudFileSrc(id, 'weapp')).toBe(id)
    expect(cloudFileSrc(id, 'h5')).toBe('https://6a69-env-1-1301.tcb.qcloud.la/uploads/avatar/202610/a.jpg')
    expect(cloudFileSrc(id, 'rn')).toBe('https://6a69-env-1-1301.tcb.qcloud.la/uploads/avatar/202610/a.jpg')
    expect(cloudFileSrc('preset:leaf', 'h5')).toBeNull()
  })
})

describe('审核页：图片复核（仅 mod / admin）', () => {
  it('显示待审图片并可通过 / 驳回', async () => {
    const fileID = 'cloud://mock-env.mock-bucket/uploads/avatar/202610/x.jpg'
    await mockCloud.fn.call('community', 'setAvatar', { fileID })
    await mockCloud.fn.call('community', 'setAvatar', { fileID: fileID.replace('x.jpg', 'y.jpg') })
    useUserStore.setState({ account: { ...STATUS, role: 'mod' } })
    mockControl.setAccount({ role: 'mod' })
    const r = render(<AdminQueue />)
    await flush()
    expect(texts(r)).toContain(`${MEDIA_TITLE}（2）`)
    click(r, '通过图片 m1')
    await flush()
    expect(mockControl.calls.find(c => c.action === 'decideMedia')?.data).toEqual({ mediaId: 'm1', decision: 'pass' })
    click(r, '驳回图片 m2')
    await flush()
    expect(mockControl.media.map(m => m.status)).toEqual(['pass', 'reject'])
    expect(texts(r).some(t => t.startsWith(MEDIA_TITLE))).toBe(false)
  })
})
