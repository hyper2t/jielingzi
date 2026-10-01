# 上线前检查（数据源切换）

前端数据源由 `.env` 的 `TARO_APP_DATA_SOURCE` 决定（见 `src/services/client.ts`）：`mock` 只改本机状态，任何云端写入（同意、设置、业务数据）都不会真的发生；**上线包必须为 `cloud`**。

## 步骤

1. TODO(business)：确认云端已有可展示的业务数据（否则切 cloud 后首页是空的），可仿照 luming 的 `ops:check-online` 写一个只读检查脚本。
2. `.env`：`TARO_APP_DATA_SOURCE=cloud`（本地想回 mock 演示，用 `.env.local` 覆盖，不要改 `.env`）。
3. 云函数与前端契约一致：`node scripts/sync-shared.mjs` 后重新部署 `user`（及业务云函数）；`node scripts/ops/ensure-collections.mjs` 建账号层集合，`node scripts/ops/security-rules.mjs --apply` 下发规则。
4. `npm run test:functions && npm test && npm run typecheck` 全绿；App 端再跑 `npm run rn:smoke`。
5. 真机回归：同意 → 登录（手机号 / 微信 / Apple）→ 设置页查看登录方式 → 退出 → 重新登录 → 注销账号回到同意弹窗；「清除本机数据」后保留登录态。

## 排障：真机调试报 `ENOENT ... dist\chunk\538.js`

- 原因：`dist` 同时被 H5（`chunk/*.js` 是 Taro H5 的异步 chunk 目录）和小程序构建写入，H5 产物被小程序构建清掉后，微信开发者工具的文件索引仍指向旧文件。`config/index.ts` 已按端隔离输出目录（weapp `dist`、h5 `dist-h5`、rn `dist-rn`），不会再互相覆盖。
- 处理：开发者工具「工具 → 清除缓存 → 清除全部缓存」→ 重启工具 → 重新编译 → 真机调试；仍报错就在真机调试面板切换 1.0 / 2.0 各试一次。构建端注意：`node_modules/@swc` 只有 Linux 二进制，`taro build` 需在 WSL 下跑，Windows 侧的 node 只用于脚本。

## 排障：开发者工具全部页面白屏，Console 报 `MiniProgramError … n[e] is not a function`

- 2026-09-29 出现过一次（重建 dist 后）。先跑 `node scripts/ops/weapp-smoke.cjs dist`：它在 Node 里模拟 wx 环境加载全部产物并渲染每个页面；如果这里正常（每页都有 setData、无 THROW），就是开发者工具缓存了旧分包 / 模板，「工具 → 清除缓存 → 全部清除」→ 编译即可。如果这里抛错，堆栈会直接指向产物文件，按文件找源码。
