/**
 * 前端（小程序 / H5 / App）代码里用到的全部 TARO_APP_* 变量及默认值。
 *
 * 背景：Taro 只会替换 .env 文件里**写了**的 TARO_APP_* 变量；没写的变量会在产物里原样留下
 * `process.env.XXX`。小程序运行时没有 `process` 全局，app.js 一加载就抛
 * `ReferenceError: process is not defined`，所有页面注册失败，界面只剩原生 tabBar。
 *
 * 这里给每个变量一个兜底值，放进 config.env。Taro CLI 会用 .env 里的值覆盖它们
 * （@tarojs/cli：initialConfig.env = patchEnv(config, dotenv)），所以 .env 始终优先。
 *
 * 新增前端变量时必须同步加到这里；src/utils/__tests__/client-env.test.ts 会扫描 src 做检查。
 */
const CLIENT_ENV_DEFAULTS = {
  /** CloudBase 环境 ID（cloud 数据源必填） */
  TARO_APP_CLOUD_ENV_ID: '',
  /** H5 js-sdk 地域（可选） */
  TARO_APP_CLOUD_REGION: '',
  /** H5 js-sdk Publishable Key（可选） */
  TARO_APP_CLOUD_ACCESS_KEY: '',
  /** 数据源：cloud | mock（默认） */
  TARO_APP_DATA_SOURCE: 'mock',
  /** 字体子集 CDN 目录（可选） */
  TARO_APP_FONT_BASE_URL: '',
  /** App 微信登录：开放平台「移动应用」AppID（可公开；Secret 只在云函数 user 的环境变量里）。为空 = 微信登录不可用（FE-L05） */
  TARO_APP_WX_APP_ID: '',
  /** App 微信登录（iOS）：Universal Link，如 https://<官网域名>/app/ */
  TARO_APP_WX_UNIVERSAL_LINK: '',
  /** App 字体：'' = 系统字体（Playground / 未打包字体的安装包）；'bundled' = 安装包已打入品牌字体（docs/ops/rn-dev-client.md「字体」） */
  TARO_APP_RN_FONTS: '',
  /** 小程序订阅消息模板 ID（每日一题提醒）：为空 = 前端根本不请求授权，见 src/features/notify/subscribe.ts */
  TARO_APP_WX_MP_PROMPT_TEMPLATE_ID: ''
}

/** 转成 Taro config.env 需要的格式（值为 JSON 字符串字面量） */
function clientEnv () {
  return Object.fromEntries(
    Object.entries(CLIENT_ENV_DEFAULTS).map(([key, value]) => [key, JSON.stringify(value)])
  )
}

/** 变量名里出现这些词就视为密钥：管理员 API Key、SecretKey、私钥、密码、令牌都不允许带 TARO_APP_ 前缀 */
const SECRET_NAME_RE = /(API_KEY|SECRET|PRIVATE|PASSWORD|TOKEN)/i

/**
 * 断言（BE-RN-05）：没有任何 TARO_APP_* 变量名像密钥。
 * Taro 会把 .env 里所有 TARO_APP_ 前缀的变量注入前端包（三端都一样）；CloudBase 管理员 API Key / 腾讯云 SecretKey
 * 一旦带了这个前缀，只要有代码引用就会进入小程序 / App 安装包。曾经的 TARO_APP_CLOUD_API_KEY 已改名 CLOUDBASE_API_KEY。
 * 扫描对象：项目根目录所有 .env* 文件里的 key（不读取值）+ 当前进程环境变量名。发现即抛错，构建中止。
 */
function assertNoSecretInClientEnv (rootDir, env = process.env) {
  const fs = require('fs')
  const path = require('path')
  const offenders = []
  const check = (key, where) => {
    if (key.startsWith('TARO_APP_') && SECRET_NAME_RE.test(key.slice('TARO_APP_'.length))) offenders.push(`${key}（${where}）`)
  }
  if (rootDir && fs.existsSync(rootDir)) {
    for (const name of fs.readdirSync(rootDir)) {
      if (!name.startsWith('.env')) continue
      const file = path.join(rootDir, name)
      if (!fs.statSync(file).isFile()) continue
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
        if (m) check(m[1], name)
      }
    }
  }
  for (const key of Object.keys(env || {})) check(key, 'process.env')
  if (offenders.length) {
    throw new Error(
      `[client-env] 以下变量名像密钥却带 TARO_APP_ 前缀，会被 Taro 注入前端包：${offenders.join('、')}。` +
      '请去掉 TARO_APP_ 前缀（如 CLOUDBASE_API_KEY），只在本地脚本中使用。'
    )
  }
}

module.exports = { CLIENT_ENV_DEFAULTS, clientEnv, assertNoSecretInClientEnv, SECRET_NAME_RE }
