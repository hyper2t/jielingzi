import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PLACEHOLDER, renderAasa, validateAasa } from './prepare-aasa.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const template = readFileSync(resolve(root, 'public/.well-known/apple-app-site-association'), 'utf8')
const UL = 'https://jielingzi.cn/app/'

test('仓库里的模板保留占位符,且是合法 JSON', () => {
  assert.ok(template.includes(PLACEHOLDER))
  assert.doesNotThrow(() => JSON.parse(template))
})

test('渲染:替换 Team ID 后通过校验,并覆盖 Universal Link 路径', () => {
  const out = renderAasa(template, 'ABCDE12345')
  assert.ok(!out.includes(PLACEHOLDER))
  assert.ok(out.includes('ABCDE12345.com.jielingzi.app'))
  assert.deepEqual(validateAasa(out, { universalLink: UL }), [])
})

test('渲染:Team ID 非法或为空时抛错', () => {
  for (const bad of ['', undefined, 'abc', 'abcde12345', 'ABCDE1234', 'ABCDE123456', 'ABCDE-2345']) {
    assert.throws(() => renderAasa(template, bad), /APPLE_TEAM_ID/)
  }
})

test('渲染:模板没有占位符时抛错(避免静默发布错误内容)', () => {
  assert.throws(() => renderAasa('{}', 'ABCDE12345'), /占位符/)
})

test('校验:未替换占位符 / 非 JSON / 结构错误', () => {
  assert.ok(validateAasa(template).some((e) => e.includes('占位符') || e.includes('appIDs')))
  assert.match(validateAasa('{oops')[0], /JSON/)
  assert.ok(validateAasa('{"applinks":{"details":[]}}').length > 0)
})

test('校验:Bundle ID 不对会报错', () => {
  const out = renderAasa(template, 'ABCDE12345').replace('com.jielingzi.app', 'com.other.app')
  assert.ok(validateAasa(out).some((e) => e.includes('appIDs')))
})

test('校验:Universal Link 路径没被覆盖会报错', () => {
  const out = renderAasa(template, 'ABCDE12345')
  assert.ok(validateAasa(out, { universalLink: 'https://jielingzi.cn/other/' }).some((e) => e.includes('/other/')))
  assert.deepEqual(validateAasa(out, { universalLink: 'https://jielingzi.cn/app/' }), [])
})
