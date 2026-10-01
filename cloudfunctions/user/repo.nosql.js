'use strict'
/** users 集合的 NoSQL（文档型数据库）实现。PG 方案落地时新增 repo.pg.js 实现同一接口。 */

function createUserRepo(db) {
  const col = () => db.collection('users')
  return {
    async findByOpenid(openid) {
      const res = await col().where({ _openid: openid }).limit(1).get()
      return (res.data && res.data[0]) || null
    },
    async create(doc) {
      const res = await col().add(doc)
      return res.id || res._id
    },
    async update(id, patch) {
      await col().doc(id).update(patch)
    },
  }
}

module.exports = { createUserRepo }
