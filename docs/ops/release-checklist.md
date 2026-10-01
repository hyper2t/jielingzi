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

1. 本地验证：`npm run test:functions`、`npm run test:ops`、`npx jest --silent`、`npx tsc --noEmit` 全绿。
2. 建索引：`node scripts/ops/ensure-indexes.mjs --apply`（M4 新增 3 个：`circles.uniq_slug`、`memberships.idx_member`、`invites.idx_owner_time`）。
3. 只读审计：`node scripts/ops/circles.mjs audit`。旧话题 / 旧回复大于 0 时，先决定归到哪个圈子，`seed` 之后再 `migrate-topics --to <slug> --apply`；为 0（目前云端即是）则无需迁移。
4. 圈子种子：`node scripts/ops/circles.mjs seed` 预览 → `--apply`。名称 / 简介 / 公约改 `scripts/ops/circles.seed.json`，可重复执行。
5. 部署 `community` 与 `moderation`（`sync-shared` → 隔离登录 → `function-env.mjs` 核对环境变量 → `tcb fn deploy`，做法见上文「部署」）；`user` 不用动。部署后 `invoke-fn.mjs community '{"action":"ping"}'` 冒烟。
6. 第一批成员：`node scripts/ops/circles.mjs grant --circle mindful --phone <号> --apply`（自己和种子用户；`--latest` 取最近活跃账号）；再签发官方邀请码：`node scripts/ops/circles.mjs issue --circle mindful --count 5 --apply`，**清单只在终端显示一次**，立刻转交。
7. 复核：`circles.mjs audit`（计数无偏差）；用刚入圈的账号在小程序 / App 走一遍：看圈子 → 发话题 → 签发邀请码 → 另一账号兑换。
8. 发客户端（小程序提审、App 打包）。

名额增发（手动）：`node scripts/ops/invite-quota.mjs --report` 看本月有效回复榜，再 `--account <id> --add N --apply`。

**回滚**：重新部署上一个提交的 `community` / `moderation`。`memberships` / `invites` 数据无副作用可保留；但旧代码不看 `circleId`，圈内话题会对所有人可见——回滚窗口内应暂停对外发版 / 先导出清单。计数偏差用 `circles.mjs recount --apply` 校正。

