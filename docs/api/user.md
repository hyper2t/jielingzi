# 云函数 `user`

实现：`cloudfunctions/user/`。通用约定见 [README](./README.md)。
`users` 集合只由本函数写入，客户端不直接写（安全规则 `write: false`）。

## 身份与账号（BE-L01）

所有需要身份的动作先经账号层（`cloudfunctions/_shared/account.js`）把平台原始身份换成 **accountId**，业务集合的 `_openid` 字段存的就是 accountId（字段名不改）：

| 调用方 | 原始身份 | accountId |
|---|---|---|
| 小程序 | 平台注入的 OPENID（绑定开放平台后另带 UNIONID） | 小程序 openid（现网老用户零迁移：下次调用时自动补 `mp:` 别名） |
| App 微信登录 | 自定义登录会话。身份认证 v2 实测：会话的 uid **就是**签票时的 `customUserId`（= accountId），函数里 `getUserInfo().customUserId` 为空、`LOGINTYPE=CUSTOM`；账号层用 `acc:<uid>` 链接识别，`linkToken` 只是兜底 | 微信 unionid（小程序已有同一 unionid 的账号则直接复用小程序账号） |
| App 手机号登录 / H5 匿名 | CloudBase uid | CloudBase uid |
| Publishable Key（未登录） | uid 为 `anon` | 无身份：只能调 `whoami` / `wechatAppLogin` / `appleLogin`，其余 40101 |

别名表 `account_links`（`_id` = `<kind>:<value>` → `accountId`；客户端不可读写；新环境先 `node scripts/ops/ensure-collections.mjs` 建集合——云端集合不会因写入自动创建，函数内也有首次写入自愈）：`acc:`（自定义登录 customUserId）、`mp:`、`unionid:`、`wxapp:`、`cbuid:`（`via` = phone / custom / anonymous）、`apple:`、`phone:`（已验证手机号的 HMAC 哈希，M1）、`pending:`（一次性关联令牌，5 分钟）。同一人出现两个账号时合并到主账号（业务集合按 `cloudfunctions/_shared/owned.js` 登记的规则改归属 / 去重、设置补齐、别名重定向、`account_merges` 审计），日志只记条数。

合并时 `users` 字段（BE-M1-05）：`phoneVerified` / `phoneHash` / `phoneVerifiedAt` / `adultConfirmedAt` / `consentVersion` / `inviteQuota` 主账号没有时从被并入方补齐；`bannedUntil` / `mutedUntil` 取较晚者（不能借合并规避处罚）；`role` 取较高者。

## 账号状态（M1，BE-M1-03）

`login` / `whoami` / `confirmAdult` / `bindPhoneWeapp` 的出参都带下面 5 个字段（不含任何标识与手机号），前端据此决定 18+ / 实名拦截与处罚提示：

| 字段 | 类型 | 说明 |
|---|---|---|
| phoneVerified | boolean | 已实名（绑定过手机号）。App 手机号登录 / 绑定、小程序 `bindPhoneWeapp` 后为 true |
| adult | boolean | 已确认年满 18 周岁（`users.adultConfirmedAt` 存在） |
| role | `'user'` \| `'mod'` \| `'admin'` | 仅 `scripts/ops/set-role.mjs`（M2）可改；非法值按 user |
| bannedUntil | number \| null | 封禁截止；未封禁或已过期为 null |
| mutedUntil | number \| null | 禁言截止；未禁言或已过期为 null |

**手机号只存哈希**：`users.phoneHash` 与 `phone:<hash>` 别名 = `'h1:' + HMAC-SHA256(PHONE_HASH_SECRET, '+86…')` 前 32 位十六进制（`_shared/phone.js`），号码明文不落库、不进日志；密钥一旦启用不可更换。

## login

首次调用时创建 users 记录（`settings` 取 `_shared/settings.js` 的 `DEFAULT_SETTINGS`，starter 为 `{}`），之后刷新 `lastActiveAt` / `lastLoginAt` / `lastLoginPlatform`。并发首次调用只会创建一条（依赖 `users._openid` 唯一索引）。
同时下发云端已保存的 `settings` 与 `guardianConsentAt`：换手机 / 重装 / 清缓存后本地只剩默认值，前端在同意后的 login 和已同意用户启动时据此恢复（`useSettingsStore.applyRemote`，云端值覆盖本地同名键）。

| 参数 | 取值 | 说明 |
|---|---|---|
| platform | `'weapp'` \| `'app'`（可选） | 不传按身份来源推断 |
| consentAt | 正整数（可选） | App 端把本机记录的同意时间上报；云端还没有同意时间时写入**服务端时间**，已有则忽略 |
| consentVersion | ≤32 字符（可选） | 与 consentAt 一起上报的协议版本 |
| linkToken | 16–128 字符（可选） | `wechatAppLogin` 返回的一次性令牌：把当前 CloudBase uid 关联到微信账号（见下） |
| adultConfirmedAt | 正整数（可选） | App 端把本机记录的 18+ 确认时间上报（首次进入流程在登录前完成）；云端还没有确认时间时写入**服务端时间**，已有则忽略（M1） |

- 出参：`{ openid, accountId, isNew, identities: { mp, wechat, phone, apple }, settings: Record<string, unknown>, guardianConsentAt: number | null, merged: boolean, ...账号状态 }`
- 账号带手机号登录方式（`cbuid` via=phone 或 `phone:` 别名）时标记 `phoneVerified`——**App 手机号登录即视为实名**（BE-M1-02）
  - `openid` 与 `accountId` 相同（兼容旧前端）；`identities` 为该账号已关联的登录方式；`merged` 表示本次登录触发了账号合并（前端应失效全部请求缓存）
- 小程序绑定开放平台后带 unionid：自动建立 `unionid:` 别名；该 unionid 已属于 App 账号时把 App 账号并入小程序账号
- 错误：40101（拿不到身份；`linkToken` 无效 / 过期且该 uid 没有账号）、40001

```json
// → { "action": "login", "platform": "app", "consentAt": 1790000000000, "adultConfirmedAt": 1790000001000 }
// ← { "code": 0, "data": { "openid": "oXXXX", "accountId": "oXXXX", "isNew": false, "identities": { "mp": true, "wechat": true, "phone": false, "apple": false }, "settings": {}, "guardianConsentAt": 1790000000000, "merged": false, "phoneVerified": false, "adult": true, "role": "user", "bannedUntil": null, "mutedUntil": null }, "msg": "ok" }
```

## confirmAdult（M1，BE-M1-03）

18+ 确认（PRD A3 / C5，首次进入第 2 步）。首次确认写 `adultConfirmedAt`（**服务端时间**，重复确认不改），并把 `consentVersion` 记为当时同意的协议版本。小程序 / H5 在 18+ 确认页直接调用；App 端登录前只记本机，登录时随 `login.adultConfirmedAt` 上报（已登录时直接调用）。用户记录不存在时先创建。

| 参数 | 取值 | 说明 |
|---|---|---|
| consentVersion | 1–32 字符（可选） | 默认 `_shared/config.js` 的 `CONSENT_VERSION`（当前 `v0.1`） |

- 出参：`{ adultConfirmedAt: number, consentVersion: string, ...账号状态 }`
- 错误：40101、40001（夹带其他字段，如客户端传时间）
- 确认后 `guardWrite` 不再返回 40303（发布类仍需实名 40302）

## consent

用户点击“同意”时调用（小程序 / H5；App 端同意只记本机，随 login 的 consentAt 上报），服务端写入当前毫秒时间到 `guardianConsentAt`；重复调用覆盖为最新时间。用户记录不存在时先创建。

- 入参：无（客户端不能传时间）
- 出参：`{ guardianConsentAt: number }`
- 错误：40101、40001

## updateSettings

局部更新设置，至少传一项；只更新传入的字段。用户记录不存在时先创建。
设置项由 `cloudfunctions/_shared/settings.js` 的 `SETTINGS_SCHEMA` 唯一定义；**starter 阶段为空**，任何入参都返回 40001。

| 参数 | 取值 | 说明 |
|---|---|---|
| TODO(business) | | 新增设置项时同步修改 `SETTINGS_SCHEMA` / `DEFAULT_SETTINGS`、前端 `src/types/models.ts` 的 `UserSettings` 与本表 |

- 出参：`{ settings: Record<string, unknown> }`（合并后的完整设置）
- 错误：40001（空参数、非法取值、数字传成字符串、夹带其他字段）、40101

```json
// 示例（假设已登记 fontScale）
// → { "action": "updateSettings", "fontScale": "large" }
// ← { "code": 0, "data": { "settings": { "fontScale": "large" } }, "msg": "ok" }
```

## whoami

不要求身份。只返回调用方身份的**形态**（全部布尔值，不含任何标识），供联调 / 冒烟确认自定义登录的 `customUserId` 在函数里是否可见。

- 入参：无
- 出参：`{ source: 'weapp' | 'custom' | 'web' | null, loginType: string | null, account, openId, unionId, uid, customUserId, anonymous, publishableKey, ...账号状态 }`（`loginType` 为平台注入的登录方式枚举，如 `ANONYMOUS` / `CUSTOM` / `PHONE`；没有账号时账号状态为默认值）
- 免身份动作（`whoami`、`wechatAppLogin`、`appleLogin`）不会因副作用建号

## wechatAppLogin（App）

App 端微信登录的服务端一跳。**用 Publishable Key 调用（未登录）**：用微信 SDK 返回的授权码换 openid / unionid（只调 `sns/oauth2/access_token`，不取昵称头像），找到或创建账号，签发 CloudBase 自定义登录票据。客户端随后：

1. `POST /auth/v1/signin/with/provider { provider_id: 'custom', provider_token: ticket }` 换会话（Bearer 为 Publishable Key）；
2. 用新会话调 `user.login({ platform: 'app', linkToken, consentAt? })` 完成登录。实测会话 uid 就等于 `customUserId`，账号层可直接识别；`linkToken` 是兜底（5 分钟内有效、只能用一次），客户端仍应带上。

| 参数 | 取值 | 说明 |
|---|---|---|
| code | 8–512 字符 | `sendAuthRequest` 返回的 code |
| state | ≤128 字符（可选） | 原样透传的防重放串，服务端不校验 |

- 出参：`{ ticket: string, linkToken: string, isNew: boolean, accountId: string }`
- 错误：40001；50201（未配置 `WX_APP_ID` / `WX_APP_SECRET` / 自定义登录私钥、微信接口失败或返回 errcode、微信未返回 unionid——移动应用未绑定到开放平台）
- 账号归属：unionid 已存在 → 复用该账号（小程序老用户直接得到自己的数据）；否则新建账号，accountId = unionid

## bindWechat（App，需登录）

手机号账号绑定微信。该微信已有自己的账号（如小程序老用户）时，把那个账号**并入当前账号**。

- 入参：`{ code, state? }`（同上）
- 出参：`{ ok: true, merged: boolean }`
- 错误：40101、40001、50201

## appleLogin（iOS）

通过 Apple 登录（BE-L09，App Store 审核指南 4.8）的服务端一跳，流程与 `wechatAppLogin` 相同：**用 Publishable Key 调用**，校验 Apple 返回的 `identityToken`，找到或创建账号，签发自定义登录票据；客户端随后用票据换会话并调 `user.login({ platform: 'app', linkToken })`。

| 参数 | 取值 | 说明 |
|---|---|---|
| identityToken | 20–4096 字符 | `ASAuthorizationAppleIDCredential.identityToken`（JWT） |
| nonce | 8–256 字符 | 客户端发起请求时生成的**原始** nonce；Apple 在 token 里放的是它的 SHA-256，服务端比对防重放 |

- 校验：Apple JWKS（`https://appleid.apple.com/auth/keys`，缓存 1 小时，kid 未命中强制刷新）RS256 验签；`iss = https://appleid.apple.com`；`aud = APPLE_BUNDLE_ID`（默认 `cn.jielingzi.app`）；`exp` 允许 60 s 时钟偏差；`nonce = sha256(原始 nonce)`
- 只取 `sub`，**不保存邮箱 / 姓名**（L8 最小采集）
- 出参：`{ ticket: string, linkToken: string, isNew: boolean, accountId: string }`
- 错误：40001；40101（token 无效 / 过期 / nonce 不符）；50201（未配置自定义登录私钥、Apple 公钥拉取失败）
- 账号归属：别名 `apple:<sub>` 已存在 → 复用；否则新建，accountId = `ap_` + sha1(sub) 前 24 位（满足 customUserId 规则）

## bindApple（iOS，需登录）

已登录账号绑定 Apple ID；该 Apple ID 已有自己的账号时并入当前账号。

- 入参：`{ identityToken, nonce }`（同上）
- 出参：`{ ok: true, merged: boolean }`
- 错误：40101、40001、50201

## linkPhoneSession（App，需登录）

微信 / Apple 账号补绑手机号（BE-M1-02）。手机号验证码登录全程走 CloudBase 身份认证 HTTP API：客户端先用手机号完成 `signin` / `signup` 拿到**另一份会话**，把它的 `access_token` 传来；服务端向 `GET /auth/v1/user/me` 核验后把该 uid 关联到当前账号并**标记实名**。之后用手机号登录会直接进入同一账号。

**手机号登录后**客户端用**自己的**会话再调一次（`features/auth/session.ts` signInWithCode）：服务端只标记实名并登记号码别名。

`/auth/v1/user/me` 返回 `phone_number` 且配置了 `PHONE_HASH_SECRET` 时登记 `phone:<hash>` 别名（只存哈希）——之后在小程序绑定同一号码时识别为同一人。号码别名先于会话关联处理：号码属于**另一个人**的账号（两边有同种类但不同的个人身份：不同的小程序 openid / unionid / Apple ID，可能是号码二次放号）时返回 40901，什么都不写；属于同一人的另一个账号时并入当前账号。

| 参数 | 取值 | 说明 |
|---|---|---|
| otherAccessToken | 16–4096 字符 | 手机号会话的 access_token（另一份，或自己的） |

- 出参：`{ ok: true, merged: boolean }`（对方 uid / 号码已有账号时并入当前账号）
- 自己的会话但不是手机号会话（如微信自定义登录）：幂等返回 `{ ok: true, merged: false }`，什么都不写
- 错误：40101（当前未登录，或 `otherAccessToken` 无效 / 过期）、40001、40901（号码已绑定其他人的账号）、50201（身份认证 API 不可达）

## bindPhoneWeapp（小程序，M1，BE-M1-01）

小程序手机号快速验证（PRD A2 / C4「发布内容前必须绑定手机号」）。前端 `<Button open-type="getPhoneNumber">`（必须由用户点击）拿到一次性 `code`（5 分钟有效）→ 服务端用**小程序** access_token（`/cgi-bin/stable_token`，进程内缓存）调 `POST /wxa/business/getuserphonenumber { code, openid }`（带 openid 让微信校验 code 属于当前用户）→ 号码规范化为 `+86…` → 只存 HMAC 哈希（`users.phoneHash` + `phone:<hash>` 别名）→ 标记 `phoneVerified`。

| 参数 | 取值 | 说明 |
|---|---|---|
| code | 8–512 字符 | `getPhoneNumber` 回调 `e.detail.code` |

- 出参：`{ ok: true, merged: boolean, ...账号状态 }`
- 号码已属于另一个账号：
  - 同一个人的 App 手机号账号（对方没有与当前账号同种类但不同的微信 / 小程序 / Apple 身份）→ 用已有合并逻辑把对方**并入当前账号**（`merged: true`，`account_merges.reason = 'phone'`）；
  - 另一个微信用户的账号 → 40901「该手机号已绑定其他账号」，不合并、不写库
- 换绑新号码：更新 `phoneHash`，释放旧号码的别名（别人可以再绑）
- 错误：40001（code 缺失 / 格式错 / **code 失效或不属于当前用户**：微信 40029 等，提示「手机号验证已失效，请重新获取」）、40101、40301（不是小程序调用：App 用手机号登录 / `linkPhoneSession`）、40901、50201（未配置 `WX_MP_APP_ID` / `WX_MP_APP_SECRET` / `PHONE_HASH_SECRET`，或微信接口失败）
- 计费与隐私：微信对手机号验证组件按次计费（有免费额度，以微信公众平台最新说明为准）；《小程序用户隐私保护指引》须声明「手机号」

## deleteAccount（需登录）

注销：按 `_shared/collections.js` 的 owned 登记处理业务数据——档案 `profiles`、成员关系、邀请码、打卡、站内消息**删除**；话题 / 回复 / 举报 / 每日一题作答**保留但解除归属**（作者显示为「已注销用户」，用户协议已说明）——再删 `users` 记录与所有别名（微信 / 手机号 / 小程序 / Apple / `phone:` 关联一并解除）。再次用同一微信 / 手机号登录会是全新账号。客户端应在成功后清理本地登录态；CloudBase 侧的用户由客户端自行 `DELETE /auth/v1/user/me`（可选）。

| 参数 | 取值 |
|---|---|
| confirm | 必须为 `'DELETE'` |
| appleAuthorizationCode | 8–1024 字符（可选）：注销前重新走一次通过 Apple 登录拿到的 `authorizationCode`，用于撤销 Apple 授权（审核指南 5.1.1(v)） |

- 出参：`{ ok: true, removed: { <每个登记集合>: 条数, user, links }, appleRevoked?: boolean }`（如 `{ profiles: 1, topics: 0, …, user: 1, links: 3 }`）
  - 只有传了 `appleAuthorizationCode` 才有 `appleRevoked`：数据删除后 best-effort 调 Apple `/auth/token` → `/auth/revoke`；失败只记日志（`false`），不影响注销结果；未配置 `.p8` 密钥时为 `null`
- 错误：40101、40001

## 运行时配置

`cloudbaserc.json` → `functions[].envVariables`（值从 `.env` 用 `{{env.KEY}}` 注入，`tcb fn deploy user` 或 `tcb config update fn user` 生效）：

| 变量 | 来源 | 缺失时 |
|---|---|---|
| `WX_APP_ID` / `WX_APP_SECRET` | 开放平台「移动应用」 | `wechatAppLogin` / `bindWechat` 返回 50201 |
| `TCB_CUSTOM_LOGIN_JSON` | 控制台 → 身份认证 → 登录方式 → 自定义登录 下载的私钥 JSON（原文或 base64；也接受只含 PEM） | `wechatAppLogin` 返回 50201 |
| `TCB_CUSTOM_LOGIN_KEY_ID` | 上面只放 PEM 时必填：控制台显示的私钥 ID | 同上 |
| `APPLE_BUNDLE_ID` | 可选，默认 `cn.jielingzi.app` | — |
| `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Apple Developer → Keys 创建的「Sign in with Apple」密钥（`.p8` 原文、字面量 `\n` 或 base64） | 注销时不撤销 Apple 授权（`appleRevoked: null`）；登录不受影响 |
| `WX_MP_APP_ID` / `WX_MP_APP_SECRET` | **小程序**后台 → 开发管理 → 开发设置（与开放平台移动应用不是同一套；moderation 函数 M2 也用） | `bindPhoneWeapp` 返回 50201 |
| `PHONE_HASH_SECRET` | ≥ 16 位随机串（如 `openssl rand -hex 32`），**启用后不可更换** | `bindPhoneWeapp` 返回 50201；App 手机号登录照常标记实名，但不建 `phone:` 别名（不做小程序 / App 同号识别） |
