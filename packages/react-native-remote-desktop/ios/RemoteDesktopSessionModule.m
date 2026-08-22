#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(RemoteDesktopSessionModule, RCTEventEmitter)

RCT_EXTERN_METHOD(isAvailable:(NSString *)protocolType
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(connect:(NSString *)sessionId
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disconnect:(NSString *)sessionId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setActive:(NSString *)sessionId
                  active:(BOOL)active
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setOrientationUnlocked:(BOOL)unlocked
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pointerMove:(NSString *)sessionId
                  x:(double)x
                  y:(double)y)

RCT_EXTERN_METHOD(pointerButton:(NSString *)sessionId
                  button:(double)button
                  pressed:(BOOL)pressed
                  x:(double)x
                  y:(double)y)

RCT_EXTERN_METHOD(scroll:(NSString *)sessionId
                  vertical:(BOOL)vertical
                  delta:(double)delta
                  x:(double)x
                  y:(double)y)

RCT_EXTERN_METHOD(keyEvent:(NSString *)sessionId
                  keysym:(double)keysym
                  pressed:(BOOL)pressed
                  keycode:(double)keycode)

RCT_EXTERN_METHOD(unicodeEvent:(NSString *)sessionId
                  codepoint:(double)codepoint
                  pressed:(BOOL)pressed)

RCT_EXTERN_METHOD(trustCertificate:(NSString *)sessionId
                  accept:(BOOL)accept
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendClipboard:(NSString *)sessionId
                  text:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(refresh:(NSString *)sessionId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(resize:(NSString *)sessionId
                  width:(double)width
                  height:(double)height
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
