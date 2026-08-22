package com.dolssh.remotedesktop

/**
 * JNI callback interface. The C++ bridge calls these methods from the Rust worker thread.
 *
 * **[onFrame] 의 버퍼만 예외다** — 그것은 Rust 메모리를 직접 가리키는 direct buffer 이고 콜백이
 * 반환하면 무효가 된다. 그 안에서 다 읽고 끝내야 한다. 나머지 `ByteArray` 인자는 JNI 가 복사한
 * 것이라 보관해도 된다.
 */
interface NativeSessionCallback {
    fun onConnected(width: Int, height: Int, name: String)
    fun onResized(width: Int, height: Int)
    fun onCapabilities(json: String)
    fun onClipboard(text: String)
    fun onError(message: String)
    fun onClosed()

    /** Length-delimited UTF-8 RDP control event JSON copied by JNI. */
    fun onRdpEvent(jsonUtf8: ByteArray)

    /** Decoded PCM copied by JNI and consumed only by Android AudioTrack. */
    fun onAudio(
        sampleRate: Int,
        channels: Int,
        bitsPerSample: Int,
        timestamp: Int,
        samples: ByteArray
    )

    /**
     * Frame rectangle RGBA pixels as a **direct buffer over Rust memory**.
     *
     * 콜백이 반환하기 전에 읽어서 자기 버퍼로 옮겨야 한다 — 보관하면 해제된 메모리를 가리킨다.
     * 프레임은 rect 단위로 자주 오므로 여기서 복사를 한 번 아끼는 것이 그대로 프레임 경로의
     * 비용이 된다(이전에는 JNI 가 byte[] 를 만들어 복사하고, Kotlin 이 다시 복사했다).
     *
     * Layout: x, y = top-left offset in desktop; remaining() = width*height*4 RGBA.
     */
    fun onFrame(x: Int, y: Int, width: Int, height: Int, pixels: java.nio.ByteBuffer)

    /** Cursor shape RGBA. width/height=0 means hide cursor. */
    fun onCursor(hotspotX: Int, hotspotY: Int, width: Int, height: Int, rgba: ByteArray)
}
