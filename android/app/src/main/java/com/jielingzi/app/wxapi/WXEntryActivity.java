package com.jielingzi.app.wxapi;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import com.wechatlib.WeChatLibModule;

/**
 * 微信 Open SDK 回调入口（NA-L01）。
 * 微信按「applicationId + .wxapi.WXEntryActivity」反射查找，本类的包名必须与 android/gradle.properties 的 app_id 一致
 * （app/build.gradle 会在配置阶段校验；改 app_id 时把本文件移到新包）。其余 Java 代码仍在 com.tarodemo 下，互不影响。
 * 只做一件事：把 Intent 交给 react-native-wechat-lib 派发到 JS（SendAuth.Resp → sendAuthRequest 的 Promise），然后立即关闭。
 */
public class WXEntryActivity extends Activity {
  private static final String TAG = "WXEntryActivity";

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    dispatch(getIntent());
    finish();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    dispatch(intent);
    finish();
  }

  private void dispatch(Intent intent) {
    try {
      // 尚未 registerApp（如微信主动拉起 App）时 SDK 内部 api 为空会抛 NPE：吞掉即可，不影响 App 本身
      WeChatLibModule.handleIntent(intent);
    } catch (Exception e) {
      Log.w(TAG, "handleIntent failed", e);
    }
  }
}
