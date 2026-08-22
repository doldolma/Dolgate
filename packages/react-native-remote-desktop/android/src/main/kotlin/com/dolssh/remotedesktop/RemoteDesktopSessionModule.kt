package com.dolssh.remotedesktop

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray

/** React Native control bridge. Framebuffer and PCM data never enter this class. */
class RemoteDesktopSessionModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext),
    RemoteDesktopSessionManager.SessionEventListener {

    override fun getName(): String = "RemoteDesktopSessionModule"

    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Int) = Unit

    override fun initialize() {
        super.initialize()
        RemoteDesktopSessionManager.setEventListener(this)
    }

    override fun invalidate() {
        RemoteDesktopSessionManager.setEventListener(null)
        RemoteDesktopSessionManager.destroyAllSessions()
        super.invalidate()
    }

    override fun onSessionEvent(
        sessionId: String,
        eventName: String,
        params: Map<String, Any?>,
    ) {
        val body = Arguments.createMap().apply {
            putString("sessionId", sessionId)
            putString("event", eventName)
            for ((key, value) in params) {
                when (value) {
                    is Int -> putInt(key, value)
                    is Long -> putDouble(key, value.toDouble())
                    is Float -> putDouble(key, value.toDouble())
                    is Double -> putDouble(key, value)
                    is String -> putString(key, value)
                    is Boolean -> putBoolean(key, value)
                    null -> putNull(key)
                    else -> putString(key, value.toString())
                }
            }
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("remoteDesktopSessionEvent", body)
    }

    @ReactMethod
    fun isAvailable(protocol: String, promise: Promise) {
        promise.resolve(RemoteDesktopSessionManager.Protocol.parse(protocol) != null)
    }

    @ReactMethod
    fun connect(sessionId: String, options: ReadableMap, promise: Promise) {
        val protocolName = options.getString("protocol") ?: "vnc"
        val protocol = RemoteDesktopSessionManager.Protocol.parse(protocolName)
        if (protocol == null) {
            promise.reject("INVALID_ARGS", "Unsupported protocol: $protocolName")
            return
        }
        val host = options.getString("host")?.trim()
        if (host.isNullOrEmpty()) {
            promise.reject("INVALID_ARGS", "host is required")
            return
        }
        val defaultPort = if (protocol == RemoteDesktopSessionManager.Protocol.RDP) 3389 else 5900
        val port = if (options.hasKey("port")) options.getInt("port") else defaultPort
        if (port !in 1..65_535) {
            promise.reject("INVALID_ARGS", "port must be between 1 and 65535")
            return
        }

        val existingProtocol = RemoteDesktopSessionManager.protocolOf(sessionId)
        if (existingProtocol != null && existingProtocol != protocol) {
            promise.reject("ALREADY_EXISTS", "Session $sessionId already uses $existingProtocol")
            return
        }
        if (existingProtocol == null &&
            !RemoteDesktopSessionManager.createSession(sessionId, protocol)
        ) {
            promise.reject("CREATE_FAILED", "Failed to create native $protocol session")
            return
        }

        val result = when (protocol) {
            RemoteDesktopSessionManager.Protocol.VNC -> startVnc(sessionId, host, port, options)
            RemoteDesktopSessionManager.Protocol.RDP -> startRdp(sessionId, host, port, options, promise)
                ?: return
        }
        if (result == 0) {
            promise.resolve(null)
        } else {
            RemoteDesktopSessionManager.destroySession(sessionId)
            promise.reject("START_FAILED", "Native $protocol start returned $result")
        }
    }

    private fun startVnc(
        sessionId: String,
        host: String,
        port: Int,
        options: ReadableMap,
    ): Int = RemoteDesktopSessionManager.startVncSession(
        sessionId = sessionId,
        host = host,
        port = port,
        password = stringOption(options, "password"),
        username = stringOption(options, "username"),
        imageQuality = stringOption(options, "imageQuality"),
        tunnelAuthToken = stringOption(options, "tunnelAuthToken"),
        shared = booleanOption(options, "shared", true),
        viewOnly = booleanOption(options, "viewOnly", false),
    )

    private fun validatedDrivesJson(
        options: ReadableMap,
        promise: Promise,
    ): String? {
        if (!options.hasKey("drives") || options.isNull("drives")) return "[]"
        if (options.getType("drives") != ReadableType.Array) {
            promise.reject("INVALID_DRIVE_PATH", "drives must be an array")
            return null
        }
        val drives = options.getArray("drives") ?: return "[]"
        for (index in 0 until drives.size()) {
            if (drives.getType(index) != ReadableType.Map) {
                promise.reject("INVALID_DRIVE_PATH", "drive at index $index must be an object")
                return null
            }
            val drive = drives.getMap(index)
            if (drive == null ||
                !drive.hasKey("path") ||
                drive.isNull("path") ||
                drive.getType("path") != ReadableType.String
            ) {
                promise.reject("INVALID_DRIVE_PATH", "drive at index $index requires a path")
                return null
            }
            val path = drive.getString("path")?.trim().orEmpty()
            val requested = java.io.File(path)
            val accessible = try {
                requested.isAbsolute && requested.canonicalFile.let {
                    it.isDirectory && it.canRead()
                }
            } catch (_: Exception) {
                false
            }
            if (!accessible) {
                promise.reject(
                    "INVALID_DRIVE_PATH",
                    "RDP drive path must be an accessible absolute filesystem directory; " +
                        "content URIs and paths from another device are unsupported: $path",
                )
                return null
            }
        }
        return JSONArray(drives.toArrayList()).toString()
    }

    private fun startRdp(
        sessionId: String,
        host: String,
        port: Int,
        options: ReadableMap,
        promise: Promise,
    ): Int? {
        val width = intOption(options, "desktopWidth", 1280)
        val height = intOption(options, "desktopHeight", 720)
        if (width !in 1..65_535 || height !in 1..65_535) {
            promise.reject(
                "INVALID_ARGS",
                "desktop dimensions must be between 1 and 65535",
            )
            RemoteDesktopSessionManager.destroySession(sessionId)
            return null
        }
        val colorDepth = intOption(options, "colorDepth", 32)
        if (colorDepth != 16 && colorDepth != 32) {
            promise.reject("INVALID_ARGS", "colorDepth must be 16 or 32")
            RemoteDesktopSessionManager.destroySession(sessionId)
            return null
        }
        val drivesJson = validatedDrivesJson(options, promise) ?: run {
            RemoteDesktopSessionManager.destroySession(sessionId)
            return null
        }

        return RemoteDesktopSessionManager.startRdpSession(
            sessionId = sessionId,
            host = host,
            dialAddress = stringOption(options, "dialAddress")?.trim(),
            tunnelAuthToken = stringOption(options, "tunnelAuthToken"),
            port = port,
            username = stringOption(options, "username") ?: "",
            password = stringOption(options, "password") ?: "",
            domain = stringOption(options, "domain") ?: "",
            desktopWidth = width,
            desktopHeight = height,
            audioEnabled = booleanOption(options, "audioEnabled", true),
            clipboardEnabled = booleanOption(options, "clipboardEnabled", true),
            microphoneEnabled = booleanOption(options, "microphoneEnabled", false),
            cameraEnabled = booleanOption(options, "cameraEnabled", false),
            adminSession = booleanOption(options, "adminSession", false),
            colorDepth = colorDepth,
            drivesJson = drivesJson,
        )
    }

    @ReactMethod
    fun disconnect(sessionId: String, promise: Promise) {
        if (!RemoteDesktopSessionManager.hasSession(sessionId)) {
            promise.resolve(false)
            return
        }
        val disconnectResult = RemoteDesktopSessionManager.disconnectSession(sessionId)
        val destroyResult = RemoteDesktopSessionManager.destroySession(sessionId)
        if (destroyResult == 0) promise.resolve(disconnectResult == 0)
        else promise.reject("DESTROY_FAILED", "Native destroy returned $destroyResult")
    }

    @ReactMethod
    fun setActive(sessionId: String, active: Boolean, promise: Promise) {
        if (!RemoteDesktopSessionManager.hasSession(sessionId)) {
            promise.reject("NO_SESSION", "Session not found: $sessionId")
            return
        }
        RemoteDesktopSessionManager.setActive(sessionId, active)
        promise.resolve(null)
    }

    /**
     * 화면이 저절로 꺼지지 않게 잡아 둔다.
     *
     * 창 플래그를 쓴다 — `PowerManager.WakeLock` 과 달리 권한이 필요 없고, 이 창이 앞에 있는
     * 동안에만 효력이 있다. 앱이 백그라운드로 가면 저절로 풀리므로 기기를 영구히 깨워 둘
     * 위험이 없다.
     */
    @ReactMethod
    fun setKeepAwake(enabled: Boolean, promise: Promise) {
        reactContext.runOnUiQueueThread {
            val activity = reactContext.currentActivity
            if (activity == null || activity.isFinishing || activity.isDestroyed) {
                // 화면이 이미 내려갔으면 잡아 둘 대상도 없다 — 실패가 아니다.
                promise.resolve(null)
                return@runOnUiQueueThread
            }

            try {
                if (enabled) {
                    activity.window.addFlags(
                        android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                    )
                } else {
                    activity.window.clearFlags(
                        android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                    )
                }
                promise.resolve(null)
            } catch (error: Throwable) {
                promise.reject("KEEP_AWAKE_FAILED", error)
            }
        }
    }

    @ReactMethod
    fun setOrientationUnlocked(unlocked: Boolean, promise: Promise) {
        reactContext.runOnUiQueueThread {
            val activity = reactContext.currentActivity
            if (activity == null || activity.isFinishing || activity.isDestroyed) {
                promise.reject(
                    "ORIENTATION_UNAVAILABLE",
                    "No active Activity is available to update orientation",
                )
                return@runOnUiQueueThread
            }

            try {
                activity.requestedOrientation = if (unlocked) {
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                } else {
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                }
                promise.resolve(null)
            } catch (error: RuntimeException) {
                promise.reject(
                    "ORIENTATION_UPDATE_FAILED",
                    "Failed to update Activity orientation",
                    error,
                )
            }
        }
    }

    @ReactMethod
    fun pointerMove(sessionId: String, x: Int, y: Int) {
        RemoteDesktopSessionManager.pointerMove(sessionId, x, y)
    }

    @ReactMethod
    fun pointerButton(
        sessionId: String,
        button: Int,
        pressed: Boolean,
        x: Int,
        y: Int,
    ) {
        RemoteDesktopSessionManager.pointerButton(sessionId, button, pressed, x, y)
    }

    @ReactMethod
    fun scroll(
        sessionId: String,
        vertical: Boolean,
        delta: Int,
        x: Int,
        y: Int,
    ) {
        RemoteDesktopSessionManager.pointerScroll(
            sessionId,
            vertical,
            delta,
            x,
            y,
        )
    }

    @ReactMethod
    fun keyEvent(sessionId: String, keysym: Int, pressed: Boolean, keycode: Int) {
        RemoteDesktopSessionManager.keyEvent(sessionId, keysym, keycode, pressed)
    }

    @ReactMethod
    fun unicodeEvent(sessionId: String, codepoint: Int, pressed: Boolean) {
        RemoteDesktopSessionManager.unicodeEvent(sessionId, codepoint, pressed)
    }

    @ReactMethod
    fun trustCertificate(sessionId: String, accept: Boolean, promise: Promise) {
        val result = RemoteDesktopSessionManager.trustCertificate(sessionId, accept)
        if (result == 0) promise.resolve(null)
        else promise.reject("TRUST_FAILED", "RDP certificate verdict returned $result")
    }

    @ReactMethod
    fun sendClipboard(sessionId: String, text: String, promise: Promise) {
        resolveControl(
            promise,
            "CLIPBOARD_FAILED",
            RemoteDesktopSessionManager.sendClipboard(sessionId, text),
        )
    }

    @ReactMethod
    fun refresh(sessionId: String, promise: Promise) {
        resolveControl(
            promise,
            "REFRESH_FAILED",
            RemoteDesktopSessionManager.refresh(sessionId),
        )
    }

    @ReactMethod
    fun resize(sessionId: String, width: Int, height: Int, promise: Promise) {
        if (width !in 1..65_535 || height !in 1..65_535) {
            promise.reject("INVALID_ARGS", "desktop dimensions must be between 1 and 65535")
            return
        }
        resolveControl(
            promise,
            "RESIZE_FAILED",
            RemoteDesktopSessionManager.resize(sessionId, width, height),
        )
    }

    private fun resolveControl(promise: Promise, code: String, result: Int) {
        when (result) {
            0 -> promise.resolve(null)
            RemoteDesktopSessionManager.ERR_VIEW_ONLY -> promise.reject(
                "VIEW_ONLY",
                "Native VNC session is view-only",
            )
            else -> promise.reject(code, "Native control call returned $result")
        }
    }

    private fun stringOption(options: ReadableMap, key: String): String? =
        if (options.hasKey(key) && !options.isNull(key)) options.getString(key) else null

    private fun booleanOption(options: ReadableMap, key: String, fallback: Boolean): Boolean =
        if (options.hasKey(key) && !options.isNull(key)) options.getBoolean(key) else fallback

    private fun intOption(options: ReadableMap, key: String, fallback: Int): Int =
        if (options.hasKey(key) && !options.isNull(key)) options.getInt(key) else fallback
}
