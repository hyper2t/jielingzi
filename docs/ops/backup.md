# 运维：用量监控与备份（BE-22）

环境 `.env` 的 `TARO_APP_CLOUD_ENV_ID`（个人版，开发与生产共用，**没有自动备份**）。脚本：`scripts/ops/usage.ts`、`scripts/ops/backup.ts`，测试 `npm run test:ops`。

## 1. 用量检查（只读）

```bash
node scripts/ops/usage.ts            # 调 tcb env usage，输出按模块报表
node scripts/ops/usage.ts --json     # 机器可读
node scripts/ops/usage.ts --file saved.json --quota 40000 --warn 70 --critical 90
```

- 主指标：本计费周期**资源点消耗 / 额度**（个人版 40000）。CLI 不返回各模块免费上限，所以不按模块设阈值（03-backend §6）。
- 另按日均消耗推算周期末用量，推算超过 100% 也预警。
- 退出码：0 正常 ｜ 2 预警（≥70% 或推算超额）｜ 3 严重（≥90%）｜ 1 查询失败。
- 频率：上线前每周一次；上线后每天一次（可放入 Windows 计划任务，非 0 退出码发提醒）。
- CLI 登录过期时会弹出设备码授权页，需要人工在浏览器确认一次。

### 70% 预警清单

| 顺序 | 检查 | 处理 |
|---|---|---|
| 1 | 报表里资源点最高的模块 | 定位是 CDN、数据库读写还是云函数 |
| 2 | CDN 流量 | 静态资源是否压缩；有无异常下载（同一文件高频） |
| 3 | 数据库读 | 列表是否分页；前端请求缓存是否生效 |
| 4 | 云函数调用 | 高频上报是否节流；有无重试风暴 |
| 5 | 推算仍超额 | 与 PM 评估升级套餐 |

## 2. 备份 SOP

| 时机 | 做法 |
|---|---|
| 改集合结构 / 规则 / 批量写 / 删除前 | `node scripts/ops/backup.ts export`（全量） |
| 每周一次 | `node scripts/ops/backup.ts export` 全量导出 |
| 上线前（清理测试数据前） | 全量导出 + `verify`，备份目录记录在检查清单里 |

- 导出只读，`COLLECTIONS`（`scripts/ops/backup.ts`，业务集合需登记）分页（每页 1000）写入 `backups/full/<UTC 时间>/<集合>.json`，并生成 `manifest.json`（每个集合的条数）。
- `node scripts/ops/backup.ts verify --dir <目录>`：核对条数与 manifest 一致、`_id` 无缺失无重复。
- `backups/` 已被 gitignore。`users` 等集合含个人数据：**只存本机或私有位置，不上传网盘 / 仓库**；保留最近 4 份全量，更早的删除。
- 云存储文件不在此备份内。

## 3. 还原

```bash
# 演练（默认）：还原到新集合 <集合>_restore_drill，写入后逐条比对
node scripts/ops/backup.ts restore --dir backups/full/<时间> --collection users          # 只打印计划
node scripts/ops/backup.ts restore --dir backups/full/<时间> --collection users --yes    # 执行（会新建集合，需确认）

# 真实恢复正式集合：必须显式 --to <正式名> --overwrite --yes；脚本会先导出该集合当前数据
node scripts/ops/backup.ts restore --dir backups/full/<时间> --collection users --to users --overwrite --yes
```

- 按 `_id` 执行 set，幂等，失败后可以重跑。备份之后新增的文档不会被删除，如需删除请人工处理。
- 演练集合默认权限是仅管理端可读写；演练结束后删除 `*_restore_drill`（删除需确认），可以在控制台删，或用 CLI：`tcb db nosql execute -e <env> --command '[{"TableName":"users_restore_drill","CommandType":"COMMAND","Command":"{\"drop\":\"users_restore_drill\"}"}]'`（PowerShell 5 会吞引号，建议在 node 里用 spawnSync 传参）。

## 4. 演练记录

| 日期 | 内容 | 结果 |
|---|---|---|
| | （新环境首次全量导出 + 演练还原后在此记录） | |
