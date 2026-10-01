/**
 * 支持 HTTP(S)_PROXY / NO_PROXY 环境变量的 fetch（Node 22 自带 fetch 不读代理环境变量；开发机常见走本地代理才能出网）。
 * 没有代理配置时就是原生 fetch；有代理时用 CONNECT 隧道 + https.request，返回的对象只实现脚本用到的
 * ok / status / headers.get / text() / json()。
 */
import http from 'node:http'
import https from 'node:https'

function proxyFor(url, env = process.env) {
  const u = new URL(url)
  const noProxy = (env.NO_PROXY || env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (noProxy.some((p) => p === '*' || u.hostname === p || (p.startsWith('.') && u.hostname.endsWith(p)))) return null
  const raw = u.protocol === 'https:'
    ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
    : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
  return raw ? new URL(raw) : null
}

function tunnel(proxy, target) {
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  const headers = { Host: `${target.hostname}:${port}` }
  if (proxy.username) {
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${target.hostname}:${port}`, headers })
    req.setTimeout(15000, () => req.destroy(new Error('代理 CONNECT 超时')))
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket)
      else { socket.destroy(); reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`)) }
    })
    req.on('error', reject)
    req.end()
  })
}

export async function fetchWithEnvProxy(url, init = {}) {
  const proxy = proxyFor(url)
  if (!proxy) return fetch(url, init)
  const target = new URL(url)
  if (target.protocol !== 'https:') return fetch(url, init) // 脚本只访问 https 接口；http 走原生
  const socket = await tunnel(proxy, target)
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: target.hostname,
      port: Number(target.port) || 443,
      servername: target.hostname,
      method: init.method || 'GET',
      path: target.pathname + target.search,
      headers: init.headers || {},
      socket,
      agent: false,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const headers = new Map(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]))
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        })
        socket.destroy()
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (init.body) req.write(init.body)
    req.end()
  })
}
