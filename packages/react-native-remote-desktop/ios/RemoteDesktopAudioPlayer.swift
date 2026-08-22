import AVFAudio
import Foundation

/// Native RDP PCM playback. Rust advertises one format: 44.1 kHz, stereo, signed 16-bit LE.
/// Buffers are copied during the C callback and never cross the React Native bridge.
final class RemoteDesktopAudioPlayer {
  private let queue = DispatchQueue(label: "com.dolssh.remote-desktop.rdp-audio")
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var format: AVAudioFormat?
  private var queuedBuffers = 0
  private var active = false
  private let maxQueuedBuffers = 12

  init() {
    engine.attach(player)
  }

  func enqueue(sampleRate: UInt32, channels: UInt16, bitsPerSample: UInt16,
               samples: UnsafePointer<UInt8>, samplesLen: UInt32) {
    guard sampleRate > 0, channels > 0, bitsPerSample == 16, samplesLen > 0 else { return }
    let copied = Data(bytes: samples, count: Int(samplesLen))
    queue.async { [weak self] in
      self?.enqueueCopied(
        sampleRate: sampleRate,
        channels: channels,
        samples: copied
      )
    }
  }

  func setActive(_ active: Bool) {
    queue.async { [weak self] in
      guard let self = self else { return }
      self.active = active
      if !active {
        self.player.stop()
        self.engine.stop()
        self.queuedBuffers = 0
        self.format = nil
      }
    }
  }

  func stop() {
    setActive(false)
  }

  private func enqueueCopied(sampleRate: UInt32, channels: UInt16, samples: Data) {
    guard active else { return }
    guard queuedBuffers < maxQueuedBuffers else { return }
    let bytesPerFrame = Int(channels) * MemoryLayout<Int16>.size
    guard bytesPerFrame > 0, samples.count >= bytesPerFrame else { return }
    let frameCount = samples.count / bytesPerFrame
    guard frameCount <= Int(AVAudioFrameCount.max) else { return }

    let targetFormat = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: Double(sampleRate),
      channels: AVAudioChannelCount(channels),
      interleaved: true
    )
    guard let targetFormat = targetFormat else { return }

    do {
      try configureIfNeeded(targetFormat)
    } catch {
      NSLog("RDP audio setup failed: %@", String(describing: error))
      return
    }

    guard let buffer = AVAudioPCMBuffer(
      pcmFormat: targetFormat,
      frameCapacity: AVAudioFrameCount(frameCount)
    ) else { return }
    buffer.frameLength = AVAudioFrameCount(frameCount)

    let audioBuffer = buffer.mutableAudioBufferList.pointee.mBuffers
    guard let destination = audioBuffer.mData else { return }
    let copyLength = min(samples.count, Int(audioBuffer.mDataByteSize))
    samples.copyBytes(to: destination.assumingMemoryBound(to: UInt8.self), count: copyLength)

    queuedBuffers += 1
    player.scheduleBuffer(buffer, completionCallbackType: .dataConsumed) { [weak self] _ in
      self?.queue.async {
        guard let self = self else { return }
        self.queuedBuffers = max(0, self.queuedBuffers - 1)
      }
    }
    if !player.isPlaying {
      player.play()
    }
  }

  private func configureIfNeeded(_ targetFormat: AVAudioFormat) throws {
    let unchanged = format?.sampleRate == targetFormat.sampleRate
      && format?.channelCount == targetFormat.channelCount
    if unchanged && engine.isRunning { return }

    player.stop()
    engine.stop()
    engine.disconnectNodeOutput(player)

    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
    try session.setActive(true)

    engine.connect(player, to: engine.mainMixerNode, format: targetFormat)
    engine.prepare()
    try engine.start()
    format = targetFormat
    queuedBuffers = 0
  }
}
