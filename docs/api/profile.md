# 练习档案（community.getProfile / updateProfile，M1）

> 实现：`cloudfunctions/community/profile.js`（BE-M1-04）；前端：`src/services/community.ts`、`src/features/profile/rules.ts`、
> `src/pkg-user/pages/profile-edit`、「我的」档案卡（FE-M1-03）。通用约定见 [README.md](./README.md)。

## 数据（`profiles` 集合，PRD §8）

每个账号一条，`_openid` = accountId。合并账号时保留主账号那条（另一条删除），注销时删除——由 `_shared/collections.js` 的 owned 登记驱动（BE-M1-05）。

| 字段 | 类型 | 规则 |
|---|---|---|
| nickname | string | 2–16 字（按 Unicode 码点计，emoji / 生僻字算 1 个）；去首尾空格、折叠连续空白；不得含「结灵子 / 官方 / 管理员 / 客服 / 系统 / 审核」；不得含控制字符、零宽字符、双向控制符 |
| avatar | string \| null | `preset:<id>`，id ∈ `AVATAR_PRESETS`（12 款预置头像，图片 `src/assets/avatars`）；null = 默认头像。**自定义头像上传随 M2 图片机审上线**（未经机审的图片不展示，PRD §3 / §9） |
| practices | string[] | 只能取 `PRACTICES` 的 id，去重后 ≤ 5 项 |
| years | number \| null | 0–80 的整数；null = 不填 |
| goal | string | ≤ 40 字（同上清洗），可为空串 |
| bio | string | ≤ 80 字（同上清洗），可为空串 |
| anonAlias | string | 匿名代号：首次保存档案时生成，全站唯一（唯一索引），之后不变；自然意象两字为主（如「竹影」），碰撞多次后追加数字 |
| badges | string[] | 如 `senior`（资深练习者，v0.2）；不可由用户修改 |
| createdAt / updatedAt | number | 毫秒 |

规则的唯一来源：`cloudfunctions/_shared/config.js`（`TEXT_RULES` / `PRACTICES` / `PROFILE_RULES` / `AVATAR_PRESETS` / `RESERVED_NICKNAME_WORDS`），前端 `src/constants/community.ts` 同名常量由测试比对；提示文案前后端一致。

## getProfile

本人档案（不提供查看他人档案；他人只能通过内容的 `author` 对象看到昵称 / 头像 / 练习方式，匿名时只看到代号）。

- 入参：无
- 出参：`{ profile: Profile | null }`——还没有档案时为 null；**任何返回都不含 `_openid` / `_id`**
- 错误：40101、40001（夹带参数）

```json
// ← { "code": 0, "data": { "profile": { "nickname": "林然", "avatar": "preset:leaf", "practices": ["mindfulness", "taichi"], "years": 3, "goal": "", "bio": "在呼吸里找回自己", "anonAlias": "竹影", "badges": [], "updatedAt": 1790000000000 } }, "msg": "ok" }
```

## updateProfile

部分更新：只传要改的字段；`avatar` / `years` 传 null 表示清除，`goal` / `bio` 传空串表示清空。首次保存时建档并分配匿名代号（初始字段与建档一次写入）。

| 参数 | 取值 |
|---|---|
| nickname / avatar / practices / years / goal / bio | 见上表；至少传一项，**其他字段一律 40001**（防夹带） |

- 写入链路：`guardWrite(ctx, 'updateProfile', { requirePhone: false })`——登录（40101）→ 未封禁（40304）→ 已确认 18+（40303）→ 未禁言（40305）→ 当日额度 20 次（42901，北京时间切日）。档案不是「发布」，**不要求实名**（首次进入流程里「完善档案」在绑定手机号之前）。
- 机审钩子：昵称 / 目标 / 介绍过 `_shared/moderation.js checkText(scene='profile')`（M1 恒放行；M2 接入 msgSecCheck + 词库）。结论 reject → 40001「内容不符合社区公约，请修改后再保存」，不写库、不扣额度。
- 出参：`{ profile: Profile }`（完整档案）
- 错误：40001（字段不合规，`msg` 为可直接展示的中文说明，如「昵称最多 16 个字」「练习方式最多选 5 项」）、40101、40303、40304、40305、42901、50000（匿名代号连续冲突，极少见，可重试）

```json
// → { "action": "updateProfile", "nickname": " 林 然 ", "practices": ["mindfulness", "taichi", "mindfulness"], "years": 3 }
// ← { "code": 0, "data": { "profile": { "nickname": "林 然", "practices": ["mindfulness", "taichi"], "years": 3, "anonAlias": "竹影", … } }, "msg": "ok" }
```

## 索引

| 集合 | 索引 | 类型 |
|---|---|---|
| profiles | `_openid` | 唯一 |
| profiles | `anonAlias` | 唯一 |

## 测试

`tests/cloudfunctions/m1.test.js`（字段校验、写入链路、匿名代号唯一与并发、合并 / 注销）；`src/features/profile/__tests__/rules.test.ts`（前端同表校验）；`src/pkg-user/__tests__/m1.test.tsx`（编辑页与档案卡）。用例索引：`docs/test/cases/M1.md`。
