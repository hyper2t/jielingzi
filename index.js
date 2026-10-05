import '@tarojs/rn-supporter/entry-file.js'

// 业务需要后台服务时在这里注册（luming 在此注册 react-native-track-player 的播放服务，
// 且只在 NativeModules.TrackPlayerModule 存在时 require，避免 Taro Playground 等壳应用启动即崩，见 docs/ops/rn-dev-client.md）。
