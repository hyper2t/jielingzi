# 结灵子门户官网

结灵子官网(首页、社区公约、404)。基于 [Astro](https://astro.build) 的**纯静态站**,构建产物是普通 HTML/CSS/JS,页面外观与改造前的手写静态站一致。

> 本目录是独立的 npm 工程,与仓库根目录的 Taro 小程序/App(yarn)互不影响。

## 常用命令

```bash
cd website
npm install          # 首次安装依赖
npm run dev          # 本地开发,http://localhost:4321(热更新)
npm run build        # 构建到 dist/
npm run preview      # 本地预览 dist/
npm run verify       # 构建后自检:文件齐全、页面引用的资源都存在
npm test             # AASA 生成/校验的单元测试
npm run deploy:dry   # 发布演练:构建 + 生成/校验 AASA,不登录、不上传
npm run deploy       # 发布到 CloudBase 静态托管(需确认)
```

需要 Node.js ≥ 20.3。

## 目录结构

```
website/
├─ astro.config.mjs        构建配置(静态输出、dist/assets/、隔离 PostCSS)
├─ public/                 原样复制到 dist/ 根目录的文件
│  ├─ favicon.svg
│  ├─ robots.txt
│  └─ .well-known/apple-app-site-association   Universal Link 的 AASA 模板(Team ID 为占位)
├─ src/
│  ├─ pages/               每个文件对应一个页面:index / rules / 404
│  ├─ layouts/Layout.astro 页面骨架:<head>、导航、页脚、脚本
│  ├─ components/
│  │  ├─ Logo.astro        品牌标记(big 为页脚上方“加入”区的大号版本)
│  │  ├─ Header.astro      导航(home=首页版 / 子页精简版)
│  │  ├─ Footer.astro      页脚(同上两个版本)
│  │  └─ home/             首页各区块:Hero、Why、Features、Circles、Safety、Faq、Join
│  ├─ styles/site.css      全站样式(色板见 docs/prd/README.md §2)
│  └─ scripts/site.js      导航阴影、练习热力图、滚动渐显
├─ scripts/
│  ├─ deploy.sh            发布脚本(构建 → AASA → 隔离登录 → 上传 → 上传后检查)
│  ├─ prepare-aasa.mjs     用 .env 的 APPLE_TEAM_ID 替换占位并校验 AASA(附 .test.mjs)
│  └─ verify-build.mjs     构建后自检
└─ dist/                   构建产物(不入库)
```

## 怎么改

- **改文案**:首页在 `src/components/home/*.astro`,社区公约在 `src/pages/rules.astro`。
- **改样式**:`src/styles/site.css`(普通 CSS,没有预处理器)。
- **改导航/页脚**:`src/components/Header.astro`、`Footer.astro`。
- **新增页面**:在 `src/pages/` 新建 `xxx.astro`,用 `<Layout title="…">` 包裹,构建后得到 `/xxx.html`。
- **SEO 信息**(description、og:*):首页在 `src/pages/index.astro` 顶部的 `meta` 对象里。

## 部署

- 部署目录是 **`website/dist/`**(不再是 `website/` 本身),站点需部署在域名根路径。
- `dist/404.html` 为未命中页面;`dist/assets/` 里的文件名带内容哈希,可设置长期缓存;HTML 建议不缓存或短缓存。

### 发布流程

```bash
npm run deploy:dry     # 先演练:确认构建、AASA 生成与校验都通过
npm run deploy         # 正式发布,会让你输入 yes 确认;CI 用 `bash scripts/deploy.sh --yes`
```

`scripts/deploy.sh` 读取环境变量,其次读取仓库根目录 `.env`(不会 source,不会打印密钥):

| 变量 | 作用 | 必需 |
|---|---|---|
| `TARO_APP_CLOUD_ENV_ID` | CloudBase 环境 ID | 发布必需 |
| `CLOUDBASE_SECRET_ID` / `CLOUDBASE_SECRET_KEY` | 该环境所属账号的 API 密钥 | 发布必需 |
| `APPLE_TEAM_ID` | 10 位 Team ID,替换 AASA 占位 | 必需 |
| `TARO_APP_WX_UNIVERSAL_LINK` | 如 `https://jielingzi.cn/app/`,用于校验 AASA 覆盖路径与发布后检查线上域名 | 可选 |

要点:
- **隔离登录**:本机全局的 `tcb` 登录可能是别的账号。脚本把 `HOME`/`USERPROFILE` 指到临时目录再登录,结束即删除,不影响全局登录。
- **不使用 `--prune`**:同一托管空间里可能还有 `/cloud-admin/`、`/__auth/` 等不属于官网的内容,脚本只新增/覆盖文件。上传带 `--safe`(先备份、失败回滚)与 `--verify`。
- **AASA 每次从模板重新生成**,所以重复执行(含 `--no-build`)是幂等的;`dist/` 里残留占位符时脚本会中止。
- 发布后会检查云端 `.well-known/` 下确实有 AASA;并尝试访问 Universal Link 域名,**仅警告**(域名未绑定时属预期)。

### Universal Link(微信登录回跳 iOS App)

AASA 模板声明:App `<TeamID>.com.jielingzi.app` 处理 `/app/*` 路径(iOS 13+ 的 `appIDs` + `components` 格式)。要真正生效,还需要三处保持一致:

1. `.env` 的 `TARO_APP_WX_UNIVERSAL_LINK`(当前为 `https://jielingzi.cn/app/`)。
2. `ios/taroDemo/taroDemo.entitlements` 的 `applinks:<域名>`(目前仍是占位 `applinks:TODO-your-universal-link-host.example.com`,`node scripts/rn/ios-native-check.mjs` 会报错)。
3. 微信开放平台登记的 Universal Links。

另外需要自行确认的事项:
- 自定义域名要绑定到该托管环境,并且 `https://<域名>/.well-known/apple-app-site-association` 必须是 HTTPS、**不重定向**、返回 JSON。
- 无扩展名文件在静态托管上可能以 `application/octet-stream` 返回;CLI 无法设置 Content-Type,首次发布后请用 Apple 验证工具(或 `https://app-site-association.cdn-apple.com/a/v1/<域名>`)确认能被识别。
- CloudBase 把 `/.well-known` 列为系统保留前缀(自定义路由不能使用),首次发布后请确认上传的文件确实被对外提供。
- Apple 会缓存 AASA,修改后可能需要一段时间才生效;iOS 只在 App 安装/更新时拉取。

## 注意事项

- `astro.config.mjs` 里显式关闭了 PostCSS 插件。否则 Vite 会向上找到仓库根目录的 `postcss.config.js`(小程序用的 tailwind + autoprefixer),污染官网样式。
- CSS 压缩目标设为较老内核(chrome61 / safari11),保持与原手写 CSS 相同的写法(如 `rgba()`),兼容部分安卓微信 WebView。
- 脚本不内联进 HTML,以外部 JS 文件发布,便于缓存与日后加 CSP。
