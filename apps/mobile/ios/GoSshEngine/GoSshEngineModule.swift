import Foundation
import React
import SshCoreEngine

/// Bridges the Go SSH engine (services/ssh-core/mobile, bound with gomobile) to JS.
///
/// This mirrors the Android module: JS cannot hold a Go object, so connections
/// and shells live here in registries addressed by string handles, and terminal
/// bytes cross as base64. The engine's ring buffer is what makes that
/// affordable — one merged buffer per coalescing window rather than one per read
/// from the socket.
///
/// Every engine call can block on the network, so all of them run off the JS
/// thread and settle their promise from there.
@objc(GoSshEngineModule)
final class GoSshEngineModule: RCTEventEmitter {

  private static let eventChunk = "GoSshEngine:chunk"
  private static let eventDropped = "GoSshEngine:dropped"
  private static let eventShellClosed = "GoSshEngine:shellClosed"
  private static let eventDisconnected = "GoSshEngine:disconnected"
  private static let errorCode = "go_ssh_engine_error"

  private let engine = MobileNewEngine()
  private let worker = DispatchQueue(
    label: "com.dolgate.gosshengine",
    qos: .userInitiated,
    attributes: .concurrent
  )

  /// Guards the registries only; engine calls happen outside it so a slow
  /// network operation cannot block an unrelated lookup.
  private let registryLock = NSLock()
  private var connections: [String: MobileConn] = [:]
  private var shells: [String: MobileShell] = [:]
  private var sftpSessions: [String: MobileSFTPSession] = [:]
  private var shellSuffix: Int64 = 0
  private var sftpSuffix: Int64 = 0

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String] {
    [
      GoSshEngineModule.eventChunk,
      GoSshEngineModule.eventDropped,
      GoSshEngineModule.eventShellClosed,
      GoSshEngineModule.eventDisconnected,
    ]
  }

  override func invalidate() {
    super.invalidate()

    registryLock.lock()
    let openShells = Array(shells.values)
    let openSftp = Array(sftpSessions.values)
    let openConnections = Array(connections.values)
    shells.removeAll()
    sftpSessions.removeAll()
    connections.removeAll()
    registryLock.unlock()

    for sftp in openSftp { try? sftp.close() }
    for shell in openShells { try? shell.close() }
    for connection in openConnections { try? connection.close() }
  }

  // MARK: - Engine level

  @objc(getEngineVersion:reject:)
  func getEngineVersion(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { MobileVersion() }
  }

  @objc(probeHostKey:resolve:reject:)
  func probeHostKey(
    requestJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      return try callReturningString { engine.probeHostKey(requestJson, error: $0) }
    }
  }

  @objc(inspectPrivateKey:passphrase:resolve:reject:)
  func inspectPrivateKey(
    privateKeyPem: String,
    passphrase: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      return try callReturningString {
        engine.inspectPrivateKey(privateKeyPem, passphrase: passphrase, error: $0)
      }
    }
  }

  @objc(inspectCertificate:resolve:reject:)
  func inspectCertificate(
    certificateText: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      return try callReturningString { engine.inspectCertificate(certificateText, error: $0) }
    }
  }

  // MARK: - Connections

  @objc(connect:requestJson:resolve:reject:)
  func connect(
    connectionId: String,
    requestJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let engine = try requireEngine(self.engine)
      var disconnected = false
      var registrationComplete = false
      var callbackConnection: MobileConn?

      let connection = try engine.connect(
        requestJson,
        responder: nil,
        onDisconnected: DisconnectedRelay { [weak self] _ in
          guard let self else { return }
          self.registryLock.lock()
          let shouldEmit: Bool
          if !registrationComplete {
            disconnected = true
            shouldEmit = true
          } else if let callbackConnection,
                    self.connections[connectionId] === callbackConnection {
            self.connections.removeValue(forKey: connectionId)
            for key in self.shells.keys where key.hasPrefix("\(connectionId)#") {
              self.shells.removeValue(forKey: key)
            }
            for key in self.sftpSessions.keys where key.hasPrefix("\(connectionId)~sftp") {
              self.sftpSessions.removeValue(forKey: key)
            }
            shouldEmit = true
          } else {
            shouldEmit = false
          }
          self.registryLock.unlock()
          if shouldEmit {
            self.dispatch(GoSshEngineModule.eventDisconnected, ["connectionId": connectionId])
          }
        }
      )
      let info = try callReturningString { connection.infoJSON($0) }

      // A reconnect under the same handle must not orphan the previous one.
      self.registryLock.lock()
      callbackConnection = connection
      registrationComplete = true
      let closedBeforeRegistration = disconnected
      let previous = closedBeforeRegistration
        ? nil
        : self.connections.updateValue(connection, forKey: connectionId)
      self.registryLock.unlock()
      if closedBeforeRegistration {
        try? connection.close()
      } else if let previous {
        try? previous.close()
      }

      return info
    }
  }

  @objc(disconnect:resolve:reject:)
  func disconnect(
    connectionId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      self.registryLock.lock()
      let connection = self.connections.removeValue(forKey: connectionId)
      for key in self.shells.keys where key.hasPrefix("\(connectionId)#") {
        self.shells.removeValue(forKey: key)
      }
      for key in self.sftpSessions.keys where key.hasPrefix("\(connectionId)~sftp") {
        self.sftpSessions.removeValue(forKey: key)
      }
      self.registryLock.unlock()

      try connection?.close()
      return nil
    }
  }

  // MARK: - Shells

  @objc(startShell:optionsJson:resolve:reject:)
  func startShell(
    connectionId: String,
    optionsJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      self.registryLock.lock()
      let connection = self.connections[connectionId]
      self.shellSuffix += 1
      let shellId = "\(connectionId)#\(self.shellSuffix)"
      self.registryLock.unlock()

      guard let connection else { throw EngineError.missingConnection(connectionId) }

      var closed = false
      let shell = try connection.startShell(
        optionsJson,
        onClosed: ShellClosedRelay { [weak self] _ in
          guard let self else { return }
          self.registryLock.lock()
          closed = true
          self.shells.removeValue(forKey: shellId)
          self.registryLock.unlock()
          self.dispatch(GoSshEngineModule.eventShellClosed, ["shellId": shellId])
        }
      )
      let info = try callReturningString { shell.infoJSON($0) }

      self.registryLock.lock()
      let closedBeforeRegistration = closed
      if !closedBeforeRegistration {
        self.shells[shellId] = shell
      }
      self.registryLock.unlock()
      if closedBeforeRegistration {
        try? shell.close()
      }

      return [
        "shellId": shellId,
        "info": info,
      ]
    }
  }

  @objc(sendData:dataBase64:resolve:reject:)
  func sendData(
    shellId: String,
    dataBase64: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let data = Data(base64Encoded: dataBase64) else { throw EngineError.badPayload }
      try self?.requireShell(shellId).send(data)
      return nil
    }
  }

  @objc(resize:rows:cols:resolve:reject:)
  func resize(
    shellId: String,
    rows: NSNumber,
    cols: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try self?.requireShell(shellId).resize(rows.intValue, cols: cols.intValue)
      return nil
    }
  }

  @objc(closeShell:resolve:reject:)
  func closeShell(
    shellId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      self.registryLock.lock()
      let shell = self.shells.removeValue(forKey: shellId)
      self.registryLock.unlock()

      try shell?.close()
      return nil
    }
  }

  @objc(readBuffer:cursorMode:seq:tailBytes:timeMs:maxBytes:resolve:reject:)
  func readBuffer(
    shellId: String,
    cursorMode: NSNumber,
    seq: NSNumber,
    tailBytes: NSNumber,
    timeMs: NSNumber,
    maxBytes: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      guard
        let result = try self.requireShell(shellId).readBuffer(
          cursorMode.intValue,
          seq: seq.int64Value,
          tailBytes: tailBytes.int64Value,
          timeMs: timeMs.doubleValue,
          maxBytes: maxBytes.intValue
        )
      else {
        throw EngineError.readFailed
      }

      var payload: [String: Any] = [
        "dataBase64": (result.data() ?? Data()).base64EncodedString(),
        "nextSeq": NSNumber(value: result.nextSeq()),
        "hasDropped": result.hasDropped(),
      ]
      if result.hasDropped() {
        payload["droppedFromSeq"] = NSNumber(value: result.droppedFromSeq())
        payload["droppedToSeq"] = NSNumber(value: result.droppedToSeq())
      }
      return payload
    }
  }

  @objc(getShellStats:resolve:reject:)
  func getShellStats(
    shellId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let shell = try self.requireShell(shellId)
      return try callReturningString { shell.statsJSON($0) }
    }
  }

  @objc(getCurrentSeq:resolve:reject:)
  func getCurrentSeq(
    shellId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      return NSNumber(value: try self.requireShell(shellId).currentSeq())
    }
  }

  /// Replays from a cursor and then follows live output; resolves to a listener id.
  @objc(followOutput:subscriptionToken:cursorMode:seq:tailBytes:timeMs:coalesceMs:resolve:reject:)
  func followOutput(
    shellId: String,
    subscriptionToken: String,
    cursorMode: NSNumber,
    seq: NSNumber,
    tailBytes: NSNumber,
    timeMs: NSNumber,
    coalesceMs: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      let relay = OutputRelay(
        onChunk: { [weak self] seq, tMs, stream, data in
          self?.dispatch(GoSshEngineModule.eventChunk, [
            "shellId": shellId,
            "subscriptionToken": subscriptionToken,
            "seq": NSNumber(value: seq),
            "tMs": tMs,
            "stream": NSNumber(value: stream),
            "dataBase64": (data ?? Data()).base64EncodedString(),
          ])
        },
        onDropped: { [weak self] fromSeq, toSeq in
          self?.dispatch(GoSshEngineModule.eventDropped, [
            "shellId": shellId,
            "subscriptionToken": subscriptionToken,
            "fromSeq": NSNumber(value: fromSeq),
            "toSeq": NSNumber(value: toSeq),
          ])
        }
      )

      // Swift renames the engine's addListener to add(_:...), the same
      // first-argument-label rule that turns sendData into send.
      let listenerId = try self.requireShell(shellId).add(
        relay,
        cursorMode: cursorMode.intValue,
        seq: seq.int64Value,
        tailBytes: tailBytes.int64Value,
        timeMs: timeMs.doubleValue,
        coalesceMs: coalesceMs.intValue
      )
      return NSNumber(value: listenerId)
    }
  }

  @objc(unfollowOutput:listenerId:resolve:reject:)
  func unfollowOutput(
    shellId: String,
    listenerId: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      self.registryLock.lock()
      let shell = self.shells[shellId]
      self.registryLock.unlock()

      // removeListener blocks until the listener has quiesced, so it must not
      // run on the JS thread.
      shell?.removeListener(listenerId.int64Value)
      return nil
    }
  }

  // MARK: - SFTP

  @objc(startSftp:resolve:reject:)
  func startSftp(
    connectionId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      self.registryLock.lock()
      let connection = self.connections[connectionId]
      self.sftpSuffix += 1
      let sftpId = "\(connectionId)~sftp\(self.sftpSuffix)"
      self.registryLock.unlock()

      guard let connection else { throw EngineError.missingConnection(connectionId) }

      let sftp = try connection.startSFTP()

      self.registryLock.lock()
      self.sftpSessions[sftpId] = sftp
      self.registryLock.unlock()

      return sftpId
    }
  }

  @objc(sftpList:path:resolve:reject:)
  func sftpList(
    sftpId: String,
    path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let sftp = try self.requireSftp(sftpId)
      return try callReturningString { sftp.listJSON(path, error: $0) }
    }
  }

  @objc(sftpReadChunk:path:offset:length:resolve:reject:)
  func sftpReadChunk(
    sftpId: String,
    path: String,
    offset: NSNumber,
    length: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let result = try self.requireSftp(sftpId).readChunk(
        path,
        offset: offset.int64Value,
        length: length.intValue
      )
      return [
        "dataBase64": (result.data() ?? Data()).base64EncodedString(),
        "eof": result.eof(),
      ]
    }
  }

  @objc(sftpWriteChunk:path:offset:dataBase64:resolve:reject:)
  func sftpWriteChunk(
    sftpId: String,
    path: String,
    offset: NSNumber,
    dataBase64: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let data = Data(base64Encoded: dataBase64) else { throw EngineError.badPayload }
      try self?.requireSftp(sftpId).writeChunk(path, offset: offset.int64Value, data: data)
      return nil
    }
  }

  @objc(sftpMkdir:path:resolve:reject:)
  func sftpMkdir(
    sftpId: String,
    path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try self?.requireSftp(sftpId).mkdir(path)
      return nil
    }
  }

  @objc(sftpRename:sourcePath:targetPath:resolve:reject:)
  func sftpRename(
    sftpId: String,
    sourcePath: String,
    targetPath: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try self?.requireSftp(sftpId).rename(sourcePath, targetPath: targetPath)
      return nil
    }
  }

  @objc(sftpChmod:path:mode:resolve:reject:)
  func sftpChmod(
    sftpId: String,
    path: String,
    mode: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try self?.requireSftp(sftpId).chmod(path, mode: mode.intValue)
      return nil
    }
  }

  @objc(sftpRemove:path:resolve:reject:)
  func sftpRemove(
    sftpId: String,
    path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try self?.requireSftp(sftpId).remove(path)
      return nil
    }
  }

  @objc(sftpStat:path:resolve:reject:)
  func sftpStat(
    sftpId: String,
    path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let sftp = try self.requireSftp(sftpId)
      return try callReturningString { sftp.statJSON(path, error: $0) }
    }
  }

  @objc(closeSftp:resolve:reject:)
  func closeSftp(
    sftpId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      self.registryLock.lock()
      let sftp = self.sftpSessions.removeValue(forKey: sftpId)
      self.registryLock.unlock()

      try sftp?.close()
      return nil
    }
  }

  // MARK: - Vault KDF

  /// Derives the sync vault's key-encryption key.
  ///
  /// Native because a memory-hard KDF is impractically slow in Hermes, and the
  /// result has to match every other implementation byte for byte or an existing
  /// vault stops opening. The passphrase arrives already NFC-normalised, as
  /// base64 of its UTF-8 bytes, so the bridge cannot alter what the KDF sees.
  @objc(deriveArgon2idKey:saltBase64:memoryKib:timeCost:parallelism:outputLength:resolve:reject:)
  func deriveArgon2idKey(
    passphraseBase64: String,
    saltBase64: String,
    memoryKib: NSNumber,
    timeCost: NSNumber,
    parallelism: NSNumber,
    outputLength: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard
        let passphrase = Data(base64Encoded: passphraseBase64),
        let salt = Data(base64Encoded: saltBase64)
      else {
        throw EngineError.badPayload
      }

      let engine = try requireEngine(self?.engine)
      let derived = try engine.deriveArgon2idKey(
        passphrase,
        salt: salt,
        memoryKiB: memoryKib.intValue,
        timeCost: timeCost.intValue,
        parallelism: parallelism.intValue,
        outputLength: outputLength.intValue
      )
      return derived.base64EncodedString()
    }
  }

  // MARK: - Plumbing

  private func requireSftp(_ sftpId: String) throws -> MobileSFTPSession {
    registryLock.lock()
    let sftp = sftpSessions[sftpId]
    registryLock.unlock()
    guard let sftp else { throw EngineError.missingSftp(sftpId) }
    return sftp
  }

  private func requireShell(_ shellId: String) throws -> MobileShell {
    registryLock.lock()
    let shell = shells[shellId]
    registryLock.unlock()
    guard let shell else { throw EngineError.missingShell(shellId) }
    return shell
  }

  private func dispatch(_ name: String, _ body: [String: Any]) {
    guard bridge != nil else { return }
    sendEvent(withName: name, body: body)
  }

  private func onWorker(
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock,
    _ work: @escaping () throws -> Any?
  ) {
    worker.async {
      do {
        resolve(try work())
      } catch {
        reject(GoSshEngineModule.errorCode, error.localizedDescription, error)
      }
    }
  }
}

private enum EngineError: LocalizedError {
  case engineUnavailable
  case missingConnection(String)
  case missingShell(String)
  case missingSftp(String)
  case badPayload
  case readFailed

  var errorDescription: String? {
    switch self {
    case .engineUnavailable: return "SSH 엔진을 초기화하지 못했습니다."
    case .missingConnection(let id): return "연결을 찾을 수 없습니다: \(id)"
    case .missingShell(let id): return "셸을 찾을 수 없습니다: \(id)"
    case .missingSftp(let id): return "SFTP 세션을 찾을 수 없습니다: \(id)"
    case .badPayload: return "전송 데이터를 디코딩하지 못했습니다."
    case .readFailed: return "출력 버퍼를 읽지 못했습니다."
    }
  }
}

private func requireEngine(_ engine: MobileEngine?) throws -> MobileEngine {
  guard let engine else { throw EngineError.engineUnavailable }
  return engine
}

/// Calls a gomobile method that reports failure through an NSErrorPointer while
/// returning a non-optional string.
///
/// Swift imports the nullable-return form as `throws`, but not this one: with a
/// non-optional return there is no value left to mean "failed", so the error
/// parameter stays visible and has to be checked by hand.
private func callReturningString(_ body: (NSErrorPointer) -> String) throws -> String {
  var error: NSError?
  let result = body(&error)
  if let error { throw error }
  return result
}

/// Relays engine output for one subscription. The engine's callbacks are ObjC
/// protocols, so conformance has to come from a class rather than a closure.
private final class OutputRelay: NSObject, MobileListenerProtocol {
  private let chunkHandler: (Int64, Double, Int, Data?) -> Void
  private let droppedHandler: (Int64, Int64) -> Void

  init(
    onChunk: @escaping (Int64, Double, Int, Data?) -> Void,
    onDropped: @escaping (Int64, Int64) -> Void
  ) {
    self.chunkHandler = onChunk
    self.droppedHandler = onDropped
  }

  func onChunk(_ seq: Int64, tMs: Double, stream: Int, data: Data?) {
    chunkHandler(seq, tMs, stream, data)
  }

  func onDropped(_ fromSeq: Int64, toSeq: Int64) {
    droppedHandler(fromSeq, toSeq)
  }
}

private final class ShellClosedRelay: NSObject, MobileShellClosedCallbackProtocol {
  private let handler: (Int64) -> Void

  init(_ handler: @escaping (Int64) -> Void) { self.handler = handler }

  func onShellClosed(_ channelID: Int64) { handler(channelID) }
}

private final class DisconnectedRelay: NSObject, MobileDisconnectedCallbackProtocol {
  private let handler: (String) -> Void

  init(_ handler: @escaping (String) -> Void) { self.handler = handler }

  func onDisconnected(_ connectionID: String?) { handler(connectionID ?? "") }
}
