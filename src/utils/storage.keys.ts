/**
 * 本地存储 key 清单：所有端共用，便于「清除本机数据 / 注销」一次清空。
 * 平台实现见 storage.ts（小程序 / H5：Taro 同步存储）与 storage.rn.ts（RN：AsyncStorage + 内存镜像）。
 * 新增业务 key 时加在这里（不要在业务代码里手写字符串）。
 */
export const STORAGE_KEYS = {
  consent: 'consent',
  /** 用户设置的本地缓存（users.settings 镜像，见 store/settings.ts） */
  settings: 'settings',
  /** 请求缓存前缀：rq:{key}（useRequest persist） */
  requestPrefix: 'rq:',
  trackQueue: 'track_queue',
  /**
   * App 端登录会话：{ accessToken, refreshToken, expiresAt, uid, method, accountId? }。
   * 用户在登录页登录后才会产生；退出登录 / 注销时删除；「清除本机数据」保留它（账号还在，只删数据）。
   */
  authSession: 'auth_session',
  /** App 端登录后的账号摘要（不含令牌）：{ phoneMasked?, identities? }，供「我的」/ 账号与安全显示 */
  authProfile: 'auth_profile',
  /** App 端同意协议的本机时间（毫秒）：App 没有匿名会话，同意只记本机，登录时随 user.login 上报 */
  consentAt: 'consent_at',
  /** App 端身份认证接口要求的随机设备号（本地生成的 UUID，非任何硬件标识）；首次发起登录请求时才生成 */
  deviceId: 'device_id',
  /** 18+ 确认状态（AdultState：confirmed / declined）；「清除本机数据」会清掉，重新走首次进入流程 */
  adult: 'adult',
  /** App 端 18+ 确认的本机时间（毫秒）：登录前确认只记本机，登录时随 user.login 上报 */
  adultAt: 'adult_at',
  /** 云端账号状态镜像（AccountStatus：实名 / 18+ / 角色 / 处罚），启动时先用它渲染，login 后刷新 */
  accountStatus: 'account_status',
  /** 已阅读的社区公约版本（= CONSENT_VERSION 时视为已读；首次发布前强制阅读一次，FE-M2-03） */
  rulesRead: 'rules_read',
  /** 发起话题的本地草稿（TopicForm + savedAt）；发布成功 / 手动清除后删除，「清除本机数据」一并清空 */
  topicDraft: 'topic_draft',
  /** 本机冥想计时状态（开始 / 结束均由时间戳推算） */
  practiceTimer: 'practice_timer',
  /** 尚未同步的个人打卡；登录后由 services/me 的登录收尾钩子补传 */
  practiceCheckinQueue: 'practice_checkin_queue'
} as const
