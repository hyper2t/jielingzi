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
- `mute` / `ban`：对象是内容作者（举报用户时为 `targetUid`）；写 `users.mutedUntil` / `bannedUntil`（取较晚，不缩短已有处罚），`guardWrite` 立即生效（40305 / 40304）；作者已注销 → 40001
- mod 不能处罚 mod / admin（40301），只有 admin 可以；举报用户只能 dismiss / mute / ban
- 关闭该目标全部 open 举报（`state = resolved`，`result`，`handledBy`，`handledAt`）；写 mod_logs（kind = manual）
- 站内通知（BE-M2-04）：remove / mute / ban 时通知作者（「你发布的话题因违反社区公约已被删除」等）与每位举报人（「你举报的内容已处理」）；**不含原文**
- 出参：`{ ok: true, resolved: 被关闭的举报数, status: 内容新状态 | null }`
- 错误：40001、40101、40301、40401

## 站内消息 notifications（BE-M2-04）

`{ _openid: 接收人, type: 'reply' | 'moderation' | 'prompt', refType, refId, text, read: false, createdAt }`；只写与「我」直接相关的消息，不含营销与被处理内容的原文。列表与未读数在 M6（FE-M6-03）。

## 角色

`users.role` 只能由 `scripts/ops/set-role.mjs` 修改（BE-M2-05）：

```bash
node scripts/ops/set-role.mjs --list
node scripts/ops/set-role.mjs --phone 13800138000 --role mod           # 预览；--phone 需 .env PHONE_HASH_SECRET
node scripts/ops/set-role.mjs --account <accountId> --role mod --apply  # 写入（打印旧值便于回滚）
```

## 待实现

- BE-M2-02 图片异步机审（`mediaCheckAsync` + 消息推送回调 → 更新内容状态），与自定义头像上传、M3 话题图片一起上线
