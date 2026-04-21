# Dolgate Mobile

Dolgate Mobile은 iOS와 Android를 위한 React Native 클라이언트입니다.  
현재 모바일 앱은 동기화된 호스트/그룹을 기반으로 세션을 열고, 현재 연결된 세션 탭 워크스페이스 안에서 터미널 작업을 이어가는 흐름을 중심으로 정리되어 있습니다.

## 현재 범위

- iOS / Android 앱 실행과 공통 계정 로그인
- 동기화된 호스트 / 그룹 브라우징
- 현재 연결된 세션 탭 워크스페이스
- SSH 및 AWS 기반 원격 세션 연결 경로
- 하단 단축키 바와 모바일 터미널 입력 보조 UI
- Android signed APK 빌드
- 저장소 공통 버전과 같은 `vX.Y.Z` 릴리즈 정책

## 로컬 실행

```bash
npm run dev:mobile:ios
npm run dev:mobile:android
```

현재 모바일 dev 스크립트는 다음 규칙을 따릅니다.

- iOS와 Android를 동시에 실행해도 같은 Metro(`:8081`)를 공유합니다.
- 먼저 실행한 세션이 Metro를 띄우고, 나중 세션은 그대로 재사용합니다.
- 마지막 세션을 종료하면 Metro도 함께 정리됩니다.

## 빌드

```bash
npm run build:mobile:ios
npm run build:mobile:android
```

산출물:

- iOS: `apps/mobile/ios/build/derived-data/Build/Products/Release-iphoneos/Dolgate.app`
- Android: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`

## Android signing

Android release APK는 debug keystore가 아니라 전용 release keystore를 사용합니다.

로컬 빌드:

- `apps/mobile/android/signing.local.properties`를 만들고
- `apps/mobile/android/signing.local.properties.example` 형식을 따릅니다.

CI/GitHub Actions:

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

## 릴리즈 메모

- Android APK는 저장소 전체 `vX.Y.Z` GitHub Release에 함께 업로드됩니다.
- iOS는 현재 release `.app` 산출까지만 자동화합니다.
- 버전은 루트 `package.json`이 source of truth이고, Android `versionCode`와 iOS `CURRENT_PROJECT_VERSION`는 수동 증가 항목입니다.

상세 버전/배포 절차는 [build-and-deploy](./build-and-deploy.md) 문서를 따릅니다.
