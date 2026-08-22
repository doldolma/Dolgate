import Foundation
import UIKit
import React

/// React Native Native Module for VNC session lifecycle and input.
///
/// JS contract:
/// - isAvailable(protocol) → Promise<bool>
/// - connect(sessionId, options) → Promise<void>
/// - disconnect(sessionId) → Promise<void>
/// - setActive(sessionId, active) → Promise<void>
/// - pointerMove(sessionId, x, y)
/// - pointerButton(sessionId, button, pressed, x, y)
/// - scroll(sessionId, vertical, delta, x, y)
/// - keyEvent(sessionId, keysym, pressed, keycode)
/// - sendClipboard(sessionId, text) → Promise<void>
/// - refresh(sessionId) → Promise<void>
/// - resize(sessionId, width, height) → Promise<void>
///
/// Events: "remoteDesktopSessionEvent" — session status/control events.
/// Pixel events are NEVER sent to JS.
@objc(RemoteDesktopSessionModule)
final class RemoteDesktopSessionModule: RCTEventEmitter {

  private var hasListeners = false

  private func clampedUInt8(_ value: Double) -> UInt8 {
    guard value.isFinite else { return 0 }
    return UInt8(min(max(value, 0), Double(UInt8.max)))
  }

  private func clampedUInt16(_ value: Double) -> UInt16 {
    guard value.isFinite else { return 0 }
    return UInt16(min(max(value, 0), Double(UInt16.max)))
  }

  private func clampedUInt32(_ value: Double) -> UInt32 {
    guard value.isFinite else { return 0 }
    return UInt32(min(max(value, 0), Double(UInt32.max)))
  }

  private func clampedInt16(_ value: Double) -> Int16 {
    guard value.isFinite else { return 0 }
    return Int16(min(max(value, Double(Int16.min)), Double(Int16.max)))
  }

  override init() {
    super.init()
    RemoteDesktopSessionManager.shared.eventEmitter = { [weak self] eventName, body in
      guard let self = self, self.hasListeners else { return }
      self.sendEvent(withName: eventName, body: body)
    }
  }

  @objc override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String] {
    return ["remoteDesktopSessionEvent"]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  override func invalidate() {
    hasListeners = false
    RemoteDesktopSessionManager.shared.eventEmitter = nil
    RemoteDesktopSessionManager.shared.destroyAllSessions()
    super.invalidate()
  }

  // MARK: - isAvailable

  @objc func isAvailable(_ protocolType: String,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    let supported = protocolType.lowercased()
    resolve(supported == "vnc" || supported == "rdp")
  }

  private func validatedDrivesJSON(
    _ value: Any?,
    reject: RCTPromiseRejectBlock
  ) -> String? {
    guard let value, !(value is NSNull) else { return "[]" }
    guard let drives = value as? [Any] else {
      reject("INVALID_DRIVE_PATH", "drives must be an array", nil)
      return nil
    }
    for (index, rawDrive) in drives.enumerated() {
      guard let drive = rawDrive as? [String: Any],
            let rawPath = drive["path"] as? String else {
        reject("INVALID_DRIVE_PATH", "drive at index \(index) requires a path", nil)
        return nil
      }
      let path = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
      var isDirectory = ObjCBool(false)
      let accessible = (path as NSString).isAbsolutePath
        && FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        && isDirectory.boolValue
        && FileManager.default.isReadableFile(atPath: path)
      guard accessible else {
        reject(
          "INVALID_DRIVE_PATH",
          "RDP drive path must be an accessible absolute filesystem directory; "
            + "security-scoped URLs and paths from another device are unsupported: \(path)",
          nil
        )
        return nil
      }
    }
    guard JSONSerialization.isValidJSONObject(drives),
          let data = try? JSONSerialization.data(withJSONObject: drives),
          let json = String(data: data, encoding: .utf8) else {
      reject("INVALID_DRIVE_PATH", "drives must be JSON serializable", nil)
      return nil
    }
    return json
  }

  // MARK: - connect

  @objc func connect(_ sessionId: String,
                      options: NSDictionary,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let host = options["host"] as? String, !host.isEmpty else {
      reject("INVALID_ARGS", "host is required", nil)
      return
    }

    let protocolType = (options["protocol"] as? String ?? "vnc").lowercased()
    guard protocolType == "vnc" || protocolType == "rdp" else {
      reject("INVALID_ARGS", "unsupported protocol: \(protocolType)", nil)
      return
    }
    let defaultPort = protocolType == "rdp" ? 3389 : 5900
    let rawPort = (options["port"] as? NSNumber)?.intValue ?? defaultPort
    guard rawPort > 0, rawPort <= Int(UInt16.max) else {
      reject("INVALID_ARGS", "port must be between 1 and 65535", nil)
      return
    }

    let password = options["password"] as? String ?? ""
    let username = options["username"] as? String ?? ""
    let result: Int32

    if protocolType == "vnc" {
      result = RemoteDesktopSessionManager.shared.connect(
        sessionId: sessionId,
        host: host,
        port: UInt16(rawPort),
        password: password,
        username: username,
        imageQuality: options["imageQuality"] as? String ?? "lossless",
        tunnelAuthToken: options["tunnelAuthToken"] as? String ?? "",
        shared: (options["shared"] as? NSNumber)?.boolValue ?? true,
        viewOnly: (options["viewOnly"] as? NSNumber)?.boolValue ?? false
      )
    } else {
      let width = (options["desktopWidth"] as? NSNumber)?.intValue ?? 1280
      let height = (options["desktopHeight"] as? NSNumber)?.intValue ?? 720
      guard width > 0, width <= Int(UInt16.max),
            height > 0, height <= Int(UInt16.max) else {
        reject("INVALID_ARGS", "desktop dimensions must be between 1 and 65535", nil)
        return
      }
      let colorDepth = (options["colorDepth"] as? NSNumber)?.intValue ?? 32
      guard colorDepth == 16 || colorDepth == 32 else {
        reject("INVALID_ARGS", "colorDepth must be 16 or 32", nil)
        return
      }
      guard let drivesJSON = validatedDrivesJSON(options["drives"], reject: reject) else {
        return
      }

      result = RemoteDesktopSessionManager.shared.connectRdp(
        sessionId: sessionId,
        host: host,
        dialAddress: options["dialAddress"] as? String ?? "",
        tunnelAuthToken: options["tunnelAuthToken"] as? String ?? "",
        port: UInt16(rawPort),
        username: username,
        password: password,
        domain: options["domain"] as? String ?? "",
        desktopWidth: UInt16(width),
        desktopHeight: UInt16(height),
        audioEnabled: (options["audioEnabled"] as? NSNumber)?.boolValue ?? true,
        clipboardEnabled: (options["clipboardEnabled"] as? NSNumber)?.boolValue ?? true,
        microphoneEnabled: (options["microphoneEnabled"] as? NSNumber)?.boolValue ?? false,
        cameraEnabled: (options["cameraEnabled"] as? NSNumber)?.boolValue ?? false,
        adminSession: (options["adminSession"] as? NSNumber)?.boolValue ?? false,
        colorDepth: UInt8(colorDepth),
        drivesJSON: drivesJSON
      )
    }

    if result == 0 {
      resolve(nil)
    } else {
      reject("CONNECT_FAILED", "native session start returned \(result)", nil)
    }
  }

  // MARK: - disconnect

  @objc func disconnect(_ sessionId: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard RemoteDesktopSessionManager.shared.getSession(id: sessionId) != nil else {
      reject("NO_SESSION", "Session not found: \(sessionId)", nil)
      return
    }
    RemoteDesktopSessionManager.shared.destroySession(sessionId: sessionId)
    resolve(nil)
  }

  // MARK: - setActive

  @objc func setActive(_ sessionId: String,
                        active: Bool,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let entry = RemoteDesktopSessionManager.shared.getSession(id: sessionId) else {
      reject("NO_SESSION", "Session not found: \(sessionId)", nil)
      return
    }
    entry.setActive(active)
    DispatchQueue.main.async {
      entry.attachedView?.setActiveState(active)
      resolve(nil)
    }
  }

  /**
   * 화면이 저절로 꺼지지 않게 잡아 둔다.
   *
   * `isIdleTimerDisabled` 는 권한도 프롬프트도 없고, 앱이 앞에 있는 동안에만 효력이 있다 —
   * 백그라운드로 가면 시스템이 알아서 되돌린다.
   */
  @objc func setKeepAwake(
    _ enabled: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = enabled
      resolve(nil)
    }
  }

  @objc func setOrientationUnlocked(
    _ unlocked: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      NotificationCenter.default.post(
        name: Notification.Name("com.dolgate.remoteDesktopOrientation"),
        object: nil,
        userInfo: ["unlocked": unlocked]
      )
      resolve(nil)
    }
  }

  // MARK: - Input (fire-and-forget, no promises for perf)

  @objc func pointerMove(_ sessionId: String, x: Double, y: Double) {
    RemoteDesktopSessionManager.shared.pointerMove(
      sessionId: sessionId, x: clampedUInt16(x), y: clampedUInt16(y))
  }

  @objc func pointerButton(_ sessionId: String, button: Double,
                             pressed: Bool, x: Double, y: Double) {
    RemoteDesktopSessionManager.shared.pointerButton(
      sessionId: sessionId, button: clampedUInt8(button),
      pressed: pressed, x: clampedUInt16(x), y: clampedUInt16(y))
  }

  @objc func scroll(_ sessionId: String, vertical: Bool,
                     delta: Double, x: Double, y: Double) {
    RemoteDesktopSessionManager.shared.scroll(
      sessionId: sessionId, vertical: vertical,
      delta: clampedInt16(delta), x: clampedUInt16(x), y: clampedUInt16(y))
  }

  @objc func keyEvent(_ sessionId: String, keysym: Double,
                       pressed: Bool, keycode: Double) {
    RemoteDesktopSessionManager.shared.keyEvent(
      sessionId: sessionId, keysym: clampedUInt32(keysym),
      keycode: clampedUInt32(keycode), down: pressed)
  }

  @objc func unicodeEvent(_ sessionId: String, codepoint: Double, pressed: Bool) {
    RemoteDesktopSessionManager.shared.unicodeEvent(
      sessionId: sessionId, codepoint: clampedUInt32(codepoint), down: pressed)
  }

  @objc func trustCertificate(_ sessionId: String,
                               accept: Bool,
                               resolver resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    let result = RemoteDesktopSessionManager.shared.trustCertificate(
      sessionId: sessionId,
      accept: accept
    )
    if result == DRDP_OK {
      resolve(nil)
    } else {
      reject("TRUST_FAILED", "drdp_session_trust_certificate returned \(result)", nil)
    }
  }

  // MARK: - Clipboard

  @objc func sendClipboard(_ sessionId: String,
                            text: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    let result = RemoteDesktopSessionManager.shared.sendClipboard(
      sessionId: sessionId,
      text: text
    )
    resolveControl(result, code: "CLIPBOARD_FAILED", resolve: resolve, reject: reject)
  }

  // MARK: - Refresh

  @objc func refresh(_ sessionId: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    RemoteDesktopSessionManager.shared.refresh(sessionId: sessionId)
    resolve(nil)
  }

  // MARK: - Resize

  @objc func resize(_ sessionId: String,
                     width: Double, height: Double,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    let result = RemoteDesktopSessionManager.shared.resize(
      sessionId: sessionId,
      width: clampedUInt16(width),
      height: clampedUInt16(height)
    )
    resolveControl(result, code: "RESIZE_FAILED", resolve: resolve, reject: reject)
  }

  private func resolveControl(_ result: Int32, code: String,
                              resolve: @escaping RCTPromiseResolveBlock,
                              reject: @escaping RCTPromiseRejectBlock) {
    if result == 0 {
      resolve(nil)
    } else if result == RemoteDesktopPolicyError.viewOnly {
      reject("VIEW_ONLY", "Native VNC session is view-only", nil)
    } else {
      reject(code, "Native control call returned \(result)", nil)
    }
  }
}
