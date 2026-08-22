#import <React/RCTViewManager.h>

@interface RCT_EXTERN_REMAP_MODULE(RemoteDesktopSurface, RemoteDesktopSurfaceManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(sessionId, NSString)
RCT_REMAP_VIEW_PROPERTY(protocol, protocolType, NSString)
RCT_EXPORT_VIEW_PROPERTY(paused, BOOL)
RCT_EXPORT_VIEW_PROPERTY(testPattern, BOOL)
RCT_EXPORT_VIEW_PROPERTY(backgroundColor, UIColor)
RCT_EXPORT_VIEW_PROPERTY(onSurfaceReady, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSurfaceDestroyed, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onMetrics, RCTDirectEventBlock)

@end
