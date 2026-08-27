import Foundation
import UIKit

enum RemoteDesktopPolicyError {
  static let viewOnly: Int32 = -7
}

// MARK: - Session Status

/// Session status broadcast via RN events.
enum SessionStatus: String {
  case connecting
  case connected
  case disconnecting
  case disconnected
  case error
}

// MARK: - Damage Region

/// A dirty rectangle in desktop coordinates.
struct DamageRect {
  let x: UInt16
  let y: UInt16
  let width: UInt16
  let height: UInt16
}

struct DamageBatch {
  let full: Bool
  let rects: [DamageRect]
}

struct FramebufferReadLock {
  let pointer: UnsafeRawPointer
  let stride: Int
  let width: UInt16
  let height: UInt16
  let generation: UInt64
}

struct CursorShape {
  let hotspotX: UInt16
  let hotspotY: UInt16
  let width: UInt16
  let height: UInt16
  let rgba: Data
  let generation: UInt64
}

struct CursorSnapshot {
  let shape: CursorShape?
  let x: UInt16
  let y: UInt16
}

// MARK: - Session Entry

/// Owns the VNC opaque handle + the authoritative RGBA framebuffer for one session.
final class VNCSessionEntry {
  let sessionId: String

  // Rust opaque handles — exactly one is populated for a live session.
  var handle: DvncSessionHandle?
  var rdpHandle: DrdpSessionHandle?
  var protocolType: String = "vnc"
  private let interactionPolicyLock = NSLock()
  private var viewOnly = false
  private var active = false
  let audioPlayer = RemoteDesktopAudioPlayer()

  // Desktop dimensions (set on connected/resized callbacks)
  private(set) var desktopWidth: UInt16 = 0
  private(set) var desktopHeight: UInt16 = 0
  fileprivate(set) var desktopName: String = ""

  // Authoritative RGBA framebuffer — written by Rust worker thread, read by Metal view
  private let framebufferLock = NSLock()
  private(set) var framebuffer: UnsafeMutableRawPointer?
  private(set) var framebufferSize: Int = 0
  private var framebufferGeneration: UInt64 = 0

  // Damage queue — bounded, coalesced into fullDirty on overflow
  private let damageQueueLock = NSLock()
  private var damageQueue: [DamageRect] = []
  private var fullDirty: Bool = false
  private static let maxDamageRects = 64
  // 64 MiB RGBA: enough for 4K while preventing a hostile server from
  // requesting a multi-gigabyte allocation through 16-bit RFB dimensions.
  private static let maxFramebufferPixels = 16_777_216

  // VNC cursor shape and local remote pointer coordinates share one snapshot lock.
  private let cursorLock = NSLock()
  private var cursorShape: CursorShape?
  private var cursorX: UInt16 = 0
  private var cursorY: UInt16 = 0
  private var cursorGeneration: UInt64 = 0
  private var cursorNotificationPending = false
  static let maxCursorDimension: UInt16 = 512

  // Attached weak view reference
  weak var attachedView: RemoteDesktopMetalView?

  // Status is written both by RN lifecycle calls and Rust callbacks.
  private let statusLock = NSLock()
  private var statusValue: SessionStatus = .disconnected

  var status: SessionStatus {
    statusLock.lock()
    defer { statusLock.unlock() }
    return statusValue
  }

  // Retain the Unmanaged pointer used as user_data for C callbacks
  var unmanagedSelf: Unmanaged<VNCSessionEntry>?

  init(sessionId: String) {
    self.sessionId = sessionId
  }

  deinit {
    deallocateFramebuffer()
  }

  func setViewOnly(_ value: Bool) {
    interactionPolicyLock.lock()
    viewOnly = value
    interactionPolicyLock.unlock()
  }

  func isViewOnly() -> Bool {
    interactionPolicyLock.lock()
    defer { interactionPolicyLock.unlock() }
    return viewOnly
  }

  func setActive(_ value: Bool) {
    interactionPolicyLock.lock()
    active = value
    interactionPolicyLock.unlock()
    audioPlayer.setActive(value)
  }

  func isActive() -> Bool {
    interactionPolicyLock.lock()
    defer { interactionPolicyLock.unlock() }
    return active
  }

  // MARK: - Framebuffer Management

  @discardableResult
  func allocateFramebuffer(width: UInt16, height: UInt16) -> UInt64? {
    let pixelCount = Int(width) * Int(height)
    guard width > 0, height > 0,
          pixelCount <= VNCSessionEntry.maxFramebufferPixels else {
      return nil
    }

    framebufferLock.lock()
    let newSize = pixelCount * 4
    let dimensionsChanged = desktopWidth != width || desktopHeight != height
    if framebuffer == nil || framebufferSize != newSize {
      let replacement = UnsafeMutableRawPointer.allocate(byteCount: newSize, alignment: 16)
      memset(replacement, 0, newSize)
      framebuffer?.deallocate()
      framebuffer = replacement
    } else if dimensionsChanged, let framebuffer {
      // A reshape may have the same byte count (for example 1920x1080 -> 1080x1920).
      memset(framebuffer, 0, newSize)
    }
    if dimensionsChanged || framebufferGeneration == 0 {
      framebufferGeneration &+= 1
    }
    framebufferSize = newSize
    desktopWidth = width
    desktopHeight = height
    let generation = framebufferGeneration
    framebufferLock.unlock()

    markFullDirty()
    return generation
  }

  private func deallocateFramebuffer() {
    framebufferLock.lock()
    defer { framebufferLock.unlock() }
    if let fb = framebuffer {
      fb.deallocate()
      framebuffer = nil
      framebufferSize = 0
    }
  }

  /// Copy pixels from the Rust callback into the authoritative framebuffer.
  /// Called on the Rust worker thread — MUST be fast, no allocations.
  func copyFrame(x: UInt16, y: UInt16, width: UInt16, height: UInt16, pixels: UnsafeRawPointer, pixelsLen: UInt32) {
    framebufferLock.lock()
    defer { framebufferLock.unlock() }

    guard let fb = framebuffer else { return }
    let dw = Int(desktopWidth)
    let rectW = Int(width)
    let rectH = Int(height)
    let srcStride = rectW * 4
    let dstStride = dw * 4

    // Bounds check
    guard Int(x) + rectW <= dw,
          Int(y) + rectH <= Int(desktopHeight),
          Int(pixelsLen) >= srcStride * rectH else {
      // Invalid rect — coalesce to a full refresh under the damage lock.
      markFullDirty()
      return
    }

    // Row-by-row copy
    for row in 0..<rectH {
      let srcOffset = row * srcStride
      let dstOffset = (Int(y) + row) * dstStride + Int(x) * 4
      memcpy(fb.advanced(by: dstOffset), pixels.advanced(by: srcOffset), srcStride)
    }

    // Enqueue damage
    pushDamage(DamageRect(x: x, y: y, width: width, height: height))
  }

  // MARK: - Damage Queue

  private func pushDamage(_ rect: DamageRect) {
    damageQueueLock.lock()
    defer { damageQueueLock.unlock() }

    if fullDirty { return } // already full

    if damageQueue.count >= VNCSessionEntry.maxDamageRects {
      // Overflow → coalesce to full
      damageQueue.removeAll(keepingCapacity: true)
      fullDirty = true
    } else {
      damageQueue.append(rect)
    }
  }

  func markFullDirty() {
    damageQueueLock.lock()
    defer { damageQueueLock.unlock() }
    damageQueue.removeAll(keepingCapacity: true)
    fullDirty = true
  }

  /// Drain the damage queue atomically. A full batch takes its dimensions from the subsequent
  /// framebuffer read lock, so resize and damage generations cannot be mixed.
  func drainDamage() -> DamageBatch? {
    damageQueueLock.lock()
    defer { damageQueueLock.unlock() }

    if fullDirty {
      fullDirty = false
      damageQueue.removeAll(keepingCapacity: true)
      return DamageBatch(full: true, rects: [])
    }
    if damageQueue.isEmpty { return nil }
    let result = damageQueue
    damageQueue.removeAll(keepingCapacity: true)
    return DamageBatch(full: false, rects: result)
  }

  /// Lock the framebuffer and all metadata belonging to the same allocation generation.
  /// Caller must call unlockFramebuffer() when done.
  func lockFramebuffer() -> FramebufferReadLock? {
    framebufferLock.lock()
    guard let fb = framebuffer else {
      framebufferLock.unlock()
      return nil
    }
    return FramebufferReadLock(
      pointer: UnsafeRawPointer(fb),
      stride: Int(desktopWidth) * 4,
      width: desktopWidth,
      height: desktopHeight,
      generation: framebufferGeneration
    )
  }

  func unlockFramebuffer() {
    framebufferLock.unlock()
  }

  /// Store a callback-owned cursor copy and coalesce the main-queue redraw notification.
  func updateCursorShape(hotspotX: UInt16, hotspotY: UInt16,
                         width: UInt16, height: UInt16, rgba: Data?) -> Bool {
    cursorLock.lock()
    defer { cursorLock.unlock() }
    cursorGeneration &+= 1
    cursorShape = rgba.map {
      CursorShape(
        hotspotX: hotspotX,
        hotspotY: hotspotY,
        width: width,
        height: height,
        rgba: $0,
        generation: cursorGeneration
      )
    }
    if cursorNotificationPending { return false }
    cursorNotificationPending = true
    return true
  }

  /// Record coordinates carried by every outbound pointer event.
  func updateCursorPosition(x: UInt16, y: UInt16) -> Bool {
    cursorLock.lock()
    defer { cursorLock.unlock() }
    guard cursorX != x || cursorY != y else { return false }
    cursorX = x
    cursorY = y
    guard cursorShape != nil, !cursorNotificationPending else { return false }
    cursorNotificationPending = true
    return true
  }

  func consumeCursorSnapshot() -> CursorSnapshot {
    cursorLock.lock()
    defer { cursorLock.unlock() }
    cursorNotificationPending = false
    return CursorSnapshot(shape: cursorShape, x: cursorX, y: cursorY)
  }

  func setStatus(_ s: SessionStatus) {
    statusLock.lock()
    statusValue = s
    statusLock.unlock()
    switch s {
    case .error, .disconnecting, .disconnected:
      setActive(false)
    case .connecting, .connected:
      break
    }
  }
}

// MARK: - Session Manager (Singleton)

/// Owns all VNC sessions. Views attach/detach without destroying sessions.
/// Tab switching detaches the view but the session + framebuffer remain live.
final class RemoteDesktopSessionManager {
  static let shared = RemoteDesktopSessionManager()

  private let sessionsLock = NSLock()
  private var sessions: [String: VNCSessionEntry] = [:]

  /// Event emitter callback — set by the RN module
  var eventEmitter: ((_ eventName: String, _ body: [String: Any]) -> Void)?

  private init() {}

  // MARK: - Session CRUD

  func getOrCreateSession(id: String) -> VNCSessionEntry {
    sessionsLock.lock()
    defer { sessionsLock.unlock() }
    if let existing = sessions[id] { return existing }
    let entry = VNCSessionEntry(sessionId: id)
    sessions[id] = entry
    return entry
  }

  func getSession(id: String) -> VNCSessionEntry? {
    sessionsLock.lock()
    defer { sessionsLock.unlock() }
    return sessions[id]
  }

  /// Tears the session down and releases the callback context.
  ///
  /// **user_data may only be released once destroy reports DVNC_OK / DRDP_OK.** The cores return
  /// `*_ERR_CALLBACK_THREAD` when destroy runs on their own worker callback thread: shutdown is
  /// requested but the worker is still alive and still holds this pointer, so releasing here would
  /// be a use-after-free. Today every callback hops to the main queue before reaching this method,
  /// so the retry path is defensive — but the cost of being wrong is a memory-corruption crash, and
  /// the cost of the retry is one dispatch.
  func removeSession(id: String) {
    sessionsLock.lock()
    let entry = sessions.removeValue(forKey: id)
    sessionsLock.unlock()

    guard let entry = entry else { return }
    entry.audioPlayer.stop()
    finishTeardown(entry: entry, attempt: 0)
  }

  private static let teardownRetryLimit = 5
  private static let teardownRetryDelay: TimeInterval = 0.05

  private func finishTeardown(entry: VNCSessionEntry, attempt: Int) {
    var mustRetry = false

    if let h = entry.handle {
      _ = dvnc_session_disconnect(h)
      let result = dvnc_session_destroy(h)
      if result == DVNC_ERR_CALLBACK_THREAD {
        mustRetry = true
      } else {
        entry.handle = nil
      }
    }
    if let h = entry.rdpHandle {
      _ = drdp_session_disconnect(h)
      let result = drdp_session_destroy(h)
      if result == DRDP_ERR_CALLBACK_THREAD {
        mustRetry = true
      } else {
        entry.rdpHandle = nil
      }
    }

    if mustRetry, attempt < Self.teardownRetryLimit {
      // Never on this thread — it is the worker's own callback thread.
      DispatchQueue.global(qos: .utility).asyncAfter(
        deadline: .now() + Self.teardownRetryDelay
      ) { [weak self] in
        self?.finishTeardown(entry: entry, attempt: attempt + 1)
      }
      return
    }

    if mustRetry {
      // Give up on joining rather than freeing a pointer the worker still reads. The leak is
      // bounded (one session) and visible in logs; a use-after-free is neither.
      NSLog(
        "[RemoteDesktop] destroy kept returning ERR_CALLBACK_THREAD for %@ — leaking the callback context on purpose",
        entry.sessionId
      )
      return
    }

    entry.unmanagedSelf?.release()
    entry.unmanagedSelf = nil
  }

  // MARK: - Connect

  func connect(sessionId: String, host: String, port: UInt16, password: String,
               username: String, imageQuality: String, tunnelAuthToken: String,
               shared: Bool, viewOnly: Bool) -> Int32 {
    let entry = getOrCreateSession(id: sessionId)

    guard entry.status == .disconnected || entry.status == .error else {
      return DVNC_ERR_ALREADY_STARTED
    }

    entry.protocolType = "vnc"
    entry.setViewOnly(viewOnly)
    entry.setStatus(.connecting)
    emitEvent(sessionId: sessionId, status: .connecting)

    // Retain the entry for user_data
    let unmanaged = Unmanaged.passRetained(entry)
    entry.unmanagedSelf = unmanaged
    let userData = unmanaged.toOpaque()

    // Set up callbacks
    var callbacks = DvncCallbacks(
      user_data: userData,
      on_connected: onConnectedCallback,
      on_resized: onResizedCallback,
      on_capabilities: onCapabilitiesCallback,
      on_clipboard: onClipboardCallback,
      on_error: onErrorCallback,
      on_closed: onClosedCallback,
      on_frame: onFrameCallback,
      on_cursor: onCursorCallback
    )

    // Create session handle
    var handle: DvncSessionHandle?
    let createResult = dvnc_session_create(&callbacks, &handle)
    guard createResult == DVNC_OK, let h = handle else {
      entry.setStatus(.error)
      entry.unmanagedSelf?.release()
      entry.unmanagedSelf = nil
      emitEvent(sessionId: sessionId, status: .error, error: "Failed to create session: \(createResult)")
      return createResult
    }
    entry.handle = h

    // Start connection
    let hostCStr = host.withCString { strdup($0) }!
    let passCStr = password.withCString { strdup($0) }!
    let userCStr = username.withCString { strdup($0) }!
    let qualCStr = imageQuality.withCString { strdup($0) }!
    let tunnelAuthCStr = tunnelAuthToken.withCString { strdup($0) }!
    defer {
      free(hostCStr)
      free(passCStr)
      free(userCStr)
      free(qualCStr)
      free(tunnelAuthCStr)
    }

    var config = DvncConnectConfig(
      host: hostCStr,
      port: port,
      password: passCStr,
      username: userCStr,
      image_quality: qualCStr,
      shared: shared ? 1 : 0,
      tunnel_auth_token: tunnelAuthCStr
    )

    let startResult = dvnc_session_start(h, &config)
    if startResult != DVNC_OK {
      entry.setStatus(.error)
      emitEvent(sessionId: sessionId, status: .error, error: "Failed to start session: \(startResult)")
      dvnc_session_destroy(h)
      entry.handle = nil
      entry.unmanagedSelf?.release()
      entry.unmanagedSelf = nil
    }
    return startResult
  }

  // MARK: - RDP Connect

  func connectRdp(sessionId: String, host: String, dialAddress: String,
                  tunnelAuthToken: String,
                  port: UInt16, username: String, password: String, domain: String,
                  desktopWidth: UInt16, desktopHeight: UInt16,
                  audioEnabled: Bool, clipboardEnabled: Bool,
                  microphoneEnabled: Bool, cameraEnabled: Bool,
                  adminSession: Bool, colorDepth: UInt8, drivesJSON: String) -> Int32 {
    let entry = getOrCreateSession(id: sessionId)
    guard entry.status == .disconnected || entry.status == .error else {
      return DRDP_ERR_ALREADY_STARTED
    }

    entry.protocolType = "rdp"
    entry.setViewOnly(false)
    entry.setStatus(.connecting)
    emitEvent(sessionId: sessionId, status: .connecting)

    let unmanaged = Unmanaged.passRetained(entry)
    entry.unmanagedSelf = unmanaged
    var callbacks = DrdpCallbacks(
      user_data: unmanaged.toOpaque(),
      on_event: onRdpEventCallback,
      on_frame: onFrameCallback,
      on_audio: onRdpAudioCallback
    )

    var handle: DrdpSessionHandle?
    let createResult = drdp_session_create(&callbacks, &handle)
    guard createResult == DRDP_OK, let h = handle else {
      entry.setStatus(.error)
      entry.unmanagedSelf?.release()
      entry.unmanagedSelf = nil
      emitEvent(
        sessionId: sessionId,
        status: .error,
        error: "Failed to create RDP session: \(createResult)"
      )
      return createResult
    }
    entry.rdpHandle = h

    let hostCStr = host.withCString { strdup($0) }!
    let dialCStr = dialAddress.withCString { strdup($0) }!
    let tunnelAuthCStr = tunnelAuthToken.withCString { strdup($0) }!
    let userCStr = username.withCString { strdup($0) }!
    let passCStr = password.withCString { strdup($0) }!
    let domainCStr = domain.withCString { strdup($0) }!
    let drivesCStr = drivesJSON.withCString { strdup($0) }!
    defer {
      free(hostCStr)
      free(dialCStr)
      free(tunnelAuthCStr)
      free(userCStr)
      free(passCStr)
      free(domainCStr)
      free(drivesCStr)
    }

    var config = DrdpConnectConfig(
      host: hostCStr,
      dial_address: dialCStr,
      port: port,
      username: userCStr,
      password: passCStr,
      domain: domainCStr,
      desktop_width: desktopWidth,
      desktop_height: desktopHeight,
      audio_enabled: audioEnabled ? 1 : 0,
      clipboard_enabled: clipboardEnabled ? 1 : 0,
      microphone_enabled: microphoneEnabled ? 1 : 0,
      camera_enabled: cameraEnabled ? 1 : 0,
      admin_session: adminSession ? 1 : 0,
      color_depth: colorDepth,
      drives_json: drivesCStr,
      tunnel_auth_token: tunnelAuthCStr
    )

    let startResult = drdp_session_start(h, &config)
    if startResult != DRDP_OK {
      entry.setStatus(.error)
      emitEvent(
        sessionId: sessionId,
        status: .error,
        error: "Failed to start RDP session: \(startResult)"
      )
      _ = drdp_session_destroy(h)
      entry.rdpHandle = nil
      entry.unmanagedSelf?.release()
      entry.unmanagedSelf = nil
    }
    return startResult
  }

  // MARK: - Disconnect

  func disconnect(sessionId: String) -> Int32 {
    guard let entry = getSession(id: sessionId) else {
      return DVNC_ERR_INVALID_HANDLE
    }
    entry.setStatus(.disconnecting)
    emitEvent(sessionId: sessionId, status: .disconnecting)
    if let h = entry.handle {
      return dvnc_session_disconnect(h)
    }
    if let h = entry.rdpHandle {
      return drdp_session_disconnect(h)
    }
    return DVNC_ERR_INVALID_HANDLE
  }

  // MARK: - Destroy (full teardown)

  func destroySession(sessionId: String) {
    removeSession(id: sessionId)
  }

  func destroyAllSessions() {
    sessionsLock.lock()
    let sessionIds = Array(sessions.keys)
    sessionsLock.unlock()
    for sessionId in sessionIds {
      removeSession(id: sessionId)
    }
  }

  // MARK: - View Attach / Detach

  func attachView(_ view: RemoteDesktopMetalView, sessionId: String) {
    let entry = getOrCreateSession(id: sessionId)
    entry.attachedView = view
    view.setActiveState(entry.isActive())
  }

  func detachView(_ view: RemoteDesktopMetalView, sessionId: String) {
    guard let entry = getSession(id: sessionId) else { return }
    if entry.attachedView === view {
      entry.attachedView = nil
    }
    // Session stays alive — framebuffer keeps updating
  }

  // MARK: - Input forwarding

  fileprivate func scheduleCursorRedraw(for entry: VNCSessionEntry) {
    DispatchQueue.main.async { [weak entry] in
      entry?.attachedView?.onCursorChanged()
    }
  }

  func pointerMove(sessionId: String, x: UInt16, y: UInt16) {
    guard let entry = getSession(id: sessionId) else { return }
    if let h = entry.handle {
      guard !entry.isViewOnly() else { return }
      if entry.updateCursorPosition(x: x, y: y) {
        scheduleCursorRedraw(for: entry)
      }
      _ = dvnc_session_pointer_move(h, x, y)
    } else if let h = entry.rdpHandle {
      _ = drdp_session_pointer_move(h, x, y)
    }
  }

  func pointerButton(sessionId: String, button: UInt8, pressed: Bool, x: UInt16, y: UInt16) {
    guard let entry = getSession(id: sessionId) else { return }
    if let h = entry.handle {
      guard !entry.isViewOnly() else { return }
      if entry.updateCursorPosition(x: x, y: y) {
        scheduleCursorRedraw(for: entry)
      }
      _ = dvnc_session_pointer_button(h, button, pressed ? 1 : 0, x, y)
    } else if let h = entry.rdpHandle {
      _ = drdp_session_pointer_button(h, button, pressed ? 1 : 0, x, y)
    }
  }

  func scroll(sessionId: String, vertical: Bool, delta: Int16, x: UInt16, y: UInt16) {
    guard let entry = getSession(id: sessionId) else { return }
    if let h = entry.handle {
      guard !entry.isViewOnly() else { return }
      if entry.updateCursorPosition(x: x, y: y) {
        scheduleCursorRedraw(for: entry)
      }
      _ = dvnc_session_pointer_scroll(h, vertical ? 1 : 0, delta, x, y)
    } else if let h = entry.rdpHandle {
      _ = drdp_session_pointer_scroll(h, vertical ? 1 : 0, delta, x, y)
    }
  }

  func keyEvent(sessionId: String, keysym: UInt32, keycode: UInt32, down: Bool) {
    guard let entry = getSession(id: sessionId) else { return }
    if let h = entry.handle {
      guard !entry.isViewOnly() else { return }
      if down {
        _ = dvnc_session_key_down(h, keysym, keycode)
      } else {
        _ = dvnc_session_key_up(h, keysym, keycode)
      }
      return
    }
    guard let h = entry.rdpHandle, keycode > 0, keycode <= UInt32(UInt16.max) else { return }
    _ = drdp_session_key(h, UInt16(keycode), down ? 1 : 0)
  }

  func unicodeEvent(sessionId: String, codepoint: UInt32, down: Bool) {
    guard let entry = getSession(id: sessionId), let h = entry.rdpHandle else { return }
    _ = drdp_session_unicode(h, codepoint, down ? 1 : 0)
  }

  func trustCertificate(sessionId: String, accept: Bool) -> Int32 {
    guard let entry = getSession(id: sessionId), let h = entry.rdpHandle else {
      return DRDP_ERR_INVALID_HANDLE
    }
    return drdp_session_trust_certificate(h, accept ? 1 : 0)
  }

  func sendClipboard(sessionId: String, text: String) -> Int32 {
    guard let entry = getSession(id: sessionId) else { return DVNC_ERR_INVALID_HANDLE }
    if entry.handle != nil, entry.isViewOnly() {
      return RemoteDesktopPolicyError.viewOnly
    }
    return text.withCString { cstr in
      if let h = entry.handle {
        return dvnc_session_send_clipboard(h, cstr)
      }
      if let h = entry.rdpHandle {
        return drdp_session_send_clipboard(h, cstr)
      }
      return Int32(DVNC_ERR_INVALID_HANDLE)
    }
  }

  func refresh(sessionId: String) {
    guard let entry = getSession(id: sessionId) else { return }
    if let h = entry.handle {
      _ = dvnc_session_refresh(h)
    } else if let h = entry.rdpHandle {
      _ = drdp_session_refresh(h)
    }
  }

  func resize(sessionId: String, width: UInt16, height: UInt16) -> Int32 {
    guard let entry = getSession(id: sessionId) else { return DVNC_ERR_INVALID_HANDLE }
    if let h = entry.handle {
      guard !entry.isViewOnly() else { return RemoteDesktopPolicyError.viewOnly }
      return dvnc_session_request_desktop_size(h, width, height)
    }
    if let h = entry.rdpHandle {
      return drdp_session_resize(h, width, height)
    }
    return DVNC_ERR_INVALID_HANDLE
  }

  // MARK: - Event Emission

  fileprivate func emitEvent(sessionId: String, status: SessionStatus, error: String? = nil,
                         extraFields: [String: Any] = [:]) {
    var body: [String: Any] = [
      "sessionId": sessionId,
      "status": status.rawValue,
    ]
    if let error = error { body["error"] = error }
    for (k, v) in extraFields { body[k] = v }
    eventEmitter?("remoteDesktopSessionEvent", body)
  }
}

// MARK: - C Callback Implementations (called on Rust worker thread)

private func rejectOversizedFramebuffer(entry: VNCSessionEntry,
                                        width: UInt16, height: UInt16) {
  let message = "Remote framebuffer \(width)x\(height) exceeds the mobile limit"
  entry.setStatus(.error)
  // This callback runs on the Rust worker. Request shutdown here, but leave
  // destroy/join and user_data release to the JS-driven manager teardown.
  if let handle = entry.handle {
    _ = dvnc_session_disconnect(handle)
  }
  if let handle = entry.rdpHandle {
    _ = drdp_session_disconnect(handle)
  }
  DispatchQueue.main.async {
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .error,
      error: message
    )
  }
}

private func rejectInvalidCursor(entry: VNCSessionEntry,
                                 width: UInt16, height: UInt16) {
  let message = "Invalid cursor update \(width)x\(height)"
  entry.setStatus(.error)
  if let handle = entry.handle {
    _ = dvnc_session_disconnect(handle)
  }
  DispatchQueue.main.async {
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .error,
      error: message
    )
  }
}

private func onConnectedCallback(userData: UnsafeMutableRawPointer?,
                                  desktopWidth: UInt16, desktopHeight: UInt16,
                                  name: UnsafePointer<CChar>?) {
  guard let userData = userData else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  guard let generation = entry.allocateFramebuffer(width: desktopWidth, height: desktopHeight) else {
    rejectOversizedFramebuffer(entry: entry, width: desktopWidth, height: desktopHeight)
    return
  }
  entry.desktopName = name.map { String(cString: $0) } ?? ""
  entry.setStatus(.connected)

  DispatchQueue.main.async {
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .connected,
      extraFields: [
        "desktopWidth": Int(desktopWidth),
        "desktopHeight": Int(desktopHeight),
        "desktopName": entry.desktopName,
      ]
    )
    entry.attachedView?.onSessionConnected(generation: generation)
  }
}

private func onResizedCallback(userData: UnsafeMutableRawPointer?,
                                desktopWidth: UInt16, desktopHeight: UInt16) {
  guard let userData = userData else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  guard let generation = entry.allocateFramebuffer(width: desktopWidth, height: desktopHeight) else {
    rejectOversizedFramebuffer(entry: entry, width: desktopWidth, height: desktopHeight)
    return
  }

  DispatchQueue.main.async {
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .connected,
      extraFields: [
        "type": "resized",
        "desktopWidth": Int(desktopWidth),
        "desktopHeight": Int(desktopHeight),
      ]
    )
    entry.attachedView?.onSessionResized(generation: generation)
  }
}

private func onCapabilitiesCallback(userData: UnsafeMutableRawPointer?, json: UnsafePointer<CChar>?) {
  guard let userData = userData, let json = json else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  let jsonStr = String(cString: json)
  DispatchQueue.main.async {
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .connected,
      extraFields: ["type": "capabilities", "capabilities": jsonStr]
    )
  }
}

private func onClipboardCallback(userData: UnsafeMutableRawPointer?, text: UnsafePointer<CChar>?) {
  guard let userData = userData, let text = text else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  let textStr = String(cString: text)
  DispatchQueue.main.async {
    guard entry.isActive() else { return }
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .connected,
      extraFields: ["type": "clipboard", "text": textStr]
    )
  }
}

private func onErrorCallback(userData: UnsafeMutableRawPointer?, message: UnsafePointer<CChar>?) {
  guard let userData = userData, let message = message else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  let msg = String(cString: message)
  entry.setStatus(.error)
  DispatchQueue.main.async {
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .error,
      error: msg
    )
  }
}

private func onClosedCallback(userData: UnsafeMutableRawPointer?) {
  guard let userData = userData else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  entry.setStatus(.disconnected)

  // Keep the retained callback context and opaque handle until destroySession().
  // dvnc_session_destroy joins the worker; only then may user_data be released.

  DispatchQueue.main.async {
    RemoteDesktopSessionManager.shared.emitEvent(
      sessionId: entry.sessionId,
      status: .disconnected
    )
  }
}

private func onFrameCallback(userData: UnsafeMutableRawPointer?,
                              x: UInt16, y: UInt16, width: UInt16, height: UInt16,
                              pixels: UnsafePointer<UInt8>?, pixelsLen: UInt32) {
  guard let userData = userData, let pixels = pixels else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  // Copy immediately — pointer invalid after return
  entry.copyFrame(x: x, y: y, width: width, height: height,
                  pixels: UnsafeRawPointer(pixels), pixelsLen: pixelsLen)
}

private func onCursorCallback(userData: UnsafeMutableRawPointer?,
                               hotspotX: UInt16, hotspotY: UInt16,
                               width: UInt16, height: UInt16,
                               rgba: UnsafePointer<UInt8>?, rgbaLen: UInt32) {
  guard let userData else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  let hidden = width == 0 && height == 0

  let copiedRgba: Data?
  if hidden {
    guard rgbaLen == 0 else {
      rejectInvalidCursor(entry: entry, width: width, height: height)
      return
    }
    copiedRgba = nil
  } else {
    let expectedLength = Int(width) * Int(height) * 4
    guard width > 0, height > 0,
          width <= VNCSessionEntry.maxCursorDimension,
          height <= VNCSessionEntry.maxCursorDimension,
          hotspotX < width, hotspotY < height,
          let rgba, Int(rgbaLen) == expectedLength else {
      rejectInvalidCursor(entry: entry, width: width, height: height)
      return
    }
    // Callback memory expires on return; retain a bounded native copy immediately.
    copiedRgba = Data(bytes: rgba, count: expectedLength)
  }

  if entry.updateCursorShape(
    hotspotX: hotspotX,
    hotspotY: hotspotY,
    width: width,
    height: height,
    rgba: copiedRgba
  ) {
    RemoteDesktopSessionManager.shared.scheduleCursorRedraw(for: entry)
  }
}

// MARK: - RDP callbacks

private func rdpUInt16(_ payload: [String: Any], _ key: String) -> UInt16? {
  guard let number = payload[key] as? NSNumber else { return nil }
  let value = number.intValue
  guard value > 0, value <= Int(UInt16.max) else { return nil }
  return UInt16(value)
}

private func onRdpEventCallback(userData: UnsafeMutableRawPointer?,
                                json: UnsafePointer<UInt8>?, jsonLen: UInt32) {
  guard let userData = userData, let json = json, jsonLen > 0 else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  let data = Data(bytes: json, count: Int(jsonLen))
  guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let type = root["type"] as? String,
        let payload = root["payload"] as? [String: Any] else {
    return
  }

  switch type {
  case "connected":
    guard let width = rdpUInt16(payload, "desktopWidth"),
          let height = rdpUInt16(payload, "desktopHeight") else { return }
    guard let generation = entry.allocateFramebuffer(width: width, height: height) else {
      rejectOversizedFramebuffer(entry: entry, width: width, height: height)
      return
    }
    entry.desktopName = "RDP"
    entry.setStatus(.connected)
    DispatchQueue.main.async {
      RemoteDesktopSessionManager.shared.emitEvent(
        sessionId: entry.sessionId,
        status: .connected,
        extraFields: [
          "desktopWidth": Int(width),
          "desktopHeight": Int(height),
          "desktopName": entry.desktopName,
        ]
      )
      entry.attachedView?.onSessionConnected(generation: generation)
    }

  case "resized":
    guard let width = rdpUInt16(payload, "desktopWidth"),
          let height = rdpUInt16(payload, "desktopHeight") else { return }
    guard let generation = entry.allocateFramebuffer(width: width, height: height) else {
      rejectOversizedFramebuffer(entry: entry, width: width, height: height)
      return
    }
    DispatchQueue.main.async {
      RemoteDesktopSessionManager.shared.emitEvent(
        sessionId: entry.sessionId,
        status: .connected,
        extraFields: [
          "type": "resized",
          "desktopWidth": Int(width),
          "desktopHeight": Int(height),
        ]
      )
      entry.attachedView?.onSessionResized(generation: generation)
    }

  case "certificateCheck":
    DispatchQueue.main.async {
      RemoteDesktopSessionManager.shared.emitEvent(
        sessionId: entry.sessionId,
        status: .connecting,
        extraFields: [
          "type": "certificate",
          "fingerprint": payload["fingerprint"] as? String ?? "",
          "subject": payload["subject"] as? String ?? "",
          "issuer": payload["issuer"] as? String ?? "",
          "notAfter": payload["notAfter"] as? String ?? "",
        ]
      )
    }

  case "clipboardText":
    DispatchQueue.main.async {
      guard entry.isActive() else { return }
      RemoteDesktopSessionManager.shared.emitEvent(
        sessionId: entry.sessionId,
        status: .connected,
        extraFields: [
          "type": "clipboard",
          "text": payload["text"] as? String ?? "",
        ]
      )
    }

  case "error":
    let message = payload["message"] as? String ?? "RDP session error"
    // 코어가 판정한 원인 코드도 함께 올린다. 자바스크립트가 문구를 다시 뜯지 않게 하려는
    // 것이고, 인증 실패는 문구로는 가릴 수 없다 — 서버가 붙이는 사유는 서버가 정하는 문장이다.
    var errorFields: [String: Any] = [:]
    if let failure = payload["failure"] as? String, !failure.isEmpty {
      errorFields["failure"] = failure
    }
    entry.setStatus(.error)
    DispatchQueue.main.async {
      RemoteDesktopSessionManager.shared.emitEvent(
        sessionId: entry.sessionId,
        status: .error,
        error: message,
        extraFields: errorFields
      )
    }

  case "closed":
    entry.setStatus(.disconnected)
    entry.audioPlayer.stop()
    var fields: [String: Any] = [
      "type": "closed",
      "graceful": (payload["graceful"] as? NSNumber)?.boolValue ?? false,
    ]
    if let reason = payload["reason"] as? String {
      fields["reason"] = reason
    }
    DispatchQueue.main.async {
      RemoteDesktopSessionManager.shared.emitEvent(
        sessionId: entry.sessionId,
        status: .disconnected,
        extraFields: fields
      )
    }

  default:
    // Microphone/camera capability events stay pixel-free and are forwarded for future UI use.
    DispatchQueue.main.async {
      RemoteDesktopSessionManager.shared.emitEvent(
        sessionId: entry.sessionId,
        status: entry.status,
        extraFields: ["type": type, "payload": payload]
      )
    }
  }
}

private func onRdpAudioCallback(userData: UnsafeMutableRawPointer?,
                                sampleRate: UInt32, channels: UInt16,
                                bitsPerSample: UInt16, timestamp: UInt32,
                                samples: UnsafePointer<UInt8>?, samplesLen: UInt32) {
  guard let userData = userData, let samples = samples else { return }
  let entry = Unmanaged<VNCSessionEntry>.fromOpaque(userData).takeUnretainedValue()
  guard entry.isActive() else { return }
  entry.audioPlayer.enqueue(
    sampleRate: sampleRate,
    channels: channels,
    bitsPerSample: bitsPerSample,
    samples: samples,
    samplesLen: samplesLen
  )
}
