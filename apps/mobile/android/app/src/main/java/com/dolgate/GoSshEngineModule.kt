package com.dolgate

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import mobile.AwsSsmClosedCallback
import mobile.Conn
import mobile.ConnectionEventListener
import mobile.DisconnectedCallback
import mobile.Engine
import mobile.Listener
import mobile.Mobile
import mobile.SFTPSession
import mobile.Shell
import mobile.ShellClosedCallback
import mobile.SsmForward
import mobile.TailnetEventListener

/**
 * Bridges the Go SSH engine (services/ssh-core/mobile, bound with gomobile) to JS.
 *
 * JS cannot hold a Go object, so connections and shells live here in registries
 * and are addressed by string handles. Terminal bytes cross as base64, matching
 * how the AWS SSM path already moves terminal data; the engine's ring buffer
 * keeps that affordable by handing over one merged buffer per coalescing window
 * rather than one per read from the socket.
 *
 * Every engine call can block on the network, so all of them run on a worker
 * pool and settle their promise from there.
 */
class GoSshEngineModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  private val executor: ExecutorService = Executors.newCachedThreadPool()

  /**
   * The engine, with Android's network facts wired in before anything can use it.
   *
   * The wiring has to happen here rather than at the first Tailnet call: Go cannot enumerate
   * interfaces on Android (SELinux blocks the netlink socket net.Interfaces() needs), and tsnet
   * reads that list while starting. Register late and the first start still fails with
   * "route ip+net: netlinkrib: permission denied".
   */
  private val engine: Engine by lazy {
    Mobile.newEngine().apply {
      setAndroidNetworkProvider(AndroidNetworkFacts(reactContext))
      // Set here, not on the first connect: a connection raises its host key and
      // OTP questions while it is being opened, so the sink has to already exist
      // when connect is called rather than being installed by it.
      setConnectionEventListener(
        ConnectionEventListener { eventJson ->
          this@GoSshEngineModule.emit(
            EVENT_CONNECTION,
            Arguments.createMap().apply { putString("eventJson", eventJson) },
          )
        },
      )
    }
  }

  private val connections = ConcurrentHashMap<String, Conn>()
  private val shells = ConcurrentHashMap<String, Shell>()
  private val shellListeners = ConcurrentHashMap<String, MutableSet<Long>>()
  private val sftpSessions = ConcurrentHashMap<String, SFTPSession>()
  private val ssmForwards = ConcurrentHashMap<String, SsmForward>()
  private val registryLock = Any()
  private val nextShellSuffix = AtomicLong(0)
  private val nextSftpSuffix = AtomicLong(0)
  private val tailnetEvents =
    TailnetEventListener { eventJson ->
      emit(
        EVENT_TAILNET,
        Arguments.createMap().apply { putString("eventJson", eventJson) },
      )
    }

  override fun getName(): String = NAME

  // NativeEventEmitter calls these; the engine's own output subscriptions are
  // followOutput/unfollowOutput so the two do not collide.
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Double) = Unit

  @ReactMethod
  fun getEngineVersion(promise: Promise) {
    onWorker(promise) { Mobile.version() }
  }

  @ReactMethod
  fun probeHostKey(requestJson: String, promise: Promise) {
    onWorker(promise) { engine.probeHostKey(requestJson) }
  }

  @ReactMethod
  fun inspectPrivateKey(privateKeyPem: String, passphrase: String, promise: Promise) {
    onWorker(promise) { engine.inspectPrivateKey(privateKeyPem, passphrase) }
  }

  @ReactMethod
  fun inspectCertificate(certificateText: String, promise: Promise) {
    onWorker(promise) { engine.inspectCertificate(certificateText) }
  }

  // MARK: - Tailnet runtime

  @ReactMethod
  fun configureTailnets(stateScope: String, configsJson: String, promise: Promise) {
    onWorker(promise) {
      engine.configureTailnets(
        reactContext.filesDir.resolve("tailnets").absolutePath,
        stateScope,
        configsJson,
        tailnetEvents,
      )
      null
    }
  }

  @ReactMethod
  fun startTailnet(requestId: String, payloadJson: String, promise: Promise) {
    onWorker(promise) {
      engine.startTailnet(requestId, payloadJson)
      null
    }
  }

  @ReactMethod
  fun cancelTailnet(requestId: String, tailnetId: String, promise: Promise) {
    onWorker(promise) {
      engine.cancelTailnet(requestId, tailnetId)
      null
    }
  }

  @ReactMethod
  fun disconnectTailnet(requestId: String, tailnetId: String, promise: Promise) {
    onWorker(promise) {
      engine.disconnectTailnet(requestId, tailnetId)
      null
    }
  }

  @ReactMethod
  fun snapshotTailnets(requestId: String, promise: Promise) {
    onWorker(promise) {
      engine.snapshotTailnets(requestId)
      null
    }
  }

  @ReactMethod
  fun forgetTailnet(tailnetId: String, promise: Promise) {
    onWorker(promise) {
      engine.forgetTailnet(tailnetId)
      null
    }
  }

  @ReactMethod
  fun closeTailnets(promise: Promise) {
    onWorker(promise) {
      engine.closeTailnets()
      null
    }
  }

  @ReactMethod
  fun connect(connectionId: String, requestJson: String, promise: Promise) {
    onWorker(promise) {
      var disconnected = false
      var registrationComplete = false
      var callbackConnection: Conn? = null
      val conn =
        engine.connect(
          requestJson,
          DisconnectedCallback {
            var shouldEmit = false
            synchronized(registryLock) {
              val ownConnection = callbackConnection
              if (!registrationComplete) {
                disconnected = true
                shouldEmit = true
              } else if (
                ownConnection != null &&
                  connections.remove(connectionId, ownConnection)
              ) {
                forgetShellsOf(connectionId)
                shouldEmit = true
              }
            }
            if (shouldEmit) {
              emit(
                EVENT_DISCONNECTED,
                Arguments.createMap().apply { putString("connectionId", connectionId) },
              )
            }
          },
        )
      val info = conn.infoJSON()
      var previous: Conn? = null
      val closedBeforeRegistration =
        synchronized(registryLock) {
          callbackConnection = conn
          registrationComplete = true
          if (disconnected) {
            true
          } else {
            // A reconnect under the same handle must not orphan the previous one.
            previous = connections.put(connectionId, conn)
            false
          }
        }
      if (closedBeforeRegistration) {
        closeQuietly { conn.close() }
      } else {
        previous?.let { old -> closeQuietly { old.close() } }
      }
      info
    }
  }

  /**
   * Answers a keyboard-interactive challenge the connection raised.
   *
   * This does not look in the connection registry: the connect call has not
   * returned yet — it is blocked waiting for exactly this — so there is nothing
   * registered to find. The engine locates the challenge by its id.
   */
  @ReactMethod
  fun respondKeyboardInteractive(payloadJson: String, promise: Promise) {
    onWorker(promise) {
      engine.respondKeyboardInteractive(payloadJson)
      null
    }
  }

  @ReactMethod
  fun respondHostKeyTrust(challengeId: String, trust: Boolean, promise: Promise) {
    onWorker(promise) {
      engine.respondHostKeyTrust(challengeId, trust)
      null
    }
  }

  /**
   * Cuts a connection that is still being opened.
   *
   * disconnect cannot: it closes a registered connection, and one that is still
   * dialing was never registered. Without this, dismissing an OTP sheet leaves the
   * dial standing until its budget runs out — holding the tailnet node's lease
   * while it waits.
   */
  @ReactMethod
  fun cancelConnect(connectionId: String, promise: Promise) {
    onWorker(promise) {
      engine.cancelConnect(connectionId)
      null
    }
  }

  @ReactMethod
  fun disconnect(connectionId: String, promise: Promise) {
    onWorker(promise) {
      val conn = connections.remove(connectionId)
      if (conn != null) {
        forgetShellsOf(connectionId)
        conn.close()
      }
      null
    }
  }

  @ReactMethod
  fun startShell(connectionId: String, optionsJson: String, promise: Promise) {
    onWorker(promise) {
      val conn = requireConnection(connectionId)
      val shellId = "$connectionId#${nextShellSuffix.incrementAndGet()}"
      var closed = false
      val shell =
        conn.startShell(
          optionsJson,
          ShellClosedCallback {
            synchronized(registryLock) {
              closed = true
              shells.remove(shellId)
              shellListeners.remove(shellId)
            }
            emit(
              EVENT_SHELL_CLOSED,
              Arguments.createMap().apply { putString("shellId", shellId) },
            )
          },
        )
      val info = shell.infoJSON()
      val closedBeforeRegistration =
        synchronized(registryLock) {
          if (closed) {
            true
          } else {
            shells[shellId] = shell
            shellListeners[shellId] = java.util.Collections.synchronizedSet(mutableSetOf())
            false
          }
        }
      if (closedBeforeRegistration) {
        closeQuietly { shell.close() }
      }

      Arguments.createMap().apply {
        putString("shellId", shellId)
        putString("info", info)
      }
    }
  }

  /**
   * AWS SSM 셸을 연다.
   *
   * **돌아오는 것은 SSH 셸과 같은 `Shell` 이다.** 그래서 이 아래의 sendData·resize·followOutput·
   * closeShell 이 그대로 쓰인다 — SSM 을 별도 레지스트리로 두면 두 경로 중 한쪽에만 있는 버그가
   * 생긴다.
   *
   * 자격증명은 여기 오지 않는다. 앱이 `ssm:StartSession` 으로 받은 streamUrl·tokenValue 만 담긴
   * requestJson 이 들어온다.
   */
  /** SSH over SSM 에 쓸 임시 키쌍. EIC 는 세션마다 새 키를 요구한다. */
  @ReactMethod
  fun generateEphemeralSshKey(promise: Promise) {
    onWorker(promise) { engine.generateEphemeralSshKey() }
  }

  @ReactMethod
  fun startAwsSsmShell(sessionId: String, requestJson: String, promise: Promise) {
    onWorker(promise) {
      val shellId = "ssm:$sessionId#${nextShellSuffix.incrementAndGet()}"
      var closed = false
      val shell =
        engine.startAwsSsmShell(
          requestJson,
          AwsSsmClosedCallback { reason ->
            synchronized(registryLock) {
              closed = true
              shells.remove(shellId)
              shellListeners.remove(shellId)
            }
            emit(
              EVENT_SHELL_CLOSED,
              Arguments.createMap().apply {
                putString("shellId", shellId)
                if (!reason.isNullOrEmpty()) putString("reason", reason)
              },
            )
          },
        )
      val info = shell.infoJSON()
      val closedBeforeRegistration =
        synchronized(registryLock) {
          if (closed) {
            true
          } else {
            shells[shellId] = shell
            shellListeners[shellId] = java.util.Collections.synchronizedSet(mutableSetOf())
            false
          }
        }
      if (closedBeforeRegistration) {
        closeQuietly { shell.close() }
      }

      Arguments.createMap().apply {
        putString("shellId", shellId)
        putString("info", info)
      }
    }
  }

  /**
   * SSH over SSM 을 태울 로컬 포워드를 연다.
   *
   * 실제로 묶인 포트를 돌려주므로 앱은 그 주소(127.0.0.1:포트)로 평범하게 SSH 를 붙인다 —
   * 데스크톱과 같은 방식이고, 그래서 점프·SFTP 가 그대로 동작한다. 세션이 끝나면 반드시
   * stopSsmPortForward 를 불러야 한다.
   */
  @ReactMethod
  fun startSsmPortForward(forwardId: String, requestJson: String, promise: Promise) {
    onWorker(promise) {
      val forward = engine.startSsmPortForward(requestJson)
      synchronized(registryLock) { ssmForwards[forwardId] = forward }
      Arguments.createMap().apply {
        putString("forwardId", forwardId)
        putInt("bindPort", forward.bindPort())
      }
    }
  }

  @ReactMethod
  fun stopSsmPortForward(forwardId: String, promise: Promise) {
    onWorker(promise) {
      val forward = synchronized(registryLock) { ssmForwards.remove(forwardId) }
      forward?.stop()
      null
    }
  }

  @ReactMethod
  fun sendData(shellId: String, dataBase64: String, promise: Promise) {
    onWorker(promise) {
      requireShell(shellId).sendData(Base64.decode(dataBase64, Base64.NO_WRAP))
      null
    }
  }

  @ReactMethod
  fun resize(shellId: String, rows: Double, cols: Double, promise: Promise) {
    onWorker(promise) {
      requireShell(shellId).resize(rows.toLong(), cols.toLong())
      null
    }
  }

  @ReactMethod
  fun closeShell(shellId: String, promise: Promise) {
    onWorker(promise) {
      val shell = shells.remove(shellId)
      shellListeners.remove(shellId)
      shell?.close()
      null
    }
  }

  @ReactMethod
  fun readBuffer(
    shellId: String,
    cursorMode: Double,
    seq: Double,
    tailBytes: Double,
    timeMs: Double,
    maxBytes: Double,
    promise: Promise,
  ) {
    onWorker(promise) {
      val result =
        requireShell(shellId)
          .readBuffer(cursorMode.toLong(), seq.toLong(), tailBytes.toLong(), timeMs, maxBytes.toLong())

      Arguments.createMap().apply {
        putString("dataBase64", Base64.encodeToString(result.data(), Base64.NO_WRAP))
        putDouble("nextSeq", result.nextSeq().toDouble())
        putBoolean("hasDropped", result.hasDropped())
        if (result.hasDropped()) {
          putDouble("droppedFromSeq", result.droppedFromSeq().toDouble())
          putDouble("droppedToSeq", result.droppedToSeq().toDouble())
        }
      }
    }
  }

  @ReactMethod
  fun getShellStats(shellId: String, promise: Promise) {
    onWorker(promise) { requireShell(shellId).statsJSON() }
  }

  @ReactMethod
  fun getCurrentSeq(shellId: String, promise: Promise) {
    onWorker(promise) { requireShell(shellId).currentSeq().toDouble() }
  }

  /** Replays from a cursor and then follows live output; resolves to a listener id. */
  @ReactMethod
  fun followOutput(
    shellId: String,
    subscriptionToken: String,
    cursorMode: Double,
    seq: Double,
    tailBytes: Double,
    timeMs: Double,
    coalesceMs: Double,
    promise: Promise,
  ) {
    onWorker(promise) {
      val shell = requireShell(shellId)
      val listenerId =
        shell.addListener(
          OutputListener(shellId, subscriptionToken),
          cursorMode.toLong(),
          seq.toLong(),
          tailBytes.toLong(),
          timeMs,
          coalesceMs.toLong(),
        )
      shellListeners[shellId]?.add(listenerId)
      listenerId.toDouble()
    }
  }

  @ReactMethod
  fun unfollowOutput(shellId: String, listenerId: Double, promise: Promise) {
    onWorker(promise) {
      // removeListener blocks until the listener has quiesced, so it must not run
      // on the JS thread.
      shells[shellId]?.removeListener(listenerId.toLong())
      shellListeners[shellId]?.remove(listenerId.toLong())
      null
    }
  }

  // MARK: - SFTP

  @ReactMethod
  fun startSftp(connectionId: String, promise: Promise) {
    onWorker(promise) {
      val conn = requireConnection(connectionId)
      val sftpId = "$connectionId~sftp${nextSftpSuffix.incrementAndGet()}"
      sftpSessions[sftpId] = conn.startSFTP()
      sftpId
    }
  }

  @ReactMethod
  fun sftpList(sftpId: String, path: String, promise: Promise) {
    onWorker(promise) { requireSftp(sftpId).listJSON(path) }
  }

  @ReactMethod
  fun sftpReadChunk(
    sftpId: String,
    path: String,
    offset: Double,
    length: Double,
    promise: Promise,
  ) {
    onWorker(promise) {
      val result = requireSftp(sftpId).readChunk(path, offset.toLong(), length.toLong())
      Arguments.createMap().apply {
        putString("dataBase64", Base64.encodeToString(result.data(), Base64.NO_WRAP))
        putBoolean("eof", result.eof())
      }
    }
  }

  @ReactMethod
  fun sftpWriteChunk(
    sftpId: String,
    path: String,
    offset: Double,
    dataBase64: String,
    promise: Promise,
  ) {
    onWorker(promise) {
      requireSftp(sftpId)
        .writeChunk(path, offset.toLong(), Base64.decode(dataBase64, Base64.NO_WRAP))
      null
    }
  }

  @ReactMethod
  fun sftpMkdir(sftpId: String, path: String, promise: Promise) {
    onWorker(promise) {
      requireSftp(sftpId).mkdir(path)
      null
    }
  }

  @ReactMethod
  fun sftpRename(sftpId: String, sourcePath: String, targetPath: String, promise: Promise) {
    onWorker(promise) {
      requireSftp(sftpId).rename(sourcePath, targetPath)
      null
    }
  }

  @ReactMethod
  fun sftpChmod(sftpId: String, path: String, mode: Double, promise: Promise) {
    onWorker(promise) {
      requireSftp(sftpId).chmod(path, mode.toLong())
      null
    }
  }

  @ReactMethod
  fun sftpRemove(sftpId: String, path: String, promise: Promise) {
    onWorker(promise) {
      requireSftp(sftpId).remove(path)
      null
    }
  }

  @ReactMethod
  fun sftpStat(sftpId: String, path: String, promise: Promise) {
    onWorker(promise) { requireSftp(sftpId).statJSON(path) }
  }

  @ReactMethod
  fun sftpReadTextFile(sftpId: String, path: String, promise: Promise) {
    onWorker(promise) { requireSftp(sftpId).readTextFileJSON(path) }
  }

  @ReactMethod
  fun sftpWriteTextFile(sftpId: String, requestJson: String, promise: Promise) {
    onWorker(promise) {
      requireSftp(sftpId).writeTextFile(requestJson)
      null
    }
  }

  @ReactMethod
  fun closeSftp(sftpId: String, promise: Promise) {
    onWorker(promise) {
      sftpSessions.remove(sftpId)?.close()
      null
    }
  }

  // MARK: - Vault KDF

  /**
   * Derives the sync vault's key-encryption key. Runs natively because a
   * memory-hard KDF is impractically slow in Hermes, and the result has to match
   * every other implementation byte for byte or an existing vault stops opening.
   *
   * The passphrase arrives already NFC-normalised, as base64 of its UTF-8 bytes,
   * so the bridge cannot alter the exact bytes the KDF sees.
   */
  @ReactMethod
  fun deriveArgon2idKey(
    passphraseBase64: String,
    saltBase64: String,
    memoryKib: Double,
    timeCost: Double,
    parallelism: Double,
    outputLength: Double,
    promise: Promise,
  ) {
    onWorker(promise) {
      val derived =
        engine.deriveArgon2idKey(
          Base64.decode(passphraseBase64, Base64.NO_WRAP),
          Base64.decode(saltBase64, Base64.NO_WRAP),
          memoryKib.toLong(),
          timeCost.toLong(),
          parallelism.toLong(),
          outputLength.toLong(),
        )
      Base64.encodeToString(derived, Base64.NO_WRAP)
    }
  }

  override fun invalidate() {
    super.invalidate()
    sftpSessions.keys.toList().forEach { sftpId ->
      sftpSessions.remove(sftpId)?.let { sftp -> closeQuietly { sftp.close() } }
    }
    shells.keys.toList().forEach { shellId ->
      shells.remove(shellId)?.let { shell -> closeQuietly { shell.close() } }
    }
    shellListeners.clear()
    connections.keys.toList().forEach { connectionId ->
      connections.remove(connectionId)?.let { conn -> closeQuietly { conn.close() } }
    }
    closeQuietly { engine.closeTailnets() }
    executor.shutdownNow()
  }

  /**
   * Relays engine output for one subscription to JS.
   *
   * The token identifies which subscription an event belongs to. A shell can
   * have several (the terminal and the background snapshot), and the engine
   * calls each one separately — without the token JS cannot tell the resulting
   * events apart and would hand every chunk to every subscriber, so each one
   * would see the same bytes once per subscription.
   *
   * It is supplied by JS rather than derived from the listener id so it is known
   * before the first callback can arrive.
   */
  private inner class OutputListener(
    private val shellId: String,
    private val subscriptionToken: String,
  ) : Listener {
    override fun onChunk(seq: Long, tMs: Double, stream: Long, data: ByteArray) {
      emit(
        EVENT_CHUNK,
        Arguments.createMap().apply {
          putString("shellId", shellId)
          putString("subscriptionToken", subscriptionToken)
          putDouble("seq", seq.toDouble())
          putDouble("tMs", tMs)
          putDouble("stream", stream.toDouble())
          putString("dataBase64", Base64.encodeToString(data, Base64.NO_WRAP))
        },
      )
    }

    override fun onDropped(fromSeq: Long, toSeq: Long) {
      emit(
        EVENT_DROPPED,
        Arguments.createMap().apply {
          putString("shellId", shellId)
          putString("subscriptionToken", subscriptionToken)
          putDouble("fromSeq", fromSeq.toDouble())
          putDouble("toSeq", toSeq.toDouble())
        },
      )
    }
  }

  private fun requireConnection(connectionId: String): Conn =
    connections[connectionId]
      ?: throw IllegalStateException("연결을 찾을 수 없습니다: $connectionId")

  private fun requireShell(shellId: String): Shell =
    shells[shellId] ?: throw IllegalStateException("셸을 찾을 수 없습니다: $shellId")

  private fun requireSftp(sftpId: String): SFTPSession =
    sftpSessions[sftpId] ?: throw IllegalStateException("SFTP 세션을 찾을 수 없습니다: $sftpId")

  private fun forgetShellsOf(connectionId: String) {
    val prefix = "$connectionId#"
    shells.keys.filter { it.startsWith(prefix) }.forEach { shellId ->
      shells.remove(shellId)
      shellListeners.remove(shellId)
    }
    val sftpPrefix = "$connectionId~sftp"
    sftpSessions.keys.filter { it.startsWith(sftpPrefix) }.forEach { sftpId ->
      sftpSessions.remove(sftpId)
    }
  }

  private fun emit(eventName: String, payload: WritableMap) {
    if (!reactContext.hasActiveReactInstance()) {
      return
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(eventName, payload)
  }

  /**
   * Runs work off the JS thread and settles the promise with its result. Engine
   * failures arrive as exceptions and are reported as a single error code so the
   * JS side can surface the message without matching on strings.
   */
  private fun onWorker(promise: Promise, work: () -> Any?) {
    executor.execute {
      try {
        promise.resolve(work())
      } catch (error: Throwable) {
        promise.reject(ERROR_CODE, error.message ?: "SSH 엔진 호출이 실패했습니다.", error)
      }
    }
  }

  private inline fun closeQuietly(block: () -> Unit) {
    try {
      block()
    } catch (_: Throwable) {
      // Already tearing down; nothing useful to report.
    }
  }

  companion object {
    const val NAME = "GoSshEngineModule"
    private const val ERROR_CODE = "go_ssh_engine_error"
    private const val EVENT_CHUNK = "GoSshEngine:chunk"
    private const val EVENT_DROPPED = "GoSshEngine:dropped"
    private const val EVENT_SHELL_CLOSED = "GoSshEngine:shellClosed"
    private const val EVENT_DISCONNECTED = "GoSshEngine:disconnected"
    private const val EVENT_TAILNET = "GoSshEngine:tailnet"
    private const val EVENT_CONNECTION = "GoSshEngine:connection"
  }
}
