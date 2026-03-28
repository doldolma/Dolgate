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
3. [apps/desktop/scripts/github-oauth-config.cjs](/Users/heodoyeong/develop/dolsh/apps/desktop/scripts/github-oauth-config.cjs)의 `DEFAULT_GITHUB_OAUTH_CLIENT_ID` 값을 실제 client ID로 바꿉니다.

자동 업로드 명령:

```bash
npm run release:mac
npm run release:win
npm run release:all
```

업로드 흐름:

1. GitHub Device Flow로 브라우저 로그인을 시작합니다.
2. 사용자가 브라우저에서 `https://github.com/login/device`에 코드 입력 후 승인을 완료합니다.
3. `ssh-core`와 앱 아티팩트를 빌드합니다.
4. `doldolma/dolgate` GitHub Release를 현재 버전 기준으로 생성하거나 갱신합니다.
5. 기존과 같은 이름의 asset은 교체하고, 새 아티팩트와 업데이트 메타데이터를 업로드합니다.

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

- Docker 이미지 정의: [services/sync-api/Dockerfile](/Users/heodoyeong/develop/dolsh/services/sync-api/Dockerfile)
- Docker ignore: [services/sync-api/.dockerignore](/Users/heodoyeong/develop/dolsh/services/sync-api/.dockerignore)
- Compose 예시: [services/sync-api/deploy/docker-compose.example.yml](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/docker-compose.example.yml)
- MySQL 포함 Compose 예시: [services/sync-api/deploy/docker-compose.mysql.example.yml](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/docker-compose.mysql.example.yml)
- OIDC + MySQL Compose 예시: [services/sync-api/deploy/docker-compose.oidc-mysql.example.yml](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/docker-compose.oidc-mysql.example.yml)
- Nginx reverse proxy 예시: [services/sync-api/deploy/nginx.sync-api.example.conf](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/nginx.sync-api.example.conf)
- GHCR 배포 workflow: [/.github/workflows/sync-api-container.yml](/Users/heodoyeong/develop/dolsh/.github/workflows/sync-api-container.yml)

### 빠른 시작

가장 단순한 self-host 경로는 공개 GHCR 이미지를 그대로 쓰는 것입니다.

1. SQLite 단일 노드 기준 compose 실행

```bash
cd services/sync-api/deploy
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

2. 상태 확인

```bash
docker compose ps
curl http://127.0.0.1:8080/healthz
```

3. 필요하면 MySQL 예시로 전환

```bash
cd services/sync-api/deploy
cp docker-compose.mysql.example.yml docker-compose.yml
docker compose up -d
```

4. Google OIDC + MySQL 기준으로 시작하려면

```bash
cd services/sync-api/deploy
cp docker-compose.oidc-mysql.example.yml docker-compose.yml
docker compose up -d
```

### compose 기본값

- 기본 SQLite 예시는 `ghcr.io/doldolma/dolgate-sync-api:latest` 이미지를 바로 pull합니다.
- SQLite 데이터베이스와 인증 서명 키는 같은 named volume `/app/data`에 저장됩니다.
- 첫 부팅 시 `/app/data/auth-signing-private.pem`이 없으면 `sync-api`가 새 RSA private key를 생성해서 저장합니다.
- 같은 volume을 유지한 채 재시작하면 기존 signing key를 재사용하므로 refresh token, browser login state, offline lease 검증이 계속 유지됩니다.
- 반대로 volume을 잃으면 기존 세션과 토큰은 모두 무효화되고 재로그인이 필요합니다.
- 기본 compose는 config file mount 없이 환경변수만으로 동작합니다.

### 고급 설정

- 기본 self-host 흐름은 자동 생성 키를 권장하지만, 멀티 인스턴스 운영이나 키 교체 정책이 필요한 환경이라면 서명 키를 명시 주입해야 합니다.
- 지원 설정:
  - `AUTH_SIGNING_PRIVATE_KEY_PEM`
  - `AUTH_SIGNING_PRIVATE_KEY_PATH`
- 운영자가 별도 PEM을 주입하면 자동 생성보다 그 값을 우선 사용합니다.
- `DOLSSH_API_CONFIG_PATH`로 외부 JSON 파일을 읽을 수는 있지만, 기본 배포 흐름은 config 파일 없이 env-only compose를 권장합니다.

### 운영 메모

- `sync-api`는 pure Go SQLite 드라이버를 사용하므로 Docker 빌드는 `CGO_ENABLED=0` 기준입니다.
- SQLite 이미지는 별도 C toolchain 없이 정적 바이너리로 빌드됩니다.
- GitHub Actions는 `ghcr.io/doldolma/dolgate-sync-api`를 `linux/amd64`, `linux/arm64` multi-arch 이미지로 publish합니다.
- self-host에서는 `latest`보다 버전 태그 pinning을 권장합니다.
- MySQL DSN의 `mysql:3306`은 Docker Compose 내부 서비스명일 때만 동작합니다.
- `auth.jwtSecret`과 `auth.offlineLeaseSigningPrivateKeyPem`은 더 이상 지원하지 않습니다.
- 새 버전은 access token, browser login state, offline lease를 모두 같은 RS256 signing keypair로 서명합니다.
- OIDC도 env-only로 설정 가능합니다. 필요하면 `OIDC_ENABLED`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL`, `OIDC_SCOPES`를 compose에 넣으세요.
- 운영 배포는 HTTPS reverse proxy 뒤에 두는 것을 전제로 합니다.
- `server.trustedProxies`를 비워 두면 `X-Forwarded-For`를 신뢰하지 않습니다. reverse proxy를 쓴다면 실제 프록시 주소만 명시하세요.
- 로컬 회원가입은 1차 보안 정책상 계속 열려 있지만, `/login`, `/signup`, `/auth/refresh`, `/auth/exchange`에는 메모리 기반 rate limit가 적용됩니다.
- 브라우저 로그인 페이지와 session share viewer는 CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`를 기본으로 보냅니다.
- reverse proxy 예시는 `services/sync-api/deploy/nginx.sync-api.example.conf`를 참고하세요.

## 수동 검증 체크리스트

- 외부 브라우저 로그인과 세션 교환이 정상 동작하는지
- 네트워크 차단 상태에서 offline-authenticated 진입과 재동기화 복귀가 동작하는지
- Session Share 생성, viewer 접속, viewer 채팅, owner `채팅 기록` 창이 정상 동작하는지
- AWS import에서 리전 선택 규칙과 `SSH 정보 확인`이 올바르게 동작하는지
- AWS SFTP progress, host key 확인, 재입력 fallback이 정상 동작하는지
- Warpgate import의 로그인, 중단, 재시도가 정상 동작하는지
