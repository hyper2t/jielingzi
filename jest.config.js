/**
 * 最小 jest 配置：组件快照 + 纯函数单测（node 环境，react-test-renderer）。
 * Taro 组件与 API 用 test/mocks 下的轻量替身；不走 babel-preset-taro，避免引入构建期插件。
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', {
      configFile: false,
      babelrc: false,
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        ['@babel/preset-react', { runtime: 'automatic' }],
        '@babel/preset-typescript'
      ]
    }]
  },
  moduleNameMapper: {
    '^@tarojs/components$': '<rootDir>/test/mocks/taro-components.tsx',
    '^@tarojs/taro$': '<rootDir>/test/mocks/taro.ts',
    '\\.(png|jpe?g|gif|svg)$': '<rootDir>/test/mocks/file.js',
    '\\.(css|scss)$': '<rootDir>/test/mocks/style.js',
    '\\.(wav)$': '<rootDir>/test/mocks/file.js',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  setupFiles: ['<rootDir>/test/setup.js']
}
