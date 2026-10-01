# M4 实施计划：官方圈子 + 邀请码

> 范围：PRD §5 G1 / G2 / G3（`docs/prd/README.md`）、§7.1 / §7.5 线框；任务编号沿用 `mvp-plan.md` M4，并补充拆分项。
> 状态：**计划（2026-10-01 完善，未开工）**。接口契约草案见 `docs/api/community.md`「圈子与邀请码（M4，草案）」。
> 约定：「默认」= 我按 PRD 与已有代码取的值，没有被推翻前照此实现；标 ❓ 的是需要产品确认的开放项（§2）。

## 1. 已有基础（盘点，M4 不重复做）

| 项 | 现状 | 位置 |
|---|---|---|
| 集合登记 | `circles`（无索引）、`memberships`（`uniq_circle_member`：`circleId` + `_openid`，合并按 `circleId` 去重保留主账号，注销删除）、`invites`（`uniq_code`，合并改归属，注销删除）均已登记并在云端存在 | `cloudfunctions/_shared/collections.js` |
| 话题索引 | `topics.idx_circle_status_time`（`circleId` + `status` + `createdAt` 倒序）已建好；`replies` 已冗余 `circleId` | 同上、`docs/ops/collections.md` |
| 话题钩子 | `createTopic` / `listTopics` 已声明 `circleId` 参数，**非空一律 40001「圈子话题暂未开放」**；`createReply` 已把话题的 `circleId` 复制到回复 | `cloudfunctions/community/topics.js` |
| 额度 | `DAILY_LIMITS.createInvite = 5` 已在 config；guard 支持 `limit` 覆盖与「成功后才计额度」 | `_shared/config.js`、`_shared/guard.js` |
| 邀请名额字段 | `users.inviteQuota` 只出现在**账号合并**的补齐字段里，**没有任何代码初始化它** → 需要明确的懒初始化（§4） | `_shared/account.js` |
| 前端占位 | `app.config.ts`（`TODO(M4)：circle-detail、join-circle、invites`）、`router.ts` 注释、`FilterChips`、`requirePhone`、`useRequest` / `usePaged`、`Toggle` / `TopicCard` | `src/` |
| 测试夹具 | `tests/cloudfunctions/fakeDb.js` 已支持等值 / `$in` / `$inc`，**不支持** `$gte` / `$lt` / `$exists` / `$ne`（邀请名额扣减与过期判断要用到，见 BE-M4-00） | `tests/cloudfunctions/` |
| 文案与公约 | 圈子名与简介在 `wording.md` §5（待确认）；全站公约 `community-rules.md` v0.1 | `docs/prd/` |

## 2. 决策

### 2.1 默认决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **圈子 3 个**：静观练习 / 传统养生 / 正念生活（简介与公约草稿见 `wording.md` §5）；名称不含任何宗教名称 | PRD G1、`wording.md` §1 |
| D2 | **邀请码绑定圈子**：一个码只能加入签发它的那个圈子；一个人可加入多个圈子（每个圈子各用一个码） | `invites.circleId`（PRD §8） |
| D3 | **只有圈子成员能签发该圈子的码**；初始名额 3（`users.inviteQuota`，懒初始化）；每码一次性、7 天有效 | PRD G3、mvp-plan BE-M4-02 |
| D4 | **过期未使用的码退回名额**（每个码只退一次）。名额只有 3 个，被丢弃的码不应白白烧掉 | 本计划新增，可裁剪（裁剪后过期码不退，运维脚本补发） |
| D5 | **加入要求与发帖相同**：登录、18+、已实名、未封禁（禁言不影响加入） | 后台实名是红线；加入后才会产生可见身份 |
| D6 | **圈内内容仅成员可见**：话题详情 / 回复 / 话题流 / 回复 / 举报都校验成员；非成员打开话题详情 → 40401（与「不存在」一致，防遍历 ID）；非成员按 `circleId` 查话题流 → 40301「加入圈子后才能查看」 | PRD G2、C5 |
| D7 | **圈子简介与公约对所有已确认 18+ 的用户可见**（含非成员）：未入圈空状态要展示圈子介绍 | PRD §7.1 空状态 |
| D8 | **首页话题流 = 我加入的所有圈子聚合**（按时间），顶部用 `FilterChips` 切换「全部 / 某圈子」；没有加入任何圈子 → 空列表（不是错误），前端展示引导 | PRD §7.1 |
| D9 | **发话题必须归属圈子**。为兼容未升级的 M3 客户端与现有测试：`circleId` 缺省时，若用户**恰好加入 1 个圈子**则默认归到该圈子；加入多个圈子必须显式传（40001「请选择圈子」） | 平滑升级 |
| D10 | **审核员没有读圈内内容的特权**：审核页只给内容摘要，已够处理举报；需要看上下文再单独加（会同时写审计日志） | 最小权限 |
| D11 | **M3 期间没有圈子的旧话题（`circleId = null`）对任何人不可见**；上线前先审计数量，> 0 则用一次性脚本归到指定圈子（§8） | PRD 红线：圈内才可见；线上目前应无真实内容 |
| D12 | **无「退出圈子」「移除成员」**（PRD 未要求）；注销账号时 `memberships` 随账号清理（已有登记），圈子计数由运维脚本 `recount` 校正 | 范围 |
| D13 | **名额增发先做运维脚本**：`invite-quota.mjs --report` 列出本月有效回复（≥ 30 字、状态 ok）数，`--add N` 手工补发；**不做自动规则**（PRD 只说「按活跃与贡献增发」，没有数字，等内测数据再定） | mvp-plan BE-M4-03 |
| D14 | **兑换尝试计入频控**：`redeemInvite` 每次调用（含失败）计 1 次，每天 10 次；邀请码空间 32⁸ ≈ 1.1×10¹²，另有频控，暴力猜码不可行 | 防猜码 |

### 2.2 开放项（❓ 需要产品确认；不阻塞开工，开工前给结论最省返工）

1. ❓ **圈子名称 / 简介 / 公约**：默认用 D1。名称写在种子脚本里，上线后改名只需重跑一次 `circles.mjs seed --apply`（按 `slug` 更新，不影响成员与话题）。
2. ❓ **第一批成员怎么进圈**：默认 **运维脚本签发「官方码」**（不占任何人的名额，`_openid = null`、`official = true`）+ 按手机号 / 账号直接加入（`circles.mjs grant`，与 `set-role.mjs` 同样的定位方式，默认预览、`--apply` 才写）。备选：管理员自动是所有圈子成员（省脚本，但管理员 3 个名额很快用完，且审核员与普通成员身份混在一起，不推荐）。
3. ❓ **旧话题处理**：默认 D11（先审计；有数据才迁移）。

## 3. 数据模型（相对 PRD §8 的差异）

字段归属沿用项目约定：账号标识是 `_openid`（承载 accountId），PRD 里的 `uid` 对应 `_openid`。所有集合保持「客户端私有、只经云函数读写」，**不改安全规则**。

**`circles`**（官方圈子，数量 ≤ 10，种子脚本写入）

| 字段 | 说明 |
|---|---|
| `slug` | 稳定标识（`mindful` / `tradition` / `lifestyle`），**新增**；种子脚本按它 upsert，改名不改 slug |
| `name`、`desc` | 名称 ≤ 12 字、简介 ≤ 60 字 |
| `cover` | M4 只放预置标识 `circle:<slug>` 或 `null`（前端映射图标；自定义封面图属「原生选图」任务） |
| `rules` | `string[]`（圈子公约，≤ 5 条，每条 ≤ 60 字），在全站公约基础上的补充 |
| `memberCount`、`topicCount` | **展示用近似值**（成员 +1 / 话题发布 +1；注销、下架、举报折叠不回写），`circles.mjs recount` 可从明细重算 |
| `sort`、`status` | 排序；`open` / `closed`（closed：不出现在列表、不能加入、不能发话题；已有内容不动） |

**`memberships`**：`circleId`、`_openid`、`joinedAt`、`invitedBy`（邀请人 accountId；官方码 / 运维直接加入为 `null`，**永不下发前端**）、`inviteCode`（用的哪个码，运维追溯）、`role = 'member'`（预留 `owner`）。唯一索引 `(circleId, _openid)` 已有。

**`invites`**：`code`（8 位，唯一）、`circleId`、`_openid`（签发人；官方码为 `null`）、`official`、`createdAt`、`expiresAt`、`usedBy`（兑换人 accountId，**永不下发**）、`usedAt`、`refunded`（过期退额度标记，初始 `false`，只用等值条件更新）。

**`users.inviteQuota`**：剩余名额。字段缺失 = 尚未初始化；首次 `listInvites` / `createInvite` 时用「字段不存在」条件写入 `INVITE_RULES.initialQuota`（并发安全、幂等，见 §6）。

**新增索引**（`collections.js` 声明，`ensure-indexes.mjs --apply` 创建，只新增）：

| 集合 | 索引 | 用途 |
|---|---|---|
| circles | `uniq_slug`：`slug`（唯一） | 种子 upsert |
| memberships | `idx_member`：`_openid` + `joinedAt` | 「我的圈子」（现有唯一索引 `circleId` 在前，不能用于按成员查） |
| invites | `idx_owner_time`：`_openid` + `createdAt`（倒序） | 「我的邀请码」、过期退额度扫描 |

## 4. 规则与配置（`_shared/config.js`，前端 `src/constants/community.ts` 同名常量，由测试比对）

```js
INVITE_RULES = {
  initialQuota: 3,          // 新用户初始名额
  ttlDays: 7,               // 邀请码有效期
  codeLength: 8,
  alphabet: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',   // Crockford base32：去掉 I L O U，避免口头 / 手输混淆
  listMax: 50               // 「我的邀请码」最多返回条数
}
CIRCLE_RULES = { nameMax: 12, descMax: 60, rulesMax: 5, ruleMax: 60 }
DAILY_LIMITS += { redeemInvite: 10 }     // createInvite: 5 已有；兑换每次尝试都计数（含失败）
```

**邀请码输入规范化**（前后端同一算法，共享 fixture `tests/fixtures/invite-code.json` 两端各读一份，和 M3 的 `topic-validation.json` 同样做法）：去首尾空白与中间空格 / `-` → 转大写 → `O→0`、`I/L→1` → 必须恰好 8 位且都在字母表内，否则 40001（「邀请码为 8 位」「邀请码含有不支持的字符」）。展示时每 4 位加一个空格（`ABCD 2345`）。

## 5. 接口（契约草案：`docs/api/community.md`）

| action | 说明 | 写 |
|---|---|---|
| `listCircles` | 全部 `open` 圈子 + 我是否已加入；不分页 | 否 |
| `getCircle` | 圈子详情（含公约）+ 是否已加入 | 否 |
| `listInvites` | 我的名额 + 我签发的码（active / used / expired），顺带触发「过期退额度」 | 是（可能退额度） |
| `createInvite` | 为我所在的圈子签发一个码，扣 1 个名额 | 是 |
| `redeemInvite` | 用码加入圈子 | 是 |
| `createTopic` / `listTopics` / `getTopic` / `createReply` / `listReplies` | 接入成员校验与 `circle` 字段（§6） | — |
| `moderation.report` | 举报圈内内容要求举报人是成员（否则 40401） | 是 |

错误码不新增：非成员读 / 写 → 40301（msg 可展示）；已在圈子 → 40901；码无效 / 已用 / 过期 → 40401（**同一条文案**，不泄露码是否存在）；名额用完 → 42901（msg「邀请名额已用完」，前端按 `quota = 0` 判断而不是按 code）。

## 6. 成员校验矩阵与一致性

### 6.1 各动作的校验

| 动作 | 校验 | 失败 |
|---|---|---|
| `listTopics`（不传 `circleId`） | 取我所有成员关系的 `circleId`，`topics.where({ circleId: in(ids), status: 'ok' })`；没有成员关系 → 空列表 | — |
| `listTopics`（传 `circleId`） | 必须是成员 | 40301 |
| `getTopic` / `listReplies` | 话题的 `circleId` 必须在我的圈子里（`null` = 旧话题，不可见） | 40401 |
| `createTopic` | `circleId` 必须是我加入的 `open` 圈子；缺省规则见 D9；机审 / 额度 / 实名链路不变 | 40301 / 40001 |
| `createReply` | 同 `getTopic`，且话题为 `ok` | 40401 |
| `deleteMine` | **不要求成员**（作者随时能删自己的内容，即使圈子已关闭） | 40401（非作者） |
| `moderation.report` | 目标内容所在圈子须有我 | 40401 |
| `moderation.queue / decide` | 不变（D10） | — |

话题的摘要（`TopicSummary`）与详情（`TopicDetail`）新增 `circle: { id, name }`；回复不需要这个字段。

### 6.2 并发与幂等（核心风险点，逐条写进单测）

1. **名额懒初始化**：`users.where({ _openid, inviteQuota: <字段不存在> }).update({ inviteQuota: 3 })`，已初始化则更新 0 行，直接跳过。
2. **扣名额**：`users.where({ _openid, inviteQuota: gte(1) }).update({ inviteQuota: inc(-1) })`，`updated === 1` 才继续；`0` → 42901。两个请求同时抢最后一个名额只有一个成功。
3. **签发后失败回滚**：扣了名额但写 `invites` 失败（含码撞唯一索引，重试至多 3 次换码）→ `inc(+1)` 退回；退回失败打日志（需人工对账，`invite-quota.mjs --report` 会显示异常）。
4. **兑换（一次性）**：①规范化 → ②找码，不存在 / 过期 / 已用 → 40401 → ③我已是该圈子成员 → 40901（**不消耗码**）→ ④条件更新 `invites.where({ code, usedBy: null, expiresAt: gt(now) }).update({ usedBy, usedAt })`，`updated === 0`（被别人抢先）→ 40401 → ⑤`memberships` 插入；撞唯一索引（并发重复兑换）→ 把码还原（`usedBy: null`）并返回 40901 → ⑥`circles.memberCount` `inc(1)`（失败只记日志，不回滚）。
5. **过期退额度**：`invites.where({ _openid, usedBy: null, refunded: false, expiresAt: lt(now) })` 逐条 `update({ refunded: true })` 且 `updated === 1` 才 `inc(+1)`；同一个码并发退两次只会成功一次。官方码（`_openid = null`）不参与。
6. **计数是展示值**：`memberCount` / `topicCount` 的偏差不影响任何权限判断（权限只看 `memberships`）。

## 7. 前端

### 7.1 页面与入口（`pkg-community`，补 `app.config.ts`、`router.ts`）

| 页面 | 内容 | 入口 |
|---|---|---|
| `circles` | 「我的圈子」+「其他官方圈子」；每项名称 / 简介 / 成员数 / 是否已加入；未加入的有 [输入邀请码] | 我的 → 我的圈子；首页空状态 |
| `circle` | 圈子详情：简介、公约（`rules`）、成员数 / 话题数；成员看圈内话题流（复用 `TopicCard` 与分页）；非成员看「加入圈子」提示，不请求话题流 | `circles`、话题卡片上的圈子名 |
| `join-circle` | 输入邀请码（自动规范化、每 4 位空格）→ 确认 → 兑换；支持 `?code=` 预填（分享卡片进入），**预填不自动兑换**，仍要点确认；成功后进入该圈子 | 首页空状态、`circles`、分享卡片 |
| `invites` | 剩余名额、有效期说明；[为「某圈子」生成邀请码]（只列我所在的圈子）；已生成的码（可用 / 已使用 / 已过期）；每个可用码 [分享] | 我的 → 邀请码（剩余 N） |

### 7.2 现有页面改动

- **首页**：话题流上方 `FilterChips`（全部 / 各圈子，只有 1 个圈子时不显示）；**未入圈空状态**：「结灵子是邀请制社区」+ [输入邀请码] + 圈子介绍列表（`listCircles`）；卡片显示圈子名（`TopicCard` 加 `circle` 一行元信息）。
- **发起话题**：圈子选择（只加入 1 个圈子时只读展示；多个时用 `Sheet` 选择；默认当前首页筛选的圈子）；草稿里存 `circleId`；未入圈用户点 ✎ → 引导进 `join-circle`。
- **我的**：新增「我的圈子」「邀请码（剩余 N）」两行（名额数异步取，取不到不显示数字）。
- **话题详情**：非成员 / 圈子关闭 → 沿用「话题不存在」文案（D6）；顶部元信息加圈子名，点击进 `circle`。

### 7.3 分享（FE-M4-01）

- 小程序：`Button openType='share'` + 页面 `onShareAppMessage`，`path = /pkg-community/pages/join-circle/index?code=<码>`；每个码一个分享按钮，点哪个分享哪个（`target.dataset.code`），标题「邀请你加入「<圈子名>」」，不写营销话术。
- App / H5：复制文案「「<圈子名>」邀请码 ABCD 2345，7 天内有效。在结灵子「我的 → 邀请码」里输入。」（`Taro.setClipboardData` + Toast），不做深链（`WX_APP_ID` / Universal Link 仍未配置）。

### 7.4 服务层与 mock

- `src/services/community.ts` 新增 `listCircles / getCircle / listInvites / createInvite / redeemInvite`；`createInvite`、`redeemInvite` 加进 `guard.ts` 的 `WRITE_ACTIONS`；读前判 `canReadCommunity()`（同 M3）；兑换 / 签发成功后失效 `circles:*`、`invites:mine`，并 `touchFeed()`（话题流要重新取）。
- 请求缓存 key：`circles:all`、`circle:<id>`、`invites:mine`；首页话题流 key 带圈子筛选。
- **mock 云端**：`mockControl` 加 `seedCircles / setMemberships / seedInvites / circles / invites`；`reset()` 默认放 **1 个圈子 + 默认账号已是成员**，这样现有 M3 页面测试基本不用改；测「未入圈」时 `setMemberships([])`。mock 的校验与云端同一份规则（邀请码规范化用共享 fixture 验证一致）。
- 类型：`Circle`、`CircleDetail`、`Invite`、`InviteList`；`TopicSummary` / `TopicDetail` 加 `circle: { id, name } | null`。

## 8. 运维脚本（`scripts/ops/`，默认预览，`--apply` 才写，风格同 `set-role.mjs` / `ensure-indexes.mjs`）

| 脚本 | 功能 |
|---|---|
| `circles.mjs seed [--apply]` | 按 `slug` upsert 3 个官方圈子（名称 / 简介 / 公约来自 `scripts/ops/circles.seed.json`，改名只改这个文件）；不动 `memberCount` / `topicCount` |
| `circles.mjs grant --circle <slug> (--account <id> \| --phone <号> \| --latest) [--apply]` | 直接让某人加入圈子（`invitedBy = null`，`memberCount` +1）；手机号定位同 `set-role.mjs`（HMAC 哈希，不打印号码） |
| `circles.mjs issue --circle <slug> --count N [--ttl-days 7] [--apply]` | 签发 N 个官方码（不占名额），打印码清单（**只在终端显示一次**） |
| `circles.mjs audit` | 只读：旧话题（`circleId = null`）数量、各圈子成员 / 话题数与计数偏差、`inviteQuota` 异常（负数 / 非整数） |
| `circles.mjs migrate-topics --to <slug> [--apply]` | 把 `circleId = null` 的话题与其回复归到指定圈子（D11；只有 `audit` 发现旧话题才需要） |
| `circles.mjs recount [--apply]` | 按明细重算 `memberCount` / `topicCount` |
| `invite-quota.mjs --report [--month YYYY-MM]` | 只读：每个账号本月有效回复数（≥ 30 字、状态 ok）、现有名额、已签发 / 已用 / 过期未退的码数 |
| `invite-quota.mjs (--account \| --phone) --add N [--apply]` | 手工补发名额；写入前打印旧值便于回滚 |

## 9. 任务拆解（1 周，BE / FE 可并行；先契约 → mock → 云函数，同前几个里程碑）

| 编号 | 负责 | 任务 | 验收 | 估时 |
|---|---|---|---|---|
| BE-M4-00 | BE | 前置：`config.js` 加 `INVITE_RULES` / `CIRCLE_RULES` / `DAILY_LIMITS.redeemInvite`；`collections.js` 加 3 个索引；`tests/cloudfunctions/fakeDb.js` 支持 `$gte / $gt / $lt / $exists / $ne`；`userHarness` 加 `seedCircle / seedMember / seedInvite` | 现有 165 例不回归；fakeDb 自测 | 0.5d |
| BE-M4-01 | BE | `circles.js`：`listCircles / getCircle`（含 `joined`、公约）；成员关系读取封装 `myCircleIds(ctx)` | 单测：closed 不出现、非成员也能看简介、`joined` 正确 | 0.5d |
| BE-M4-02 | BE | `invites.js`：`createInvite`（成员校验、懒初始化、原子扣减、换码重试、回滚）、`listInvites`（状态计算、过期退额度）、`redeemInvite`（§6.2 第 4 条）；`guard` 链、频控 | 单测：过期 / 已用 / 名额不足 / 并发抢最后名额 / 并发重复兑换 / 已是成员不消耗码 / 退额度只退一次 / 频控含失败尝试 / 返回体无 `usedBy`、`invitedBy`、`_openid` | 1d |
| BE-M4-03 | BE | `topics.js` 接入成员校验与 `circle` 字段（§6.1）；`moderation.report` 成员校验；`circles.topicCount` 维护；`deleteMine` 不要求成员 | 单测：非成员读话题流 / 详情 / 回复被拒；缺省圈子规则；旧话题不可见；M3 用例仅补成员种子后全绿 | 1d |
| OPS-M4-01 | OPS | `circles.mjs`（seed / grant / issue / audit / migrate-topics / recount）、`invite-quota.mjs`、`circles.seed.json`；`ensure-indexes` 建 3 个新索引 | 脚本单测（参数解析、预览不写、幂等）；云端 `audit` 输出符合预期 | 0.5d |
| FE-M4-00 | FE | 类型、`constants/community.ts`（`INVITE_RULES` 等，与 config 比对）、`features/circle/rules.ts`（邀请码规范化）、`services/community.ts` 新方法、`guard.ts`、mock 云端、`app.config.ts` / `router.ts` | `tsc` 无错；规则单测读共享 fixture | 0.5d |
| FE-M4-01 | FE | 页面 `circles / circle / join-circle / invites`；「我的」两行入口；分享 / 复制 | 页面测试（§10）；快照 1 个 | 1.5d |
| FE-M4-02 | FE | 首页 `FilterChips` 与未入圈空状态；发起话题圈子选择与草稿；`TopicCard` 圈子名；话题详情圈子名与非成员文案 | 页面测试；「首页话题流」快照更新 | 1d |
| QA-M4-01 | QA | `docs/test/cases/M4.md`；邀请全链路、越权读取、名额边界、注销后成员关系清理的自动化与真机清单 | 自动化全绿；真机清单入库 | 0.5d |
| DOC-M4 | PM / BE | 契约定稿（`docs/api/community.md`）、`docs/ops/collections.md` 索引表、`wording.md` §5 定稿、`mvp-plan.md` 进度、`docs/ops/release-checklist.md` | 文档与实现一致 | 随各项 |

合计约 7 个工作日（含并行）。依赖：BE-M4-00 → 01 / 02 / 03；FE-M4-00 可与 BE 并行（先 mock）；OPS-M4-01 在 BE-M4-01 之后；FE-M4-01 / 02 在 FE-M4-00 之后。

## 10. 测试计划（QA-M4-01 详细，用例编号 M4-xx 写进 `docs/test/cases/M4.md`）

**云函数（`tests/cloudfunctions/m4.test.js` + `m4-parity.test.js`）**
- 圈子：`listCircles` 只含 open、按 `sort`；非成员可见简介与公约；`joined` 正确；`getCircle` 不存在 40401。
- 签发：非成员 40301；名额 3 → 第 4 次 42901；扣减原子（并发 2 个抢最后名额）；码字符集 / 长度；撞码重试；写库失败回滚名额；`createInvite` 日限 5；返回体无内部字段。
- 兑换：成功（成员关系 + `memberCount` + 码标记已用）；大小写 / 空格 / 连字符 / `O0`、`I1L` 容错；不存在 / 已用 / 已过期 → 同一条 40401 文案；已是成员 40901 且码不消耗；未实名 40302、未 18+ 40303、封禁 40304；日限 10 含失败；并发重复兑换同一个码 → 只有一个成功，另一个还原码。
- 退额度：过期未用的码在 `listInvites` / `createInvite` 时退回，只退一次，官方码不退；已用的码不退。
- 可见性：非成员读 `listTopics(circleId)` 40301；`getTopic` / `listReplies` / `createReply` 40401；缺省圈子规则（1 个 → 默认；多个 → 40001）；旧话题（`null`）不可见；`deleteMine` 不要求成员；`moderation.report` 非成员 40401；匿名脱敏不回归（M3 用例全跑）。
- 注销 / 合并：注销后 `memberships`、`invites` 被清理；合并按 `circleId` 去重（登记表已有，补断言）。
- 共享 fixture：`invite-code.json`（规范化 / 错误文案 ≥ 20 例）前后端一致。

**前端（`src/pkg-community/__tests__/m4.test.tsx` 等）**
- 首页：未入圈空状态（介绍 + 输入邀请码入口）；多圈子时筛选条切换并带 `circleId` 重新取数；只有 1 个圈子不显示筛选条；卡片显示圈子名。
- `join-circle`：输入规范化与每 4 位空格；`?code=` 预填但不自动兑换；各错误文案（无效 / 已是成员 / 日限 / 未实名先弹手机号验证）；成功后进入圈子并刷新首页。
- `invites`：名额与有效期展示；只能选自己所在的圈子；名额 0 时按钮禁用并提示；生成后列表出现；分享（小程序：`onShareAppMessage` 的 path 带 `code`；App：写剪贴板）。
- `circle` / `circles`：成员与非成员两种形态（非成员不请求话题流）；公约展示。
- 发起话题：单圈子只读、多圈子选择、草稿保存 / 恢复 `circleId`、未入圈引导。
- 服务层：未同意 / 未 18+ 不请求；`createInvite` / `redeemInvite` 写前拦截与缓存失效；`_id` 映射。
- 变异验证：去掉成员校验 / 去掉名额扣减 / 去掉兑换时的「已是成员」判断，相应用例必须变红（M3 起的习惯）。

**真机清单（☐，小程序 / iOS / Android）**：A 签发 → 分享 → B 打开分享卡片兑换 → B 在圈内发帖 → A 看到；C（非成员）看不到圈内内容、直接打开话题链接提示不存在；名额耗尽；邀请码 7 天后过期并退额度（可用运维脚本把 `expiresAt` 提前验证）；匿名话题抓包无 `usedBy` / `invitedBy` / `_openid`。

## 11. 上线与回滚

1. 合并前：`yarn test:functions && yarn test && yarn typecheck` 全绿；新文件跑 eslint。
2. `node scripts/sync-shared.mjs`；`ensure-indexes.mjs`（预览 → `--apply`，只新增 3 个索引）。
3. `circles.mjs audit`（只读）：确认旧话题数量；> 0 则先 `migrate-topics`。
4. `circles.mjs seed --apply` 建圈子。
5. 部署 `community`、`moderation`（`tcb fn deploy <name> --force`；**部署前确认 `.env` 里 `WX_MP_APP_ID / WX_MP_APP_SECRET` 有值**，`tcb` 全局登录账号要核对，做法见 `docs/ops/release-checklist.md`）。`user` 不改。
6. `circles.mjs grant` / `issue` 给第一批成员；冒烟：管理端 SDK 免身份调用 → 新 action 返回 40101 / 参数校验提示；**不在生产写测试数据**（或用 `test_` 前缀圈子并事后清理）。
7. 前端：小程序体验版重新构建；老的 M3 客户端在后端升级后仍可发帖（D9：只加入 1 个圈子时缺省归属），但话题流会按成员关系过滤——**没有圈子的用户会看到空流**，所以先给成员再发版。
8. **回滚**：重新部署上一个提交的 `community` / `moderation`（memberships / invites 数据无副作用，可保留）；话题的 `circleId` 是新增数据，旧代码仍能读（旧代码不看 `circleId`，圈内话题会对所有人可见——回滚窗口内应暂停发帖，或回滚前先 `circles.mjs` 导出清单）。

## 12. 风险与未决

| 风险 | 缓解 |
|---|---|
| 名额只有 3 个，丢码 / 过期烧名额，内测起不来 | D4 退额度；官方码不占名额；`invite-quota.mjs --add` |
| 邀请码在群里被一人抢先 / 外传 | 一次性 + 7 天 + 绑定圈子；兑换要求实名；后台可追溯 `invitedBy` / `inviteCode` |
| 并发扣名额 / 兑换 | §6.2 条件更新 + 唯一索引 + 单测并发用例 |
| 回滚后圈内话题对所有人可见 | §11 第 8 条；内测期回滚窗口内暂停发帖 |
| 旧话题与回复的 `circleId` 为空 | D11 审计 + 迁移脚本 |
| `users.inviteQuota` 合并时「主账号没有才补齐」：两个账号各有 3 个名额合并后只剩主账号的 | 可接受（防止合并刷名额）；不改 |
| 微信 `onShareAppMessage` 审核：分享标题不能含诱导 / 营销话术 | 文案固定为「邀请你加入「<圈子名>」」 |
| 圈子名称 / 公约未最终确认（PRD §12 待确认项） | 种子 JSON 可随时重跑；公约上线前需法务审阅（同全站公约） |
