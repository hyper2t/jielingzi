import { readFileSync } from 'node:fs'
import { resolveEnvId } from '../lib/env-id.mjs'
const env = Object.fromEntries(readFileSync('.env','utf8').split(/\r?\n/).map(l=>/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map(m=>[m[1],m[2]]))
const rc = JSON.parse(readFileSync('cloudbaserc.json','utf8'))
const tcb = (await import('@cloudbase/node-sdk')).default
const app = tcb.init({ env: resolveEnvId(rc.envId, { ...env, ...process.env }), secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY })
const [name, json] = process.argv.slice(2)
const t = Date.now()
const r = await app.callFunction({ name, data: JSON.parse(json || '{}') })
console.log(`${name} ${json} -> ${Date.now()-t}ms`, JSON.stringify(r.result))
