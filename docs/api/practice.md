# practice 云函数（打卡 / 每日一题）

> 通用约定见 [README.md](./README.md)。所有动作需登录（安全规则 `auth != null`），写动作经 `guardWrite`。

## ping

健康检查，免身份，不读写数据库。

- 入参：无
- 返回：`{ fn: 'practice', at: <毫秒时间戳> }`

## 待实现（按 docs/prd/mvp-plan.md）

```
M5：checkin、listCheckins
M6：todayPrompt、answerPrompt、listAnswers
```

每个动作落地时在本文补齐：入参（validate 规则）、返回、错误码、额度、匿名脱敏说明。
