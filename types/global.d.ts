/// <reference types="@tarojs/taro" />

declare module '*.png';
declare module '*.gif';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.svg';
declare module '*.css';
declare module '*.less';
declare module '*.scss';
declare module '*.sass';
declare module '*.styl';

declare namespace NodeJS {
  interface ProcessEnv {
    TARO_ENV: 'weapp' | 'swan' | 'alipay' | 'h5' | 'rn' | 'tt' | 'quickapp' | 'qq' | 'jd'
    /** CloudBase 环境 ID（必填） */
    TARO_APP_CLOUD_ENV_ID?: string
    /** CloudBase 地域（H5 js-sdk，可选，默认 ap-shanghai） */
    TARO_APP_CLOUD_REGION?: string
    /** CloudBase Publishable Key（H5 js-sdk，可选） */
    TARO_APP_CLOUD_ACCESS_KEY?: string
    /** 数据源：cloud = CloudBase；其他 / 未配置 = mock（后端部署前默认） */
    TARO_APP_DATA_SOURCE?: string
    /** 字体子集 CDN 目录（可选，未配置时使用系统字体） */
    TARO_APP_FONT_BASE_URL?: string
    /** mock 数据源下单集的试听音频地址（可选，仅开发用；未配置时 mock 音频不可播放） */
    TARO_APP_MOCK_AUDIO_URL?: string
  }
}
