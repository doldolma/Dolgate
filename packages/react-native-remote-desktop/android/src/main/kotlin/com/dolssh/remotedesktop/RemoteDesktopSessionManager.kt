package com.dolssh.remotedesktop

import android.graphics.Rect
import android.util.Log
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * Owns one native VNC or RDP handle, one authoritative RGBA framebuffer, and
 * one weak renderer attachment per session. Rust callbacks may arrive on worker
 * threads; all mutable framebuffer state is protected by [SessionState.lock].
 */
object RemoteDesktopSessionManager {
    enum class Protocol {
        VNC,
        RDP;

        companion object {
            fun parse(value: String): Protocol? = when (value.lowercase()) {
                "vnc" -> VNC
                "rdp" -> RDP
                else -> null
            }
        }
    }

    private const val TAG = "RemoteDesktopSessionMgr"
    private const val DESTROY_RETRY_LIMIT = 5
    private const val DESTROY_RETRY_DELAY_MS = 50L
    private const val MAX_COALESCED_DAMAGE = 16
    private const val MAX_FRAMEBUFFER_PIXELS = 16_777_216L // 64 MiB RGBA
    private const val MAX_CURSOR_DIMENSION = 512
    private const val OK = 0
    private const val ERR_INVALID_ARGUMENT = -6
    /**
     * 워커 콜백 스레드에서 destroy 를 불렀다는 코어의 응답. 종료는 요청됐지만 세션 소유권은
     * 코어에 남아 있으므로 **다른 스레드에서 다시 불러야** 하고, 그 전에 콜백 컨텍스트를
     * 해제하면 안 된다(dvnc.h / drdp.h 의 *_ERR_CALLBACK_THREAD).
     */
    private const val ERR_CALLBACK_THREAD = -7
    /**
     * Kotlin 이 직접 만드는 코드는 코어가 쓰는 대역(0, -1..-7, -99)과 겹치지 않게 둔다.
     * 겹치면 코어의 오류가 이 뜻으로 번역돼 사용자에게 엉뚱한 원인을 말한다 — -7 이 실제로
     * 그랬다(view-only 와 callback-thread 가 같은 값이었다).
     */
    const val ERR_VIEW_ONLY = -1001

    init {
        System.loadLibrary("dvnc_jni")
    }

    // VNC JNI.
    private external fun nativeCreate(callback: NativeSessionCallback): Long
    private external fun nativeStart(
        handle: Long,
        host: String,
        port: Int,
        password: String?,
        username: String?,
        imageQuality: String?,
        tunnelAuthToken: String?,
        shared: Boolean,
    ): Int
    private external fun nativeDisconnect(handle: Long): Int
    private external fun nativeDestroy(handle: Long): Int
    private external fun nativePointerMove(handle: Long, x: Int, y: Int): Int
    private external fun nativePointerButton(
        handle: Long,
        button: Int,
        pressed: Boolean,
        x: Int,
        y: Int,
    ): Int
    private external fun nativePointerScroll(
        handle: Long,
        vertical: Boolean,
        delta: Int,
        x: Int,
        y: Int,
    ): Int
    private external fun nativeKeyDown(handle: Long, keysym: Int, keycode: Int): Int
    private external fun nativeKeyUp(handle: Long, keysym: Int, keycode: Int): Int
    private external fun nativeSendClipboard(handle: Long, text: String): Int
    private external fun nativeRefresh(handle: Long): Int
    private external fun nativeResize(handle: Long, width: Int, height: Int): Int

    // RDP JNI.
    private external fun nativeCreateRdp(callback: NativeSessionCallback): Long
    private external fun nativeStartRdp(
        handle: Long,
        host: String,
        dialAddress: String?,
        tunnelAuthToken: String?,
        port: Int,
        username: String,
        password: String,
        domain: String,
        desktopWidth: Int,
        desktopHeight: Int,
        audioEnabled: Boolean,
        clipboardEnabled: Boolean,
        microphoneEnabled: Boolean,
        cameraEnabled: Boolean,
        adminSession: Boolean,
        colorDepth: Int,
        drivesJson: String,
    ): Int
    private external fun nativeDisconnectRdp(handle: Long): Int
    private external fun nativeDestroyRdp(handle: Long): Int
    private external fun nativeRdpPointerMove(handle: Long, x: Int, y: Int): Int
    private external fun nativeRdpPointerButton(
        handle: Long,
        button: Int,
        pressed: Boolean,
        x: Int,
        y: Int,
    ): Int
    private external fun nativeRdpPointerScroll(
        handle: Long,
        vertical: Boolean,
        delta: Int,
        x: Int,
        y: Int,
    ): Int
    private external fun nativeRdpKey(handle: Long, scancode: Int, pressed: Boolean): Int
    private external fun nativeRdpUnicode(handle: Long, codepoint: Int, pressed: Boolean): Int
    private external fun nativeRdpSendClipboard(handle: Long, text: String): Int
    private external fun nativeRdpRefresh(handle: Long): Int
    private external fun nativeRdpResize(handle: Long, width: Int, height: Int): Int
    private external fun nativeRdpTrustCertificate(handle: Long, accept: Boolean): Int

    data class CursorShape(
        val hotspotX: Int,
        val hotspotY: Int,
        val width: Int,
        val height: Int,
        val rgba: ByteArray,
        val generation: Long,
    )

    data class CursorSnapshot(
        val shape: CursorShape?,
        val x: Int,
        val y: Int,
    )

    data class SessionState(
        val nativeHandle: Long,
        val protocol: Protocol,
        val lock: ReentrantLock = ReentrantLock(),
        val audioPlayer: RemoteDesktopAudioPlayer? =
            if (protocol == Protocol.RDP) RemoteDesktopAudioPlayer() else null,
        var framebuffer: ByteArray? = null,
        var desktopWidth: Int = 0,
        var desktopHeight: Int = 0,
        var framebufferGeneration: Long = 0,
        var damageRects: MutableList<Rect> = mutableListOf(),
        var pendingDamageBytes: Long = 0,
        var fullDirty: Boolean = false,
        var cursorShape: CursorShape? = null,
        var cursorGeneration: Long = 0,
        var cursorX: Int = 0,
        var cursorY: Int = 0,
        @Volatile var viewOnly: Boolean = false,
        @Volatile var active: Boolean = false,
        var textureView: WeakReference<RemoteDesktopTextureView>? = null,
        var connected: Boolean = false,
    )

    data class FramePatch(
        val x: Int,
        val y: Int,
        val width: Int,
        val height: Int,
        val pixels: ByteArray,
    )

    data class FrameData(
        val width: Int,
        val height: Int,
        val generation: Long,
        val patches: List<FramePatch>,
    )

    interface SessionEventListener {
        fun onSessionEvent(
            sessionId: String,
            eventName: String,
            params: Map<String, Any?>,
        )
    }

    private val sessions = ConcurrentHashMap<String, SessionState>()

    /**
     * destroy 재시도 전용 스레드. 코어의 워커 콜백 스레드에서 destroy 를 부른 경우 **그 스레드가
     * 아닌 곳**에서 다시 불러야 하므로, 재시도는 항상 여기로 넘긴다. daemon 이라 앱 종료를 막지
     * 않는다.
     */
    private val destroyRetryExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "rd-destroy-retry").apply { isDaemon = true }
    }

    @Volatile
    private var eventListener: SessionEventListener? = null

    fun setEventListener(listener: SessionEventListener?) {
        eventListener = listener
    }

    fun hasSession(sessionId: String): Boolean = sessions.containsKey(sessionId)

    fun protocolOf(sessionId: String): Protocol? = sessions[sessionId]?.protocol

    fun createSession(sessionId: String, protocol: Protocol): Boolean {
        if (sessions.containsKey(sessionId)) {
            Log.w(TAG, "Session $sessionId already exists")
            return false
        }

        val callback = object : NativeSessionCallback {
            override fun onConnected(width: Int, height: Int, name: String) {
                handleConnected(sessionId, width, height, name)
            }

            override fun onResized(width: Int, height: Int) {
                handleResized(sessionId, width, height)
            }

            override fun onCapabilities(json: String) {
                eventListener?.onSessionEvent(
                    sessionId,
                    "capabilities",
                    mapOf("json" to json),
                )
            }

            override fun onClipboard(text: String) {
                val state = sessions[sessionId] ?: return
                if (!state.active) return
                eventListener?.onSessionEvent(
                    sessionId,
                    "clipboard",
                    mapOf("text" to text),
                )
            }

            override fun onError(message: String) {
                handleError(sessionId, message)
            }

            override fun onClosed() {
                handleClosed(sessionId)
            }

            override fun onRdpEvent(jsonUtf8: ByteArray) {
                handleRdpEvent(sessionId, jsonUtf8)
            }

            override fun onAudio(
                sampleRate: Int,
                channels: Int,
                bitsPerSample: Int,
                timestamp: Int,
                samples: ByteArray,
            ) {
                val state = sessions[sessionId] ?: return
                if (!state.active) return
                state.audioPlayer?.enqueue(
                    sampleRate,
                    channels,
                    bitsPerSample,
                    samples,
                )
            }

            override fun onFrame(
                x: Int,
                y: Int,
                width: Int,
                height: Int,
                pixels: ByteBuffer,
            ) {
                handleFrame(sessionId, x, y, width, height, pixels)
            }

            override fun onCursor(
                hotspotX: Int,
                hotspotY: Int,
                width: Int,
                height: Int,
                rgba: ByteArray,
            ) {
                handleCursor(sessionId, hotspotX, hotspotY, width, height, rgba)
            }
        }

        val nativeHandle = when (protocol) {
            Protocol.VNC -> nativeCreate(callback)
            Protocol.RDP -> nativeCreateRdp(callback)
        }
        if (nativeHandle == 0L) {
            Log.e(TAG, "Could not create $protocol session $sessionId")
            return false
        }

        val state = SessionState(nativeHandle = nativeHandle, protocol = protocol)
        val existing = sessions.putIfAbsent(sessionId, state)
        if (existing != null) {
            state.audioPlayer?.stop()
            when (protocol) {
                Protocol.VNC -> nativeDestroy(nativeHandle)
                Protocol.RDP -> nativeDestroyRdp(nativeHandle)
            }
            return false
        }
        return true
    }

    fun startVncSession(
        sessionId: String,
        host: String,
        port: Int,
        password: String?,
        username: String?,
        imageQuality: String?,
        tunnelAuthToken: String?,
        shared: Boolean,
        viewOnly: Boolean,
    ): Int {
        val state = sessions[sessionId] ?: return -1
        if (state.protocol != Protocol.VNC) return ERR_INVALID_ARGUMENT
        state.viewOnly = viewOnly
        return nativeStart(
            state.nativeHandle,
            host,
            port,
            password,
            username,
            imageQuality,
            tunnelAuthToken,
            shared,
        )
    }

    fun startRdpSession(
        sessionId: String,
        host: String,
        dialAddress: String?,
        tunnelAuthToken: String?,
        port: Int,
        username: String,
        password: String,
        domain: String,
        desktopWidth: Int,
        desktopHeight: Int,
        audioEnabled: Boolean,
        clipboardEnabled: Boolean,
        microphoneEnabled: Boolean,
        cameraEnabled: Boolean,
        adminSession: Boolean,
        colorDepth: Int,
        drivesJson: String,
    ): Int {
        val state = sessions[sessionId] ?: return -1
        if (state.protocol != Protocol.RDP) return ERR_INVALID_ARGUMENT
        return nativeStartRdp(
            state.nativeHandle,
            host,
            dialAddress,
            tunnelAuthToken,
            port,
            username,
            password,
            domain,
            desktopWidth,
            desktopHeight,
            audioEnabled,
            clipboardEnabled,
            microphoneEnabled,
            cameraEnabled,
            adminSession,
            colorDepth,
            drivesJson,
        )
    }

    fun disconnectSession(sessionId: String): Int {
        val state = sessions[sessionId] ?: return -1
        return when (state.protocol) {
            Protocol.VNC -> nativeDisconnect(state.nativeHandle)
            Protocol.RDP -> nativeDisconnectRdp(state.nativeHandle)
        }
    }

    /**
     * 세션을 완전히 정리한다.
     *
     * `ERR_CALLBACK_THREAD` 는 실패가 아니라 **"다른 스레드에서 다시 부르라"** 는 응답이다.
     * 여기서 로그만 남기고 끝내면 JNI 쪽 핸들 쌍·전역 참조와 코어의 워커 스레드가 앱이 죽을
     * 때까지 남는다(맵에서 이미 지웠으니 재시도할 경로도 없다). 오늘은 콜백이 모두 스레드를
     * 넘겨 오므로 이 분기에 닿지 않지만, 닿았을 때의 대가가 스레드 누수라 방어해 둔다.
     */
    fun destroySession(sessionId: String): Int {
        val state = sessions.remove(sessionId) ?: return -1
        state.audioPlayer?.stop()
        val result = destroyNative(state)
        if (result == ERR_CALLBACK_THREAD) {
            scheduleDestroyRetry(sessionId, state, attempt = 1)
            return result
        }
        if (result != OK) {
            Log.e(TAG, "Destroy failed for $sessionId/${state.protocol}: $result")
        }
        return result
    }

    private fun destroyNative(state: SessionState): Int = when (state.protocol) {
        Protocol.VNC -> nativeDestroy(state.nativeHandle)
        Protocol.RDP -> nativeDestroyRdp(state.nativeHandle)
    }

    private fun scheduleDestroyRetry(
        sessionId: String,
        state: SessionState,
        attempt: Int,
    ) {
        if (attempt > DESTROY_RETRY_LIMIT) {
            Log.e(
                TAG,
                "Destroy kept returning ERR_CALLBACK_THREAD for $sessionId — " +
                    "leaving the native session owned by the core",
            )
            return
        }
        // 반드시 다른 스레드여야 한다 — 이 호출이 온 스레드가 코어의 워커다.
        destroyRetryExecutor.schedule(
            {
                val result = destroyNative(state)
                if (result == ERR_CALLBACK_THREAD) {
                    scheduleDestroyRetry(sessionId, state, attempt + 1)
                } else if (result != OK) {
                    Log.e(TAG, "Destroy retry failed for $sessionId: $result")
                }
            },
            DESTROY_RETRY_DELAY_MS,
            TimeUnit.MILLISECONDS,
        )
    }

    fun destroyAllSessions() {
        for (sessionId in sessions.keys.toList()) {
            disconnectSession(sessionId)
            destroySession(sessionId)
        }
    }

    fun isConnected(sessionId: String): Boolean =
        sessions[sessionId]?.connected == true

    fun pointerMove(sessionId: String, x: Int, y: Int): Int =
        withSession(sessionId) { state ->
            if (state.protocol == Protocol.VNC && state.viewOnly) {
                return@withSession ERR_VIEW_ONLY
            }
            when (state.protocol) {
                Protocol.VNC -> {
                    updateCursorPosition(sessionId, x, y)
                    nativePointerMove(state.nativeHandle, x, y)
                }
                Protocol.RDP -> nativeRdpPointerMove(state.nativeHandle, x, y)
            }
        }

    fun pointerButton(
        sessionId: String,
        button: Int,
        pressed: Boolean,
        x: Int,
        y: Int,
    ): Int = withSession(sessionId) { state ->
        if (state.protocol == Protocol.VNC && state.viewOnly) {
            return@withSession ERR_VIEW_ONLY
        }
        when (state.protocol) {
            Protocol.VNC -> {
                updateCursorPosition(sessionId, x, y)
                nativePointerButton(
                    state.nativeHandle,
                    button,
                    pressed,
                    x,
                    y,
                )
            }
            Protocol.RDP -> nativeRdpPointerButton(
                state.nativeHandle,
                button,
                pressed,
                x,
                y,
            )
        }
    }

    fun pointerScroll(
        sessionId: String,
        vertical: Boolean,
        delta: Int,
        x: Int,
        y: Int,
    ): Int = withSession(sessionId) { state ->
        if (state.protocol == Protocol.VNC && state.viewOnly) {
            return@withSession ERR_VIEW_ONLY
        }
        when (state.protocol) {
            Protocol.VNC -> {
                updateCursorPosition(sessionId, x, y)
                nativePointerScroll(
                    state.nativeHandle,
                    vertical,
                    delta,
                    x,
                    y,
                )
            }
            Protocol.RDP -> nativeRdpPointerScroll(
                state.nativeHandle,
                vertical,
                delta,
                x,
                y,
            )
        }
    }

    fun keyEvent(
        sessionId: String,
        keysym: Int,
        keycode: Int,
        pressed: Boolean,
    ): Int = withSession(sessionId) { state ->
        if (state.protocol == Protocol.VNC && state.viewOnly) {
            return@withSession ERR_VIEW_ONLY
        }
        when (state.protocol) {
            Protocol.VNC -> if (pressed) {
                nativeKeyDown(state.nativeHandle, keysym, keycode)
            } else {
                nativeKeyUp(state.nativeHandle, keysym, keycode)
            }
            Protocol.RDP -> nativeRdpKey(state.nativeHandle, keycode, pressed)
        }
    }

    fun unicodeEvent(sessionId: String, codepoint: Int, pressed: Boolean): Int =
        withSession(sessionId) { state ->
            if (state.protocol != Protocol.RDP) ERR_INVALID_ARGUMENT
            else nativeRdpUnicode(state.nativeHandle, codepoint, pressed)
        }

    fun trustCertificate(sessionId: String, accept: Boolean): Int =
        withSession(sessionId) { state ->
            if (state.protocol != Protocol.RDP) ERR_INVALID_ARGUMENT
            else nativeRdpTrustCertificate(state.nativeHandle, accept)
        }

    fun sendClipboard(sessionId: String, text: String): Int =
        withSession(sessionId) { state ->
            if (state.protocol == Protocol.VNC && state.viewOnly) {
                return@withSession ERR_VIEW_ONLY
            }
            when (state.protocol) {
                Protocol.VNC -> nativeSendClipboard(state.nativeHandle, text)
                Protocol.RDP -> nativeRdpSendClipboard(state.nativeHandle, text)
            }
        }

    fun refresh(sessionId: String): Int = withSession(sessionId) { state ->
        when (state.protocol) {
            Protocol.VNC -> nativeRefresh(state.nativeHandle)
            Protocol.RDP -> nativeRdpRefresh(state.nativeHandle)
        }
    }

    fun resize(sessionId: String, width: Int, height: Int): Int =
        withSession(sessionId) { state ->
            if (state.protocol == Protocol.VNC && state.viewOnly) {
                return@withSession ERR_VIEW_ONLY
            }
            when (state.protocol) {
                Protocol.VNC -> nativeResize(state.nativeHandle, width, height)
                Protocol.RDP -> nativeRdpResize(state.nativeHandle, width, height)
            }
        }

    private inline fun withSession(
        sessionId: String,
        action: (SessionState) -> Int,
    ): Int {
        val state = sessions[sessionId] ?: return -1
        return action(state)
    }

    fun attachTextureView(sessionId: String, view: RemoteDesktopTextureView) {
        val state = sessions[sessionId] ?: return
        var notify = false
        var active = false
        state.lock.lock()
        try {
            state.textureView = WeakReference(view)
            active = state.active
            state.framebuffer?.let { framebuffer ->
                state.damageRects.clear()
                state.pendingDamageBytes = framebuffer.size.toLong()
                state.fullDirty = true
                notify = true
            }
        } finally {
            state.lock.unlock()
        }
        view.paused = !active
        if (notify) view.notifyFrameAvailable()
        view.notifyCursorAvailable()
    }

    fun detachTextureView(sessionId: String, view: RemoteDesktopTextureView) {
        val state = sessions[sessionId] ?: return
        state.lock.lock()
        try {
            if (state.textureView?.get() === view) state.textureView = null
        } finally {
            state.lock.unlock()
        }
    }

    fun setActive(sessionId: String, active: Boolean): Boolean {
        val state = sessions[sessionId] ?: return false
        state.active = active
        state.audioPlayer?.setActive(active)
        attachedTextureView(state)?.let { view ->
            view.post { view.paused = !active }
        }
        return true
    }

    private fun attachedTextureView(state: SessionState): RemoteDesktopTextureView? {
        state.lock.lock()
        return try {
            state.textureView?.get()
        } finally {
            state.lock.unlock()
        }
    }

    fun consumeCursor(sessionId: String): CursorSnapshot? {
        val state = sessions[sessionId] ?: return null
        state.lock.lock()
        return try {
            CursorSnapshot(
                shape = state.cursorShape,
                x = state.cursorX,
                y = state.cursorY,
            )
        } finally {
            state.lock.unlock()
        }
    }

    fun consumeDamage(sessionId: String): FrameData? {
        val state = sessions[sessionId] ?: return null
        state.lock.lock()
        try {
            val framebuffer = state.framebuffer ?: return null
            val width = state.desktopWidth
            val height = state.desktopHeight
            if (width <= 0 || height <= 0) return null

            val fullDirty = state.fullDirty
            val damage = when {
                fullDirty -> listOf(Rect(0, 0, width, height))
                state.damageRects.isEmpty() -> return null
                else -> state.damageRects.toList()
            }
            val patches = try {
                damage.map { rect -> snapshotPatch(framebuffer, width, rect) }
            } catch (error: OutOfMemoryError) {
                Log.e(TAG, "Could not snapshot framebuffer damage", error)
                state.damageRects.clear()
                state.pendingDamageBytes = framebuffer.size.toLong()
                state.fullDirty = true
                return null
            }

            state.damageRects.clear()
            state.pendingDamageBytes = 0
            state.fullDirty = false
            return FrameData(width, height, state.framebufferGeneration, patches)
        } finally {
            state.lock.unlock()
        }
    }

    private fun snapshotPatch(
        framebuffer: ByteArray,
        desktopWidth: Int,
        rect: Rect,
    ): FramePatch {
        val patchWidth = rect.width()
        val patchHeight = rect.height()
        val rowBytes = patchWidth * 4
        val pixels = ByteArray(rowBytes * patchHeight)
        val desktopStride = desktopWidth * 4
        for (row in 0 until patchHeight) {
            System.arraycopy(
                framebuffer,
                (rect.top + row) * desktopStride + rect.left * 4,
                pixels,
                row * rowBytes,
                rowBytes,
            )
        }
        return FramePatch(
            x = rect.left,
            y = rect.top,
            width = patchWidth,
            height = patchHeight,
            pixels = pixels,
        )
    }

    private fun allocateFramebuffer(
        sessionId: String,
        width: Int,
        height: Int,
    ): ByteArray? {
        val pixels = width.toLong() * height.toLong()
        if (width <= 0 || height <= 0 || pixels > MAX_FRAMEBUFFER_PIXELS) {
            rejectFramebuffer(sessionId, width, height)
            return null
        }
        return try {
            ByteArray((pixels * 4L).toInt())
        } catch (error: OutOfMemoryError) {
            Log.e(TAG, "Could not allocate framebuffer ${width}x$height", error)
            rejectFramebuffer(sessionId, width, height)
            null
        }
    }

    private fun rejectFramebuffer(sessionId: String, width: Int, height: Int) {
        handleError(
            sessionId,
            "Remote framebuffer ${width}x$height exceeds the mobile limit",
        )
        // Callback thread may request disconnect, but must never destroy/join itself.
        disconnectSession(sessionId)
    }

    private fun handleConnected(
        sessionId: String,
        width: Int,
        height: Int,
        name: String,
    ) {
        val state = sessions[sessionId] ?: return
        val framebuffer = allocateFramebuffer(sessionId, width, height) ?: return
        state.lock.lock()
        try {
            state.desktopWidth = width
            state.desktopHeight = height
            state.framebuffer = framebuffer
            state.framebufferGeneration++
            state.damageRects.clear()
            state.pendingDamageBytes = framebuffer.size.toLong()
            state.fullDirty = true
            state.connected = true
        } finally {
            state.lock.unlock()
        }
        eventListener?.onSessionEvent(
            sessionId,
            "connected",
            mapOf(
                "desktopWidth" to width,
                "desktopHeight" to height,
                "name" to name,
            ),
        )
        attachedTextureView(state)?.notifyFrameAvailable()
    }

    private fun handleResized(sessionId: String, width: Int, height: Int) {
        val state = sessions[sessionId] ?: return
        val framebuffer = allocateFramebuffer(sessionId, width, height) ?: return
        state.lock.lock()
        try {
            state.desktopWidth = width
            state.desktopHeight = height
            state.framebuffer = framebuffer
            state.framebufferGeneration++
            state.damageRects.clear()
            state.pendingDamageBytes = framebuffer.size.toLong()
            state.fullDirty = true
        } finally {
            state.lock.unlock()
        }
        eventListener?.onSessionEvent(
            sessionId,
            "resized",
            mapOf("desktopWidth" to width, "desktopHeight" to height),
        )
        attachedTextureView(state)?.notifyFrameAvailable()
    }

    private fun handleError(sessionId: String, message: String, failure: String?) {
        val state = sessions[sessionId]
        state?.lock?.lock()
        try {
            state?.connected = false
        } finally {
            state?.lock?.unlock()
        }
        state?.active = false
        state?.audioPlayer?.setActive(false)
        // 코어가 판정한 원인 코드도 함께 올린다(iOS 와 같은 계약). 자바스크립트가 문구를 다시
        // 뜯지 않게 하려는 것이고, 인증 실패는 문구로는 가릴 수 없다.
        val fields = mutableMapOf<String, Any>("message" to message)
        if (!failure.isNullOrEmpty()) {
            fields["failure"] = failure
        }
        eventListener?.onSessionEvent(sessionId, "error", fields)
    }

    private fun handleClosed(
        sessionId: String,
        graceful: Boolean? = null,
        reason: String? = null,
    ) {
        val state = sessions[sessionId]
        state?.lock?.lock()
        try {
            state?.connected = false
        } finally {
            state?.lock?.unlock()
        }
        state?.active = false
        state?.audioPlayer?.stop()
        val details = mutableMapOf<String, Any?>()
        if (graceful != null) details["graceful"] = graceful
        if (!reason.isNullOrEmpty()) details["reason"] = reason
        eventListener?.onSessionEvent(sessionId, "closed", details)
    }

    private fun handleRdpEvent(sessionId: String, jsonUtf8: ByteArray) {
        val root = try {
            JSONObject(String(jsonUtf8, StandardCharsets.UTF_8))
        } catch (error: Throwable) {
            Log.e(TAG, "Invalid RDP control event", error)
            return
        }
        val type = root.optString("type")
        val payload = root.optJSONObject("payload") ?: JSONObject()
        when (type) {
            "connected" -> handleConnected(
                sessionId,
                payload.optInt("desktopWidth"),
                payload.optInt("desktopHeight"),
                "RDP",
            )
            "resized" -> handleResized(
                sessionId,
                payload.optInt("desktopWidth"),
                payload.optInt("desktopHeight"),
            )
            "certificateCheck" -> eventListener?.onSessionEvent(
                sessionId,
                "certificate",
                mapOf(
                    "fingerprint" to payload.optString("fingerprint"),
                    "subject" to payload.optString("subject"),
                    "issuer" to payload.optString("issuer"),
                    "notAfter" to payload.optString("notAfter"),
                ),
            )
            "clipboardText" -> {
                val state = sessions[sessionId] ?: return
                if (!state.active) return
                eventListener?.onSessionEvent(
                    sessionId,
                    "clipboard",
                    mapOf("text" to payload.optString("text")),
                )
            }
            "error" -> handleError(
                sessionId,
                payload.optString("message", "RDP session error"),
                payload.optString("failure").ifEmpty { null },
            )
            "closed" -> handleClosed(
                sessionId,
                payload.optBoolean("graceful", false),
                payload.optString("reason").ifEmpty { null },
            )
            else -> if (type.isNotEmpty()) {
                eventListener?.onSessionEvent(
                    sessionId,
                    type,
                    mapOf("payload" to payload.toString()),
                )
            }
        }
    }

    private fun handleCursor(
        sessionId: String,
        hotspotX: Int,
        hotspotY: Int,
        width: Int,
        height: Int,
        rgba: ByteArray,
    ) {
        val hidden = width == 0 && height == 0
        val expectedBytes = width.toLong() * height.toLong() * 4L
        val valid = hidden || (
            width in 1..MAX_CURSOR_DIMENSION &&
                height in 1..MAX_CURSOR_DIMENSION &&
                hotspotX in 0 until width &&
                hotspotY in 0 until height &&
                expectedBytes == rgba.size.toLong()
            )
        if (!valid) {
            handleError(sessionId, "Invalid cursor update ${width}x$height")
            disconnectSession(sessionId)
            return
        }

        val copiedRgba = if (hidden) {
            null
        } else {
            try {
                rgba.copyOf()
            } catch (error: OutOfMemoryError) {
                Log.e(TAG, "Could not copy cursor ${width}x$height", error)
                handleError(sessionId, "Could not allocate cursor ${width}x$height")
                disconnectSession(sessionId)
                return
            }
        }

        val state = sessions[sessionId] ?: return
        var viewToNotify: RemoteDesktopTextureView? = null
        state.lock.lock()
        try {
            state.cursorGeneration++
            state.cursorShape = copiedRgba?.let {
                CursorShape(
                    hotspotX = hotspotX,
                    hotspotY = hotspotY,
                    width = width,
                    height = height,
                    rgba = it,
                    generation = state.cursorGeneration,
                )
            }
            viewToNotify = state.textureView?.get()
        } finally {
            state.lock.unlock()
        }
        viewToNotify?.notifyCursorAvailable()
    }

    private fun updateCursorPosition(sessionId: String, x: Int, y: Int) {
        val state = sessions[sessionId] ?: return
        var viewToNotify: RemoteDesktopTextureView? = null
        state.lock.lock()
        try {
            if (state.cursorX == x && state.cursorY == y) return
            state.cursorX = x
            state.cursorY = y
            if (state.protocol == Protocol.VNC && state.cursorShape != null) {
                viewToNotify = state.textureView?.get()
            }
        } finally {
            state.lock.unlock()
        }
        viewToNotify?.notifyCursorAvailable()
    }

    /**
     * `pixels` 는 Rust 메모리를 직접 가리키는 direct buffer 다. 이 함수 안에서만 유효하므로
     * 여기서 framebuffer 로 옮기고 끝낸다 — 보관하거나 다른 스레드로 넘기면 안 된다.
     */
    private fun handleFrame(
        sessionId: String,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        pixels: ByteBuffer,
    ) {
        val state = sessions[sessionId] ?: return
        var invalidReason: String? = null
        var viewToNotify: RemoteDesktopTextureView? = null
        state.lock.lock()
        try {
            val framebuffer = state.framebuffer ?: return
            val desktopWidth = state.desktopWidth
            val desktopHeight = state.desktopHeight
            val expectedBytes = width.toLong() * height.toLong() * 4L
            val inBounds = x >= 0 && y >= 0 && width > 0 && height > 0 &&
                x.toLong() + width <= desktopWidth.toLong() &&
                y.toLong() + height <= desktopHeight.toLong()
            if (!inBounds || expectedBytes != pixels.remaining().toLong()) {
                invalidReason = "Invalid framebuffer update ${x},${y} ${width}x$height"
            } else {
                val desktopStride = desktopWidth * 4
                val rowBytes = width * 4
                // 절대 위치로 읽어 buffer 의 position 을 건드리지 않는다(같은 버퍼를 두 번 보지는
                // 않지만, position 에 의존하지 않는 편이 이 경계에서 실수가 적다).
                val source = pixels.duplicate()
                var offset = source.position()
                for (row in 0 until height) {
                    source.position(offset)
                    source.get(
                        framebuffer,
                        (y + row) * desktopStride + x * 4,
                        rowBytes,
                    )
                    offset += rowBytes
                }

                if (!state.fullDirty) {
                    val exceedsSnapshotBudget =
                        state.pendingDamageBytes + expectedBytes > framebuffer.size.toLong()
                    if (state.damageRects.size >= MAX_COALESCED_DAMAGE || exceedsSnapshotBudget) {
                        state.fullDirty = true
                        state.damageRects.clear()
                        state.pendingDamageBytes = framebuffer.size.toLong()
                    } else {
                        state.damageRects.add(Rect(x, y, x + width, y + height))
                        state.pendingDamageBytes += expectedBytes
                    }
                }
                viewToNotify = state.textureView?.get()
            }
        } finally {
            state.lock.unlock()
        }

        if (invalidReason != null) {
            handleError(sessionId, invalidReason!!)
            disconnectSession(sessionId)
            return
        }
        viewToNotify?.notifyFrameAvailable()
    }
}
