package com.dolgate

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Dolgate"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * savedInstanceState 를 넘기지 않는다 — OS 가 백그라운드 프로세스를 회수한 뒤 작업 목록에서
   * 재진입하면 Android 가 프래그먼트 상태를 복원하는데, react-native-screens 의 ScreenFragment
   * 는 복원을 허용하지 않아 IllegalStateException 으로 앱이 죽는다("Screen fragments should
   * never be restored"). RN 화면 상태는 JS 쪽에서 복원하므로 여기서 버려도 안전하다.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    requestedOrientation =
        android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    super.onCreate(null)
  }

  override fun onNewIntent(intent: Intent) {
    // Keep the latest deep link intent on the activity so React Native Linking
    // can read it consistently after the app is resumed from the browser.
    setIntent(intent)
    super.onNewIntent(intent)
  }
}
