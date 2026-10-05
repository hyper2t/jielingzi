/**
 * CloudBase 统一入口。Taro 按平台后缀解析：
 *   weapp → cloud.weapp.ts ｜ h5 → cloud.h5.ts ｜ rn → cloud.rn.ts
 * 本文件为 tsc 与其他平台的兜底，复用小程序实现（接口一致）。
 * 各平台文件都 re-export cloud.types，业务层统一 `import { cloud, CloudError } from '@/services/cloud'`。
 */
export * from './cloud.weapp'
