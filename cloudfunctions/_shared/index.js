'use strict'
/**
 * 云函数公共库（BE-06）。
 * 源码只维护在 cloudfunctions/_shared/；各函数通过 require('./_shared') 引用，
 * 由 `node scripts/sync-shared.mjs` 复制到 cloudfunctions/<fn>/_shared/（副本已 gitignore），
 * 部署与本地测试前都要先同步。
 */
module.exports = {
  ...require('./errors'),
  ...require('./validate'),
  ...require('./identity'),
  ...require('./handler'),
  ...require('./db'),
  ...require('./owned'),
  ...require('./settings'),
  ...require('./account'),
  ...require('./collections'),
  ...require('./config'),
  ...require('./guard'),
  ...require('./phone'),
  ...require('./wxmp'),
  ...require('./moderation'),
}
