# Dolgate 빌드 및 배포 가이드

이 문서는 저장소 공통 버전 정책과 빌드/배포 절차만 다룹니다.  
앱별 기능과 로컬 사용법은 [desktop](./desktop.md), [mobile](./mobile.md) 문서를 참고하세요.

## 한눈에 보기

- 저장소 전체는 하나의 `vX.Y.Z` 버전으로 릴리즈합니다.
- GitHub Release 하나에 데스크톱 아티팩트와 Android APK가 함께 올라갑니다.
- `sync-api` 컨테이너도 같은 `vX.Y.Z` 태그를 기준으로 publish 됩니다.
- 버전 source of truth는 루트 `package.json`입니다.

## 사전 요구 사항

- Node.js 24+
- npm 11+
- Go 1.25+

초기 설치:

```bash
npm install
(cd services/ssh-core && go mod tidy)
(cd services/sync-api && go mod tidy)
```

## 로컬 개발 실행

```bash
npm run dev
npm run dev:desktop
npm run dev:mobile:ios
npm run dev:mobile:android
npm run dev:api
```

## 로컬 검증

전체 테스트:

```bash
npm test
```

추가 검증:

```bash
npm run typecheck --workspace @dolssh/desktop
(cd services/ssh-core && go test ./...)
(cd services/ssh-core && go build ./...)
(cd services/sync-api && go test ./...)
(cd services/sync-api && go build ./...)
```

## 저장소 공통 버전 관리

릴리즈 버전의 source of truth는 루트 `package.json`입니다.

- 루트 `package.json`
- `apps/desktop/package.json`
- `apps/mobile/package.json`
- Android `versionName`
- iOS `MARKETING_VERSION`

위 값들은 모두 같은 버전이어야 하고, `vX.Y.Z` 태그와도 일치해야 합니다.

루트 버전 동기화 스크립트:

```bash
npm run version:set -- 1.4.3
npm run version:check
npm run version:bump:patch
npm run version:bump:minor
npm run version:bump:major
```

수동 증가 항목:

- Android `defaultAndroidVersionCode`
- iOS `CURRENT_PROJECT_VERSION`

## 통합 GitHub Release

저장소 전체는 하나의 `vX.Y.Z` 태그와 하나의 GitHub Release로 배포합니다.

- 데스크톱 아티팩트
- Android signed APK
- `sync-api` 컨테이너 publish

이 세 가지가 모두 같은 `vX.Y.Z` 기준으로 동작합니다.

Android 배포 산출물:

- `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- GitHub Release 업로드 이름: `Dolgate-android-vX.Y.Z.apk`

데스크톱 빌드/업로드 세부는 [desktop](./desktop.md), 모바일 빌드 세부는 [mobile](./mobile.md)를 따릅니다.

### 공개 배포용 서명

`build:mobile:android`는 debug keystore가 아니라 전용 release keystore를 요구합니다.

로컬 빌드:

- `apps/mobile/android/signing.local.properties`를 만들고
- `apps/mobile/android/signing.local.properties.example` 형식을 따릅니다.

CI/GitHub Actions:

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

workflow는 keystore를 임시 파일로 복원한 뒤 signed APK를 빌드하고, `apksigner verify`까지 통과해야 성공합니다.

### 배포 절차

1. `npm run version:set -- X.Y.Z` 또는 `npm run version:bump:*`
2. `apps/mobile/android/app/build.gradle`의 `defaultAndroidVersionCode`를 올립니다.
3. `apps/mobile/ios/Dolgate.xcodeproj/project.pbxproj`의 `CURRENT_PROJECT_VERSION`를 올립니다.
4. `npm run version:check`
5. `git tag vX.Y.Z`
6. `git push origin vX.Y.Z`

GitHub Actions가 하나의 `vX.Y.Z` GitHub Release를 만들고, 데스크톱 아티팩트와 `Dolgate-android-vX.Y.Z.apk`를 함께 업로드합니다.

`sync-api` 컨테이너 배포도 같은 `v*` 태그를 기준으로 연결됩니다.

- `vX.Y.Z` 같은 태그가 push되면 GHCR에 `ghcr.io/doldolma/dolgate-sync-api:X.Y.Z`, `:X.Y`, `:latest`가 함께 생성됩니다.
- `main` 브랜치 push만으로는 `sync-api` 운영 이미지를 새로 빌드하지 않습니다.

## sync-api 빌드

```bash
cd services/sync-api
mkdir -p dist
go build -o dist/sync-api ./cmd/api
```

## sync-api Docker 배포

### 포함된 파일

- Docker 이미지 정의: [services/sync-api/Dockerfile](../services/sync-api/Dockerfile)
- Docker ignore: [services/sync-api/.dockerignore](../services/sync-api/.dockerignore)
- Compose 예시: [services/sync-api/deploy/docker-compose.example.yml](../services/sync-api/deploy/docker-compose.example.yml)
- MySQL 포함 Compose 예시: [services/sync-api/deploy/docker-compose.mysql.example.yml](../services/sync-api/deploy/docker-compose.mysql.example.yml)
- OIDC + MySQL Compose 예시: [services/sync-api/deploy/docker-compose.oidc-mysql.example.yml](../services/sync-api/deploy/docker-compose.oidc-mysql.example.yml)
- GHCR 배포 workflow: [.github/workflows/sync-api-container.yml](../.github/workflows/sync-api-container.yml)
- 자체 호스팅 운영 가이드: [sync-api-self-hosting.md](./sync-api-self-hosting.md)

### 배포 메모

- 가장 단순한 self-host 시작은 공개 GHCR 이미지를 그대로 사용하는 것입니다.
- 예제 compose는 빠른 시작용으로 `latest`를 사용하지만, 운영에서는 `ghcr.io/doldolma/dolgate-sync-api:X.Y.Z`처럼 명시 버전 태그 고정을 권장합니다.
- `latest`를 계속 쓴다면 업데이트 시 아래 순서로 반영합니다.

```bash
docker compose pull
docker compose up -d
```

- GitHub Actions는 `ghcr.io/doldolma/dolgate-sync-api`를 `linux/amd64`, `linux/arm64` multi-arch 이미지로 publish합니다.
- `sync-api`는 pure Go SQLite 드라이버를 사용하므로 Docker 빌드는 `CGO_ENABLED=0` 기준입니다.
- `main` 브랜치 push만으로는 운영 이미지를 새로 빌드하지 않고, 릴리즈 태그 기준으로만 publish합니다.
- 실제 self-host 운영 절차, MySQL/OIDC 구성, signing key, reverse proxy 주의사항은 [sync-api 자체 호스팅 가이드](./sync-api-self-hosting.md)로 이동합니다.

## 수동 검증 체크리스트

- 외부 브라우저 로그인과 세션 교환이 정상 동작하는지
- 네트워크 차단 상태에서 offline-authenticated 진입과 재동기화 복귀가 동작하는지
- Session Share 생성, viewer 접속, viewer 채팅, owner `채팅 기록` 창이 정상 동작하는지
- AWS import에서 리전 선택 규칙과 `SSH 정보 확인`이 올바르게 동작하는지
- AWS SFTP progress, host key 확인, 재입력 fallback이 정상 동작하는지
- Warpgate import의 로그인, 중단, 재시도가 정상 동작하는지
