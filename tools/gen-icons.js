/**
 * 图标导出（FE-02）：Lucide SVG → PNG@3x，供小程序 Image / tabBar 使用（小程序不支持内联 SVG）。
 * 产物提交入库，构建时不依赖本脚本。新增图标：改 ICONS 后运行 `node tools/gen-icons.js`。
 * 颜色取自 tailwind.config.js，不另写色值。
 */
const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')
const { theme } = require('../tailwind.config.js')

const c = theme.extend.colors
const COLORS = {
  ink: c.ink.DEFAULT,
  soft: c.ink.soft,
  brand: c.brand.DEFAULT,
  light: c.paper.light
}

// name -> { src: lucide 图标名, colors?: 额外颜色, fill?: 实心 }
const ICONS = {
  'chevron-left': {},
  'chevron-right': {},
  'chevron-down': {},
  play: { fill: true },
  pause: { fill: true },
  'skip-back': {},
  'skip-forward': {},
  repeat: {},
  'repeat-1': {},
  timer: {},
  'list-music': {},
  heart: {},
  'heart-fill': { src: 'heart', fill: true },
  sparkles: { colors: { apricot: c.apricot.dark } },
  check: {},
  lock: {},
  x: {},
  'loader-circle': {},
  'wifi-off': {},
  'refresh-cw': {},
  'audio-lines': {},
  'book-open': {},
  'a-large-small': {},
  clock: {},
  // 其余通用图标
  feather: {},
  'scroll-text': {},
  landmark: {},
  'layout-grid': {},
  // M1：发起话题（✎）、手机号绑定、18+ / 已实名、默认人像
  pencil: {},
  smartphone: {},
  'shield-check': {},
  'user-round': {}
}

// 预置头像（M1 练习档案，profiles.avatar = 'preset:<id>'）：令牌色圆底 + 白色 Lucide 自然意象，144px = 48pt@3x。
// id 与 cloudfunctions/_shared/config.js 的 AVATAR_PRESETS 一致（src/constants/__tests__/community.test.ts 比对）。
// 自定义头像上传随 M2 图片机审一起上线。
const AVATARS = {
  leaf: { src: 'leaf', bg: c.brand.DEFAULT },
  sprout: { src: 'sprout', bg: c.brand.dark },
  mountain: { src: 'mountain', bg: c.ink.soft },
  waves: { src: 'waves', bg: c.brand.dark },
  moon: { src: 'moon', bg: c.ink.DEFAULT },
  sun: { src: 'sun', bg: c.apricot.dark },
  cloud: { src: 'cloud', bg: c.ink.faint },
  trees: { src: 'trees', bg: c.brand.DEFAULT },
  flower: { src: 'flower-2', bg: c.apricot.dark },
  wind: { src: 'wind', bg: c.ink.soft },
  feather: { src: 'feather', bg: c.brand.dark },
  bird: { src: 'bird', bg: c.ink.faint }
}
// 没设头像：竹青浅底 + 竹青人像；匿名发布：纸色底 + 淡墨人像（不暴露任何个人头像）
const AVATAR_EXTRA = {
  _default: { src: 'user-round', bg: c.brand.light, fg: c.brand.DEFAULT },
  _anon: { src: 'user-round', bg: c.paper.dark, fg: c.ink.faint }
}

const TABS = { home: 'house', practice: 'sprout', mine: 'user' }

const root = path.resolve(__dirname, '..')
const lucideDir = path.join(root, 'node_modules/lucide-static/icons')
const iconDir = path.join(root, 'src/assets/icons')
const tabDir = path.join(root, 'src/assets/tabbar')
const avatarDir = path.join(root, 'src/assets/avatars')

function render (src, color, size, fill) {
  let svg = fs.readFileSync(path.join(lucideDir, `${src}.svg`), 'utf8')
    .replace(/<!--.*?-->/s, '')
    .replace(/currentColor/g, color)
  if (fill) svg = svg.replace('fill="none"', `fill="${color}"`)
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

/** 圆底头像：Lucide 线条图标居中占 50%，线宽随缩放 */
function renderAvatar (src, bg, fg, size) {
  const inner = fs.readFileSync(path.join(lucideDir, `${src}.svg`), 'utf8')
    .replace(/<!--.*?-->/s, '')
    .replace(/<svg[^>]*>/, '')
    .replace('</svg>', '')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
    `<circle cx="48" cy="48" r="48" fill="${bg}"/>` +
    `<g transform="translate(24 24) scale(2)" fill="none" stroke="${fg}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner}</g>` +
    '</svg>'
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

fs.mkdirSync(iconDir, { recursive: true })
fs.mkdirSync(tabDir, { recursive: true })
fs.mkdirSync(avatarDir, { recursive: true })

const entries = []
for (const [name, opt] of Object.entries(ICONS)) {
  const colors = { ...COLORS, ...(opt.colors || {}) }
  for (const [cname, hex] of Object.entries(colors)) {
    const file = `${name}-${cname}.png`
    fs.writeFileSync(path.join(iconDir, file), render(opt.src || name, hex, 72, opt.fill))
    entries.push([name, cname, file])
  }
}

// tabBar：81px 推荐尺寸，未选中 ink-soft，选中 brand-dark（与 app.config.ts 文字色一致）
for (const [name, src] of Object.entries(TABS)) {
  fs.writeFileSync(path.join(tabDir, `${name}.png`), render(src, c.ink.soft, 81))
  fs.writeFileSync(path.join(tabDir, `${name}-active.png`), render(src, c.brand.dark, 81))
}

// 生成类型化索引
const ident = (n, cn) => `${n}_${cn}`.replace(/-/g, '_')
const lines = [
  '/* 由 tools/gen-icons.js 生成，勿手改 */',
  ...entries.map(([n, cn, f]) => `import ${ident(n, cn)} from './${f}'`),
  '',
  'export const ICONS = {',
  ...Object.keys(ICONS).map(n => {
    const cs = entries.filter(e => e[0] === n).map(([, cn]) => `${cn}: ${ident(n, cn)}`)
    return `  '${n}': { ${cs.join(', ')} },`
  }),
  '} as const',
  '',
  'export type IconName = keyof typeof ICONS',
  'export type IconColor<N extends IconName = IconName> = keyof (typeof ICONS)[N]',
  ''
]
fs.writeFileSync(path.join(iconDir, 'index.ts'), lines.join('\n'))
console.log(`icons: ${entries.length}, tabs: ${Object.keys(TABS).length * 2}`)

// 预置头像 + 默认 / 匿名头像
for (const [id, a] of Object.entries(AVATARS)) fs.writeFileSync(path.join(avatarDir, `${id}.png`), renderAvatar(a.src, a.bg, c.paper.light, 144))
for (const [id, a] of Object.entries(AVATAR_EXTRA)) fs.writeFileSync(path.join(avatarDir, `${id}.png`), renderAvatar(a.src, a.bg, a.fg, 144))
fs.writeFileSync(path.join(avatarDir, 'index.ts'), [
  '/* 由 tools/gen-icons.js 生成，勿手改 */',
  ...Object.keys(AVATARS).map(id => `import ${id} from './${id}.png'`),
  "import avatarDefault from './_default.png'",
  "import avatarAnon from './_anon.png'",
  '',
  "/** 预置头像（profiles.avatar = 'preset:<id>'），id 与云函数 AVATAR_PRESETS 一致 */",
  `export const AVATARS = { ${Object.keys(AVATARS).join(', ')} } as const`,
  'export type AvatarId = keyof typeof AVATARS',
  '/** 没设头像时 */',
  'export const AVATAR_DEFAULT = avatarDefault',
  '/** 匿名发布时（不暴露个人头像） */',
  'export const AVATAR_ANON = avatarAnon',
  ''
].join('\n'))
console.log(`avatars: ${Object.keys(AVATARS).length} + ${Object.keys(AVATAR_EXTRA).length}`)

// 空态插画占位：品牌标志（正式插画到位前使用），360px = 120pt@3x
{
  const svg = fs.readFileSync(path.join(root, 'src/assets/brand/logo-mark.svg'), 'utf8')
  fs.writeFileSync(path.join(root, 'src/assets/brand/mark.png'),
    new Resvg(svg, { fitTo: { mode: 'width', value: 360 } }).render().asPng())
}
