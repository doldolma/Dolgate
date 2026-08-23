package com.dolgate

import android.content.pm.ActivityInfo
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 화면 방향을 앱이 직접 정한다.
 *
 * 원격 데스크톱은 가로가 기본인데, 폰의 자동 회전을 꺼 둔 사람은 세로로만 보게 된다. 그
 * 사람들이 시스템 설정을 건드리지 않고도 가로로 볼 수 있어야 해서 만들었다.
 *
 * **세션을 벗어나면 반드시 UNSPECIFIED 로 되돌려야 한다.** 안 되돌리면 홈 화면까지 가로로
 * 남는다 — 되돌리는 책임은 부르는 쪽(RemoteDesktopSurface 언마운트)에 있다.
 */
class ScreenOrientationModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  @ReactMethod
  fun lockLandscape() {
    apply(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
  }

  @ReactMethod
  fun unlock() {
    apply(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
  }

  private fun apply(orientation: Int) {
    val activity = reactApplicationContext.currentActivity ?: return
    // 방향 변경은 UI 스레드에서만 안전하다.
    activity.runOnUiThread {
      activity.requestedOrientation = orientation
    }
  }

  companion object {
    const val NAME = "ScreenOrientationModule"
  }
}
