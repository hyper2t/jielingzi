# community 云函数（练习档案 / 圈子 / 邀请 / 话题 / 回复）

> 通用约定见 [README.md](./README.md)。所有动作需登录（安全规则 `auth != null`），写动作经 `guardWrite`。

## ping

健康检查，免身份，不读写数据库。

- 入参：无
- 返回：`{ fn: 'community', at: <毫秒时间戳> }`

## getProfile / updateProfile（M1）

练习档案，契约见 [profile.md](./profile.md)。

## 深度话题与回复（M3）

> 实现：`cloudfunctions/community/topics.js`（BE-M3-01 ~ 04）；前端：`src/services/community.ts`、`src/features/topic/rules.ts`、首页话题流、`pkg-community/pages/topic-new` / `topic`（FE-M3-01 ~ 03）。用例：`docs/test/cases/M3.md`。

### 数据

`topics`：`_openid`（作者 accountId，PRD 里的 authorUid；注销时 detach → `null` + `authorDeleted: true`）、`circleId`（M3 恒为 `null`，M4 接入）、`anon`、`title`、`body`、`tags`、`images`（预留，M3 恒为 `[]`）、`status`（`pending` / `ok` / `folded` / `removed`）、`featured`、`replyCount`、`reportCount`、`createdAt`、`lastReplyAt`；删除时另有 `removedBy: 'author'`、`removedAt`。
`replies`：`_openid`、`topicId`、`circleId`、`anon`、`body`、`short`、`quoteId`、`status`、`reportCount`、`createdAt`。

| 规则 | 值（唯一来源 `_shared/config.js` 的 `TEXT_RULES` / `TOPIC_RULES` / `DAILY_LIMITS`，前端 `src/constants/community.ts` 同名常量由测试比对） |
|---|---|
| 标题 | 5–40 字，单行（空白折叠、去首尾空格），按 Unicode 码点计 |
| 正文 | **有效字数 ≥ 50**（不含空白，防空格凑数），总长 ≤ 10000；换行统一为 `\n`、去行尾空白、3 个以上连续换行折叠为 2 个 |
| 标签 | 可选，≤ 3 个，每个 1–12 字，去 `#`、去重 |
| 回复 | 有效字数 ≥ 1，总长 ≤ 5000；有效字数 **< 30** 标记 `short`（前端默认折叠） |
| 额度（北京时间切日） | 话题 2 条 / 天，回复 20 条 / 天；被机审拒绝的不占额度；删除不占额度 |

不允许含控制字符、零宽字符、双向控制符；所有动作**拒绝未声明的参数**（40001，防夹带 `status` / `images` / `_openid` 等）。

### 匿名脱敏（BE-M3-04，PRD §8.3）

所有返回值不含 `_openid` / `authorUid` / `_id` / `reportCount` / `removedBy` 等内部字段（测试抓取返回体断言）；作者只给：

```json
{ "name": "…", "avatar": "preset:leaf | cloud://… | null", "badges": ["senior"],
  "practices": ["meditation"], "years": 3, "isSelf": false, "anon": false, "deleted": false }
```

| 情形 | name | avatar | badges | practices / years |
|---|---|---|---|---|
| 实名 | 昵称（没填昵称时回退为匿名代号） | 档案头像（预置或审核通过的上传头像） | 档案徽章 | 档案里的练习方式 / 练习年限（`profile.md`：他人可见） |
| 匿名（`anon: true`） | 匿名代号 `anonAlias`（前端自行加「匿名·」前缀） | `null`（默认头像） | `[]`（避免用徽章反推） | `[]` / `null` |
| 作者已注销（`deleted: true`） | `已注销用户` | `null` | `[]`，`isSelf: false` | `[]` / `null` |

`anon`、`deleted` 是显式布尔值，前端 `AuthorBadge` 据此渲染；这个形状与前端 `AuthorView` 一致。

同一账号在所有匿名内容里代号相同；`isSelf` 是「是我发的」（匿名内容本人也看得到 `true`）。

### 可见性与机审

- 写入链路：`guardWrite`（登录 40101 → 未封禁 40304 → 已确认 18+ 40303 → 已实名 40302 → 未禁言 40305 → 当日额度 42901）→ 机审 → 落库 → 计额度。话题走 `forum` 场景（标题 + 正文 + 标签），回复走 `comment` 场景。
- 机审 `reject`：40001「内容不符合社区公约，请修改后再发布」，不落库、不扣额度，写 `mod_logs`。
- 机审 `review`：落库 `status = 'pending'`——**只有作者本人看得到**（`pending: true`），不在话题流里，不计入 `replyCount`；同时写一条「系统待复核」举报（`reports`：`_openid = null`、`system: true`、`reason = other`、`note = 机审待复核`），**复用 M2 的审核队列与审核页**：审核员 `decide` 的 `restore` / `dismiss` = 放行（pending → ok），`remove` = 下架并通知作者。
- **读**也要求已确认 18+（PRD C5），否则 40303；读不要求实名。
- 话题流只含 `ok`；`folded`（举报达 3 人自动折叠）的话题不进话题流，直接打开详情时 `folded: true`、`body: null`；回复被折叠时保留位置、`body: null`；`removed` / 不存在 / 别人的 `pending` 一律 40401。

### createTopic

| 参数 | 取值 |
|---|---|
| title | 见上表（必填） |
| body | 见上表（必填） |
| anon | boolean，默认 `false` |
| tags | string[]，可选 |

- 首次发帖会补建档案并分配匿名代号（`ensureProfile`），实名发帖时昵称没填则显示代号。
- 出参：`{ topic, status: 'ok' | 'pending', remaining }`；`topic` 为 `getTopic` 同样的完整对象。
- 错误：40001（`msg` 可直接展示）、40101、40302、40303、40304、40305、42901。

### listTopics

话题流：`status = ok`，新的在前。入参 `page`（默认 1）、`size`（1–50，默认 20）；`circleId` 暂不支持（传了 40001，M4 接入成员校验）。

- 出参：`{ list, total, page, size, hasMore }`；list 项只给摘要：`{ id, title, excerpt（≤ 80 字）, tags, anon, author, replyCount, createdAt, lastReplyAt, featured, images, folded, pending }`，**不含正文**。
- 错误：40101、40303。

### getTopic

- 入参：`{ id }`；出参：`{ topic }`，字段同上，用 `body`（完整正文）代替 `excerpt`。
- 错误：40001、40101、40303、40401（不存在 / 已下架 / 别人的待审）。

### createReply

| 参数 | 取值 |
|---|---|
| topicId | 话题 id（必填；话题必须是 `ok`，否则 40401） |
| body | 见上表（必填） |
| anon | boolean，默认 `false` |
| quoteId | 可选；必须是**同一话题**里状态为 `ok` 的回复，否则 40001 |

- 出参：`{ reply, status: 'ok' | 'pending', remaining }`。`status = ok` 时话题的 `replyCount` +1、`lastReplyAt` 更新。
- `replyCount` 是展示用的近似值：审核员放行 / 下架、举报折叠不回写它。
- 错误：同 createTopic，另有 40401。

### listReplies

按时间**正序**。入参 `{ topicId, page, size }`（`size` 1–50，默认 **30**）。

- 出参：`{ list, total, page, size, hasMore }`；list 项：

```json
{ "id": "…", "topicId": "…", "body": "…（折叠时为 null）", "short": false, "anon": false,
  "author": { "name": "阿青", "avatar": "preset:moon", "badges": [], "practices": [], "years": null, "isSelf": false, "anon": false, "deleted": false },
  "quote": { "id": "…", "unavailable": false, "authorName": "竹影", "anon": false, "excerpt": "被引用回复的前 60 字" },
  "createdAt": 1790000000000, "folded": false, "pending": false }
```

- `quote`：没有引用为 `null`；被引用的回复已折叠 / 删除 / 待审时 `unavailable: true`，`authorName` 与 `excerpt` 为 `null`（不泄露内容）；引用里的作者同样脱敏。
- ok / folded 所有人可见，`pending` 只有作者本人看得到（所以某页可能少于 `size` 条）。
- 「展开 N 条简短回复」由前端按 `short` 统计与折叠。
- 错误：40001、40101、40303、40401（话题不可见）。

### deleteMine

作者删除自己的话题 / 回复（软删除：`status = removed`、`removedBy = author`）。

- 入参：`{ type: 'topic' | 'reply', id }`；出参：`{ ok: true, changed: boolean }`（重复删除幂等，`changed: false`）。
- 不是作者本人（含内容不存在）一律 40401，不暴露内容是否存在；禁言期间也可以删；不占额度；不要求实名。
- 删除回复时话题 `replyCount` −1；删除待审内容时队列里的「系统待复核」一并关闭。
- **作者自己删除的内容审核员不能 `restore`**（40001「作者已自行删除该内容，不能恢复」）。话题被删后，其下的回复不再有入口可见。

### 索引（M3 新增）

| 集合 | 索引 | 类型 |
|---|---|---|
| topics | `idx_status_time`：`status` + `createdAt`（话题流） | 普通 |

> 部署后需要执行一次 `scripts/ops/ensure-indexes.mjs`（见 `docs/ops/collections.md`）。

## 圈子与邀请码（M4，草案）

> **状态：契约草案**（2026-10-01）。**已实现：`listCircles`、`getCircle`、`listInvites`、`createInvite`、`redeemInvite`**（`cloudfunctions/community/{circles,invites}.js`，用例 `tests/cloudfunctions/m4*.test.js`，未部署）；话题 / 回复 / 举报的成员校验（BE-M4-03）尚未实现。实施计划与决策见 [`docs/prd/m4-plan.md`](../prd/m4-plan.md)；落地时以本节为准并同步更新。所有动作沿用本文件前面的通则：扁平入参、**拒绝未声明参数（40001）**、读要求 18+（40303）、写走 `guardWrite`。

### 数据

- `circles`：`slug`（稳定标识，唯一）、`name`、`desc`、`cover`（`circle:<slug>` 或 `null`）、`rules`（`string[]`）、`memberCount` / `topicCount`（**展示用近似值**）、`sort`、`status`（`open` / `closed`）。
- `memberships`：`circleId`、`_openid`、`joinedAt`、`invitedBy`（**不下发**）、`inviteCode`、`role = 'member'`；唯一 `(circleId, _openid)`。
- `invites`：`code`（8 位）、`circleId`、`_openid`（签发人；官方码为 `null`）、`official`、`createdAt`、`expiresAt`、`usedBy`（**不下发**）、`usedAt`、`refunded`。
- `users.inviteQuota`：剩余名额；字段缺失 = 未初始化，首次 `listInvites` / `createInvite` 时用「字段不存在」条件写入 `INVITE_RULES.initialQuota`。

| 规则 | 值（唯一来源 `_shared/config.js` 的 `INVITE_RULES` / `CIRCLE_RULES` / `DAILY_LIMITS`） |
|---|---|
| 初始名额 | 3 |
| 邀请码 | 8 位，字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（Crockford base32，无 I L O U）；一次性；绑定签发它的圈子；**7 天**有效 |
| 过期退额度 | 过期未使用的码退回 1 个名额，每个码只退一次；官方码（运维签发）不占名额也不退 |
| 额度（北京时间切日） | `createInvite` 5 次 / 天；`redeemInvite` 10 次 / 天（**含失败尝试**） |

**邀请码规范化**（服务端与前端同一算法，共享 fixture `tests/fixtures/invite-code.json`）：去首尾空白与中间空格 / `-` → 大写 → `O→0`、`I/L→1`；必须恰好 8 位且都在字母表内，否则 40001（「邀请码为 8 位」「邀请码含有不支持的字符」）。

### 圈子对象

```json
{ "id": "…", "slug": "mindful", "name": "静观练习", "desc": "冥想、正念、内观的日常练习与困惑",
  "cover": "circle:mindful", "memberCount": 12, "topicCount": 30, "joined": true }
```

不含成员名单、`invitedBy` 等任何成员标识。

### listCircles

- 入参：无。出参：`{ list }`（只含 `open`，按 `sort`；圈子数量很少，不分页）。
- 非成员也能看到（用于「未入圈」引导页），`joined` 标明我是否已加入。
- 错误：40101、40303。

### getCircle

- 入参：`{ id }`；出参：`{ circle }`：圈子对象加 `rules: string[]`（圈子公约，在全站公约基础上的补充）。
- 错误：40001、40101、40303、40401（不存在 / 已 `closed`）。

### listInvites

- 入参：无。出参：`{ quota, ttlDays, list }`；`list` 为我签发的码，新的在前，最多 50 条：

```json
{ "code": "ABCD2345", "circle": { "id": "…", "name": "静观练习" }, "status": "active | used | expired",
  "createdAt": 1790000000000, "expiresAt": 1790604800000, "usedAt": null }
```

- 完整的码只返回给签发人本人；**不返回兑换人**（`usedBy`）。
- 副作用：触发「过期退额度」（见上，幂等）与名额懒初始化。
- 错误：40101、40303。

### createInvite

- 入参：`{ circleId }`（必填）；我必须是该圈子的成员且圈子为 `open`，否则 40301（「加入圈子后才能邀请」）。
- 出参：`{ invite, quota }`（`invite` 同上；`quota` 为扣减后的剩余名额）。
- 副作用：签发前同样先做名额懒初始化与「过期退额度」，所以名额为 0 但有过期未用的码时仍可签发。生成的码撞唯一索引时自动重试（最多 5 次）。
- 圈子不存在 / 已关闭 / 我不是成员返回同一句 40301，不泄露圈子是否存在。
- 名额用完：42901（msg「邀请名额已用完」；前端以 `quota = 0` 判断，不依赖 code）。写库失败时名额自动退回。
- 错误：40001、40101、40301、40302、40303、40304、40305、42901。

### redeemInvite

- 入参：`{ code }`（规范化见上）。出参：`{ circle, joined: true }`。
- 校验顺序：规范化（40001）→ 码不存在 / 已用 / 已过期（**同一条 40401「邀请码无效、已被使用或已过期」**，不泄露码是否存在）→ 我已是该圈子成员（40901「你已在这个圈子里」，**不消耗码**）→ 条件更新标记已用（被抢先 → 40401）→ 写 `memberships`（撞唯一索引 → 还原码并 40901）→ `circles.memberCount` +1。
- 要求：已登录、已确认 18+、已实名、未封禁（禁言不影响加入）；每次调用（含失败）计 1 次日额度，超出 42901。
- 错误：40001、40101、40302、40303、40304、40401、40901、42901。

### 对话题与回复接口的改动（BE-M4-03）

| 接口 | 改动 |
|---|---|
| `createTopic` | 新增 `circleId`：必须是我加入的 `open` 圈子，否则 40301。**缺省**：恰好加入 1 个圈子 → 默认归到该圈子；多个 → 40001「请选择圈子」；没有 → 40301。返回体 `topic.circle = { id, name }` |
| `listTopics` | `circleId` 可选。不传 = 我所有圈子的话题聚合（没有任何圈子 → 空列表，不是错误）；传了必须是成员，否则 40301（「加入圈子后才能查看」）。列表项新增 `circle: { id, name }` |
| `getTopic` / `listReplies` / `createReply` | 话题所在圈子必须有我，否则 **40401**（与「不存在」一致，防遍历 ID）；`circleId = null` 的旧话题对任何人不可见。`topic.circle` 同上 |
| `deleteMine` | 不要求是成员（作者随时能删自己的内容） |
| `moderation.report` | 目标内容所在圈子须有我，否则 40401；`queue` / `decide` 不变（审核员没有额外读圈内内容的特权，审核页只给摘要） |

### 新增索引（M4）

| 集合 | 索引 | 类型 |
|---|---|---|
| circles | `uniq_slug`：`slug` | 唯一 |
| memberships | `idx_member`：`_openid` + `joinedAt` | 普通 |
| invites | `idx_owner_time`：`_openid` + `createdAt`（倒序） | 普通 |

> 落地后需执行 `scripts/ops/ensure-indexes.mjs`；运维脚本（`circles.mjs`、`invite-quota.mjs`）见 `m4-plan.md` §8。
