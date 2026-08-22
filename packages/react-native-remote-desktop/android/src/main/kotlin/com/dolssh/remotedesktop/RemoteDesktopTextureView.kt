package com.dolssh.remotedesktop

import android.content.Context
import android.graphics.SurfaceTexture
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.TextureView
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * TextureView-backed OpenGL ES surface for remote desktop rendering.
 *
 * Two modes:
 * 1. Test pattern (default) — animated color bars, no external data.
 * 2. Real-frame mode — when sessionId is set and a session is connected, reads
 *    the authoritative framebuffer from RemoteDesktopSessionManager and uploads
 *    dirty rects to a GL texture via glTexSubImage2D. Renders with aspect-fit.
 *
 * Damage-driven: only draws when damage is available or test pattern is active.
 * When paused, rendering stops but session stays connected. TextureView destroy
 * only detaches from session — does NOT disconnect.
 */
class RemoteDesktopTextureView(context: Context) : TextureView(context),
    TextureView.SurfaceTextureListener {

    companion object {
        private const val TAG = "DvncTextureView"
        private const val MAX_CURSOR_DIMENSION = 512
    }

    // ── Public properties (set from RN props) ───────────────────────

    var sessionId: String = ""
        set(value) {
            if (field == value) return
            detachFromSessionIfNeeded()
            field = value
            attachToSessionIfNeeded()
        }

    var protocolType: String = "vnc"

    @Volatile
    var paused: Boolean = false
        set(value) {
            field = value
            if (value) stopRendering() else startRendering()
        }

    @Volatile
    var testPattern: Boolean = true
        set(value) {
            if (field == value) return
            field = value
            requestRender()
        }

    var surfaceBackgroundColor: Int = 0xFF000000.toInt()

    // ── Events ──────────────────────────────────────────────────────

    var onSurfaceReady: ((width: Int, height: Int) -> Unit)? = null
    var onSurfaceDestroyed: (() -> Unit)? = null
    var onMetrics: ((fps: Double, dirtyRects: Int, frameTimeMs: Double) -> Unit)? = null

    // ── GL state ────────────────────────────────────────────────────

    private var renderThread: HandlerThread? = null
    @Volatile
    private var renderHandler: Handler? = null
    @Volatile
    private var surfaceWidth: Int = 0
    @Volatile
    private var surfaceHeight: Int = 0
    @Volatile
    private var rendering = false
    @Volatile
    private var surfaceReady = false
    @Volatile
    private var surfaceAvailable = false
    @Volatile
    private var surfaceGeneration = 0L
    private var attachedSessionId: String? = null

    // EGL
    private var egl: javax.microedition.khronos.egl.EGL10? = null
    private var eglDisplay: javax.microedition.khronos.egl.EGLDisplay? = null
    private var eglSurface: javax.microedition.khronos.egl.EGLSurface? = null
    private var eglContext: javax.microedition.khronos.egl.EGLContext? = null
    private var eglConfig: javax.microedition.khronos.egl.EGLConfig? = null

    // Shader programs
    private var testPatternProgram: Int = 0
    private var textureProgram: Int = 0
    private var textureId: Int = 0
    private var texWidth: Int = 0
    private var texHeight: Int = 0
    private var textureGeneration: Long = 0
    private var cursorTextureId: Int = 0
    private var cursorTextureGeneration: Long = 0
    private var cursorSnapshot: RemoteDesktopSessionManager.CursorSnapshot? = null

    // Callback threads only set flags; at most one real-frame runnable enters the GL queue.
    private val pendingFrame = AtomicBoolean(false)
    private val pendingCursor = AtomicBoolean(false)
    private val presentRequested = AtomicBoolean(false)
    private val renderScheduled = AtomicBoolean(false)

    // Metrics
    private var frameCount = 0
    private var lastMetricsTime = System.nanoTime()
    private var lastFrameTime = System.nanoTime()
    private var startTime = System.nanoTime()

    // Vertex data (fullscreen quad)
    private val quadVertices: FloatBuffer = ByteBuffer.allocateDirect(8 * 4)
        .order(ByteOrder.nativeOrder())
        .asFloatBuffer()
        .apply {
            put(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
            position(0)
        }

    // Test pattern render runnable (~30fps when active)
    private val testPatternRunnable = object : Runnable {
        override fun run() {
            if (!rendering || paused || !testPattern) return
            drawTestPattern()
            renderHandler?.postDelayed(this, 33L)
        }
    }

    init {
        isOpaque = false
        surfaceTextureListener = this
    }

    /**
     * Called from RemoteDesktopSessionManager when new frame data is available.
     * Can be called from any thread.
     */
    fun notifyFrameAvailable() {
        pendingFrame.set(true)
        scheduleRealFrame()
    }

    /** Called when only the VNC cursor shape or remote position changed. */
    fun notifyCursorAvailable() {
        pendingCursor.set(true)
        scheduleRealFrame()
    }

    private fun requestRender() {
        presentRequested.set(true)
        if (!surfaceReady || paused) return
        if (!rendering) {
            startRendering()
        } else if (testPattern) {
            renderHandler?.removeCallbacks(testPatternRunnable)
            renderHandler?.post(testPatternRunnable)
        } else {
            renderHandler?.removeCallbacks(testPatternRunnable)
            scheduleRealFrame()
        }
    }

    private fun canRenderRealFrame(): Boolean =
        rendering && surfaceReady && surfaceAvailable && !paused && !testPattern

    private fun scheduleRealFrame() {
        if (!canRenderRealFrame()) return
        val handler = renderHandler ?: return
        val generation = surfaceGeneration
        if (!renderScheduled.compareAndSet(false, true)) return

        val accepted = handler.post {
            try {
                if (generation != surfaceGeneration || !canRenderRealFrame()) return@post
                val hadFrame = pendingFrame.getAndSet(false)
                val hadCursor = pendingCursor.getAndSet(false)
                val forcePresent = presentRequested.getAndSet(false)
                if (hadFrame || hadCursor || forcePresent) {
                    drawRealFrame(forcePresent, hadCursor)
                }
            } finally {
                renderScheduled.set(false)
                if (generation == surfaceGeneration &&
                    (pendingFrame.get() || pendingCursor.get() || presentRequested.get())
                ) {
                    scheduleRealFrame()
                }
            }
        }
        if (!accepted) renderScheduled.set(false)
    }

    // ── SurfaceTextureListener ──────────────────────────────────────

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        surfaceWidth = width
        surfaceHeight = height
        surfaceAvailable = true
        val generation = ++surfaceGeneration
        initGL(surface, generation)
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        surfaceWidth = width
        surfaceHeight = height
        presentRequested.set(true)
        val generation = surfaceGeneration
        renderHandler?.post {
            if (generation != surfaceGeneration || !surfaceReady) return@post
            GLES20.glViewport(0, 0, width, height)
            scheduleRealFrame()
        }
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        tearDownSurface()
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) { /* no-op */ }

    /** Permanently release a dropped React Native view; safe after TextureView teardown. */
    fun release() {
        tearDownSurface()
    }

    // ── GL Setup ────────────────────────────────────────────────────

    private fun initGL(surfaceTexture: SurfaceTexture, generation: Long) {
        renderThread = HandlerThread("DvncGL-${hashCode()}-$generation").also { it.start() }
        val handler = Handler(renderThread!!.looper)
        renderHandler = handler

        handler.post glInit@{
            try {
                setupEGL(surfaceTexture)
                setupShaders()
                if (generation != surfaceGeneration || !surfaceAvailable) return@glInit
                GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight)
                surfaceReady = true
                startTime = System.nanoTime()
                lastMetricsTime = startTime
                post surfaceReady@{
                    if (generation != surfaceGeneration || !surfaceReady || !surfaceAvailable) {
                        return@surfaceReady
                    }
                    attachToSessionIfNeeded()
                    startRendering()
                    onSurfaceReady?.invoke(surfaceWidth, surfaceHeight)
                }
            } catch (error: Exception) {
                Log.e(TAG, "GL init failed", error)
                post {
                    if (generation == surfaceGeneration) tearDownSurface()
                }
            }
        }
    }

    private fun setupEGL(surfaceTexture: SurfaceTexture) {
        egl = javax.microedition.khronos.egl.EGLContext.getEGL() as javax.microedition.khronos.egl.EGL10
        eglDisplay = egl!!.eglGetDisplay(javax.microedition.khronos.egl.EGL10.EGL_DEFAULT_DISPLAY)

        val version = IntArray(2)
        check(egl!!.eglInitialize(eglDisplay, version)) { "eglInitialize failed" }

        val configAttribs = intArrayOf(
            javax.microedition.khronos.egl.EGL10.EGL_RENDERABLE_TYPE, 4,
            javax.microedition.khronos.egl.EGL10.EGL_RED_SIZE, 8,
            javax.microedition.khronos.egl.EGL10.EGL_GREEN_SIZE, 8,
            javax.microedition.khronos.egl.EGL10.EGL_BLUE_SIZE, 8,
            javax.microedition.khronos.egl.EGL10.EGL_ALPHA_SIZE, 8,
            javax.microedition.khronos.egl.EGL10.EGL_SURFACE_TYPE, javax.microedition.khronos.egl.EGL10.EGL_WINDOW_BIT,
            javax.microedition.khronos.egl.EGL10.EGL_NONE
        )
        val configs = arrayOfNulls<javax.microedition.khronos.egl.EGLConfig>(1)
        val numConfigs = IntArray(1)
        egl!!.eglChooseConfig(eglDisplay, configAttribs, configs, 1, numConfigs)
        check(numConfigs[0] > 0) { "No suitable EGL config" }
        eglConfig = configs[0]

        val contextAttribs = intArrayOf(0x3098, 2, javax.microedition.khronos.egl.EGL10.EGL_NONE)
        eglContext = egl!!.eglCreateContext(
            eglDisplay, eglConfig,
            javax.microedition.khronos.egl.EGL10.EGL_NO_CONTEXT, contextAttribs
        )
        check(eglContext != javax.microedition.khronos.egl.EGL10.EGL_NO_CONTEXT) { "eglCreateContext failed" }

        eglSurface = egl!!.eglCreateWindowSurface(eglDisplay, eglConfig, surfaceTexture, null)
        check(eglSurface != javax.microedition.khronos.egl.EGL10.EGL_NO_SURFACE) { "eglCreateWindowSurface failed" }

        check(egl!!.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) { "eglMakeCurrent failed" }
    }

    private fun setupShaders() {
        // Test pattern program
        testPatternProgram = createProgram(
            """
            attribute vec4 aPosition;
            varying vec2 vUV;
            void main() {
                gl_Position = aPosition;
                vUV = aPosition.xy * 0.5 + 0.5;
            }
            """.trimIndent(),
            """
            precision mediump float;
            varying vec2 vUV;
            uniform float uTime;
            void main() {
                float x = vUV.x;
                float barIndex = floor(x * 8.0);
                float r = mod(barIndex, 2.0) * (0.5 + 0.5 * sin(uTime + barIndex));
                float g = mod(barIndex + 1.0, 3.0) / 2.0 * (0.5 + 0.5 * cos(uTime * 0.7 + vUV.y * 3.14));
                float b = (1.0 - x) * (0.5 + 0.5 * sin(uTime * 1.3 + barIndex * 0.5));
                gl_FragColor = vec4(r, g, b, 1.0);
            }
            """.trimIndent()
        )

        // Texture program (aspect-fit VNC framebuffer)
        textureProgram = createProgram(
            """
            attribute vec2 aPosition;
            varying vec2 vUV;
            uniform vec4 uViewport; // x, y, w, h in NDC
            void main() {
                // Map [-1,1] quad to the aspect-fit viewport rect
                vec2 pos = aPosition * 0.5 + 0.5; // [0,1]
                pos = uViewport.xy + pos * uViewport.zw; // [x, x+w] etc
                pos = pos * 2.0 - 1.0; // back to NDC
                gl_Position = vec4(pos, 0.0, 1.0);
                // UV: flip Y for GL texture coordinate
                vUV = vec2(aPosition.x * 0.5 + 0.5, 1.0 - (aPosition.y * 0.5 + 0.5));
            }
            """.trimIndent(),
            """
            precision mediump float;
            varying vec2 vUV;
            uniform sampler2D uTexture;
            void main() {
                gl_FragColor = texture2D(uTexture, vUV);
            }
            """.trimIndent()
        )

        // Desktop and cursor bytes remain in separate native GL textures.
        val texIds = IntArray(2)
        GLES20.glGenTextures(2, texIds, 0)
        textureId = texIds[0]
        cursorTextureId = texIds[1]
        configureTexture(textureId)
        configureTexture(cursorTextureId)
    }

    private fun configureTexture(id: Int) {
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, id)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)
    }

    private fun createProgram(vertSrc: String, fragSrc: String): Int {
        val vs = compileShader(GLES20.GL_VERTEX_SHADER, vertSrc)
        val fs = compileShader(GLES20.GL_FRAGMENT_SHADER, fragSrc)
        val prog = GLES20.glCreateProgram()
        GLES20.glAttachShader(prog, vs)
        GLES20.glAttachShader(prog, fs)
        GLES20.glLinkProgram(prog)

        val linkStatus = IntArray(1)
        GLES20.glGetProgramiv(prog, GLES20.GL_LINK_STATUS, linkStatus, 0)
        if (linkStatus[0] == 0) {
            val log = GLES20.glGetProgramInfoLog(prog)
            GLES20.glDeleteProgram(prog)
            throw RuntimeException("Program link failed: $log")
        }

        GLES20.glDeleteShader(vs)
        GLES20.glDeleteShader(fs)
        return prog
    }

    private fun compileShader(type: Int, src: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, src)
        GLES20.glCompileShader(shader)

        val compileStatus = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compileStatus, 0)
        if (compileStatus[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(shader)
            GLES20.glDeleteShader(shader)
            throw RuntimeException("Shader compile failed ($type): $log")
        }
        return shader
    }

    // ── Rendering ───────────────────────────────────────────────────

    private fun drawTestPattern() {
        if (!surfaceReady || eglContext == null) return

        val now = System.nanoTime()
        val time = (now - startTime) / 1_000_000_000.0f

        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)

        GLES20.glUseProgram(testPatternProgram)
        val posLoc = GLES20.glGetAttribLocation(testPatternProgram, "aPosition")
        GLES20.glEnableVertexAttribArray(posLoc)
        GLES20.glVertexAttribPointer(posLoc, 2, GLES20.GL_FLOAT, false, 0, quadVertices)

        val timeLoc = GLES20.glGetUniformLocation(testPatternProgram, "uTime")
        GLES20.glUniform1f(timeLoc, time)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(posLoc)

        egl?.eglSwapBuffers(eglDisplay, eglSurface)
        reportMetrics(now)
    }

    private fun uploadFrameData(frameData: RemoteDesktopSessionManager.FrameData): Boolean {
        if (frameData.width <= 0 || frameData.height <= 0) return false
        val generationChanged = textureGeneration != frameData.generation ||
            texWidth != frameData.width || texHeight != frameData.height

        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)
        var fullPatch: RemoteDesktopSessionManager.FramePatch? = null
        if (generationChanged) {
            fullPatch = frameData.patches.firstOrNull { patch ->
                patch.x == 0 && patch.y == 0 &&
                    patch.width == frameData.width && patch.height == frameData.height
            }
            if (fullPatch == null || !isValidPatch(frameData, fullPatch)) {
                Log.e(TAG, "Framebuffer generation ${frameData.generation} has no valid full snapshot")
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)
                return false
            }
            GLES20.glTexImage2D(
                GLES20.GL_TEXTURE_2D,
                0,
                GLES20.GL_RGBA,
                frameData.width,
                frameData.height,
                0,
                GLES20.GL_RGBA,
                GLES20.GL_UNSIGNED_BYTE,
                ByteBuffer.wrap(fullPatch.pixels),
            )
            texWidth = frameData.width
            texHeight = frameData.height
            textureGeneration = frameData.generation
        }

        for (patch in frameData.patches) {
            if (patch === fullPatch || !isValidPatch(frameData, patch)) continue
            GLES20.glTexSubImage2D(
                GLES20.GL_TEXTURE_2D,
                0,
                patch.x,
                patch.y,
                patch.width,
                patch.height,
                GLES20.GL_RGBA,
                GLES20.GL_UNSIGNED_BYTE,
                ByteBuffer.wrap(patch.pixels),
            )
        }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)
        return true
    }

    private fun isValidPatch(
        frameData: RemoteDesktopSessionManager.FrameData,
        patch: RemoteDesktopSessionManager.FramePatch,
    ): Boolean {
        val expectedBytes = patch.width.toLong() * patch.height.toLong() * 4L
        return patch.x >= 0 && patch.y >= 0 && patch.width > 0 && patch.height > 0 &&
            patch.x.toLong() + patch.width <= frameData.width.toLong() &&
            patch.y.toLong() + patch.height <= frameData.height.toLong() &&
            expectedBytes == patch.pixels.size.toLong()
    }

    private fun refreshCursorSnapshot() {
        val snapshot = RemoteDesktopSessionManager.consumeCursor(sessionId)
        cursorSnapshot = snapshot
        val shape = snapshot?.shape ?: return
        if (shape.generation == cursorTextureGeneration) return

        val expectedBytes = shape.width.toLong() * shape.height.toLong() * 4L
        val valid = shape.width in 1..MAX_CURSOR_DIMENSION &&
            shape.height in 1..MAX_CURSOR_DIMENSION &&
            shape.hotspotX in 0 until shape.width &&
            shape.hotspotY in 0 until shape.height &&
            expectedBytes == shape.rgba.size.toLong()
        if (!valid) {
            Log.e(TAG, "Ignoring invalid cursor snapshot ${shape.width}x${shape.height}")
            cursorSnapshot = null
            return
        }

        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, cursorTextureId)
        GLES20.glTexImage2D(
            GLES20.GL_TEXTURE_2D,
            0,
            GLES20.GL_RGBA,
            shape.width,
            shape.height,
            0,
            GLES20.GL_RGBA,
            GLES20.GL_UNSIGNED_BYTE,
            ByteBuffer.wrap(shape.rgba),
        )
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)
        cursorTextureGeneration = shape.generation
    }

    private fun drawRealFrame(forcePresent: Boolean, cursorChanged: Boolean) {
        if (!surfaceReady || eglContext == null || sessionId.isEmpty()) return

        if (cursorChanged) refreshCursorSnapshot()
        val frameData = RemoteDesktopSessionManager.consumeDamage(sessionId)
        if (frameData != null && !uploadFrameData(frameData)) return
        if (frameData == null && !forcePresent && !cursorChanged) return
        if (texWidth <= 0 || texHeight <= 0 || surfaceWidth <= 0 || surfaceHeight <= 0) return

        val now = System.nanoTime()
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)

        // Draw with aspect-fit viewport
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)

        GLES20.glUseProgram(textureProgram)

        // Calculate aspect-fit in NDC [0,1]
        val surfAspect = surfaceWidth.toFloat() / surfaceHeight.toFloat()
        val texAspect = texWidth.toFloat() / texHeight.toFloat()
        val vx: Float
        val vy: Float
        val vw: Float
        val vh: Float
        if (texAspect > surfAspect) {
            // Letterbox (bars top/bottom)
            vw = 1f
            vh = surfAspect / texAspect
            vx = 0f
            vy = (1f - vh) / 2f
        } else {
            // Pillarbox (bars left/right)
            vh = 1f
            vw = texAspect / surfAspect
            vx = (1f - vw) / 2f
            vy = 0f
        }

        val viewportLoc = GLES20.glGetUniformLocation(textureProgram, "uViewport")
        GLES20.glUniform4f(viewportLoc, vx, vy, vw, vh)

        val texLoc = GLES20.glGetUniformLocation(textureProgram, "uTexture")
        GLES20.glUniform1i(texLoc, 0)

        val posLoc = GLES20.glGetAttribLocation(textureProgram, "aPosition")
        GLES20.glEnableVertexAttribArray(posLoc)
        GLES20.glVertexAttribPointer(posLoc, 2, GLES20.GL_FLOAT, false, 0, quadVertices)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        drawCursor(viewportLoc, vx, vy, vw, vh)
        GLES20.glDisableVertexAttribArray(posLoc)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)

        egl?.eglSwapBuffers(eglDisplay, eglSurface)
        reportMetrics(now)
    }

    private fun drawCursor(
        viewportLoc: Int,
        desktopX: Float,
        desktopY: Float,
        desktopWidth: Float,
        desktopHeight: Float,
    ) {
        val snapshot = cursorSnapshot ?: return
        val shape = snapshot.shape ?: return
        if (shape.generation != cursorTextureGeneration) return

        val remoteLeft = snapshot.x.toDouble() - shape.hotspotX.toDouble()
        val remoteTop = snapshot.y.toDouble() - shape.hotspotY.toDouble()
        val remoteRight = remoteLeft + shape.width.toDouble()
        val remoteBottom = remoteTop + shape.height.toDouble()
        if (remoteRight <= 0.0 || remoteBottom <= 0.0 ||
            remoteLeft >= texWidth.toDouble() || remoteTop >= texHeight.toDouble()
        ) {
            return
        }

        val cursorX = desktopX +
            (remoteLeft / texWidth.toDouble() * desktopWidth).toFloat()
        val cursorY = desktopY +
            ((texHeight.toDouble() - remoteBottom) / texHeight.toDouble() * desktopHeight).toFloat()
        val cursorWidth = shape.width.toFloat() / texWidth.toFloat() * desktopWidth
        val cursorHeight = shape.height.toFloat() / texHeight.toFloat() * desktopHeight

        val scissorLeft = kotlin.math.floor(desktopX * surfaceWidth).toInt()
            .coerceIn(0, surfaceWidth)
        val scissorBottom = kotlin.math.floor(desktopY * surfaceHeight).toInt()
            .coerceIn(0, surfaceHeight)
        val scissorRight = kotlin.math.ceil((desktopX + desktopWidth) * surfaceWidth).toInt()
            .coerceIn(scissorLeft, surfaceWidth)
        val scissorTop = kotlin.math.ceil((desktopY + desktopHeight) * surfaceHeight).toInt()
            .coerceIn(scissorBottom, surfaceHeight)
        if (scissorRight == scissorLeft || scissorTop == scissorBottom) return

        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        GLES20.glEnable(GLES20.GL_SCISSOR_TEST)
        GLES20.glScissor(
            scissorLeft,
            scissorBottom,
            scissorRight - scissorLeft,
            scissorTop - scissorBottom,
        )
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, cursorTextureId)
        GLES20.glUniform4f(viewportLoc, cursorX, cursorY, cursorWidth, cursorHeight)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)
        GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
        GLES20.glDisable(GLES20.GL_BLEND)
    }

    private fun reportMetrics(now: Long) {
        val frameTimeMs = (now - lastFrameTime) / 1_000_000.0
        lastFrameTime = now
        frameCount++
        val elapsed = (now - lastMetricsTime) / 1_000_000_000.0
        if (elapsed >= 1.0) {
            val fps = frameCount / elapsed
            val dirtyCount = frameCount // approximation
            Handler(Looper.getMainLooper()).post {
                onMetrics?.invoke(fps, dirtyCount, frameTimeMs)
            }
            frameCount = 0
            lastMetricsTime = now
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    private fun startRendering() {
        if (rendering || !surfaceReady || !surfaceAvailable || paused) return
        rendering = true
        if (testPattern) {
            renderHandler?.post(testPatternRunnable)
        } else {
            scheduleRealFrame()
        }
    }

    private fun stopRendering() {
        rendering = false
        renderHandler?.removeCallbacks(testPatternRunnable)
    }

    private fun attachToSessionIfNeeded() {
        if (!surfaceReady || !surfaceAvailable || sessionId.isEmpty() ||
            attachedSessionId == sessionId
        ) {
            return
        }
        detachFromSessionIfNeeded()
        RemoteDesktopSessionManager.attachTextureView(sessionId, this)
        attachedSessionId = sessionId
    }

    private fun detachFromSessionIfNeeded() {
        val attached = attachedSessionId ?: return
        RemoteDesktopSessionManager.detachTextureView(attached, this)
        attachedSessionId = null
    }

    private fun tearDownSurface() {
        val hadSurface = surfaceAvailable || surfaceReady || renderThread != null
        if (!hadSurface && attachedSessionId == null) return

        surfaceAvailable = false
        surfaceGeneration++
        stopRendering()
        detachFromSessionIfNeeded()
        pendingFrame.set(false)
        pendingCursor.set(false)
        presentRequested.set(false)
        destroyGL()
        if (hadSurface) onSurfaceDestroyed?.invoke()
    }

    private fun destroyGL() {
        surfaceReady = false
        val handler = renderHandler
        val thread = renderThread
        handler?.post {
            if (textureId != 0 || cursorTextureId != 0) {
                GLES20.glDeleteTextures(2, intArrayOf(textureId, cursorTextureId), 0)
                textureId = 0
                cursorTextureId = 0
            }
            if (testPatternProgram != 0) {
                GLES20.glDeleteProgram(testPatternProgram)
                testPatternProgram = 0
            }
            if (textureProgram != 0) {
                GLES20.glDeleteProgram(textureProgram)
                textureProgram = 0
            }
            egl?.eglMakeCurrent(
                eglDisplay,
                javax.microedition.khronos.egl.EGL10.EGL_NO_SURFACE,
                javax.microedition.khronos.egl.EGL10.EGL_NO_SURFACE,
                javax.microedition.khronos.egl.EGL10.EGL_NO_CONTEXT,
            )
            eglSurface?.let { egl?.eglDestroySurface(eglDisplay, it) }
            eglContext?.let { egl?.eglDestroyContext(eglDisplay, it) }
            egl?.eglTerminate(eglDisplay)
            eglSurface = null
            eglContext = null
            eglDisplay = null
            eglConfig = null
        }
        thread?.quitSafely()
        try {
            thread?.join(2_000)
            if (thread?.isAlive == true) {
                Log.w(TAG, "GL thread did not stop cleanly; forcing queue shutdown")
                thread.quit()
                thread.join(1_000)
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        renderThread = null
        renderHandler = null
        renderScheduled.set(false)
        textureId = 0
        cursorTextureId = 0
        testPatternProgram = 0
        textureProgram = 0
        texWidth = 0
        texHeight = 0
        textureGeneration = 0
        cursorTextureGeneration = 0
        cursorSnapshot = null
    }
}
