#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exports the Swift implementation to React Native. The Swift class carries the
// matching @objc selectors; this file only declares them for the bridge.
@interface RCT_EXTERN_MODULE (GoSshEngineModule, RCTEventEmitter)

RCT_EXTERN_METHOD(getEngineVersion
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(probeHostKey
                  : (NSString *)requestJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(inspectPrivateKey
                  : (NSString *)privateKeyPem passphrase
                  : (NSString *)passphrase resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(inspectCertificate
                  : (NSString *)certificateText resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(configureTailnets
                  : (NSString *)stateScope configsJson
                  : (NSString *)configsJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startTailnet
                  : (NSString *)requestId payloadJson
                  : (NSString *)payloadJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelTailnet
                  : (NSString *)requestId tailnetId
                  : (NSString *)tailnetId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disconnectTailnet
                  : (NSString *)requestId tailnetId
                  : (NSString *)tailnetId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(snapshotTailnets
                  : (NSString *)requestId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(forgetTailnet
                  : (NSString *)tailnetId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(closeTailnets
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(connect
                  : (NSString *)connectionId requestJson
                  : (NSString *)requestJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(respondKeyboardInteractive
                  : (NSString *)payloadJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(respondHostKeyTrust
                  : (NSString *)challengeId trust
                  : (nonnull NSNumber *)trust resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelConnect
                  : (NSString *)connectionId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disconnect
                  : (NSString *)connectionId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startShell
                  : (NSString *)connectionId optionsJson
                  : (NSString *)optionsJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(generateEphemeralSshKey
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startAwsSsmShell
                  : (NSString *)sessionId requestJson
                  : (NSString *)requestJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startSsmPortForward
                  : (NSString *)forwardId requestJson
                  : (NSString *)requestJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopSsmPortForward
                  : (NSString *)forwardId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendData
                  : (NSString *)shellId dataBase64
                  : (NSString *)dataBase64 resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(resize
                  : (NSString *)shellId rows
                  : (nonnull NSNumber *)rows cols
                  : (nonnull NSNumber *)cols resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(closeShell
                  : (NSString *)shellId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readBuffer
                  : (NSString *)shellId cursorMode
                  : (nonnull NSNumber *)cursorMode seq
                  : (nonnull NSNumber *)seq tailBytes
                  : (nonnull NSNumber *)tailBytes timeMs
                  : (nonnull NSNumber *)timeMs maxBytes
                  : (nonnull NSNumber *)maxBytes resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getShellStats
                  : (NSString *)shellId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getCurrentSeq
                  : (NSString *)shellId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(followOutput
                  : (NSString *)shellId subscriptionToken
                  : (NSString *)subscriptionToken cursorMode
                  : (nonnull NSNumber *)cursorMode seq
                  : (nonnull NSNumber *)seq tailBytes
                  : (nonnull NSNumber *)tailBytes timeMs
                  : (nonnull NSNumber *)timeMs coalesceMs
                  : (nonnull NSNumber *)coalesceMs resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unfollowOutput
                  : (NSString *)shellId listenerId
                  : (nonnull NSNumber *)listenerId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startSftp
                  : (NSString *)connectionId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpList
                  : (NSString *)sftpId path
                  : (NSString *)path resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpReadChunk
                  : (NSString *)sftpId path
                  : (NSString *)path offset
                  : (nonnull NSNumber *)offset length
                  : (nonnull NSNumber *)length resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpWriteChunk
                  : (NSString *)sftpId path
                  : (NSString *)path offset
                  : (nonnull NSNumber *)offset dataBase64
                  : (NSString *)dataBase64 resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpMkdir
                  : (NSString *)sftpId path
                  : (NSString *)path resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpRename
                  : (NSString *)sftpId sourcePath
                  : (NSString *)sourcePath targetPath
                  : (NSString *)targetPath resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpChmod
                  : (NSString *)sftpId path
                  : (NSString *)path mode
                  : (nonnull NSNumber *)mode resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpRemove
                  : (NSString *)sftpId path
                  : (NSString *)path resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpStat
                  : (NSString *)sftpId path
                  : (NSString *)path resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpReadTextFile
                  : (NSString *)sftpId path
                  : (NSString *)path resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sftpWriteTextFile
                  : (NSString *)sftpId requestJson
                  : (NSString *)requestJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(closeSftp
                  : (NSString *)sftpId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(deriveArgon2idKey
                  : (NSString *)passphraseBase64 saltBase64
                  : (NSString *)saltBase64 memoryKib
                  : (nonnull NSNumber *)memoryKib timeCost
                  : (nonnull NSNumber *)timeCost parallelism
                  : (nonnull NSNumber *)parallelism outputLength
                  : (nonnull NSNumber *)outputLength resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

@end
