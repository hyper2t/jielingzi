# moderation 云函数（内容安全，M2）

> 实现：`cloudfunctions/moderation/service.js`、`cloudfunctions/_shared/{moderation,wordlist,notify}.js`。通用约定见 [README.md](./README.md)。
> 前端：`src/services/moderation.ts`、`components/ReportSheet`（FE-M2-01）、`pkg-admin/pages/queue`（FE-M2-02）。

## 机审（BE-M2-01，内部能力，不是 action）

`checkText(ctx, { scene, texts })`：所有发布类写入（M1 档案、M3 话题 / 回复）落库前调用。

| 层 | 说明 |
|---|---|
| 自建词库 `_shared/wordlist.js` | 分类：宗教活动组织、疗效 / 医疗承诺、神秘能力、资金往来、辱骂、违法 / 邪教组织（名单由运营按监管口径维护）、站外引流（微信号 / QQ / 手机号 / 二维码 / 加群正则，网址进人工）。同时匹配原文与「去空白 / 分隔符 / 零宽字符、全角转半角」的紧凑文本，防拆字规避 |
| 微信 msgSecCheck v2 | `POST /wxa/msg_sec_check { content, version: 2, scene, openid }`；scene：资料 1 / 评论 2 / 论坛 3 / 社交日志 4；需要用户的小程序 openid（近 2 小时访问过小程序）。`risky` → reject，`review` → review。超过 2500 字分段。App 用户没有 openid 时只用词库（后续接腾讯云内容安全，见 mvp-plan 风险表） |
| 结论 | 取更严：**reject**（不予发布：40001「内容不符合社区公约」，不写库、不扣额度）> **review**（落库，`status = pending`，不对他人展示，进人工复核）> **pass**。微信接口失败不阻断，但至少 review |
| 留痕 | 非 pass 的结论写 `mod_logs`（kind = machine，分类 / 标签 / 场景 / 作者，不记原文，`expireAt` = 6 个月后） |

样本集与命中率（QA-M2-01）：`tests/cloudfunctions/fixtures/moderation-samples.json`，`yarn test:functions` 输出命中率与误杀数。

## report（需登录）

举报话题 / 回复 / 用户（PRD S2）。

| 参数 | 取值 | 说明 |
|---|---|---|
| targetType | `topic` / `reply` / `user` | |
| targetId | 内容 id | 举报**用户**时也传他发布的那条内容的 id |
| contentType | `topic` / `reply` | 举报用户时必填；其他情况可省略（须与 targetType 一致） |
| reason | `religion` / `medical` / `money` / `diversion` / `abuse` / `porn` / `illegal` / `privacy` / `spam` / `other` | 文案见 `_shared/config.js` REPORT_REASONS |
| note | ≤ 200 字（可选） | 补充说明 |

- 写入链路：`guardWrite(ctx, 'report', { requirePhone: false, allowMuted: true })`——需 18+；**不要求实名**；禁言中也可举报；封禁不可；每日 30 次
- 同一人对同一目标只计一次（`reports` 唯一索引 `targetId + _openid`）：重复返回 `duplicate: true`，不扣额度
- 不能举报自己发布的内容（40001）；目标不存在 40401
- 不同举报人达到 `REPORT_FOLD_THRESHOLD`（3）时内容自动 `folded`（mod_logs 记 `fold`）；举报用户只进队列，不折叠
- 举报用户时服务端解析作者 accountId 存 `report.targetUid`，**永不下发**
- 出参：`{ ok: true, duplicate: boolean, folded: boolean }`

## queue（仅 mod / admin）

- 入参：`{ state?: 'open' | 'resolved'（默认 open）, page?, size?（≤ 50） }`
- 出参：`{ list, total, page, size, hasMore }`；list 按目标聚合、按举报人数降序：
  `{ targetType, targetId, contentType, count（不同举报人数）, reasons: { <reason>: 人数 }, notes（最多 3 条）, latestAt, target: { status, excerpt（≤ 60 字）, anon, authorDeleted } | null }`
- **不含任何作者 / 举报人标识**
- 错误：40101、40301（非 mod / admin）

## decide（仅 mod / admin）

| 参数 | 取值 | 说明 |
|---|---|---|
| targetType / targetId / contentType | 同 report | |
| decision | `remove` / `restore` / `dismiss` / `mute` / `ban` | **不叫 action**（action 是路由字段，同名会被覆盖） |
| days | 整数（可选） | mute 必填 1–30；ban 不传 = 永久（≤ 3650） |
| note | ≤ 200 字（可选） | 处理备注，写 mod_logs |

- `remove`：内容 `status = removed`；`restore`：恢复为 `ok`；`dismiss`：驳回，折叠的内容恢复为 `ok`
- **机审待复核的内容（M3，`status = pending`）**：`restore` / `dismiss` = 放行（`ok`），`remove` = 下架；队列里它以「系统待复核」举报的形式出现（`_openid = null`、`system: true`），不需要另建审核页
- **作者自己删除的内容**（`removedBy = author`，见 `community.md` 的 `deleteMine`）不能 `restore`：40001「作者已自行删除该内容，不能恢复」
- `mute` / `ban`：对象是内容作者（举报用户时为 `targetUid`）；写 `users.mutedUntil` / `bannedUntil`（取较晚，不缩短已有处罚），`guardWrite` 立即生效（40305 / 40304）；作者已注销 → 40001
- mod 不能处罚 mod / admin（40301），只有 admin 可以；举报用户只能 dismiss / mute / ban
- 关闭该目标全部 open 举报（`state = resolved`，`result`，`handledBy`，`handledAt`）；写 mod_logs（kind = manual）
- 站内通知（BE-M2-04）：remove / mute / ban 时通知作者（「你发布的话题因违反社区公约已被删除」等）与每位举报人（「你举报的内容已处理」）；**不含原文**
- 出参：`{ ok: true, resolved: 被关闭的举报数, status: 内容新状态 | null }`
- 错误：40001、40101、40301、40401

## markFeatured（仅 mod / admin，M6）

- 入参：`{ topicId, featured, note? }`（`featured` 必填布尔；`note` ≤ 200 字，只进 `mod_logs`）。只支持话题。
- 行为：只改 `topics.featured`，**不动 `status`**（D12：精华不解除 M4 的圈子成员校验，精华列表不会变成越权通道）；`featured: true` 要求话题当前是 `ok`，否则 40001；取消标记任何时候都允许，便于撤销误标。
- 出参：`{ ok: true, featured, changed }`。同值重复调用是幂等的（`changed: false`、数据不变），但每次仍写一条 `mod_logs`（`kind: 'featured'`、`action: 'feature' | 'unfeature'`、`actor`、`subject` = 话题作者）。
- 错误：40001（参数）、40301（非 mod / admin）、40401（话题不存在或已删除）。
- 不发站内消息（通知归 BE-M6-03）；配套入口是 `community.listTopics({ featured: true })`。

## 站内消息 notifications（BE-M2-04）

`{ _openid: 接收人, type: 'reply' | 'moderation' | 'prompt', refType, refId, text, read: false, createdAt }`；只写与「我」直接相关的消息，不含营销与被处理内容的原文。列表与未读数在 M6（FE-M6-03）。

## 角色

`users.role` 只能由 `scripts/ops/set-role.mjs` 修改（BE-M2-05）：

```bash
node scripts/ops/set-role.mjs --list
node scripts/ops/set-role.mjs --phone 13800138000 --role mod           # 预览；--phone 需 .env PHONE_HASH_SECRET
node scripts/ops/set-role.mjs --account <accountId> --role mod --apply  # 写入（打印旧值便于回滚）
```

## 图片机审（BE-M2-02）

实现：`cloudfunctions/_shared/media.js`（登记 / 落地）、`cloudfunctions/mediacheck`（回调）。集合 `media`：`{ _openid: 上传者, fileID, purpose: 'avatar', status: pending | review | pass | reject, provider: wx | manual, traceId, label, size, createdAt, checkedAt, checkedBy }`。

```
客户端上传到 uploads/<用途>/ → community.setAvatar → startImageCheck：校验路径 / 类型 / 大小 → 登记 media
  ├─ 小程序用户：mediaCheckAsync v2 { media_url: 临时链接, media_type: 2, version: 2, scene: 1, openid } → pending
  │     └─ 微信「消息推送」事件 wxa_media_check → mediacheck 云函数 → settleMedia
  │           pass  → 生效（头像写入 avatar，旧的自定义头像文件删除）
  │           risky → 删除文件（违规图自动下架）+ 清掉 avatarPending + 站内通知 + mod_logs
  │           review→ 进人工复核
  └─ App 用户（无 openid）/ 微信接口失败 → review → 人工复核（mediaQueue / decideMedia）
```

- **mediacheck 只能由平台推送触发**：云函数安全规则 `mediacheck: { invoke: false }`（客户端一律不能调，防伪造结论）；函数内再校验 `appid = WX_MP_APP_ID`、`trace_id` 必须已登记；结论幂等（已 pass / reject 的不再变化）；被新上传替代的图片即使通过也不生效并删除
- **需要在微信侧配置消息推送**（只需一次）：微信开发者工具 → 云开发控制台 → 设置 → 其他设置 →「消息推送」→ 添加：消息类型 `event`、事件类型 `wxa_media_check`、环境选结灵子环境、云函数 `mediacheck`。没配置时机审结论推不回来，图片会在 30 分钟后进入人工复核队列
- 注销：`user.deleteAccount` 删除该用户在 `media` 里登记过的全部文件，记录随 owned 登记删除

### mediaQueue（仅 mod / admin）

- 入参：`{ page?, size? }`；出参 `{ list, total, page, size, hasMore }`，list：`{ mediaId, purpose, purposeLabel, status, provider, label, createdAt, url（1 小时临时预览链接） }`
- 内容：status = review 的，以及 pending 超过 30 分钟（回调没来）的；**不含上传者标识**

### decideMedia（仅 mod / admin）

- 入参：`{ mediaId, decision: 'pass' | 'reject', note? }`；结论同回调落地（reject 删除文件并通知上传者），写 mod_logs（kind = manual）
- 出参：`{ ok: true, status, changed }`；错误：40001、40101、40301、40401
