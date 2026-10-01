/**
 * 把 cloudfunctions/_shared 复制到每个云函数目录下的 _shared/（副本已 gitignore）。
 * 部署前、本地测试前执行：node scripts/sync-shared.mjs
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'cloudfunctions')
const src = join(root, '_shared')
const fns = readdirSync(root).filter(
  (d) => !d.startsWith('_') && !d.startsWith('.') && statSync(join(root, d)).isDirectory() && existsSync(join(root, d, 'index.js')),
)
for (const fn of fns) {
  const dest = join(root, fn, '_shared')
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true, filter: (p) => !/[\\/](test|__tests__)([\\/]|$)/.test(p) })
}
console.log(`synced _shared -> ${fns.join(', ') || '(none)'}`)
