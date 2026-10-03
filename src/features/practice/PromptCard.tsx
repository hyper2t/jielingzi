/**
 * 练习 Tab 的「每日一题」卡片（FE-M6-01，PRD W3）。
 * - 状态机在 features/practice/prompt.ts：无题目（含门禁未过）→ 整块不渲染；未作答 → 去作答；已作答 / 审核中 → 看其他人的回答
 * - 数据只走 `services/practice.ts`，门禁不满足时那里直接返回空结果，卡片不额外发请求
 * - 每次回到练习 Tab 刷新一次（作答后从回答页返回即可看到「已作答」）
 */
import { Text, View } from '@tarojs/components'
import { useDidShow } from '@tarojs/taro'
import { useRef } from 'react'
import { Button } from '@/components'
import { TODAY_PROMPT_KEY, todayPrompt } from '@/services/practice'
import { useRequest } from '@/hooks/useRequest'
import { useUserStore } from '@/store/user'
import { navigate } from '@/utils/router'
import { tw } from '@/utils/tw'
import type { PromptToday } from '@/types/models'
import { PROMPT_CARD_TITLE, UNANSWERED_HINT, answerCountText, promptCtaOf, promptStateOf, promptTagOf } from './prompt'

export default function PromptCard () {
  // 订阅门禁字段：同意 / 18+ 变化后 ready 重新求值，请求 key 随之从 null 变成有值
  const consent = useUserStore(s => s.consent)
  const adult = useUserStore(s => s.adult)
  const account = useUserStore(s => s.account)
  const ready = !!consent && (adult === 'confirmed' || account?.adult === true)
  const req = useRequest(ready ? TODAY_PROMPT_KEY : null, todayPrompt)
  const shown = useRef(false)
  useDidShow(() => {
    if (shown.current && ready) void req.refresh()
    shown.current = true
  })

  const prompt: PromptToday['prompt'] = req.data?.prompt || null
  if (!prompt) return null
  const tag = promptTagOf(promptStateOf({ prompt }))
  const cta = promptCtaOf(promptStateOf({ prompt }))

  return (
    <View {...tw('mx-4 mt-5 rounded-2xl border border-solid border-paper-dark bg-paper-light p-5')}>
      <View {...tw('flex flex-row items-center justify-between')}>
        <Text {...tw('font-body text-caption font-bold text-brand-dark')}>{PROMPT_CARD_TITLE}</Text>
        <Text {...tw('font-body text-caption text-ink-faint')}>{prompt.date}</Text>
      </View>
      <Text {...tw('mt-3 font-body text-body text-ink')}>{prompt.text}</Text>
      <View {...tw('flex flex-row items-center mt-2')}>
        {!!tag && <Text {...tw('font-body text-caption font-bold text-brand-dark')}>{tag}</Text>}
        {prompt.answered && prompt.answerCount > 0 && (
          <Text {...tw('ml-2 font-body text-caption text-ink-faint')}>{answerCountText(prompt.answerCount)}</Text>
        )}
        {!prompt.answered && (
          <Text {...tw('ml-2 font-body text-caption text-ink-faint')}>{UNANSWERED_HINT}</Text>
        )}
      </View>
      <Button block size='kid' label={cta} className='mt-4' onClick={() => navigate('prompt', { promptId: prompt.id, date: prompt.date })}>
        {cta}
      </Button>
    </View>
  )
}
