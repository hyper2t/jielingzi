/* 由 tools/gen-icons.js 生成，勿手改 */
import leaf from './leaf.png'
import sprout from './sprout.png'
import mountain from './mountain.png'
import waves from './waves.png'
import moon from './moon.png'
import sun from './sun.png'
import cloud from './cloud.png'
import trees from './trees.png'
import flower from './flower.png'
import wind from './wind.png'
import feather from './feather.png'
import bird from './bird.png'
import avatarDefault from './_default.png'
import avatarAnon from './_anon.png'

/** 预置头像（profiles.avatar = 'preset:<id>'），id 与云函数 AVATAR_PRESETS 一致 */
export const AVATARS = { leaf, sprout, mountain, waves, moon, sun, cloud, trees, flower, wind, feather, bird } as const
export type AvatarId = keyof typeof AVATARS
/** 没设头像时 */
export const AVATAR_DEFAULT = avatarDefault
/** 匿名发布时（不暴露个人头像） */
export const AVATAR_ANON = avatarAnon
