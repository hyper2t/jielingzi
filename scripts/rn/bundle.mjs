#!/usr/bin/env node
/**
 * RN 离线包构建（FE-RN-01）。
 *
 * 为什么不用 `taro build --type rn`：@tarojs/rn-runner 只是 spawn 一个 `react-native bundle` 子进程，
 * 既不等待也不检查退出码——metro 报错（语法错误、样式转换失败）时命令仍以 0 退出，还可能留下上一次的旧产物，
 * CI 完全感知不到。这里做同样的事，但：
 *   1. 子进程非 0 退出码原样向上传播；
 *   2. 产物不存在或小于 MIN_BUNDLE_BYTES 视为失败（防止半截产物被打进 APK / IPA）；
 *   3. 构建前删除旧产物，构建后打印 bundle / sourcemap 体积；超过 MAX_BUNDLE_BYTES 给出警告（CI 可用 --strict 变为失败）。
 *
 * 用法：
 *   node scripts/rn/bundle.mjs --platform android|ios [--dev] [--no-sourcemap] [--reset-cache] [--strict]
 * 产物路径与 config/index.ts 的 rn.output 保持一致（可用 --bundle-output / --assets-dest / --sourcemap-output 覆盖）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { runIosNativeCheck } from './ios-native-check.mjs'

const MIN_BUNDLE_BYTES = 500 * 1024
const MAX_BUNDLE_BYTES = 3 * 1024 * 1024

/** 与 config/index.ts rn.output 一致；改动请两处同步 */
const OUTPUT = {
  android: {
    bundle: 'android/app/src/main/assets/index.android.bundle',
    sourcemap: 'android/app/src/main/assets/index.android.map',
    assets: 'android/app/src/main/res'
  },
  ios: {
    bundle: 'ios/main.jsbundle',
    sourcemap: 'ios/main.map',
    assets: 'ios'
  }
}

function parseArgs (argv) {
  const opts = { platform: '', dev: false, sourcemap: true, resetCache: false, strict: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--platform') opts.platform = next()
    else if (a.startsWith('--platform=')) opts.platform = a.slice('--platform='.length)
    else if (a === '--dev') opts.dev = true
    else if (a === '--no-sourcemap') opts.sourcemap = false
    else if (a === '--reset-cache') opts.resetCache = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--bundle-output') opts.bundleOutput = next()
    else if (a === '--sourcemap-output') opts.sourcemapOutput = next()
    else if (a === '--assets-dest') opts.assetsDest = next()
    else {
      console.error(`[rn:bundle] 未知参数 ${a}`)
      process.exit(2)
    }
  }
  if (opts.platform !== 'android' && opts.platform !== 'ios') {
    console.error('[rn:bundle] 请指定 --platform android|ios')
    process.exit(2)
  }
  return opts
}

/**
 * 用当前 node 直接运行 react-native 的 CLI 入口（react-native/cli.js），不再 spawn npx(.cmd)：
 * Windows 上 Node ≥ 18.20.2 / 20.12.2 起 spawn .cmd / .bat 不带 shell 会直接 EINVAL（CVE-2024-27980），
 * 而带 shell 又要处理路径里的空格与引号。解析不到入口时才退回 npx（Windows 加 shell）。
 */
function reactNativeCli () {
  try {
    return { cmd: process.execPath, prefix: [createRequire(import.meta.url).resolve('react-native/cli.js')], shell: false }
  } catch {
    const win = process.platform === 'win32'
    return { cmd: win ? 'npx.cmd' : 'npx', prefix: ['react-native'], shell: win }
  }
}

function fmt (bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.platform === 'ios') {
    // 微信登录的 URL Scheme / Universal Link 与 .env 一致性（NA-L03）；CI --strict 时不一致直接失败
    const { errors, warnings } = runIosNativeCheck()
    for (const w of warnings) console.warn(`[rn:bundle] iOS 原生配置提示：${w}`)
    for (const e of errors) console.error(`[rn:bundle] iOS 原生配置错误：${e}`)
    if (errors.length && opts.strict) process.exit(1)
  }
  const out = OUTPUT[opts.platform]
  const bundleOutput = resolve(opts.bundleOutput || out.bundle)
  const sourcemapOutput = opts.sourcemap ? resolve(opts.sourcemapOutput || out.sourcemap) : null
  const assetsDest = resolve(opts.assetsDest || out.assets)

  // 旧产物先删掉：失败时不会残留上一次的 bundle
  for (const f of [bundleOutput, sourcemapOutput]) {
    if (f && existsSync(f)) rmSync(f)
  }
  mkdirSync(dirname(bundleOutput), { recursive: true })
  mkdirSync(assetsDest, { recursive: true })

  const args = [
    'bundle',
    '--platform', opts.platform,
    '--dev', String(opts.dev),
    '--entry-file', 'index.js',
    '--bundle-output', bundleOutput,
    '--assets-dest', assetsDest
  ]
  if (sourcemapOutput) args.push('--sourcemap-output', sourcemapOutput)
  if (opts.resetCache) args.push('--reset-cache')

  const started = Date.now()
  console.log(`[rn:bundle] ${opts.platform} → ${bundleOutput}`)
  const cli = reactNativeCli()
  const res = spawnSync(cli.cmd, [...cli.prefix, ...args], {
    stdio: 'inherit',
    shell: cli.shell,
    env: {
      ...process.env,
      TARO_ENV: 'rn',
      NODE_ENV: opts.dev ? 'development' : 'production'
    }
  })
  if (res.error) {
    console.error('[rn:bundle] 无法启动 react-native bundle：', res.error.message)
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(`[rn:bundle] react-native bundle 失败（退出码 ${res.status}${res.signal ? `，信号 ${res.signal}` : ''}）`)
    process.exit(res.status || 1)
  }
  if (!existsSync(bundleOutput)) {
    console.error('[rn:bundle] 构建结束但产物不存在：', bundleOutput)
    process.exit(1)
  }
  const size = statSync(bundleOutput).size
  if (size < MIN_BUNDLE_BYTES) {
    console.error(`[rn:bundle] 产物过小（${fmt(size)} < ${fmt(MIN_BUNDLE_BYTES)}），视为失败`)
    process.exit(1)
  }
  const mapSize = sourcemapOutput && existsSync(sourcemapOutput) ? statSync(sourcemapOutput).size : 0
  console.log(`[rn:bundle] 完成，用时 ${((Date.now() - started) / 1000).toFixed(0)} s；bundle ${fmt(size)}${mapSize ? `，sourcemap ${fmt(mapSize)}` : ''}`)
  if (size > MAX_BUNDLE_BYTES) {
    const msg = `[rn:bundle] bundle 超过 ${fmt(MAX_BUNDLE_BYTES)} 阈值（${fmt(size)}），请检查是否引入了大依赖`
    if (opts.strict) {
      console.error(msg)
      process.exit(1)
    }
    console.warn(msg)
  }
}

main()
