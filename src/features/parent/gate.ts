/**
 * 家长验证逻辑（FE-20，04-ui §3 ParentGate）：两位数加法（和 < 100），每次换题；答错不显示答案；
 * 连错 3 次冷却 30s。冷却状态放在模块内，关掉弹层重开也不会绕过。
 * 登录页（FE-L02）复用：通过后记一次时间，GATE_FRESH_MS 内再进登录页免重复验证（只在内存，重启即失效）。
 */
export const MAX_WRONG = 3
export const COOLDOWN_MS = 30 * 1000
/** 通过验证后多久内免重复验证（登录页 / 绑定页） */
export const GATE_FRESH_MS = 5 * 60 * 1000

export interface Question { a: number, b: number, answer: number }

export function newQuestion (rand: () => number = Math.random, prev?: Question): Question {
  for (let i = 0; i < 20; i++) {
    const a = 10 + Math.floor(rand() * 40) // 10–49
    const b = 10 + Math.floor(rand() * 40)
    if (!prev || prev.a !== a || prev.b !== b) return { a, b, answer: a + b }
  }
  const a = prev && prev.a < 49 ? prev.a + 1 : 10
  const b = prev ? prev.b : 10
  return { a, b, answer: a + b }
}

const state = { wrong: 0, cooldownUntil: 0, passedAt: 0 }

export type CheckResult = 'ok' | 'wrong' | 'cooldown'

export function cooldownLeft (now = Date.now()): number {
  return Math.max(0, state.cooldownUntil - now)
}

export function checkAnswer (q: Question, input: number, now = Date.now()): CheckResult {
  if (cooldownLeft(now) > 0) return 'cooldown'
  if (input === q.answer) {
    state.wrong = 0
    return 'ok'
  }
  state.wrong += 1
  if (state.wrong >= MAX_WRONG) {
    state.wrong = 0
    state.cooldownUntil = now + COOLDOWN_MS
    return 'cooldown'
  }
  return 'wrong'
}

/** ParentGate onPass 时调用（登录页自己调；家长中心入口也可调，进登录页就不用再答一次） */
export function markGatePassed (now = Date.now()): void {
  state.passedAt = now
}

/** GATE_FRESH_MS 内通过过验证 */
export function gateFresh (now = Date.now(), ttl = GATE_FRESH_MS): boolean {
  return state.passedAt > 0 && now - state.passedAt < ttl
}

export function __resetGateForTest (): void {
  state.wrong = 0
  state.cooldownUntil = 0
  state.passedAt = 0
}
