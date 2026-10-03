/**
 * 本机打卡队列：离线、未登录或未同意时先保存在设备；登录收尾与练习页回到前台时补传。
 * sessionId 在本机队列、客户端重试与云端幂等记录之间保持不变。
 * 同一台设备可能轮换账号：每条记录都绑定写入它的账号（ownerId），补传与日历合并都只认当前账号，
 * 避免把上一位用户尚未同步的记录显示给、或写入到下一位账号（M5-D05 复盘）。
 */
import type { PracticeCheckinInput } from '@/types/models'
import { canSync, isAdultConfirmed, useUserStore } from '@/store/user'
import { checkin as sendCheckin } from '@/services/practice'
import { getClient } from '@/services/client'
import { flushStorage, getItem, setItem, STORAGE_KEYS } from '@/utils/storage'

export interface PendingCheckin extends PracticeCheckinInput {
  queuedAt: number
  /** App 已登录时绑定本机用户；未登录创建的记录在首次登录后补传。 */
  ownerId?: string
}

export interface CheckinSyncResult {
  synced: number
  pending: number
  error?: unknown
}

let syncPromise: Promise<CheckinSyncResult> | null = null

/** 最近一次解析到的账号标识：小程序 / H5 的登录态里没有 uid / accountId，靠它给记录补归属。 */
let resolvedOwnerId: string | undefined

function storeOwnerId (): string | undefined {
  const auth = useUserStore.getState().auth
  return auth.accountId || auth.uid || undefined
}

/** 当前账号：本机登录态优先，其次最近一次从云端解析到的身份。 */
export function currentOwnerId (): string | undefined {
  return storeOwnerId() || resolvedOwnerId
}

/** 小程序 / H5 没有登录页，身份要问云端；离线时退回已有缓存，不阻塞本机落队列。 */
async function resolveOwnerId (): Promise<string | undefined> {
  const fromStore = storeOwnerId()
  if (fromStore) {
    resolvedOwnerId = fromStore
    return fromStore
  }
  try {
    const identity = await getClient().identity()
    const next = identity.accountId || identity.uid || undefined
    if (next) resolvedOwnerId = next
  } catch { /* 离线：沿用已有缓存 */ }
  return resolvedOwnerId
}

/** 「清除本机数据」/ 退出登录时丢弃进程内身份缓存，避免下一个账号沿用上一位的归属。 */
export function resetPracticeOwnerCache (): void {
  resolvedOwnerId = undefined
}

function setQueue (queue: PendingCheckin[]) {
  setItem(STORAGE_KEYS.practiceCheckinQueue, queue)
}

export function readPendingCheckins (): PendingCheckin[] {
  const rows = getItem<PendingCheckin[]>(STORAGE_KEYS.practiceCheckinQueue, [])
  return Array.isArray(rows) ? rows.filter(row => row && typeof row.sessionId === 'string' && typeof row.date === 'string') : []
}

export function pendingCheckinsForMonth (month: string, ownerId = currentOwnerId ()): PendingCheckin[] {
  return readPendingCheckins().filter(row => {
    if (!row.date.startsWith(`${month}-`)) return false
    if (!row.ownerId) return true
    return row.ownerId === ownerId
  })
}

async function addPending (input: PracticeCheckinInput, ownerId?: string): Promise<void> {
  const queue = readPendingCheckins()
  const previous = queue.find(row => row.sessionId === input.sessionId)
  if (previous) {
    if (previous.date !== input.date || previous.practice !== input.practice || previous.minutes !== input.minutes) {
      throw new Error('同一 sessionId 不能用于不同练习记录')
    }
    // 身份当时还没解析出来的行：这次把归属补上，避免被下一个账号认领
    if (!previous.ownerId) {
      const owner = ownerId || await resolveOwnerId()
      if (owner) {
        previous.ownerId = owner
        setQueue(queue)
      }
    }
    return
  }
  const owner = ownerId || await resolveOwnerId()
  queue.push({ ...input, queuedAt: Date.now(), ownerId: owner })
  setQueue(queue)
}

function removePending (sessionId: string): void {
  setQueue(readPendingCheckins().filter(row => row.sessionId !== sessionId))
}

/** 单飞、顺序补传；任一网络 / 权限失败即保留剩余队列，避免静默丢记录。 */
export function syncPendingCheckins (): Promise<CheckinSyncResult> {
  if (syncPromise) return syncPromise
  syncPromise = (async () => {
    let synced = 0
    let error: unknown
    if (!canSync() || !isAdultConfirmed()) return { synced, pending: readPendingCheckins().length }
    try {
      const initialQueue = readPendingCheckins()
      if (!initialQueue.length) return { synced, pending: 0 }
      const identity = await getClient().identity()
      const ownerId = identity.accountId || identity.uid || undefined
      if (!ownerId) return { synced, pending: readPendingCheckins().length }
      resolvedOwnerId = ownerId
      for (const row of initialQueue) {
        if (row.ownerId && row.ownerId !== ownerId) continue
        // 无主的历史行先认领给当前账号再补传：失败留在队列时也不会被下一个账号同步走
        if (!row.ownerId) {
          setQueue(readPendingCheckins().map(item => item.sessionId === row.sessionId ? { ...item, ownerId } : item))
        }
        try {
          await sendCheckin({ sessionId: row.sessionId, date: row.date, practice: row.practice, minutes: row.minutes })
          removePending(row.sessionId)
          synced += 1
          await flushStorage()
        } catch (e) {
          error = e
          break
        }
      }
    } catch (e) {
      error = e
    }
    return { synced, pending: readPendingCheckins().length, ...(error ? { error } : {}) }
  })().finally(() => { syncPromise = null })
  return syncPromise
}

/** 先写透本机队列，再尝试同步；调用方无论在线与否都可将计时页标记为已打卡。 */
export async function submitCheckin (input: PracticeCheckinInput, ownerId?: string): Promise<CheckinSyncResult> {
  await addPending(input, ownerId)
  await flushStorage()
  return syncPendingCheckins()
}
