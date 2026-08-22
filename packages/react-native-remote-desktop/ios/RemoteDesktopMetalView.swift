import UIKit
import Metal
import MetalKit
import QuartzCore

/// Native Metal-backed surface for remote desktop rendering.
///
/// Renders either a test pattern (animated color bars at 30fps) or the authoritative
/// RGBA framebuffer from RemoteDesktopSessionManager. Dirty-rect partial texture
/// updates minimize GPU bandwidth. Display-link ticks with no damage return before
/// acquiring a drawable or creating a command buffer.
///
/// Surface destroyed (removeFromSuperview / didMoveToWindow nil) is a VIEW detach,
/// NOT a session destroy — the manager framebuffer keeps updating in the background.
@objcMembers
final class RemoteDesktopMetalView: UIView {

  // MARK: - Public Properties (set from RN props)

  var sessionId: String = "" {
    didSet {
      guard oldValue != sessionId else { return }
      detachFromSessionIfNeeded()
      cursorTexture = nil
      cursorTextureGeneration = 0
      cursorSnapshot = nil
      attachToSessionIfNeeded()
    }
  }
  var protocolType: String = "vnc" // "vnc" | "rdp"
  var paused: Bool = false {
    didSet { updateDisplayLink() }
  }
  var testPattern: Bool = true {
    didSet {
      if testPattern {
        // Ensure display link is running for test pattern
        updateDisplayLink()
      } else {
        hasPendingDamage = true
      }
    }
  }
  var surfaceBackgroundColor: UIColor = .black {
    didSet { metalLayer.backgroundColor = surfaceBackgroundColor.cgColor }
  }

  // MARK: - Events

  var onSurfaceReady: (([String: Any]) -> Void)?
  var onSurfaceDestroyed: (([String: Any]) -> Void)?
  var onMetrics: (([String: Any]) -> Void)?

  // MARK: - Metal State

  private var device: MTLDevice!
  private var commandQueue: MTLCommandQueue!
  private var testPatternPipeline: MTLRenderPipelineState!
  private var framebufferPipeline: MTLRenderPipelineState!
  private var cursorPipeline: MTLRenderPipelineState!
  private var metalLayer: CAMetalLayer!
  private var displayLink: CADisplayLink?
  private var frameCount: Int = 0
  private var lastMetricsTime: CFTimeInterval = 0
  private var lastFrameTime: CFTimeInterval = 0

  // MARK: - Desktop Texture (real framebuffer)

  private var desktopTexture: MTLTexture?
  private var desktopWidth: UInt16 = 0
  private var desktopHeight: UInt16 = 0
  private var desktopGeneration: UInt64 = 0
  private var cursorTexture: MTLTexture?
  private var cursorTextureGeneration: UInt64 = 0
  private var cursorSnapshot: CursorSnapshot?

  // MARK: - Dirty tracking

  private var hasPendingDamage: Bool = false
  private var hasPendingCursor: Bool = false

  // MARK: - Active state

  private var isActive: Bool = true
  private var attachedSessionId: String?
  private var isSurfaceAvailable: Bool = false
  private var hasEmittedSurfaceReady: Bool = false

  // MARK: - Lifecycle

  override init(frame: CGRect) {
    super.init(frame: frame)
    setupMetal()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setupMetal()
  }

  override class var layerClass: AnyClass {
    return CAMetalLayer.self
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      isSurfaceAvailable = true
      attachToSessionIfNeeded()
      updateDisplayLink()
      emitSurfaceReadyIfNeeded()
    } else {
      tearDownSurfaceIfNeeded()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    metalLayer.drawableSize = CGSize(
      width: bounds.width * contentScaleFactor,
      height: bounds.height * contentScaleFactor
    )
    hasPendingDamage = true
    emitSurfaceReadyIfNeeded()
  }

  private func attachToSessionIfNeeded() {
    guard window != nil, !sessionId.isEmpty, attachedSessionId != sessionId else { return }
    detachFromSessionIfNeeded()
    RemoteDesktopSessionManager.shared.attachView(self, sessionId: sessionId)
    attachedSessionId = sessionId
    syncDesktopTexture()
    syncCursor()
  }

  private func detachFromSessionIfNeeded() {
    guard let attachedSessionId else { return }
    RemoteDesktopSessionManager.shared.detachView(self, sessionId: attachedSessionId)
    self.attachedSessionId = nil
  }

  private func tearDownSurfaceIfNeeded() {
    guard isSurfaceAvailable || attachedSessionId != nil else { return }
    stopDisplayLink()
    detachFromSessionIfNeeded()
    if isSurfaceAvailable {
      isSurfaceAvailable = false
      hasEmittedSurfaceReady = false
      onSurfaceDestroyed?([:])
    }
  }

  private func emitSurfaceReadyIfNeeded() {
    guard isSurfaceAvailable, !hasEmittedSurfaceReady,
          bounds.width > 0, bounds.height > 0 else { return }
    hasEmittedSurfaceReady = true
    onSurfaceReady?([
      "width": Int(bounds.width),
      "height": Int(bounds.height),
    ])
  }

  // MARK: - Session Callbacks (called from main queue by manager)

  func onSessionConnected(generation: UInt64) {
    requestTextureSync(generation: generation)
  }

  func onSessionResized(generation: UInt64) {
    requestTextureSync(generation: generation)
  }

  func onCursorChanged() {
    hasPendingCursor = true
  }

  private func requestTextureSync(generation: UInt64) {
    guard generation >= desktopGeneration else { return }
    hasPendingDamage = true
  }

  /// Set active state (for setActive from JS). Inactive = no presentation but framebuffer updates.
  func setActiveState(_ active: Bool) {
    isActive = active
    if active { hasPendingDamage = true }
    updateDisplayLink()
  }

  // MARK: - Metal Setup

  private func setupMetal() {
    guard let device = MTLCreateSystemDefaultDevice() else {
      assertionFailure("Metal is not supported on this device")
      return
    }
    self.device = device
    self.commandQueue = device.makeCommandQueue()!

    metalLayer = self.layer as? CAMetalLayer ?? CAMetalLayer()
    metalLayer.device = device
    metalLayer.pixelFormat = .bgra8Unorm
    metalLayer.framebufferOnly = true
    metalLayer.contentsScale = UIScreen.main.scale
    metalLayer.backgroundColor = surfaceBackgroundColor.cgColor

    setupPipelines()
  }

  private func setupPipelines() {
    // Test pattern shader (same as before)
    let testShaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct VertexOut {
      float4 position [[position]];
      float2 uv;
    };

    vertex VertexOut vertex_main(uint vertexID [[vertex_id]]) {
      float2 positions[4] = {
        float2(-1, -1), float2(1, -1),
        float2(-1, 1), float2(1, 1)
      };
      float2 uvs[4] = {
        float2(0, 1), float2(1, 1),
        float2(0, 0), float2(1, 0)
      };
      VertexOut out;
      out.position = float4(positions[vertexID], 0, 1);
      out.uv = uvs[vertexID];
      return out;
    }

    fragment float4 fragment_test_pattern(VertexOut in [[stage_in]],
                                          constant float &time [[buffer(0)]]) {
      float x = in.uv.x;
      float y = in.uv.y;
      float t = time;
      float barIndex = floor(x * 8.0);
      float r = fmod(barIndex, 2.0) * (0.5 + 0.5 * sin(t + barIndex));
      float g = fmod(barIndex + 1.0, 3.0) / 2.0 * (0.5 + 0.5 * cos(t * 0.7 + y * 3.14));
      float b = (1.0 - x) * (0.5 + 0.5 * sin(t * 1.3 + barIndex * 0.5));
      return float4(r, g, b, 1.0);
    }

    fragment float4 fragment_framebuffer(VertexOut in [[stage_in]],
                                         texture2d<float> tex [[texture(0)]]) {
      constexpr sampler s(filter::linear, address::clamp_to_edge);
      return tex.sample(s, in.uv);
    }

    fragment float4 fragment_cursor(VertexOut in [[stage_in]],
                                     texture2d<float> tex [[texture(0)]],
                                     constant float4 &uvRect [[buffer(0)]]) {
      constexpr sampler s(filter::linear, address::clamp_to_edge);
      float2 uv = uvRect.xy + in.uv * uvRect.zw;
      return tex.sample(s, uv);
    }
    """

    do {
      let library = try device.makeLibrary(source: testShaderSource, options: nil)
      let vertexFn = library.makeFunction(name: "vertex_main")!

      // Test pattern pipeline
      let testFragFn = library.makeFunction(name: "fragment_test_pattern")!
      let testDesc = MTLRenderPipelineDescriptor()
      testDesc.vertexFunction = vertexFn
      testDesc.fragmentFunction = testFragFn
      testDesc.colorAttachments[0].pixelFormat = .bgra8Unorm
      testPatternPipeline = try device.makeRenderPipelineState(descriptor: testDesc)

      // Framebuffer pipeline
      let fbFragFn = library.makeFunction(name: "fragment_framebuffer")!
      let fbDesc = MTLRenderPipelineDescriptor()
      fbDesc.vertexFunction = vertexFn
      fbDesc.fragmentFunction = fbFragFn
      fbDesc.colorAttachments[0].pixelFormat = .bgra8Unorm
      framebufferPipeline = try device.makeRenderPipelineState(descriptor: fbDesc)

      // Cursor pipeline — straight-alpha RGBA over the desktop pass.
      let cursorFragFn = library.makeFunction(name: "fragment_cursor")!
      let cursorDesc = MTLRenderPipelineDescriptor()
      cursorDesc.vertexFunction = vertexFn
      cursorDesc.fragmentFunction = cursorFragFn
      let cursorAttachment = cursorDesc.colorAttachments[0]!
      cursorAttachment.pixelFormat = .bgra8Unorm
      cursorAttachment.isBlendingEnabled = true
      cursorAttachment.rgbBlendOperation = .add
      cursorAttachment.alphaBlendOperation = .add
      cursorAttachment.sourceRGBBlendFactor = .sourceAlpha
      cursorAttachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
      cursorAttachment.sourceAlphaBlendFactor = .one
      cursorAttachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
      cursorPipeline = try device.makeRenderPipelineState(descriptor: cursorDesc)
    } catch {
      assertionFailure("Failed to create Metal pipeline: \(error)")
    }
  }

  // MARK: - Desktop Texture Management

  @discardableResult
  private func recreateDesktopTexture(width: UInt16, height: UInt16,
                                      generation: UInt64) -> Bool {
    guard width > 0, height > 0 else { return false }

    let desc = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba8Unorm,
      width: Int(width),
      height: Int(height),
      mipmapped: false
    )
    desc.usage = [.shaderRead]
    desc.storageMode = .shared // iOS unified memory — direct CPU write
    guard let texture = device.makeTexture(descriptor: desc) else { return false }

    desktopTexture = texture
    desktopWidth = width
    desktopHeight = height
    desktopGeneration = generation
    return true
  }

  /// Sync texture from the existing session framebuffer (for example after reattachment).
  private func syncDesktopTexture() {
    guard let entry = RemoteDesktopSessionManager.shared.getSession(id: sessionId) else { return }
    entry.markFullDirty()
    hasPendingDamage = true
  }

  private func syncCursor() {
    hasPendingCursor = true
  }

  /// Consume one coalesced cursor snapshot and upload a new shape generation if needed.
  @discardableResult
  private func refreshCursorSnapshot() -> Bool {
    guard hasPendingCursor else { return false }
    guard let entry = RemoteDesktopSessionManager.shared.getSession(id: sessionId) else {
      hasPendingCursor = false
      cursorSnapshot = nil
      return true
    }

    let snapshot = entry.consumeCursorSnapshot()
    hasPendingCursor = false
    cursorSnapshot = snapshot
    guard let shape = snapshot.shape else { return true }
    guard shape.generation != cursorTextureGeneration || cursorTexture == nil else {
      return true
    }

    let expectedLength = Int(shape.width) * Int(shape.height) * 4
    guard shape.width > 0, shape.height > 0,
          shape.width <= VNCSessionEntry.maxCursorDimension,
          shape.height <= VNCSessionEntry.maxCursorDimension,
          shape.hotspotX < shape.width, shape.hotspotY < shape.height,
          shape.rgba.count == expectedLength else {
      cursorSnapshot = nil
      return true
    }

    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba8Unorm,
      width: Int(shape.width),
      height: Int(shape.height),
      mipmapped: false
    )
    descriptor.usage = [.shaderRead]
    descriptor.storageMode = .shared
    guard let texture = device.makeTexture(descriptor: descriptor) else {
      hasPendingCursor = true
      return true
    }

    let region = MTLRegion(
      origin: MTLOrigin(x: 0, y: 0, z: 0),
      size: MTLSize(width: Int(shape.width), height: Int(shape.height), depth: 1)
    )
    shape.rgba.withUnsafeBytes { bytes in
      texture.replace(
        region: region,
        mipmapLevel: 0,
        withBytes: bytes.baseAddress!,
        bytesPerRow: Int(shape.width) * 4
      )
    }
    cursorTexture = texture
    cursorTextureGeneration = shape.generation
    return true
  }

  /// Upload current-generation dirty rectangles from the authoritative framebuffer.
  /// Returns true only when texture bytes changed.
  private func uploadDirtyRegions() -> Bool {
    guard let entry = RemoteDesktopSessionManager.shared.getSession(id: sessionId),
          let damage = entry.drainDamage(),
          let framebuffer = entry.lockFramebuffer() else { return false }
    defer { entry.unlockFramebuffer() }

    let generationChanged = desktopTexture == nil
      || desktopGeneration != framebuffer.generation
      || desktopWidth != framebuffer.width
      || desktopHeight != framebuffer.height
    let uploadFullFrame = damage.full || generationChanged

    if generationChanged,
       !recreateDesktopTexture(width: framebuffer.width,
                               height: framebuffer.height,
                               generation: framebuffer.generation) {
      entry.markFullDirty()
      return false
    }
    guard let texture = desktopTexture else { return false }

    let rects: [DamageRect]
    if uploadFullFrame {
      rects = [DamageRect(x: 0, y: 0,
                          width: framebuffer.width, height: framebuffer.height)]
    } else {
      rects = damage.rects
    }

    var uploaded = false
    for rect in rects {
      let x = Int(rect.x)
      let y = Int(rect.y)
      let width = Int(rect.width)
      let height = Int(rect.height)
      guard width > 0, height > 0,
            x + width <= Int(framebuffer.width),
            y + height <= Int(framebuffer.height) else { continue }

      let region = MTLRegion(
        origin: MTLOrigin(x: x, y: y, z: 0),
        size: MTLSize(width: width, height: height, depth: 1)
      )
      let srcOffset = y * framebuffer.stride + x * 4
      texture.replace(
        region: region,
        mipmapLevel: 0,
        withBytes: framebuffer.pointer.advanced(by: srcOffset),
        bytesPerRow: framebuffer.stride
      )
      uploaded = true
    }
    return uploaded
  }

  // MARK: - Display Link

  private func startDisplayLink() {
    guard displayLink == nil else { return }
    let link = CADisplayLink(target: self, selector: #selector(renderFrame))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 24, maximum: 60, preferred: 30)
    link.add(to: .main, forMode: .common)
    displayLink = link
    lastMetricsTime = CACurrentMediaTime()
    frameCount = 0
  }

  private func stopDisplayLink() {
    displayLink?.invalidate()
    displayLink = nil
  }

  private func updateDisplayLink() {
    if paused || !isActive {
      stopDisplayLink()
    } else if window != nil {
      startDisplayLink()
    }
  }

  // MARK: - Render

  @objc private func renderFrame() {
    guard !paused, isActive else { return }

    if testPattern {
      renderTestPattern()
    } else {
      renderDesktopFramebuffer()
    }
  }

  private func renderTestPattern() {
    guard let drawable = metalLayer.nextDrawable() else { return }
    guard let commandBuffer = commandQueue.makeCommandBuffer() else { return }

    let now = CACurrentMediaTime()
    let frameTime = now - lastFrameTime
    lastFrameTime = now

    let passDescriptor = MTLRenderPassDescriptor()
    passDescriptor.colorAttachments[0].texture = drawable.texture
    passDescriptor.colorAttachments[0].loadAction = .clear
    passDescriptor.colorAttachments[0].storeAction = .store
    passDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)

    guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor) else { return }
    encoder.setRenderPipelineState(testPatternPipeline)

    var time = Float(now.truncatingRemainder(dividingBy: 100))
    encoder.setFragmentBytes(&time, length: MemoryLayout<Float>.size, index: 0)
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    encoder.endEncoding()

    commandBuffer.present(drawable)
    commandBuffer.commit()

    emitMetrics(frameTime: frameTime)
  }

  private func renderDesktopFramebuffer() {
    let uploadedDamage = uploadDirtyRegions()
    let cursorChanged = refreshCursorSnapshot()
    guard uploadedDamage || hasPendingDamage || cursorChanged else { return }
    guard let texture = desktopTexture else { return }
    hasPendingDamage = false

    guard let drawable = metalLayer.nextDrawable() else {
      hasPendingDamage = true
      return
    }
    guard let commandBuffer = commandQueue.makeCommandBuffer() else {
      hasPendingDamage = true
      return
    }

    let now = CACurrentMediaTime()
    let frameTime = now - lastFrameTime
    lastFrameTime = now

    let passDescriptor = MTLRenderPassDescriptor()
    passDescriptor.colorAttachments[0].texture = drawable.texture
    passDescriptor.colorAttachments[0].loadAction = .clear
    passDescriptor.colorAttachments[0].storeAction = .store
    passDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)

    guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor) else {
      hasPendingDamage = true
      return
    }
    encoder.setRenderPipelineState(framebufferPipeline)
    encoder.setFragmentTexture(texture, index: 0)

    // Aspect-fit: compute viewport to maintain desktop aspect ratio
    let drawableW = Float(drawable.texture.width)
    let drawableH = Float(drawable.texture.height)
    let desktopAspect = Float(desktopWidth) / max(Float(desktopHeight), 1)
    let drawableAspect = drawableW / max(drawableH, 1)

    var vpX: Float = 0
    var vpY: Float = 0
    var vpW: Float = drawableW
    var vpH: Float = drawableH

    if desktopAspect > drawableAspect {
      // Desktop wider → letterbox top/bottom
      vpH = drawableW / desktopAspect
      vpY = (drawableH - vpH) / 2
    } else {
      // Desktop taller → pillarbox left/right
      vpW = drawableH * desktopAspect
      vpX = (drawableW - vpW) / 2
    }

    let viewport = MTLViewport(
      originX: Double(vpX), originY: Double(vpY),
      width: Double(vpW), height: Double(vpH),
      znear: 0, zfar: 1
    )
    encoder.setViewport(viewport)
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    drawCursor(
      encoder: encoder,
      desktopX: Double(vpX),
      desktopY: Double(vpY),
      desktopWidth: Double(vpW),
      desktopHeight: Double(vpH)
    )
    encoder.endEncoding()

    commandBuffer.present(drawable)
    commandBuffer.commit()

    emitMetrics(frameTime: frameTime)
  }

  private func drawCursor(encoder: MTLRenderCommandEncoder,
                          desktopX: Double, desktopY: Double,
                          desktopWidth: Double, desktopHeight: Double) {
    guard let snapshot = cursorSnapshot,
          let shape = snapshot.shape,
          let texture = cursorTexture,
          shape.generation == cursorTextureGeneration,
          self.desktopWidth > 0, self.desktopHeight > 0 else { return }

    let remoteWidth = Double(self.desktopWidth)
    let remoteHeight = Double(self.desktopHeight)
    let left = Double(snapshot.x) - Double(shape.hotspotX)
    let top = Double(snapshot.y) - Double(shape.hotspotY)
    let right = left + Double(shape.width)
    let bottom = top + Double(shape.height)
    let visibleLeft = max(0, left)
    let visibleTop = max(0, top)
    let visibleRight = min(remoteWidth, right)
    let visibleBottom = min(remoteHeight, bottom)
    guard visibleRight > visibleLeft, visibleBottom > visibleTop else { return }

    let cursorViewport = MTLViewport(
      originX: desktopX + visibleLeft / remoteWidth * desktopWidth,
      originY: desktopY + visibleTop / remoteHeight * desktopHeight,
      width: (visibleRight - visibleLeft) / remoteWidth * desktopWidth,
      height: (visibleBottom - visibleTop) / remoteHeight * desktopHeight,
      znear: 0,
      zfar: 1
    )
    var uvRect = SIMD4<Float>(
      Float((visibleLeft - left) / Double(shape.width)),
      Float((visibleTop - top) / Double(shape.height)),
      Float((visibleRight - visibleLeft) / Double(shape.width)),
      Float((visibleBottom - visibleTop) / Double(shape.height))
    )

    encoder.setViewport(cursorViewport)
    encoder.setRenderPipelineState(cursorPipeline)
    encoder.setFragmentTexture(texture, index: 0)
    encoder.setFragmentBytes(
      &uvRect,
      length: MemoryLayout<SIMD4<Float>>.stride,
      index: 0
    )
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
  }

  private func emitMetrics(frameTime: CFTimeInterval) {
    frameCount += 1
    let now = CACurrentMediaTime()
    if now - lastMetricsTime >= 1.0 {
      let fps = Double(frameCount) / (now - lastMetricsTime)
      onMetrics?([
        "fps": fps,
        "dirtyRects": 1,
        "frameTimeMs": frameTime * 1000.0,
      ])
      frameCount = 0
      lastMetricsTime = now
    }
  }
}
