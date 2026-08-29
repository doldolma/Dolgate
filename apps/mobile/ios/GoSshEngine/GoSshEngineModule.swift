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
  private static let eventTailnet = "GoSshEngine:tailnet"
  private static let eventConnection = "GoSshEngine:connection"
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
  private var invalidated = false
  private var connections: [String: MobileConn] = [:]
  private var shells: [String: MobileShell] = [:]
  private var sftpSessions: [String: MobileSFTPSession] = [:]
  private var ssmForwards: [String: MobileSsmForward] = [:]
  private var shellSuffix: Int64 = 0
  private var sftpSuffix: Int64 = 0
  private lazy var tailnetEvents = TailnetEventRelay { [weak self] eventJson in
    self?.dispatch(GoSshEngineModule.eventTailnet, ["eventJson": eventJson])
  }

  override static func requiresMainQueueSetup() -> Bool { false }

  override init() {
    super.init()
    // Registered here rather than on the first connect: a connection raises its
    // host key and OTP questions while it is being opened, so the sink has to be
    // in place before any connect call, not installed by one.
    engine?.setConnectionEventListener(
      ConnectionEventRelay { [weak self] eventJson in
        self?.dispatch(GoSshEngineModule.eventConnection, ["eventJson": eventJson])
      }
    )
  }

  override func supportedEvents() -> [String] {
    [
      GoSshEngineModule.eventChunk,
      GoSshEngineModule.eventDropped,
      GoSshEngineModule.eventShellClosed,
      GoSshEngineModule.eventDisconnected,
      GoSshEngineModule.eventTailnet,
      GoSshEngineModule.eventConnection,
    ]
  }

  override func invalidate() {
    super.invalidate()

    registryLock.lock()
    if invalidated {
      registryLock.unlock()
      return
    }
    invalidated = true
    let openShells = Array(shells.values)
    let openSftp = Array(sftpSessions.values)
    let openConnections = Array(connections.values)
    let openSsmForwards = Array(ssmForwards.values)
    shells.removeAll()
    sftpSessions.removeAll()
    connections.removeAll()
    ssmForwards.removeAll()
    registryLock.unlock()

    for sftp in openSftp { try? sftp.close() }
    for shell in openShells { try? shell.close() }
    for connection in openConnections { try? connection.close() }
    engine?.closeAllRDTunnels()
    for forward in openSsmForwards { try? forward.stop() }
    try? engine?.closeTailnets()
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

  // MARK: - Tailnet runtime

  @objc(configureTailnets:configsJson:resolve:reject:)
  func configureTailnets(
    stateScope: String,
    configsJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let engine = try requireEngine(self.engine)
      try engine.configureTailnets(
        try self.tailnetStateRoot(),
        stateScope: stateScope,
        configsJSON: configsJson,
        listener: self.tailnetEvents
      )
      return nil
    }
  }

  @objc(startTailnet:payloadJson:resolve:reject:)
  func startTailnet(
    requestId: String,
    payloadJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.startTailnet(requestId, payloadJSON: payloadJson)
      return nil
    }
  }

  @objc(cancelTailnet:tailnetId:resolve:reject:)
  func cancelTailnet(
    requestId: String,
    tailnetId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.cancelTailnet(requestId, id_: tailnetId)
      return nil
    }
  }

  @objc(disconnectTailnet:tailnetId:resolve:reject:)
  func disconnectTailnet(
    requestId: String,
    tailnetId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.disconnectTailnet(requestId, id_: tailnetId)
      return nil
    }
  }

  @objc(snapshotTailnets:resolve:reject:)
  func snapshotTailnets(
    requestId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.snapshotTailnets(requestId)
      return nil
    }
  }

  @objc(forgetTailnet:resolve:reject:)
  func forgetTailnet(
    tailnetId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.forgetTailnet(tailnetId)
      return nil
    }
  }

  @objc(closeTailnets:reject:)
  func closeTailnets(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try self?.engine?.closeTailnets()
      return nil
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
      let closedBeforeRegistration = disconnected || self.invalidated
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

  /// Answers a keyboard-interactive challenge the connection raised.
  ///
  /// This does not go through the connection registry: the connect call has not
  /// returned yet — it is blocked waiting for exactly this — so there is nothing
  /// registered to look up. The engine finds the challenge by its id.
  @objc(respondKeyboardInteractive:resolve:reject:)
  func respondKeyboardInteractive(
    payloadJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.respondKeyboardInteractive(payloadJson)
      return nil
    }
  }

  @objc(respondHostKeyTrust:trust:resolve:reject:)
  func respondHostKeyTrust(
    challengeId: String,
    trust: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.respondHostKeyTrust(challengeId, trust: trust.boolValue)
      return nil
    }
  }

  /// Cuts a connection that is still being opened.
  ///
  /// disconnect cannot do this: it closes a registered connection, and one that
  /// is still dialing was never registered. Without this, dismissing an OTP sheet
  /// leaves the dial standing until its budget runs out — holding the tailnet
  /// node's lease while it waits.
  @objc(cancelConnect:resolve:reject:)
  func cancelConnect(
    connectionId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try requireEngine(self?.engine).cancelConnect(connectionId)
      return nil
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
      let closedBeforeRegistration = closed || self.invalidated
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

  /// SSH over SSM 에 쓸 임시 키쌍. EIC 는 세션마다 새 키를 요구한다.
  @objc(generateEphemeralSshKey:reject:)
  func generateEphemeralSshKey(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      return try callReturningString { engine.generateEphemeralSshKey($0) }
    }
  }

  /// AWS SSM 셸을 연다.
  ///
  /// **돌아오는 것은 SSH 셸과 같은 `MobileShell` 이다.** 그래서 아래의 sendData·resize·
  /// followOutput·closeShell 이 그대로 쓰인다 — SSM 을 별도 레지스트리로 두면 두 경로 중 한쪽에만
  /// 있는 버그가 생긴다.
  ///
  /// 자격증명은 여기 오지 않는다. 앱이 `ssm:StartSession` 으로 받은 streamUrl·tokenValue 만 담긴
  /// requestJson 이 들어온다.
  @objc(startAwsSsmShell:requestJson:resolve:reject:)
  func startAwsSsmShell(
    sessionId: String,
    requestJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }

      self.registryLock.lock()
      self.shellSuffix += 1
      let shellId = "ssm:\(sessionId)#\(self.shellSuffix)"
      self.registryLock.unlock()

      var closed = false
      let engine = try requireEngine(self.engine)
      let shell = try engine.startAwsSsmShell(
        requestJson,
        onClosed: AwsSsmClosedRelay { [weak self] reason in
          guard let self else { return }
          self.registryLock.lock()
          closed = true
          self.shells.removeValue(forKey: shellId)
          self.registryLock.unlock()
          var payload: [String: Any] = ["shellId": shellId]
          if !reason.isEmpty { payload["reason"] = reason }
          self.dispatch(GoSshEngineModule.eventShellClosed, payload)
        }
      )
      let info = try callReturningString { shell.infoJSON($0) }

      self.registryLock.lock()
      let closedBeforeRegistration = closed || self.invalidated
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

  /// SSH over SSM 을 태울 로컬 포워드를 연다. 실제로 묶인 포트를 돌려준다.
  ///
  /// 앱은 그 주소(127.0.0.1:포트)로 평범하게 SSH 를 붙인다 — 데스크톱과 같은 방식이라 점프·SFTP
  /// 가 그대로 동작한다. 세션이 끝나면 반드시 stopSsmPortForward 를 불러야 한다.
  @objc(startSsmPortForward:requestJson:resolve:reject:)
  func startSsmPortForward(
    forwardId: String,
    requestJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let engine = try requireEngine(self.engine)
      let forward = try engine.startSsmPortForward(requestJson)
      self.registryLock.lock()
      let rejected = self.invalidated
      let previous = rejected ? nil : self.ssmForwards.updateValue(forward, forKey: forwardId)
      self.registryLock.unlock()
      if rejected {
        try? forward.stop()
        throw EngineError.moduleInvalidated
      }
      try? previous?.stop()
      return [
        "forwardId": forwardId,
        "bindPort": Int(forward.bindPort()),
      ]
    }
  }

  @objc(stopSsmPortForward:resolve:reject:)
  func stopSsmPortForward(
    forwardId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      self.registryLock.lock()
      let forward = self.ssmForwards.removeValue(forKey: forwardId)
      self.registryLock.unlock()
      try forward?.stop()
      return nil
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

  @objc(prepareAutocomplete:resolve:reject:)
  func prepareAutocomplete(
    shellId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let shell = try self.requireShell(shellId)
      return try callReturningString { shell.prepareAutocompleteJSON($0) }
    }
  }

  @objc(runCompletion:command:resolve:reject:)
  func runCompletion(
    shellId: String,
    command: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let shell = try self.requireShell(shellId)
      return try callReturningString { shell.runCompletionJSON(command, error: $0) }
    }
  }

  @objc(reinjectShellIntegration:shellHint:resolve:reject:)
  func reinjectShellIntegration(
    shellId: String,
    shellHint: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      try self?.requireShell(shellId).reinjectShellIntegration(shellHint)
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
      let rejected = self.invalidated
      if !rejected {
        self.sftpSessions[sftpId] = sftp
      }
      self.registryLock.unlock()
      if rejected {
        try? sftp.close()
        throw EngineError.moduleInvalidated
      }

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

  @objc(sftpReadTextFile:path:resolve:reject:)
  func sftpReadTextFile(
    sftpId: String,
    path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let sftp = try self.requireSftp(sftpId)
      return try callReturningString { sftp.readTextFileJSON(path, error: $0) }
    }
  }

  @objc(sftpWriteTextFile:requestJson:resolve:reject:)
  func sftpWriteTextFile(
    sftpId: String,
    requestJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      guard let self else { return nil }
      let sftp = try self.requireSftp(sftpId)
      try sftp.writeTextFile(requestJson)
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

  private func tailnetStateRoot() throws -> String {
    var root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first ?? FileManager.default.temporaryDirectory
    root.appendPathComponent("Tailnets", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true
    )
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    try root.setResourceValues(resourceValues)
    return root.path
  }

  private func onWorker(
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock,
    _ work: @escaping () throws -> Any?
  ) {
    registryLock.lock()
    let rejectedImmediately = invalidated
    registryLock.unlock()
    if rejectedImmediately {
      reject(
        GoSshEngineModule.errorCode,
        EngineError.moduleInvalidated.localizedDescription,
        EngineError.moduleInvalidated
      )
      return
    }

    worker.async { [weak self] in
      guard let self else {
        reject(
          GoSshEngineModule.errorCode,
          EngineError.moduleInvalidated.localizedDescription,
          EngineError.moduleInvalidated
        )
        return
      }
      self.registryLock.lock()
      let rejectedAfterQueueing = self.invalidated
      self.registryLock.unlock()
      if rejectedAfterQueueing {
        reject(
          GoSshEngineModule.errorCode,
          EngineError.moduleInvalidated.localizedDescription,
          EngineError.moduleInvalidated
        )
        return
      }
      do {
        resolve(try work())
      } catch {
        reject(GoSshEngineModule.errorCode, error.localizedDescription, error)
      }
    }
  }

  // MARK: - Remote Desktop Tunnel

  @objc(openRemoteDesktopTunnel:resolve:reject:)
  func openRemoteDesktopTunnel(
    requestJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      return try callReturningString { error in
        engine.openRemoteDesktopTunnel(requestJson, error: error)
      }
    }
  }

  @objc(closeRemoteDesktopTunnel:resolve:reject:)
  func closeRemoteDesktopTunnel(
    tunnelId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    onWorker(resolve, reject) { [weak self] in
      let engine = try requireEngine(self?.engine)
      try engine.closeRemoteDesktopTunnel(tunnelId)
      return nil
    }
  }
}

private enum EngineError: LocalizedError {
  case moduleInvalidated
  case engineUnavailable
  case missingConnection(String)
  case missingShell(String)
  case missingSftp(String)
  case badPayload
  case readFailed

  var errorDescription: String? {
    switch self {
    case .moduleInvalidated: return "SSH engine module has been invalidated."
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

private final class AwsSsmClosedRelay: NSObject, MobileAwsSsmClosedCallbackProtocol {
  private let handler: (String) -> Void

  init(_ handler: @escaping (String) -> Void) { self.handler = handler }

  func onAwsSsmClosed(_ reason: String?) { handler(reason ?? "") }
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

private final class TailnetEventRelay: NSObject, MobileTailnetEventListenerProtocol {
  private let handler: (String) -> Void

  init(_ handler: @escaping (String) -> Void) { self.handler = handler }

  func onTailnetEvent(_ eventJSON: String?) { handler(eventJSON ?? "") }
}

private final class ConnectionEventRelay: NSObject, MobileConnectionEventListenerProtocol {
  private let handler: (String) -> Void

  init(_ handler: @escaping (String) -> Void) { self.handler = handler }

  func onConnectionEvent(_ eventJSON: String?) { handler(eventJSON ?? "") }
}
