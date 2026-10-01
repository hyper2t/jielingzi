# 上线资质与合规清单（OPS-M0-01）

> 主体：**企业**。平台：微信小程序 + iOS / Android App。本清单需在 M0 启动，最长的一项决定上线日期。
> 资质要求以微信公众平台「服务类目」页面与当地通信管理局的最新口径为准，提交前再核对一次：
> https://developers.weixin.qq.com/miniprogram/product/material/

## 1. 小程序服务类目

| 项 | 结论 / 动作 | 状态 |
|---|---|---|
| 推荐类目 | **社交 › 笔记** 或 **社交 › 论坛**（以用户发帖、长文交流为主）。不选"婚恋 / 交友 / 直播"类目 | ☐ |
| 类目资质 | 企业主体需提供与主体一致的 **ICP 备案（非经营性互联网信息服务备案）**；营业执照本身不够 | ☐ |
| 何时需要 ICP **许可证** | 开始收费（会员费 v1.0）或经营性服务时，升级为《增值电信业务经营许可证》（第二类 B25 信息服务）。MVP 免费，暂不需要 | — |
| 不在 MVP 范围、暂不申请 | 一对一私聊（即时通信属性更强，v0.3 前复核）、语音房间（音视频，v0.4 前复核） | — |

> 不要用"先以其它类目上线、再打开社交功能"的方式规避审核——会导致下架与主体信用受损。

## 2. 备案与评估

| 项 | 说明 | 负责 | 状态 |
|---|---|---|---|
| 域名 + 网站 ICP 备案 | 云函数 HTTP 访问 / 协议页如需自有域名 | OPS | ☐ |
| **小程序备案** | 微信公众平台 → 小程序备案（2023-09 起新小程序必须备案后才能上线） | OPS | ☐ |
| **App 备案** | iOS / Android 均需在接入商处完成 App ICP 备案，否则应用商店不予上架 | OPS | ☐ |
| **互联网信息服务安全评估** | 社区具有舆论属性，上线前在「全国互联网安全管理服务平台」提交安全评估报告（用户实名、内容审核、日志留存、应急处置） | OPS + BE | ☐ |
| 公安联网备案 | 网站 / App 上线后 30 日内在全国互联网安全管理服务平台备案 | OPS | ☐ |
| 软件著作权 | 安卓商店（华为 / 小米 / OPPO / vivo 等）上架通常要求 | OPS | ☐ |

## 3. 必须具备的产品能力（安全评估 / 审核会检查）

| 能力 | 落地 | 里程碑 |
|---|---|---|
| 后台实名（手机号） | 发布前绑定手机号，`guardWrite` 拦截 40302；小程序手机号快捷验证（`user.bindPhoneWeapp`）/ App 手机号登录或绑定；只存 HMAC 哈希 | M1 ✅（代码） |
| 内容审核（机审 + 人审） | 文本：词库 + `msgSecCheck`（M2 ✅ 代码）；图片：`mediaCheckAsync`（BE-M2-02 待做）；举报 + 审核队列 + 处罚（M2 ✅ 代码） | M2 |
| 日志留存 ≥ 6 个月 | `mod_logs`（机审 / 人工处理，`expireAt` = 6 个月，需建 TTL 索引）+ 云函数日志；用户发布记录保留（注销后解除归属） | M2 ✅（代码） |
| 举报入口与处理 | 每条内容可举报（`ReportSheet`），达 3 人自动折叠，审核队列 24h 内处理，结果站内通知 | M2 ✅（代码；入口随 M3 内容卡片） |
| 未成年人保护 | 首次进入 18+ 确认（`pkg-user/pages/adult`，`user.confirmAdult`），协议与社区公约写明 | M1 ✅（代码） |
| 用户协议 / 隐私政策 / 社区公约 | `docs/prd/community-rules.md`；隐私政策列 SDK 清单（`docs/ops/app-sdk-list.md`） | M0–M2 |
| 注销账号 | 已有（user.deleteAccount） | 已有 |
| 应急处置预案 | 封禁 / 下架 / 关闭发帖开关的操作手册 | M7 |

## 3.1 M1 上线前要做的平台配置

| 项 | 说明 | 状态 |
|---|---|---|
| 小程序《用户隐私保护指引》 | 声明收集「手机号」（发布前实名）与用户主动填写的档案信息；未声明时 getPhoneNumber 等隐私接口不可用 | ☐ |
| 手机号快捷验证组件计费 | 微信对手机号验证组件按次计费（有免费额度），以微信公众平台最新说明为准；上线前确认额度 / 余额，避免实名入口失效 | ☐ |
| 云函数环境变量 | `user`：`WX_MP_APP_ID` / `WX_MP_APP_SECRET` / `PHONE_HASH_SECRET`；`moderation`：`WX_MP_APP_ID` / `WX_MP_APP_SECRET`（见 `.env.example`） | ☐ |
| `PHONE_HASH_SECRET` 保管 | 随机生成后离线备份；**启用后不可更换**（更换会让已绑定的手机号全部失效） | ☐ |
| 索引 | `profiles._openid` 唯一、`profiles.anonAlias` 唯一（`docs/ops/collections.md` §3） | ☐ |

## 4. 待你提供 / 确认

- [ ] 企业主体名称与营业执照
- [x] 小程序正式 AppID：`wxa9a39ea781ab3c58`（2026-10-01：`project.config.json` 与 `.env` 的 `WX_MP_APP_ID` 一致；原 project.config.json 是 luming 遗留的 AppID 与描述）
- [ ] 微信开放平台移动应用 AppID / AppSecret / Universal Link（`.env`：`WX_APP_ID`、`WX_APP_SECRET`、`TARO_APP_WX_APP_ID`、`TARO_APP_WX_UNIVERSAL_LINK`）
- [ ] Apple 开发者账号（`.env`：`APPLE_TEAM_ID`、`APPLE_KEY_ID`、`APPLE_PRIVATE_KEY`）
- [ ] 用于备案的域名
- [ ] 内容审核值班人（至少 2 人，响应时效 24h）
- [ ] 小程序 AppSecret（`WX_MP_APP_SECRET`）与手机号哈希密钥 `PHONE_HASH_SECRET`（M1 实名用）
