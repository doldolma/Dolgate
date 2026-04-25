import UIKit
import SafariServices
import Network
import UniformTypeIdentifiers
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "Dolgate",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey : Any] = [:]
  ) -> Bool {
    RCTLinkingManager.application(app, open: url, options: options)
  }

  func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    RCTLinkingManager.application(
      application,
      continue: userActivity,
      restorationHandler: restorationHandler
    )
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

fileprivate enum TerminalInputSpecialKey: String {
  case escape
  case tab
  case enter
  case backspace
  case delete
  case arrowUp
  case arrowDown
  case arrowLeft
  case arrowRight
  case home
  case end
  case pageUp
  case pageDown
  case c
  case d
  case l
  case z
}

private final class TerminalInputTextView: UITextView {
  weak var terminalInputView: TerminalInputContainerView?

  override var keyCommands: [UIKeyCommand]? {
    [
      UIKeyCommand(
        input: UIKeyCommand.inputEscape,
        modifierFlags: [],
        action: #selector(handleEscape(_:))
      ),
      UIKeyCommand(
        input: "\t",
        modifierFlags: [],
        action: #selector(handleTab(_:))
      ),
      UIKeyCommand(
        input: "c",
        modifierFlags: .control,
        action: #selector(handleCtrlC(_:))
      ),
      UIKeyCommand(
        input: "d",
        modifierFlags: .control,
        action: #selector(handleCtrlD(_:))
      ),
      UIKeyCommand(
        input: "l",
        modifierFlags: .control,
        action: #selector(handleCtrlL(_:))
      ),
      UIKeyCommand(
        input: "z",
        modifierFlags: .control,
        action: #selector(handleCtrlZ(_:))
      ),
    ]
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    guard let key = presses.first?.key else {
      super.pressesBegan(presses, with: event)
      return
    }

    if let terminalKey = terminalKey(for: key) {
      terminalInputView?.handleSpecialKey(terminalKey.key, ctrl: terminalKey.ctrl)
      return
    }

    super.pressesBegan(presses, with: event)
  }

  private func terminalKey(for key: UIKey) -> (key: TerminalInputSpecialKey, ctrl: Bool)? {
    if markedTextRange != nil {
      return nil
    }

    if key.modifierFlags.contains(.control) {
      let input = key.charactersIgnoringModifiers.lowercased()
      switch input {
      case "c":
        return (.c, true)
      case "d":
        return (.d, true)
      case "l":
        return (.l, true)
      case "z":
        return (.z, true)
      default:
        break
      }
    }

    switch key.keyCode {
    case .keyboardUpArrow:
      return (.arrowUp, false)
    case .keyboardDownArrow:
      return (.arrowDown, false)
    case .keyboardLeftArrow:
      return (.arrowLeft, false)
    case .keyboardRightArrow:
      return (.arrowRight, false)
    case .keyboardDeleteForward:
      return (.delete, false)
    case .keyboardHome:
      return (.home, false)
    case .keyboardEnd:
      return (.end, false)
    case .keyboardPageUp:
      return (.pageUp, false)
    case .keyboardPageDown:
      return (.pageDown, false)
    default:
      return nil
    }
  }

  @objc private func handleEscape(_ command: UIKeyCommand) {
    terminalInputView?.handleSpecialKey(.escape)
  }

  @objc private func handleTab(_ command: UIKeyCommand) {
    terminalInputView?.handleSpecialKey(.tab)
  }

  @objc private func handleCtrlC(_ command: UIKeyCommand) {
    terminalInputView?.handleSpecialKey(.c, ctrl: true)
  }

  @objc private func handleCtrlD(_ command: UIKeyCommand) {
    terminalInputView?.handleSpecialKey(.d, ctrl: true)
  }

  @objc private func handleCtrlL(_ command: UIKeyCommand) {
    terminalInputView?.handleSpecialKey(.l, ctrl: true)
  }

  @objc private func handleCtrlZ(_ command: UIKeyCommand) {
    terminalInputView?.handleSpecialKey(.z, ctrl: true)
  }
}

@objc(TerminalInputContainerView)
final class TerminalInputContainerView: UIView, UITextViewDelegate {
  @objc var onTerminalInput: RCTDirectEventBlock?
  @objc var isInputFocused: Bool = false {
    didSet {
      syncFocus()
    }
  }
  @objc var focusToken: NSNumber = 0 {
    didSet {
      if focusToken != oldValue {
        syncFocus(force: true)
      }
    }
  }
  @objc var clearToken: NSNumber = 0 {
    didSet {
      if clearToken != oldValue {
        resetBuffer(keepFocus: isInputFocused)
      }
    }
  }

  private let textView = TerminalInputTextView(frame: .zero)
  private var previousValue = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    configure()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    configure()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      textView.resignFirstResponder()
      return
    }
    syncFocus(force: true)
  }

  private func configure() {
    backgroundColor = .clear
    isAccessibilityElement = false

    textView.translatesAutoresizingMaskIntoConstraints = false
    textView.delegate = self
    textView.terminalInputView = self
    textView.backgroundColor = .clear
    textView.textColor = .clear
    textView.tintColor = .clear
    textView.autocorrectionType = .no
    textView.autocapitalizationType = .none
    textView.spellCheckingType = .no
    textView.smartInsertDeleteType = .no
    textView.smartQuotesType = .no
    textView.smartDashesType = .no
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.keyboardDismissMode = .none
    textView.inputAssistantItem.leadingBarButtonGroups = []
    textView.inputAssistantItem.trailingBarButtonGroups = []

    addSubview(textView)
    NSLayoutConstraint.activate([
      textView.leadingAnchor.constraint(equalTo: leadingAnchor),
      textView.trailingAnchor.constraint(equalTo: trailingAnchor),
      textView.topAnchor.constraint(equalTo: topAnchor),
      textView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  fileprivate func handleSpecialKey(_ key: TerminalInputSpecialKey, ctrl: Bool = false) {
    if textView.markedTextRange != nil {
      return
    }

    emitTerminalInput([
      "kind": "special-key",
      "key": key.rawValue,
      "ctrl": ctrl,
    ])
    resetBuffer(keepFocus: isInputFocused)
  }

  func textViewDidChange(_ textView: UITextView) {
    let normalizedValue = textView.text
      .replacingOccurrences(of: "\r", with: "")
      .replacingOccurrences(of: "\n", with: "")

    if textView.text != normalizedValue {
      textView.text = normalizedValue
    }

    let delta = diff(previousValue, normalizedValue)
    if delta.deleteCount == 0 && delta.insertText.isEmpty {
      moveCaretToEnd()
      return
    }

    previousValue = normalizedValue
    emitTerminalInput([
      "kind": "text-delta",
      "deleteCount": delta.deleteCount,
      "insertText": delta.insertText,
    ])
    moveCaretToEnd()
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    moveCaretToEnd()
  }

  func textView(
    _ textView: UITextView,
    shouldChangeTextIn range: NSRange,
    replacementText text: String
  ) -> Bool {
    if text.contains(where: \.isNewline) {
      handleSpecialKey(.enter)
      return false
    }

    if previousValue.isEmpty && range.length == 0 && text.isEmpty {
      emitTerminalInput([
        "kind": "special-key",
        "key": TerminalInputSpecialKey.backspace.rawValue,
      ])
      syncFocus(force: true)
      return false
    }

    return true
  }

  private func syncFocus(force: Bool = false) {
    guard window != nil else {
      return
    }

    DispatchQueue.main.async { [weak self] in
      guard let self else {
        return
      }

      if self.isInputFocused {
        if force || !self.textView.isFirstResponder {
          self.textView.becomeFirstResponder()
        }
      } else if self.textView.isFirstResponder {
        self.textView.resignFirstResponder()
      }
    }
  }

  fileprivate func focusInput() {
    isInputFocused = true
    syncFocus(force: true)
  }

  fileprivate func blurInput() {
    isInputFocused = false
    syncFocus(force: true)
  }

  private func resetBuffer(keepFocus: Bool) {
    previousValue = ""
    if !textView.text.isEmpty {
      textView.text = ""
    }
    moveCaretToEnd()
    if keepFocus {
      syncFocus(force: true)
    }
  }

  private func moveCaretToEnd() {
    let endPosition = textView.endOfDocument
    let selection = textView.textRange(from: endPosition, to: endPosition)
    textView.selectedTextRange = selection
  }

  private func emitTerminalInput(_ payload: [String: Any]) {
    onTerminalInput?(payload)
  }

  private func diff(_ previousValue: String, _ nextValue: String) -> (deleteCount: Int, insertText: String) {
    let previousChars = Array(previousValue)
    let nextChars = Array(nextValue)
    var prefixLength = 0

    while prefixLength < previousChars.count &&
      prefixLength < nextChars.count &&
      previousChars[prefixLength] == nextChars[prefixLength]
    {
      prefixLength += 1
    }

    return (
      deleteCount: previousChars.count - prefixLength,
      insertText: String(nextChars.dropFirst(prefixLength))
    )
  }
}

@objc(TerminalInputViewManager)
final class TerminalInputViewManager: RCTViewManager {
  override class func requiresMainQueueSetup() -> Bool {
    true
  }

  override func view() -> UIView! {
    TerminalInputContainerView()
  }

  @objc func focus(_ reactTag: NSNumber) {
    bridge.uiManager.addUIBlock { _, viewRegistry in
      guard let view = viewRegistry?[reactTag] as? TerminalInputContainerView else {
        return
      }
      view.focusInput()
    }
  }

  @objc func blur(_ reactTag: NSNumber) {
    bridge.uiManager.addUIBlock { _, viewRegistry in
      guard let view = viewRegistry?[reactTag] as? TerminalInputContainerView else {
        return
      }
      view.blurInput()
    }
  }
}

private final class AwsSsoLoopbackServer {
  private let queue = DispatchQueue(label: "com.dolgate.aws-sso-loopback")
  private var listener: NWListener?
  private var deepLinkBaseURL: URL?

  func start(
    deepLinkBase: String,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    stop()

    guard let deepLinkBaseURL = URL(string: deepLinkBase) else {
      completion(.failure(NSError(
        domain: "AwsSsoLoopbackServer",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "AWS SSO callback URL이 올바르지 않습니다."]
      )))
      return
    }
    self.deepLinkBaseURL = deepLinkBaseURL

    do {
      let listener = try NWListener(using: .tcp, on: .any)
      self.listener = listener
      listener.stateUpdateHandler = { [weak self] state in
        switch state {
        case .ready:
          guard let port = listener.port?.rawValue else {
            completion(.failure(NSError(
              domain: "AwsSsoLoopbackServer",
              code: 2,
              userInfo: [NSLocalizedDescriptionKey: "AWS SSO loopback 포트를 열지 못했습니다."]
            )))
            self?.stop()
            return
          }
          completion(.success("http://127.0.0.1:\(port)/oauth/callback"))
        case .failed(let error):
          completion(.failure(error))
          self?.stop()
        default:
          break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        self?.handle(connection)
      }
      listener.start(queue: queue)
    } catch {
      completion(.failure(error))
    }
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private func handle(_ connection: NWConnection) {
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, _, _ in
      guard let self else {
        connection.cancel()
        return
      }

      let requestString = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      let response = self.buildResponse(for: requestString)
      connection.send(content: response, completion: .contentProcessed { _ in
        connection.cancel()
      })
    }
  }

  private func buildResponse(for requestString: String) -> Data {
    let target = parseTarget(requestString)
    guard let target, target.path == "/oauth/callback" else {
      return httpResponse(
        statusLine: "HTTP/1.1 404 Not Found",
        body: "<!doctype html><html><body>Not Found</body></html>"
      )
    }

    let deepLink = buildDeepLink(from: target)
    if let deepLink {
      DispatchQueue.main.async {
        UIApplication.shared.open(deepLink, options: [:], completionHandler: nil)
      }
      stop()
      return httpResponse(
        statusLine: "HTTP/1.1 200 OK",
        body: successHTML(for: deepLink)
      )
    }

    return httpResponse(
      statusLine: "HTTP/1.1 400 Bad Request",
      body: "<!doctype html><html><body>Invalid callback</body></html>"
    )
  }

  private func parseTarget(_ requestString: String) -> URLComponents? {
    guard
      let requestLine = requestString.components(separatedBy: "\r\n").first,
      requestLine.hasPrefix("GET "),
      let pathComponent = requestLine.split(separator: " ").dropFirst().first
    else {
      return nil
    }
    return URLComponents(string: "http://127.0.0.1\(pathComponent)")
  }

  private func buildDeepLink(from target: URLComponents) -> URL? {
    guard var deepLink = URLComponents(url: deepLinkBaseURL ?? URL(string: "dolgate://aws-sso/callback")!, resolvingAgainstBaseURL: false) else {
      return nil
    }
    deepLink.queryItems = target.queryItems
    return deepLink.url
  }

  private func httpResponse(statusLine: String, body: String) -> Data {
    let headers = [
      statusLine,
      "Content-Type: text/html; charset=utf-8",
      "Cache-Control: no-store",
      "Connection: close",
      "Content-Length: \(body.utf8.count)",
      "",
      body,
    ].joined(separator: "\r\n")
    return Data(headers.utf8)
  }

  private func successHTML(for deepLink: URL) -> String {
    let escaped = deepLink.absoluteString
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "\"", with: "&quot;")
    let scriptTarget = deepLink.absoluteString
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")

    return """
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Dolgate</title>
        <script>
          const target = "\(scriptTarget)";
          window.location.replace(target);
          setTimeout(() => { window.location.href = target; }, 120);
        </script>
      </head>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;">
        <h1 style="font-size:24px;margin:0 0 12px;">Dolgate</h1>
        <p style="margin:0 0 16px;">Returning to the app…</p>
        <a href="\(escaped)" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#0f62fe;color:#fff;text-decoration:none;">Open Dolgate</a>
      </body>
    </html>
    """
  }
}

@objc(AwsSsoBridgeModule)
final class AwsSsoBridgeModule: NSObject, SFSafariViewControllerDelegate {
  private static let loopbackServer = AwsSsoLoopbackServer()
  private static weak var browserController: SFSafariViewController?

  @objc static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc(startLoopback:resolver:rejecter:)
  func startLoopback(
    deepLinkBase: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    AwsSsoBridgeModule.loopbackServer.start(deepLinkBase: deepLinkBase) { result in
      switch result {
      case .success(let redirectURI):
        resolve(["redirectUri": redirectURI])
      case .failure(let error):
        reject("aws_sso_loopback_start_failed", error.localizedDescription, error)
      }
    }
  }

  @objc(stopLoopback:rejecter:)
  func stopLoopback(
    resolver resolve: RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    AwsSsoBridgeModule.loopbackServer.stop()
    resolve(nil)
  }

  @objc(openBrowser:resolver:rejecter:)
  func openBrowser(
    urlString: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = URL(string: urlString) else {
      reject("aws_sso_browser_invalid_url", "AWS SSO 브라우저 URL이 올바르지 않습니다.", nil)
      return
    }

    DispatchQueue.main.async {
      let presentBrowser = {
        guard let presenter = AwsSsoBridgeModule.topViewController() else {
          reject("aws_sso_browser_present_failed", "AWS SSO 브라우저를 표시할 화면을 찾지 못했습니다.", nil)
          return
        }

        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .close
        controller.delegate = self
        AwsSsoBridgeModule.browserController = controller
        presenter.present(controller, animated: true) {
          resolve(nil)
        }
      }

      if let existing = AwsSsoBridgeModule.browserController {
        existing.dismiss(animated: false) {
          AwsSsoBridgeModule.browserController = nil
          presentBrowser()
        }
        return
      }

      presentBrowser()
    }
  }

  @objc(closeBrowser:rejecter:)
  func closeBrowser(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let browserController = AwsSsoBridgeModule.browserController else {
        resolve(nil)
        return
      }
      browserController.dismiss(animated: true) {
        AwsSsoBridgeModule.browserController = nil
        resolve(nil)
      }
    }
  }

  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    if AwsSsoBridgeModule.browserController === controller {
      AwsSsoBridgeModule.browserController = nil
    }
  }

  private static func topViewController(base: UIViewController? = nil) -> UIViewController? {
    let root = base ?? UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?
      .rootViewController

    if let navigationController = root as? UINavigationController {
      return topViewController(base: navigationController.visibleViewController)
    }
    if let tabBarController = root as? UITabBarController {
      return topViewController(base: tabBarController.selectedViewController)
    }
    if let presented = root?.presentedViewController {
      return topViewController(base: presented)
    }
    return root
  }
}

@objc(DolsshFileTransferModule)
final class DolsshFileTransferModule: NSObject, UIDocumentPickerDelegate {
  private var pendingExportResolve: RCTPromiseResolveBlock?
  private var pendingExportReject: RCTPromiseRejectBlock?
  private var pendingExportUrl: URL?
  private var pendingExportName: String?

  @objc static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc(pickDownloadDestination:resolver:rejecter:)
  func pickDownloadDestination(
    fileName: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      do {
        let stagedUrl = try self.createStagedDownloadTarget(
          requestedName: fileName,
          isDirectory: false
        )
        resolve([
          "uri": stagedUrl.absoluteString,
          "name": stagedUrl.lastPathComponent,
          "requiresExport": true,
        ])
      } catch {
        reject("download_destination_failed", error.localizedDescription, error)
      }
    }
  }

  @objc(pickDownloadDirectory:resolver:rejecter:)
  func pickDownloadDirectory(
    directoryName: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      do {
        let stagedUrl = try self.createStagedDownloadTarget(
          requestedName: directoryName,
          isDirectory: true
        )
        resolve([
          "uri": stagedUrl.absoluteString,
          "name": stagedUrl.lastPathComponent,
          "requiresExport": true,
        ])
      } catch {
        reject("download_directory_failed", error.localizedDescription, error)
      }
    }
  }

  @objc(finalizeDownloadDestination:name:resolver:rejecter:)
  func finalizeDownloadDestination(
    destinationUri: String,
    name: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard self.pendingExportResolve == nil else {
        reject("download_export_busy", "이미 저장 위치를 선택하는 중입니다.", nil)
        return
      }
      guard let exportUrl = URL(string: destinationUri) else {
        reject("download_export_failed", "저장 파일 경로가 올바르지 않습니다.", nil)
        return
      }
      guard FileManager.default.fileExists(atPath: exportUrl.path) else {
        reject("download_export_failed", "저장할 파일을 찾지 못했습니다.", nil)
        return
      }
      guard let presenter = DolsshFileTransferModule.topViewController() else {
        reject("download_export_unavailable", "저장 위치를 열 화면을 찾지 못했습니다.", nil)
        return
      }

      self.pendingExportResolve = resolve
      self.pendingExportReject = reject
      self.pendingExportUrl = exportUrl
      self.pendingExportName = name.isEmpty ? exportUrl.lastPathComponent : name

      let controller = UIDocumentPickerViewController(
        forExporting: [exportUrl],
        asCopy: true
      )
      controller.delegate = self
      controller.allowsMultipleSelection = false
      presenter.present(controller, animated: true)
      self.clearPendingExportIfPickerDidNotPresent(controller)
    }
  }

  @objc(createDownloadDirectory:directoryName:resolver:rejecter:)
  func createDownloadDirectory(
    parentUri: String,
    directoryName: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      let directoryUrl = try createChildDocument(
        parentUri: parentUri,
        requestedName: directoryName,
        isDirectory: true
      )
      resolve([
        "uri": directoryUrl.absoluteString,
        "name": directoryUrl.lastPathComponent,
      ])
    } catch {
      reject("download_directory_create_failed", error.localizedDescription, error)
    }
  }

  @objc(createDownloadFile:fileName:resolver:rejecter:)
  func createDownloadFile(
    parentUri: String,
    fileName: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      let fileUrl = try createChildDocument(
        parentUri: parentUri,
        requestedName: fileName,
        isDirectory: false
      )
      resolve([
        "uri": fileUrl.absoluteString,
        "name": fileUrl.lastPathComponent,
      ])
    } catch {
      reject("download_file_create_failed", error.localizedDescription, error)
    }
  }

  @objc(writeDownloadChunk:base64Chunk:append:resolver:rejecter:)
  func writeDownloadChunk(
    destinationUri: String,
    base64Chunk: String,
    append: Bool,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      guard let url = URL(string: destinationUri) else {
        reject("download_write_failed", "저장 파일 경로가 올바르지 않습니다.", nil)
        return
      }
      let bytes = Data(base64Encoded: base64Chunk) ?? Data()
      let didStartAccess = url.startAccessingSecurityScopedResource()
      defer {
        if didStartAccess {
          url.stopAccessingSecurityScopedResource()
        }
      }

      if append, FileManager.default.fileExists(atPath: url.path) {
        let handle = try FileHandle(forWritingTo: url)
        defer {
          try? handle.close()
        }
        try handle.seekToEnd()
        try handle.write(contentsOf: bytes)
      } else {
        try bytes.write(to: url, options: [.atomic])
      }
      resolve(nil)
    } catch {
      reject("download_write_failed", error.localizedDescription, error)
    }
  }

  @objc(deleteDocument:resolver:rejecter:)
  func deleteDocument(
    destinationUri: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      guard let url = URL(string: destinationUri) else {
        resolve(false)
        return
      }
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
      resolve(true)
    } catch {
      reject("document_delete_failed", error.localizedDescription, error)
    }
  }

  @objc(readLocalFileChunk:offset:length:resolver:rejecter:)
  func readLocalFileChunk(
    sourceUri: String,
    offset: NSNumber,
    length: NSNumber,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      guard let url = URL(string: sourceUri) else {
        reject("upload_read_failed", "업로드 파일 경로가 올바르지 않습니다.", nil)
        return
      }
      let handle = try FileHandle(forReadingFrom: url)
      defer {
        try? handle.close()
      }
      try handle.seek(toOffset: offset.uint64Value)
      let data = try handle.read(upToCount: length.intValue) ?? Data()
      resolve([
        "base64": data.base64EncodedString(),
        "bytesRead": data.count,
      ])
    } catch {
      reject("upload_read_failed", error.localizedDescription, error)
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pendingExportReject?(
      "DOCUMENT_PICKER_CANCELED",
      "저장이 취소되었습니다.",
      nil
    )
    cleanupPendingExport()
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController,
    didPickDocumentsAt urls: [URL]
  ) {
    guard let exportedUrl = urls.first else {
      pendingExportReject?(
        "DOCUMENT_PICKER_CANCELED",
        "저장이 취소되었습니다.",
        nil
      )
      cleanupPendingExport()
      return
    }

    let exportedName =
      exportedUrl.lastPathComponent.isEmpty
        ? (pendingExportName ?? "download")
        : exportedUrl.lastPathComponent
    pendingExportResolve?([
      "uri": exportedUrl.absoluteString,
      "name": exportedName,
    ])
    cleanupPendingExport()
  }

  private func clearPendingExport() {
    pendingExportResolve = nil
    pendingExportReject = nil
    pendingExportUrl = nil
    pendingExportName = nil
  }

  private func cleanupPendingExport() {
    let stagedUrl = pendingExportUrl
    clearPendingExport()
    if let stagedUrl = stagedUrl {
      try? FileManager.default.removeItem(at: stagedUrl)
      let parentUrl = stagedUrl.deletingLastPathComponent()
      if parentUrl.lastPathComponent.hasPrefix("dolgate-download-") {
        try? FileManager.default.removeItem(at: parentUrl)
      }
    }
  }

  private func clearPendingExportIfPickerDidNotPresent(
    _ controller: UIDocumentPickerViewController
  ) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self, weak controller] in
      guard let self = self else {
        return
      }
      guard self.pendingExportResolve != nil else {
        return
      }
      guard let controller = controller else {
        self.pendingExportReject?(
          "download_picker_failed",
          "저장 위치 선택기를 열지 못했습니다.",
          nil
        )
        self.cleanupPendingExport()
        return
      }
      if controller.presentingViewController == nil && controller.view.window == nil {
        self.pendingExportReject?(
          "download_picker_failed",
          "저장 위치 선택기를 열지 못했습니다.",
          nil
        )
        self.cleanupPendingExport()
      }
    }
  }

  private func createStagedDownloadTarget(
    requestedName: String,
    isDirectory: Bool
  ) throws -> URL {
    let safeName = sanitizedDownloadName(requestedName, fallback: "download")
    let containerUrl = FileManager.default.temporaryDirectory
      .appendingPathComponent("dolgate-download-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: containerUrl,
      withIntermediateDirectories: true
    )
    let targetUrl = containerUrl.appendingPathComponent(safeName, isDirectory: isDirectory)
    if isDirectory {
      try FileManager.default.createDirectory(
        at: targetUrl,
        withIntermediateDirectories: false
      )
    } else {
      FileManager.default.createFile(atPath: targetUrl.path, contents: nil)
    }
    return targetUrl
  }

  private func sanitizedDownloadName(_ input: String, fallback: String) -> String {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let candidate = trimmed.isEmpty ? fallback : trimmed
    let fileName = URL(fileURLWithPath: candidate).lastPathComponent
    return fileName.isEmpty ? fallback : fileName
  }

  private func createChildDocument(
    parentUri: String,
    requestedName: String,
    isDirectory: Bool
  ) throws -> URL {
    guard let parentUrl = URL(string: parentUri) else {
      throw NSError(
        domain: "DolsshFileTransferModule",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "저장 폴더 경로가 올바르지 않습니다."]
      )
    }

    let didStartAccess = parentUrl.startAccessingSecurityScopedResource()
    defer {
      if didStartAccess {
        parentUrl.stopAccessingSecurityScopedResource()
      }
    }

    let safeName = requestedName.isEmpty ? "download" : requestedName
    let targetName = uniqueChildName(parentUrl: parentUrl, requestedName: safeName)
    let targetUrl = parentUrl.appendingPathComponent(targetName)
    if isDirectory {
      try FileManager.default.createDirectory(
        at: targetUrl,
        withIntermediateDirectories: false
      )
    } else {
      FileManager.default.createFile(atPath: targetUrl.path, contents: nil)
    }
    return targetUrl
  }

  private func uniqueChildName(parentUrl: URL, requestedName: String) -> String {
    let existingNames =
      (try? FileManager.default.contentsOfDirectory(atPath: parentUrl.path))
      .map { Set($0) } ?? Set<String>()
    if !existingNames.contains(requestedName) {
      return requestedName
    }

    let url = URL(fileURLWithPath: requestedName)
    let stem = url.deletingPathExtension().lastPathComponent
    let ext = url.pathExtension.isEmpty ? "" : ".\(url.pathExtension)"
    var index = 1
    while true {
      let suffix = index == 1 ? " copy" : " copy \(index)"
      let candidate = "\(stem)\(suffix)\(ext)"
      if !existingNames.contains(candidate) {
        return candidate
      }
      index += 1
    }
  }

  private static func topViewController(base: UIViewController? = nil) -> UIViewController? {
    let root = base ?? UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?
      .rootViewController

    if let navigationController = root as? UINavigationController {
      return topViewController(base: navigationController.visibleViewController)
    }
    if let tabBarController = root as? UITabBarController {
      return topViewController(base: tabBarController.selectedViewController)
    }
    if let presented = root?.presentedViewController {
      return topViewController(base: presented)
    }
    return root
  }

}
