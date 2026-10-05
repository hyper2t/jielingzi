/**
 * 「登录 / 同意之后」的业务同步钩子（luming 中是「本机播放进度补传云端」）。
 * 业务模块在初始化时 registerAfterSignIn(fn) 注册自己的补传逻辑；completeSignIn 与 agree 会依次调用。
 * 单个钩子失败只记日志，不影响登录结果与其他钩子。
 */
type Hook = () => Promise<void> | void

const hooks: Hook[] = []

export function registerAfterSignIn (fn: Hook): () => void {
  hooks.push(fn)
  return () => {
    const i = hooks.indexOf(fn)
    if (i >= 0) hooks.splice(i, 1)
  }
}

export async function runAfterSignIn (): Promise<void> {
  for (const fn of hooks.slice()) {
    try {
      await fn()
    } catch (e) {
      console.warn('[auth] 登录后同步钩子失败', e)
    }
  }
}

/** 测试用 */
export function __resetAfterSignInForTest (): void {
  hooks.splice(0, hooks.length)
}
