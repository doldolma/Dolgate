package com.dolssh.remotedesktop

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.max

/**
 * Bounded streaming PCM player for RDP audio.
 *
 * JNI has already copied each borrowed Rust callback buffer into [ByteArray].
 * This queue remains entirely native-side. If rendering falls behind, the oldest
 * audio is dropped instead of blocking the RDP worker or accumulating latency.
 */
class RemoteDesktopAudioPlayer {
    private data class Packet(
        val sampleRate: Int,
        val channels: Int,
        val bitsPerSample: Int,
        val samples: ByteArray,
    )

    companion object {
        private const val TAG = "RdpAudioPlayer"
        private const val MAX_QUEUED_BUFFERS = 12
    }

    private val queue = ArrayBlockingQueue<Packet>(MAX_QUEUED_BUFFERS)

    @Volatile
    private var running = true

    @Volatile
    private var active = false

    private val worker = Thread({ playbackLoop() }, "rdp-audio-player").apply {
        isDaemon = true
        start()
    }

    fun enqueue(
        sampleRate: Int,
        channels: Int,
        bitsPerSample: Int,
        samples: ByteArray,
    ) {
        if (!running || !active || samples.isEmpty()) return
        if (sampleRate <= 0 || channels !in 1..2 || bitsPerSample != 16) {
            Log.w(TAG, "Ignoring unsupported PCM format: ${sampleRate}/${channels}/${bitsPerSample}")
            return
        }

        val packet = Packet(sampleRate, channels, bitsPerSample, samples)
        if (!queue.offer(packet)) {
            queue.poll()
            queue.offer(packet)
        }
    }

    fun setActive(active: Boolean) {
        if (!running) return
        this.active = active
        if (!active) queue.clear()
        worker.interrupt()
    }

    fun stop() {
        if (!running) return
        active = false
        running = false
        queue.clear()
        worker.interrupt()
    }

    private fun playbackLoop() {
        var audioTrack: AudioTrack? = null
        var activeFormat: Triple<Int, Int, Int>? = null
        try {
            while (running) {
                if (!active) {
                    release(audioTrack)
                    audioTrack = null
                    activeFormat = null
                    try {
                        Thread.sleep(250)
                    } catch (_: InterruptedException) {
                        // Activation and shutdown wake the worker immediately.
                    }
                    continue
                }
                val packet = try {
                    queue.poll(250, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    null
                } ?: continue
                if (!active) continue

                val format = Triple(packet.sampleRate, packet.channels, packet.bitsPerSample)
                if (audioTrack == null || activeFormat != format) {
                    release(audioTrack)
                    audioTrack = createTrack(packet.sampleRate, packet.channels)
                    activeFormat = format
                }
                val track = audioTrack ?: continue
                var offset = 0
                while (running && active && offset < packet.samples.size) {
                    val written = track.write(
                        packet.samples,
                        offset,
                        packet.samples.size - offset,
                        AudioTrack.WRITE_BLOCKING,
                    )
                    if (written <= 0) {
                        Log.w(TAG, "AudioTrack write failed: $written")
                        release(track)
                        audioTrack = null
                        activeFormat = null
                        break
                    }
                    offset += written
                }
            }
        } catch (error: Throwable) {
            Log.e(TAG, "RDP audio playback stopped", error)
        } finally {
            release(audioTrack)
        }
    }

    private fun createTrack(sampleRate: Int, channels: Int): AudioTrack? {
        val channelMask = if (channels == 1) {
            AudioFormat.CHANNEL_OUT_MONO
        } else {
            AudioFormat.CHANNEL_OUT_STEREO
        }
        val minimum = AudioTrack.getMinBufferSize(
            sampleRate,
            channelMask,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) {
            Log.w(TAG, "AudioTrack rejected PCM format: $minimum")
            return null
        }
        val bytesPerSecond = sampleRate * channels * 2
        val bufferSize = max(minimum, bytesPerSecond / 5)
        return try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setLegacyStreamType(AudioManager.STREAM_MUSIC)
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(bufferSize)
                .build()
                .also { it.play() }
        } catch (error: IllegalArgumentException) {
            Log.e(TAG, "Could not create AudioTrack", error)
            null
        } catch (error: IllegalStateException) {
            Log.e(TAG, "Could not start AudioTrack", error)
            null
        }
    }

    private fun release(track: AudioTrack?) {
        if (track == null) return
        try {
            track.pause()
            track.flush()
            track.stop()
        } catch (_: IllegalStateException) {
            // A failed/partially initialized track can already be stopped.
        } finally {
            track.release()
        }
    }
}
