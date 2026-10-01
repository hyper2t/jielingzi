/**
 * 用户设置（users.settings 的本地镜像）。
 * 启动先用本地值；user.login / updateSettings 返回后由 applyRemote 覆盖。写云端由 services/me.ts 负责（未同意 / 未登录时只存本地）。
 * starter 阶段 UserSettings 为空对象；新增设置项时同步 types/models.ts 与 cloudfunctions/_shared/settings.js。
 */
import { create } from 'zustand'
import type { UserSettings } from '@/types/models'
import { getItem, setItem, STORAGE_KEYS } from '@/utils/storage'

export interface LocalSettings {
  settings: UserSettings
}

const DEFAULTS: LocalSettings = { settings: {} }

/** 从本地读设置（RN 端存储预热后由 store/hydrate.ts 再读一次） */
export function readLocalSettings (): LocalSettings {
  const v = getItem<UserSettings>(STORAGE_KEYS.settings, {})
  return { ...DEFAULTS, settings: v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
}

interface SettingsState extends LocalSettings {
  /** 本地修改（合并），立即持久化 */
  patch: (p: Partial<UserSettings>) => void
  /** 用云端值覆盖同名项（本地独有项保留） */
  applyRemote: (s: Partial<UserSettings> | undefined) => void
  /** 恢复默认（清除本机数据 / 注销后） */
  reset: () => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...readLocalSettings(),
  patch: (p) => {
    const settings = { ...get().settings, ...p }
    set({ settings })
    setItem(STORAGE_KEYS.settings, settings)
  },
  applyRemote: (s) => {
    if (!s || typeof s !== 'object') return
    get().patch(s)
  },
  reset: () => set({ ...DEFAULTS, settings: {} })
}))
