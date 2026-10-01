const path = require('path')
const { clientEnv, assertNoSecretInClientEnv } = require('./client-env')

// 构建前检查：.env* 里不允许出现带 TARO_APP_ 前缀的密钥类变量（会被注入前端包，BE-RN-05）
assertNoSecretInClientEnv(path.resolve(__dirname, '..'))

const OUTPUT_ROOT = process.env.TARO_OUTPUT_ROOT
  || (process.env.TARO_ENV === 'h5' ? 'dist-h5' : process.env.TARO_ENV === 'rn' ? 'dist-rn' : 'dist')

const config = {
  projectName: 'jielingzi',
  date: '2026-9-24',
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2
  },
  sourceRoot: 'src',
  // 输出目录按端隔离：weapp → dist（project.config.json 的 miniprogramRoot），h5 → dist-h5，rn → dist-rn。
  // 以前各端都写 dist，H5 构建会留下 chunk/*.js，再被小程序构建清掉，微信开发者工具的文件索引就会报
  // ENOENT dist/chunk/538.js（真机调试）。可用 TARO_OUTPUT_ROOT 覆盖（与正在运行的 dev watch 隔离验证构建）。
  outputRoot: OUTPUT_ROOT,
  // 前端 TARO_APP_* 变量兜底默认值；.env 中的值优先。缺了会导致小程序 process is not defined 白屏，见 client-env.js
  env: clientEnv(),
  // 路径别名，四端通用；需与 tsconfig.json 的 paths 保持一致
  alias: {
    '@': path.resolve(__dirname, '..', 'src')
  },
  plugins: [
    // Taro 3.6 小程序模板未透传 aria-*，注入后 ariaLabel / ariaRole / ariaHidden 才会生效（读屏，见 src/utils/a11y.ts）
    ['@tarojs/plugin-inject', {
      components: {
        View: { 'aria-label': "''", 'aria-role': "''", 'aria-hidden': "''" },
        Text: { 'aria-label': "''", 'aria-hidden': "''" },
        Image: { 'aria-label': "''", 'aria-hidden': "''" }
      }
    }]
  ],
  defineConstants: {
  },
  copy: {
    patterns: [
      // tabBar 图标需为包内静态文件，不能走 import
      { from: 'src/assets/tabbar/', to: `${OUTPUT_ROOT}/assets/tabbar/` }
    ],
    options: {
    }
  },
  framework: 'react',
  compiler: 'webpack5',
  cache: {
    enable: false // Webpack 持久化缓存配置，建议开启。默认配置请参考：https://docs.taro.zone/docs/config-detail#cache
  },
  mini: {
    webpackChain (chain) {
      // Tailwind 小程序适配：转义任意值类名、rem → rpx
      // weapp-tailwindcss 固定 4.x：5.x 只支持 tailwindcss v4，与本项目 tailwindcss v3 + twrnc 不兼容
      const { UnifiedWebpackPluginV5: WeappTailwindcss } = require('weapp-tailwindcss/webpack')
      chain.merge({
        plugin: {
          install: {
            plugin: WeappTailwindcss,
            args: [{
              appType: 'taro',
              rem2rpx: true
            }]
          }
        }
      })
    },
    postcss: {
      pxtransform: {
        enable: true,
        config: {

        }
      },
      url: {
        enable: true,
        config: {
          limit: 1024 // 设定转换尺寸上限
        }
      },
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        config: {
          namingPattern: 'module', // 转换模式，取值为 global/module
          generateScopedName: '[name]__[local]___[hash:base64:5]'
        }
      }
    }
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    postcss: {
      autoprefixer: {
        enable: true,
        config: {
        }
      },
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        config: {
          namingPattern: 'module', // 转换模式，取值为 global/module
          generateScopedName: '[name]__[local]___[hash:base64:5]'
        }
      }
    }
  },
  rn: {
    // 原生工程里注册的 RN 根组件名（MainActivity.getMainComponentName / AppDelegate moduleName），与产品名无关，勿改
    appName: 'taroDemo',
    entry: 'app',
    output: {
      ios: './ios/main.jsbundle',
      iosAssetsDest: './ios',
      android: './android/app/src/main/assets/index.android.bundle',
      androidAssetsDest: './android/app/src/main/res',
      // iosSourceMapUrl: '',
      iosSourcemapOutput: './ios/main.map',
      // iosSourcemapSourcesRoot: '',
      // androidSourceMapUrl: '',
      androidSourcemapOutput: './android/app/src/main/assets/index.android.map',
      // androidSourcemapSourcesRoot: '',
    },
    postcss: {
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
      }
    }
  }
}

module.exports = function (merge) {
  if (process.env.NODE_ENV === 'development') {
    return merge({}, config, require('./dev'))
  }
  return merge({}, config, require('./prod'))
}
