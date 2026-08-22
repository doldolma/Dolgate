package com.dolssh.remotedesktop

import android.graphics.Color
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.Event

/**
 * ViewManager for RemoteDesktopSurface.
 *
 * Implements the New Architecture interop ViewManager pattern — auto-bridged to Fabric.
 * The component name matches the codegen spec for future pure-Fabric migration.
 */
class RemoteDesktopSurfaceManager : SimpleViewManager<RemoteDesktopTextureView>() {

    override fun getName(): String = REACT_CLASS

    override fun createViewInstance(reactContext: ThemedReactContext): RemoteDesktopTextureView {
        val view = RemoteDesktopTextureView(reactContext)

        view.onSurfaceReady = { width, height ->
            dispatch(view) { surfaceId, viewTag ->
                SurfaceEvent(surfaceId, viewTag, "topSurfaceReady") {
                    putInt("width", width)
                    putInt("height", height)
                }
            }
        }

        view.onSurfaceDestroyed = {
            dispatch(view) { surfaceId, viewTag ->
                SurfaceEvent(surfaceId, viewTag, "topSurfaceDestroyed") {}
            }
        }

        view.onMetrics = { fps, dirtyRects, frameTimeMs ->
            dispatch(view) { surfaceId, viewTag ->
                SurfaceEvent(surfaceId, viewTag, "topMetrics") {
                    putDouble("fps", fps)
                    putInt("dirtyRects", dirtyRects)
                    putDouble("frameTimeMs", frameTimeMs)
                }
            }
        }

        return view
    }

    override fun onDropViewInstance(view: RemoteDesktopTextureView) {
        view.release()
        super.onDropViewInstance(view)
    }

    // --- Props ---

    @ReactProp(name = "sessionId")
    fun setSessionId(view: RemoteDesktopTextureView, sessionId: String?) {
        view.sessionId = sessionId ?: ""
    }

    @ReactProp(name = "protocol")
    fun setProtocol(view: RemoteDesktopTextureView, protocol: String?) {
        view.protocolType = protocol ?: "vnc"
    }

    @ReactProp(name = "paused", defaultBoolean = false)
    fun setPaused(view: RemoteDesktopTextureView, paused: Boolean) {
        view.paused = paused
    }

    @ReactProp(name = "testPattern", defaultBoolean = true)
    fun setTestPattern(view: RemoteDesktopTextureView, testPattern: Boolean) {
        view.testPattern = testPattern
    }

    @ReactProp(name = "backgroundColor", customType = "Color")
    fun setBackgroundColor(view: RemoteDesktopTextureView, color: Int?) {
        view.surfaceBackgroundColor = color ?: Color.BLACK
    }

    // --- Events ---

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any>? {
        return MapBuilder.builder<String, Any>()
            .put("topSurfaceReady", MapBuilder.of("registrationName", "onSurfaceReady"))
            .put("topSurfaceDestroyed", MapBuilder.of("registrationName", "onSurfaceDestroyed"))
            .put("topMetrics", MapBuilder.of("registrationName", "onMetrics"))
            .build()
    }

    /**
     * 이 뷰의 EventDispatcher 로 이벤트를 보낸다.
     *
     * **`getJSModule(RCTEventEmitter)` 를 쓰지 않는다.** 그 경로는 구 아키텍처용이고, 새
     * 아키텍처에서는 RN 이 soft exception 을 남기며 "interop 이 꺼지면 멈춘다" 고 경고한다
     * (BridgelessReactContext). EventDispatcher 는 두 아키텍처 모두에서 정식 경로다.
     *
     * surfaceId 가 필요하다 — Fabric 은 이벤트를 그 화면에 붙여 배달한다. 뷰가 이미 떨어졌으면
     * dispatcher 가 null 이고, 그때는 보낼 곳이 없으니 조용히 버린다.
     */
    private fun dispatch(
        view: RemoteDesktopTextureView,
        build: (surfaceId: Int, viewTag: Int) -> Event<*>,
    ) {
        val viewTag = view.id
        val dispatcher =
            UIManagerHelper.getEventDispatcherForReactTag(
                view.context as? com.facebook.react.bridge.ReactContext ?: return,
                viewTag,
            ) ?: return
        dispatcher.dispatchEvent(build(UIManagerHelper.getSurfaceId(view), viewTag))
    }

    /** 이름과 내용만 다른 direct 이벤트. 세 이벤트가 같은 모양이라 한 타입으로 묶는다. */
    private class SurfaceEvent(
        surfaceId: Int,
        viewTag: Int,
        private val name: String,
        private val fill: WritableMap.() -> Unit,
    ) : Event<SurfaceEvent>(surfaceId, viewTag) {
        override fun getEventName(): String = name

        /**
         * 합치지 않는다. RN 의 기본값은 합치기라, 같은 프레임에 두 개가 들어오면 앞선 것이
         * 버려진다 — 이 셋은 "지금 준비됐다/사라졌다" 같은 개별 사실이라 잃으면 안 된다.
         */
        override fun canCoalesce(): Boolean = false

        override fun getEventData(): WritableMap = Arguments.createMap().apply(fill)
    }

    companion object {
        const val REACT_CLASS = "RemoteDesktopSurface"
    }
}
