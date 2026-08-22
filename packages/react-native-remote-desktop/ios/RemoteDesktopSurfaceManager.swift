import UIKit
import React

/// ViewManager for RemoteDesktopSurface — bridges the Metal surface to React Native.
///
/// This uses the New Architecture interop layer (RCTViewManager subclass auto-bridged
/// to Fabric). The component name matches the codegen spec so a future pure-Fabric
/// migration only removes this file.
@objc(RemoteDesktopSurfaceManager)
final class RemoteDesktopSurfaceManager: RCTViewManager {

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func view() -> UIView! {
    return RemoteDesktopMetalView()
  }
}
