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

@interface RCT_EXTERN_MODULE(DolsshFileTransferModule, NSObject)

RCT_EXTERN_METHOD(pickDownloadDestination:(NSString *)fileName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pickDownloadDirectory:(NSString *)directoryName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(createDownloadDirectory:(NSString *)parentUri
                  directoryName:(NSString *)directoryName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(createDownloadFile:(NSString *)parentUri
                  fileName:(NSString *)fileName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(writeDownloadChunk:(NSString *)destinationUri
                  base64Chunk:(NSString *)base64Chunk
                  append:(BOOL)append
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(deleteDocument:(NSString *)destinationUri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readLocalFileChunk:(NSString *)sourceUri
                  offset:(nonnull NSNumber *)offset
                  length:(nonnull NSNumber *)length
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

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
