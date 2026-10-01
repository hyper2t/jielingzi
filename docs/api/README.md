# 接口约定（通用）

适用于所有云函数：`user`，以及之后新增的业务云函数（TODO(business)：每个业务函数一份 `<name>.md`）。

## 调用方式

| 端 | 方式 |
|---|---|
| 小程序 | `wx.cloud.callFunction({ name, data: { action, ...params } })`，身份由平台注入（OPENID） |
| H5 | `@cloudbase/js-sdk` 匿名登录后 `app.callFunction({ name, data: { action, ...params } })`，身份为匿名 uid |
| App（RN） | CloudBase HTTP API：`POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{name}`，JSON body 同上。免身份调用（`user.whoami` / `user.wechatAppLogin` / `user.appleLogin`，以及业务的公开读函数，见 `src/services/cloud.rn.ts` 的 `PUBLIC_FUNCTIONS`）用 Publishable Key 作 Bearer；需要身份的调用（其余 `user.*` 与业务私有函数）在登录后用会话 access_token 作 Bearer。登录方式：**微信**（`user.wechatAppLogin` → `POST /auth/v1/signin/with/provider` 自定义登录票据）、**通过 Apple 登录**（`user.appleLogin`，同样换自定义登录票据）与**手机号验证码**（CloudBase 内置 `POST /auth/v1/verification` → `/auth/v1/signin` 或 `/auth/v1/signup`）。身份经账号层换成 accountId：App 微信登录与小程序通过 unionid 归到同一账号，数据互通（见 [user.md](./user.md)「身份与账号」）。匿名登录仅 H5 使用。 |

入参统一为扁平对象：`{ action: string, ...params }`。**未声明的参数一律返回 40001**；客户端传入的 `openid`、`userInfo` 等身份字段不会被采用。

## 返回结构

```json
{ "code": 0, "data": {}, "msg": "ok" }
```

失败时 `data` 为 `null`，`msg` 为可展示的简短说明（不含个人信息）。

HTTP API 调用时函数返回值即响应 body（HTTP 200）；网关层错误为非 2xx，body 形如 `{ "code": "EXCEED_AUTHORITY", "message": "...", "requestId": "..." }`（字符串 code），常见：`MISSING_CREDENTIALS`（缺 Bearer）、`EXCEED_AUTHORITY` / `PERMISSION_DENIED`（云函数安全规则拒绝：公开函数需设为 `invoke: true`，`user` 与业务私有函数需 `"auth != null"` 以放行匿名用户）。

## 错误码

| code | 含义 | 典型场景 |
|---|---|---|
| 0 | 成功 | |
| 40001 | 参数错误 | 缺必填、类型/取值不对、多余参数、未知 action |
| 40101 | 未登录 | 拿不到调用方身份 |
| 40301 | 无权限 | 越权访问；非 mod/admin 调用管理动作 |
| 40302 | 需绑定手机号 | 发布类动作，后台实名（`_shared/guard.js`） |
| 40303 | 需确认 18+ | 未确认年满 18 周岁 |
| 40304 | 已封禁 | `users.bannedUntil` 未到期 |
| 40305 | 禁言中 | `users.mutedUntil` 未到期 |
| 40401 | 不存在 | 记录不存在 |
| 40901 | 冲突 | 手机号已绑定其他人的账号（`user.bindPhoneWeapp` / `linkPhoneSession`） |
| 42901 | 请求过频 / 超出当日额度 | 额度见 `_shared/config.js` DAILY_LIMITS（北京时间切日） |
| 50000 | 服务异常 | 未预期错误（服务端记录日志） |
| 50201 | 上游不可用 | 微信接口失败 / 未返回 unionid、微信登录 / 自定义登录 / 小程序凭证 / 手机号哈希密钥未配置、身份认证 API 不可达 |

## 分页

`page` 从 1 开始（≤10000），`size` 默认 20、最大 50。返回 `{ list, total }`。

## 时间与单位

时间戳为毫秒。

## 实现位置

- 公共库：`cloudfunctions/_shared/`（统一返回、错误码、参数校验、身份解析、账号层 `account.js`）。
- 各函数目录下的 `_shared/` 是副本，由 `node scripts/sync-shared.mjs` 生成，不要直接修改。
- 本地测试：`yarn test:functions`。

## 云函数一览

| 函数 | 契约 | 状态 |
|---|---|---|
| user | [user.md](./user.md) | 已有 |
| community | [community.md](./community.md)、[profile.md](./profile.md) | M1：练习档案 |
| moderation | [moderation.md](./moderation.md) | M0 骨架（ping） |
| practice | [practice.md](./practice.md) | M0 骨架（ping） |

**写入链路**：所有发布 / 社区写动作先过 `guardWrite`（登录 → 未封禁 → 18+ → 实名 → 未禁言 → 当日额度），成功落库后才计入额度。
