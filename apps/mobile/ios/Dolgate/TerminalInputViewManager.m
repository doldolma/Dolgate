#import <React/RCTComponent.h>
#import <React/RCTViewManager.h>

@interface RCT_EXTERN_REMAP_MODULE(TerminalInputView, TerminalInputViewManager, RCTViewManager)

RCT_REMAP_VIEW_PROPERTY(focused, isInputFocused, BOOL)
RCT_EXPORT_VIEW_PROPERTY(focusToken, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(clearToken, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(onTerminalInput, RCTDirectEventBlock)
RCT_EXTERN_METHOD(focus:(nonnull NSNumber *)reactTag)
RCT_EXTERN_METHOD(blur:(nonnull NSNumber *)reactTag)

@end

@interface RCT_EXTERN_MODULE(AwsSsoBridgeModule, NSObject)

RCT_EXTERN_METHOD(startLoopback:(NSString *)deepLinkBase
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopLoopback:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(openBrowser:(NSString *)urlString
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(closeBrowser:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
