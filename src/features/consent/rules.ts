/**
 * 社区公约阅读（FE-M2-03）：首次发布前强制阅读一次；公约更新（CONSENT_VERSION 变化）后需重新阅读。
 * 只记本机（「清除本机数据」后会再读一次）；入口：features/auth/gates.ts requirePhone 的最后一道门，
 * 阅读页复用协议页（agreement?type=rules&mode=gate，底部「我已阅读并遵守」）。
 */
import { CONSENT_VERSION } from '@/constants/community'
import { getItem, setItem, STORAGE_KEYS } from '@/utils/storage'

export function isRulesRead (): boolean {
  return getItem<string>(STORAGE_KEYS.rulesRead) === CONSENT_VERSION
}

export function markRulesRead (): void {
  setItem(STORAGE_KEYS.rulesRead, CONSENT_VERSION)
}
