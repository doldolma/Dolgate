# Dolgate 빌드 및 배포 가이드

복잡한 사용자 흐름은 [feature-flows](./feature-flows.md) 문서를 함께 참고하세요.

## 한눈에 보기

- 데스크톱 앱과 `sync-api`는 별개로 배포합니다.
- `ssh-core`는 앱 시작 시 항상 뜨지 않고, SSH/SFTP/포트 포워딩이 필요할 때 lazily 시작합니다.
- 데스크톱 로그인은 외부 식별자 `dolgate://auth/callback`을 가지지만, 실제 브라우저 교환은 loopback callback을 사용할 수 있습니다.
- 자동 업데이트는 공개 GitHub Releases `doldolma/dolgate`를 기준으로 동작합니다.
- AWS SFTP를 쓰려면 `aws-cli`, `session-manager-plugin`, Linux 인스턴스, SSM managed 상태, EIC 가능 조건이 필요합니다.

## 런타임 구성

### 데스크톱 앱

- Electron `main`, `preload`, `renderer`로 구성됩니다.
- 로컬 상태와 로그는 파일 기반 저장소에 유지합니다.
- `ssh-core`와는 stdio framed protocol로 통신합니다.
- auto update는 `electron-updater`가 GitHub Releases를 조회하는 구조입니다.

### ssh-core는 언제 실행되나

현재 구현에서는 Electron 창이 뜬다고 곧바로 `ssh-core`를 띄우지 않습니다.

다음과 같은 실제 작업이 필요할 때 child process를 lazily 시작합니다.

- SSH 터미널 연결
- SFTP endpoint 연결과 원격 파일 작업
- 포트 포워딩 시작

즉, 사용자가 별도로 `ssh-core`를 켤 필요는 없지만, 항상 메모리에 상주시켜 두는 구조도 아닙니다.

### sync-api

- 브라우저 로그인 페이지와 인증 API를 제공합니다.
- 암호화된 동기화 payload 저장소 역할을 합니다.
- session share viewer와 관련 WebSocket도 함께 제공합니다.

## 인증과 리다이렉트

- 데스크톱의 외부 식별자는 `dolgate://auth/callback`입니다.
- 실제 브라우저 로그인 교환은 로컬 loopback callback `http://127.0.0.1:<port>/auth/callback`을 사용할 수 있습니다.
- `sync-api`는 두 형태를 모두 검증하고, 성공 후 데스크톱 세션 교환 코드로 연결합니다.
- 배포 문서나 OAuth 설정을 갱신할 때는 deep link만 보지 말고 loopback callback 허용도 함께 확인해야 합니다.

## 개발 모드와 릴리즈 모드 차이

개발 모드:

- `npm run dev`
- `CoreManager`가 `go run ./cmd/ssh-core`를 필요 시 실행
- auto update 비활성

릴리즈 모드:

- `npm run release:dist:mac` 또는 `npm run release:dist:win`
- 릴리즈 스크립트가 먼저 `ssh-core`를 타깃 플랫폼 바이너리로 빌드
- Electron Forge가 prepackaged 앱을 만들고, electron-builder가 배포용 아티팩트와 업데이트 메타데이터를 생성
- 패키지 앱은 `process.resourcesPath/bin/ssh-core(.exe)`를 실행
- auto update 활성

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

데스크톱 앱만:

```bash
npm run dev:desktop
```

sync API만:

```bash
npm run dev:api
```

- 로컬 기본 SQLite 경로는 `services/sync-api/data/dolgate_sync.db`입니다.
- `npm run dev:api`는 필요한 `services/sync-api/data/` 디렉터리를 자동으로 생성합니다.

둘 다 함께:

```bash
npm run dev
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

## 데스크톱 앱 빌드

로컬 패키징:

```bash
npm run build --workspace @dolssh/desktop
```

산출물:

- macOS 기준 `apps/desktop/out/` 아래에 패키징 결과가 생성됩니다.

현재 이 명령이 하는 일:

- Electron main/preload/renderer 번들 빌드
- `sync:runtime-deps`로 hoisted 런타임 의존성을 `apps/desktop/node_modules` 아래에 다시 맞춤
- Electron Forge로 앱 패키징
- 로컬 머신 기준으로 실행 가능한 앱 번들 생성

아직 하지 않는 일:

- 플랫폼별 installer 생성
- 코드 서명
- notarization

즉, `npm run build --workspace @dolssh/desktop`은 개발용 패키지 검증에 가깝고, 실제 배포는 아래 릴리즈 명령을 사용합니다.

## 릴리즈 빌드

### macOS universal

```bash
npm run release:dist:mac
```

생성 흐름:

1. `ssh-core`를 `darwin/amd64`, `darwin/arm64`로 각각 빌드
2. `lipo`로 universal `ssh-core` 생성
3. Electron Forge가 universal prepackaged `.app` 생성
4. electron-builder가 `dmg`, `zip`, 업데이트 메타데이터 생성

### Windows x64

```bash
npm run release:dist:win
```

생성 흐름:

1. `ssh-core.exe`를 `windows/amd64`로 크로스 빌드
2. Windows 대상 네이티브 모듈 재빌드 시도
3. Electron Forge가 `win32/x64` prepackaged 앱 생성
4. electron-builder가 `nsis`, `latest.yml` 생성

Windows 설치 동작:

- NSIS는 `current user` 전용 설치로 고정됩니다.
- 설치 마법사는 `one-click` 모드로 동작합니다.
- `all users` 설치는 지원하지 않습니다.

## GitHub Releases 업로드

브라우저 로그인 기반 publish를 쓰려면 GitHub OAuth App을 한 번 설정해야 합니다.

1. GitHub에서 OAuth App을 등록합니다.
2. OAuth App 설정에서 `Device Flow`를 활성화합니다.
3. [apps/desktop/scripts/github-oauth-config.cjs](../apps/desktop/scripts/github-oauth-config.cjs)의 `DEFAULT_GITHUB_OAUTH_CLIENT_ID` 값을 실제 client ID로 바꿉니다.

자동 업로드 명령:

```bash
npm run release:publish:mac
npm run release:publish:win
npm run release:all
```

업로드 흐름:

1. GitHub Device Flow로 브라우저 로그인을 시작합니다.
2. 사용자가 브라우저에서 `https://github.com/login/device`에 코드 입력 후 승인을 완료합니다.
3. `ssh-core`와 앱 아티팩트를 빌드합니다.
4. 현재 버전의 `v<version>` git 태그를 만들고 원격에 push합니다.
5. `doldolma/dolgate` GitHub Release를 현재 버전 기준으로 생성하거나 갱신합니다.
6. 기존과 같은 이름의 asset은 교체하고, 새 아티팩트와 업데이트 메타데이터를 업로드합니다.

`sync-api` 컨테이너 배포도 이 릴리즈 태그를 기준으로 연결됩니다.

- `v1.2.4` 같은 태그가 push되면 GHCR에 `ghcr.io/doldolma/dolgate-sync-api:1.2.4`, `:1.2`, `:latest`가 함께 생성됩니다.
- `main` 브랜치 push만으로는 `sync-api` 운영 이미지를 새로 빌드하지 않습니다.

## AWS / Warpgate 운영 전제

### AWS Import / AWS SFTP

- `aws-cli`가 설치되어 있어야 합니다.
- AWS SFTP와 일부 inspection 경로에는 `session-manager-plugin`이 필요합니다.
- AWS SFTP는 Linux 인스턴스만 지원합니다.
- 인스턴스는 SSM managed 상태여야 하고, sshd/SFTP가 활성화되어 있어야 합니다.
- EC2 Instance Connect 공개 키 주입이 가능해야 합니다.

### Warpgate Import

- 내부 브라우저 인증 창에서 로그인 후 target 목록을 가져옵니다.
- 로그인 대기 중에는 import 다이얼로그에서 중단하고 다시 시도할 수 있습니다.

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
- 예제 compose는 빠른 시작용으로 `latest`를 사용하지만, 운영에서는 `ghcr.io/doldolma/dolgate-sync-api:1.2.4`처럼 명시 버전 태그 고정을 권장합니다.
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
