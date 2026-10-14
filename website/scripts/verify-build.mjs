// 构建后自检:确认 dist/ 里有部署所需的全部文件,且页面引用的资源真实存在。
//   npm run build && npm run verify
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const errors = [];

for (const f of ['index.html', 'rules.html', '404.html', 'robots.txt', 'favicon.svg']) {
  if (!existsSync(join(dist, f))) errors.push(`缺少 dist/${f}`);
}
const assets = existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')) : [];
if (!assets.some((a) => a.endsWith('.css'))) errors.push('dist/assets/ 里没有 CSS');
if (!assets.some((a) => a.endsWith('.js'))) errors.push('dist/assets/ 里没有 JS');

// 页面里以 / 开头、指向本站文件的引用必须存在(锚点与外链不检查)
for (const page of ['index.html', 'rules.html', '404.html']) {
  const file = join(dist, page);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  if (!/<link rel="stylesheet" href="\/assets\/[^"]+\.css"/.test(html)) errors.push(`${page} 没有引用 CSS`);
  if (!/<script type="module" src="\/assets\/[^"]+\.js"/.test(html)) errors.push(`${page} 没有引用 JS`);
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) {
    const p = m[1];
    if (p === '/') continue;
    if (!existsSync(join(dist, p))) errors.push(`${page} 引用了不存在的 ${p}`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`[verify] 错误:${e}`);
  process.exit(1);
}
console.log('[verify] dist/ 完整,页面引用的资源均存在');
