# dolssh 빌드 및 배포 가이드

## 한눈에 보기

- 데스크톱 앱은 Electron이 뜰 때 `ssh-core`를 함께 실행합니다.
- `ssh-core`는 Electron `main` 프로세스가 child process로 자동 실행합니다.
- sync API는 데스크톱과 별개로 독립 배포합니다.
- 로컬 개발에서는 `go run ./cmd/ssh-core`, 릴리즈 빌드에서는 번들된 `ssh-core` 바이너리를 사용합니다.
- 자동 업데이트는 공개 GitHub Releases를 기준으로 동작하고, 릴리즈는 브라우저 로그인 후 자동 업로드까지 지원합니다.

## ssh-core는 언제 실행되나

현재 구현에서는 Electron 앱 준비가 끝난 뒤 창을 만들 때 `ssh-core`를 바로 띄웁니다.

흐름은 다음과 같습니다.

1. Electron `app.whenReady()`
2. `createWindow()`
3. `coreManager.start()`
4. `main` 프로세스가 Go `ssh-core` child process 실행
5. renderer는 preload를 통해 이미 떠 있는 `ssh-core`와만 통신

관련 코드:

- [`apps/desktop/src/main/main.ts`](../apps/desktop/src/main/main.ts)
- [`apps/desktop/src/main/core-manager.ts`](../apps/desktop/src/main/core-manager.ts)

즉, 사용자가 별도로 `ssh-core`를 켤 필요는 없습니다.

## 개발 모드와 릴리즈 모드 차이

개발 모드:

- `npm run dev`
- `CoreManager`가 `go run ./cmd/ssh-core`를 실행
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

- Electron main/preload/renderer 번들을 빌드
- `sync:runtime-deps`로 hoisted 런타임 의존성을 `apps/desktop/node_modules` 아래에 다시 맞춤
- Electron Forge로 앱 패키징
- 로컬 머신 기준으로 실행 가능한 앱 번들 생성

`sync:runtime-deps`를 남겨둔 이유:

- 현재 desktop은 monorepo hoisting을 쓰고 있고,
- Forge 패키징은 `apps/desktop/node_modules`를 기준으로 파일을 모으기 때문에,
- 이 단계가 없으면 런타임 의존성이 패키지 앱에 누락될 수 있습니다.

아직 하지 않는 일:

- 플랫폼별 installer 생성
- 코드 서명
- notarization

즉, 현재 `npm run build --workspace @dolssh/desktop`은 개발용 패키지 검증에 가깝고, 실제 배포는 아래 릴리즈 명령을 사용합니다.

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

### 두 플랫폼을 순서대로 시도

```bash
npm run release:dist:mac
npm run release:dist:win
```

참고:

- 데스크톱 로컬 저장소는 파일 기반이라 네이티브 DB/키체인 모듈 의존성이 없습니다.
- 그래도 Windows 아티팩트는 실제 Windows 머신 또는 CI runner에서 한 번 검증하는 것을 권장합니다.

## GitHub Releases 업로드

브라우저 로그인 기반 publish를 쓰려면 GitHub OAuth App을 한 번 설정해야 합니다.

1. GitHub에서 OAuth App을 등록합니다.
2. OAuth App 설정에서 `Device Flow`를 활성화합니다.
3. [apps/desktop/scripts/github-oauth-config.cjs](/Users/heodoyeong/develop/dolsh/apps/desktop/scripts/github-oauth-config.cjs)의 `DEFAULT_GITHUB_OAUTH_CLIENT_ID` 값을 실제 client ID로 바꿉니다.

참고:

- access token은 이번 실행 동안만 메모리에 유지되고, 로컬 파일이나 encrypted store에 저장하지 않습니다.
- 필요하면 로컬 개발용으로만 `DOLSSH_GITHUB_OAUTH_CLIENT_ID` 환경변수 override를 사용할 수 있지만, 기본 흐름은 브라우저 로그인만 사용하는 방식입니다.

### 자동 업로드

macOS만 업로드:

```bash
npm run release:mac
```

Windows만 업로드:

```bash
npm run release:win
```

두 플랫폼 모두 업로드:

```bash
npm run release:all
```

자동 업로드 명령은 다음을 수행합니다.

1. GitHub Device Flow로 브라우저 로그인을 시작합니다.
2. 사용자가 브라우저에서 `https://github.com/login/device`에 코드 입력 후 승인을 완료합니다.
3. `ssh-core`와 앱 아티팩트를 빌드합니다.
4. `doldolma/dolssh` GitHub Release를 현재 버전 기준으로 생성하거나 갱신합니다.
5. 기존과 같은 이름의 asset은 교체하고, 새 아티팩트와 업데이트 메타데이터를 업로드합니다.

`npm run release:all`은 로그인 1회 후 `mac -> win` 순서로 이어서 수행합니다.

### 수동 업로드를 유지하고 싶을 때

1. `apps/desktop/package.json`의 버전을 올립니다.
2. `npm run release:dist:mac`, `npm run release:dist:win`으로 아티팩트를 생성합니다.
3. GitHub에서 `vX.Y.Z` 태그 기준 Release를 직접 만듭니다.
4. 아래 파일을 릴리즈에 수동 업로드합니다.
   - macOS: `.dmg`, `.zip`, `latest-mac.yml`
   - Windows: `.exe`, `latest.yml`
5. 설치된 앱에서 우측 상단 벨 아이콘으로 업데이트 확인/다운로드/재시작 적용을 검증합니다.

## ssh-core 단독 빌드

개발/배포 파이프라인에서 별도로 확인하고 싶다면 다음처럼 빌드할 수 있습니다.

```bash
cd services/ssh-core
mkdir -p dist
go build -o dist/ssh-core ./cmd/ssh-core
```

플랫폼별 크로스 빌드 예시:

```bash
cd services/ssh-core
mkdir -p dist
GOOS=darwin GOARCH=arm64 go build -o dist/ssh-core-darwin-arm64 ./cmd/ssh-core
GOOS=linux GOARCH=amd64 go build -o dist/ssh-core-linux-amd64 ./cmd/ssh-core
GOOS=windows GOARCH=amd64 go build -o dist/ssh-core-windows-amd64.exe ./cmd/ssh-core
```

## sync API 빌드

```bash
cd services/sync-api
mkdir -p dist
go build -o dist/sync-api ./cmd/api
```

## sync API Docker 배포

### 포함된 파일

- Docker 이미지 정의: [services/sync-api/Dockerfile](/Users/heodoyeong/develop/dolsh/services/sync-api/Dockerfile)
- Docker ignore: [services/sync-api/.dockerignore](/Users/heodoyeong/develop/dolsh/services/sync-api/.dockerignore)
- 운영 설정 예시: [services/sync-api/config/production.example.json](/Users/heodoyeong/develop/dolsh/services/sync-api/config/production.example.json)
- 운영 MySQL 설정 예시: [services/sync-api/config/production.mysql.example.json](/Users/heodoyeong/develop/dolsh/services/sync-api/config/production.mysql.example.json)
- Compose 예시: [services/sync-api/deploy/docker-compose.example.yml](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/docker-compose.example.yml)
- MySQL 포함 Compose 예시: [services/sync-api/deploy/docker-compose.mysql.example.yml](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/docker-compose.mysql.example.yml)
- Nginx reverse proxy 예시: [services/sync-api/deploy/nginx.sync-api.example.conf](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/nginx.sync-api.example.conf)

### 빠른 시작

1. 운영 설정 파일 생성

SQLite 기준:

```bash
cp services/sync-api/config/production.example.json services/sync-api/config/production.json
mkdir -p services/sync-api/data
```

MySQL 기준:

```bash
cp services/sync-api/config/production.mysql.example.json services/sync-api/config/production.json
mkdir -p services/sync-api/data/mysql
```

2. `production.json` 수정

- `auth.jwtSecret`를 운영용 값으로 변경
- OIDC를 쓸 경우 `auth.oidc.*` 채우기
- MySQL을 쓸 경우 `database.driver=mysql`, `database.url=...`로 변경

3. Compose 파일 준비 후 실행

SQLite 기준:

```bash
cd services/sync-api/deploy
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

MySQL 기준:

```bash
cd services/sync-api/deploy
cp docker-compose.mysql.example.yml docker-compose.yml
docker compose up -d --build
```

4. 상태 확인

```bash
docker compose ps
curl http://127.0.0.1:8080/healthz
```

### 운영 메모

- 기본 compose 예시는 컨테이너 내부 `/app/config/production.json`을 읽도록 `DOLSSH_API_CONFIG_PATH`를 지정합니다.
- SQLite를 계속 쓰면 DB 파일은 `services/sync-api/data/dolssh_sync.db`에 유지됩니다.
- `database.url`의 `mysql:3306`은 Compose 내부 서비스명입니다. Docker 밖에서 `go run`이나 단독 바이너리로 실행하면 `127.0.0.1:3306` 또는 실제 DB 호스트명을 사용해야 합니다.
- `lookup mysql on 127.0.0.11:53: no such host`가 뜨면, 현재 실행 환경에 `mysql` 서비스가 없다는 뜻입니다. 이 경우 MySQL 포함 compose를 쓰거나 DB 호스트를 실제 주소로 바꿔야 합니다.
- `https://ssh.doldolma.com`으로 실제 서비스하려면 별도 reverse proxy가 필요합니다.
- 리버스 프록시가 지금 backend 대신 Synology 기본 페이지를 반환하면 desktop 앱은 로그인/refresh/sync를 전부 실패합니다.

## sync API 실행 환경 변수

SQLite 개발 기본값:

```bash
DB_DRIVER=sqlite
PORT=8080
DATABASE_URL=file:dolssh_sync.db?_pragma=busy_timeout(5000)
JWT_SECRET=change-me-in-production
LOCAL_AUTH_ENABLED=true
LOCAL_SIGNUP_ENABLED=true
OIDC_ENABLED=false
```

MySQL 전환 예시:

```bash
DB_DRIVER=mysql
PORT=8080
DATABASE_URL=user:password@tcp(127.0.0.1:3306)/dolssh?charset=utf8mb4&parseTime=True&loc=UTC
JWT_SECRET=change-me-in-production
LOCAL_AUTH_ENABLED=true
LOCAL_SIGNUP_ENABLED=true
OIDC_ENABLED=true
OIDC_DISPLAY_NAME=SSO
OIDC_ISSUER_URL=https://issuer.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URL=https://ssh.doldolma.com/auth/oidc/callback
```

실행:

```bash
cd services/sync-api
DB_DRIVER=sqlite \
DATABASE_URL=file:dolssh_sync.db?_pragma=busy_timeout(5000) \
JWT_SECRET=change-me-in-production \
go run ./cmd/api
```

또는 빌드한 바이너리 실행:

```bash
cd services/sync-api
DB_DRIVER=sqlite \
DATABASE_URL=file:dolssh_sync.db?_pragma=busy_timeout(5000) \
JWT_SECRET=change-me-in-production \
./dist/sync-api
```

참고:

- 저장소 초기화는 앱 시작 시 GORM `AutoMigrate`로 처리됩니다.
- 운영에서는 SQLite보다 MySQL을 권장합니다.
- 운영에서는 반드시 HTTPS 뒤에 두고, JWT secret은 강한 값으로 교체해야 합니다.
- refresh token은 absolute max 없이 미사용 14일 만료 정책을 사용합니다.
- desktop은 `https://ssh.doldolma.com/login` 브라우저 페이지를 열고 `dolssh://auth/callback` 딥링크로 복귀합니다.
- hybrid 모드에서는 local 로그인 폼이 기본이고, OIDC가 켜져 있으면 SSO 버튼이 같은 페이지 하단에 추가됩니다.
- Git에는 `services/sync-api/config/default.example.json`만 올리고, 실제 운영 값은 `services/sync-api/config/default.json` 또는 `DOLSSH_API_CONFIG_PATH`로 주입하는 것을 권장합니다.

## 설정파일 정책

- desktop:
  - 예시 파일: `apps/desktop/config/development.example.json`, `apps/desktop/config/desktop.example.json`
  - 실제 파일: `apps/desktop/config/development.json`, `apps/desktop/config/desktop.json`
- sync API:
  - 예시 파일: `services/sync-api/config/default.example.json`
  - 실제 파일: `services/sync-api/config/default.json`
- 실제 파일이 없으면 코드가 자동으로 `*.example.json`을 fallback으로 읽습니다.
- 실제 secret이나 운영값이 들어간 `*.json` 파일은 Git에 올리지 않고 `.gitignore`로 제외합니다.

## 데스크톱 자동 업데이트 전략

- 업데이트 소스는 공개 GitHub Releases `doldolma/dolssh`
- 앱은 시작 후 지연 체크와 수동 체크를 모두 지원
- 자동 다운로드/자동 설치는 하지 않음
- 사용자가 벨 아이콘 팝오버에서 `다운로드`를 눌러야 내려받기 시작
- 다운로드 완료 후 `재시작 후 업데이트`를 눌러야 적용
- 활성 SSH 세션, 진행 중인 전송, 포트 포워딩이 있으면 재시작 전 확인 모달을 띄움

## 권장 배포 시나리오

### 데스크톱 앱

현재 기준 권장 순서:

1. macOS universal 릴리즈 빌드
2. `npm run release:mac`으로 GitHub Release 업로드
3. 설치 앱에서 auto update 검증
4. 동일 구조로 Windows x64 릴리즈 검증
5. Apple notarization과 Windows code signing 자격을 실제 배포 환경에 맞게 정착

### sync API

권장 운영 흐름:

1. MySQL 준비
2. `services/sync-api` 바이너리 빌드
3. 환경 변수 주입
4. systemd, Docker, 혹은 프로세스 매니저로 실행
5. Nginx/ALB/Cloudflare Tunnel 등 HTTPS reverse proxy 뒤에 배치

## 릴리스 체크리스트

- `npm test` 통과
- `npm run typecheck --workspace @dolssh/desktop` 통과
- `services/ssh-core` 테스트/빌드 통과
- `services/sync-api` 테스트/빌드 통과
- `JWT_SECRET` 운영값 적용
- sync API를 HTTPS 뒤에 배치
- 데스크톱 앱에 번들된 `ssh-core`가 타깃 플랫폼에서 실제 실행되는지 확인
- GitHub Release 태그와 앱 버전이 일치하는지 확인
- 설치 앱의 벨 아이콘에서 업데이트 감지/다운로드/재시작 적용을 검증
