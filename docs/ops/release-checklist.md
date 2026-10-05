# 上线前检查（数据源切换）

前端数据源由 `.env` 的 `TARO_APP_DATA_SOURCE` 决定（见 `src/services/client.ts`）：`mock` 只改本机状态，任何云端写入（同意、设置、业务数据）都不会真的发生；**上线包必须为 `cloud`**。

## 步骤

1. TODO(business)：确认云端已有可展示的业务数据（否则切 cloud 后首页是空的），可仿照 luming 的 `ops:check-online` 写一个只读检查脚本。
2. `.env`：`TARO_APP_DATA_SOURCE=cloud`（本地想回 mock 演示，用 `.env.local` 覆盖，不要改 `.env`）。
3. 云函数与前端契约一致：`node scripts/sync-shared.mjs` 后重新部署 `user`（及业务云函数）；`node scripts/ops/ensure-collections.mjs` 建账号层集合，`node scripts/ops/security-rules.mjs --apply` 下发规则。
   - 部署云函数：`tcb fn deploy <name> --force`（只部署改动的函数）。**先确认 `.env` 里该函数 `envVariables` 引用的键都有值**（部署会整体覆盖线上环境变量，缺键 = 清空；`node scripts/ops/function-env.mjs <name>` 可查看线上现状）。
   - **`tcb` 的全局登录可能是别的账号**（`tcb env list` 看不到本环境时会报 `env not found`）。不想动全局登录，可在单次命令里把 `USERPROFILE` / `HOME` 指向临时目录，再用 `.env` 的 `CLOUDBASE_SECRET_ID / KEY` 执行 `tcb login --apiKeyId … --apiKey …`，部署完删掉该临时目录。
   - 冒烟调用别用 `data` 包一层：云函数入参是平铺的（`{"action":"listTopics"}`），多余字段会 40001；PowerShell 5 传 JSON 要把引号转义成 `\"`。
4. `npm run test:functions && npm test && npm run typecheck` 全绿；App 端再跑 `npm run rn:smoke`。
5. 真机回归：同意 → 登录（手机号 / 微信 / Apple）→ 设置页查看登录方式 → 退出 → 重新登录 → 注销账号回到同意弹窗；「清除本机数据」后保留登录态。

## 排障：真机调试报 `ENOENT ... dist\chunk\538.js`

- 原因：`dist` 同时被 H5（`chunk/*.js` 是 Taro H5 的异步 chunk 目录）和小程序构建写入，H5 产物被小程序构建清掉后，微信开发者工具的文件索引仍指向旧文件。`config/index.ts` 已按端隔离输出目录（weapp `dist`、h5 `dist-h5`、rn `dist-rn`），不会再互相覆盖。
- 处理：开发者工具「工具 → 清除缓存 → 清除全部缓存」→ 重启工具 → 重新编译 → 真机调试；仍报错就在真机调试面板切换 1.0 / 2.0 各试一次。构建端注意：`node_modules/@swc` 只有 Linux 二进制，`taro build` 需在 WSL 下跑，Windows 侧的 node 只用于脚本。

## 排障：开发者工具全部页面白屏，Console 报 `MiniProgramError … n[e] is not a function`

- 2026-09-29 出现过一次（重建 dist 后）。先跑 `node scripts/ops/weapp-smoke.cjs dist`：它在 Node 里模拟 wx 环境加载全部产物并渲染每个页面；如果这里正常（每页都有 setData、无 THROW），就是开发者工具缓存了旧分包 / 模板，「工具 → 清除缓存 → 全部清除」→ 编译即可。如果这里抛错，堆栈会直接指向产物文件，按文件找源码。

## M4 上线（官方圈子 + 邀请码）

> 顺序很重要：**先让第一批成员入圈，再发客户端**——部署新的 `community` 后，没有圈子成员的人读不到任何话题（旧话题不可见，见 `docs/prd/m4-plan.md` D11）。以下命令都在仓库根目录执行；云端写入类命令默认只预览，确认输出后再加 `--apply`。
>
> **当前状态（2026-10-02）**：当前共享 CloudBase 已创建 3 个 M4 索引、写入 `mindful` / `tradition` / `lifestyle` 三个开放圈子，`community` / `moderation` 已部署且 `ping` 通过；全量 26 个索引存在、无冲突，圈子成员 / 话题计数均为 0。用户确认 `docs/prd/wording.md` §5 法务审阅已通过。首批成员与邀请码尚未配置，三端手工验收及客户端发布尚未完成；本状态不构成 M4 上线签核。按 [`docs/test/cases/M4.md`](../test/cases/M4.md) 记录手工结果。

1. ✅ 2026-10-02 本地验证：`yarn test:functions`、`yarn test:ops`、`yarn test --runInBand --silent`、`yarn typecheck` 全绿（217 个云函数测试、32 个运维测试、35 个 Jest suites / 510 tests / 31 snapshots）；代码变更后、上线前仍须重跑。
2. ✅ 2026-10-02 建索引：`node scripts/ops/ensure-indexes.mjs --apply` 已创建 3 个 M4 索引（`circles.uniq_slug`、`memberships.idx_member`、`invites.idx_owner_time`）；复核 26 个索引齐全、0 冲突。
3. ✅ 2026-10-02 只读审计：部署前后旧话题 / 旧回复均为 0；种子写入后 3 圈成员 / 话题计数均为 0 且一致，无名额异常、无邀请码。首批成员加入及客户端发布前仍须重跑 `audit`；若旧话题 / 回复大于 0，先决定迁移目标。
4. ✅ 2026-10-02 圈子种子：用户确认 `wording.md` §5 法务审阅通过并确认其与 `scripts/ops/circles.seed.json` 一致后，执行 `seed --apply`，创建 3 个开放圈子。以后若改名称 / 简介 / 公约，须更新两处并重跑措辞测试；不可用真实用户数据造测试种子。
5. ✅ 2026-10-02 部署 `community` 与 `moderation`：执行 `sync-shared`、隔离登录并核对函数环境变量后部署；两函数均 Active，`invoke-fn.mjs` 的 `ping` 均通过；`user` 未变更。
6. ✅ 2026-10-03 首批成员与官方邀请码：须先收到明确的圈子、QA / 首批账号名单及邀请码数量，再执行 `grant` / `issue`；不以 `--latest` 代替明确名单。官方码清单只在终端显示一次，须按确认对象安全转交。当前 CloudBase 尚无成员和邀请码。 2026-10-03 执行：用户在会话中明确要求以 `--latest` 覆盖本条对名单的要求，`grant --circle lifestyle --latest --apply` 把最近活跃账号 `oraM0x…sP_U` 加入 `lifestyle`（输出 `已加入`）；`issue --circle lifestyle --count 3 --apply` 签发 3 个一次性官方码（7 天有效），清单只在终端打印一次、不写入仓库或文档。复核 `circles.mjs audit`：`lifestyle` 成员 1/1，邀请码 有效 3（官方 3）/ 已用 0 / 过期 0，旧话题与旧回复仍为 0。
7. ☐ 手工复核待办：M4-D01 的非成员浏览开放圈子列表 / 简介 / 公约可由获批的 18+ QA 非成员独立执行，不依赖 grant / issue；其余依赖成员、邀请码或圈内测试内容的用例按 `docs/test/cases/M4.md` 逐项准备 QA 账号与数据。小程序、iOS、Android 结果均须留证；不得把未执行的独立用例一并标为受阻，也不得据此签 M4 上线。
8. ☐ 发客户端（小程序提审、App 打包）；须待三端 QA 通过并签核后执行。

9. ✅ 2026-10-04 只读盘点与工具补齐（用户授权范围：只建缺失索引）：`tcb` CLI 换账号后能列出本环境 5 个函数（`practice` 仍是 10-02 版本，M6 代码未上线）；`ensure-indexes.mjs --apply` 补建 `prompt_answers.idx_prompt_list`，复核 28 条索引齐、`conflicts 0`；`daily_prompts` 仍 0 条题，`audit` 输出「没问题 ✓」。另把 `scripts/ops/weapp-smoke.cjs` 从「只扫主包 + pkg-user」改为按 `app.json` 的 `subpackages` 扫全部分包（17 个页面全加载、14 个注册页 onLoad 全通过、0 抛错），并让它在缺 chunk 文件时打印 `skip (missing chunk)`。顺带记一条常态：`pkg-community` 各页页首都 `require("../../sub-vendors.js")` 而 dist 只输出 `vendors.js`，M4 已验收的 `topic` / `circles` 也一样——不是缺陷，但真机白屏时先查这里。步骤 7（非成员浏览与圈成员 / 邀请码相关）与步骤 8（提审、发客户端）仍需人工与设备，M4 尚未签核。

10. ✅ 2026-10-04 M6 上线（体验版，经用户授权）：先把三函数代码与 `envVariables` 备份到仓库外 `../deploy-backup-20261004/`（`tcb fn code download` / `tcb fn env pull`），再 `sync-shared` → `tcb fn deploy practice community moderation --force` 全部成功；`tcb fn detail` 显示 `practice` 已带 `dailyPromptReminder：0 0 8 * * * *`（deploy 会自动建触发器）。`ensure-indexes --apply` 补建 `prompt_answers.idx_prompt_list`；`daily-prompt.mjs set --from-file scripts/ops/daily-prompt.seed.json --apply` 写入 7 条、二次运行 `需改动 0 · 未变 7`、`audit`「没问题 ✓」。冒烟：`todayPrompt` / `listNotifications` / `markFeatured` 均 40101（动作已上线，只等身份），`listTopics` 接受 `featured`。**两个坑**：`cloudbaserc.json` 里 `user` 引用的 `WX_APP_ID` / `WX_APP_SECRET` / `APPLE_*` 在 `.env` 是空值——别顺手部署 `user`；`rn:smoke` 第 3 步返回 400，`tcb env login get` 佐证 `AnonymousLogin: false`——App 端 HTTP 链路要开匿名登录才能通，待你决定（`tcb env login set --anonymous-login true`）。 **补充（同日读码更正）**：控制台核对 cron 时区只是「几点发」的体验问题——`cnDate` 固定按北京时区取「今天」、`notify` 先查后写去重、`createTimerEntry` 不向平台抛错（防重试），所以 UTC 解释下最坏是提醒晚发 8 小时，不会重复发也不会错日期；另注意定时分支只认不带 `action` 的 `{"Type":"timer"}` 事件，`tcb fn invoke practice --params '{"Type":"timer"}'` 会真的写一批站内消息，别当冒烟用。 **2026-10-04 收口（经用户授权）**：执行 `tcb env login set --anonymous-login true` → `tcb env login get` 回读 `AnonymousLogin: true`（`EmailLogin: false` 未动）；复跑 `npm run rn:smoke` **全部符合预期**——含 `4b 匿名会话 user.whoami`、`5a refresh_token 轮换`、`5b 旧 refresh_token 复用被拒（400 invalid_grant）`、`6 GET /auth/v1/user/me`、`8c/8d 自定义登录票据换取会话`、`8f user.login（accountId == customUserId 且 isNew）`、`7/8h 注销测试账号`（`removed` 全 0）→ 第 4 步「App 端再跑 `npm run rn:smoke`」转为**通过**。

11. ☐ 待办（M6-D09b 上线，2026-10-05 起阻塞在外部）：送达链路的代码已就位（`recordPromptSubscription` + `sendSubscriptionReminders`），真发出去还差两步——① 小程序后台按 `thing1`（微信对 thing 限 20 字）+ `date2` 建一次性订阅模板，把真值填进 `.env` 的 `TARO_APP_WX_MP_PROMPT_TEMPLATE_ID`，再 `npm run build:weapp`；② `cloudbaserc.json` 给 `practice` 加 `WX_MP_APP_ID` / `WX_MP_APP_SECRET` / `WX_MP_PROMPT_TEMPLATE_ID` 三个 `envVariables`，并 `tcb fn deploy practice --force`（部署前先备份上一版代码：本环境没有 published versions，回滚只能靠 `code update`）。
    - 验收口径：真机答完一题应弹授权 → 同意后 `users.promptSubscribeQuota` 变 1 → 次日 08:00 触发器跑完，summary 的 `subscribe` 从 `null` 变成 `{ attempted: 1, sent: 1, ... }`。**别把「看云端日志」写进验收**：本环境 `tcb fn log` 报 `SearchClsLog topic not exist`，查不到。
    - 这两步没做之前线上是安全空转：模板 ID 留空 → 前端不请求授权、云端 `subscribe: null`，站内提醒照常，不报错也不会误发。

名额增发（手动）：`node scripts/ops/invite-quota.mjs --report` 看本月有效回复榜，再 `--account <id> --add N --apply`。

每日一题录题（手动，OPS-M6-01）：`node scripts/ops/daily-prompt.mjs set --from-file scripts/ops/daily-prompt.seed.json` 预览 → 确认后加 `--apply`；当天要撤 `close --date … --apply`（只改 `status`，正文留着）；录完 `audit` 期望只输出「没问题 ✓」。索引侧待办 1 个：`prompt_answers.idx_prompt_list`，须用户授权后 `ensure-indexes.mjs --apply`。

**回滚**：重新部署上一个提交的 `community` / `moderation`。`memberships` / `invites` 数据无副作用可保留；但旧代码不看 `circleId`，圈内话题会对所有人可见——回滚窗口内应暂停对外发版 / 先导出清单。计数偏差用 `circles.mjs recount --apply` 校正。

