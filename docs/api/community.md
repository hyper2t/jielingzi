# community 云函数（练习档案 / 圈子 / 邀请 / 话题 / 回复）

> 通用约定见 [README.md](./README.md)。所有动作需登录（安全规则 `auth != null`），写动作经 `guardWrite`。

## ping

健康检查，免身份，不读写数据库。

- 入参：无
- 返回：`{ fn: 'community', at: <毫秒时间戳> }`

## getProfile / updateProfile（M1）

练习档案，契约见 [profile.md](./profile.md)。

## 待实现（按 docs/prd/mvp-plan.md）

```
M3：createTopic、listTopics、getTopic、createReply、listReplies、deleteMine
M4：listCircles、getCircle、createInvite、redeemInvite
```

每个动作落地时在本文补齐：入参（validate 规则）、返回、错误码、额度、匿名脱敏说明。
