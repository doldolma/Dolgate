# dolssh

dolssh는 Electron, React, xterm.js, Go, Gin, GORM으로 구성한 크로스 플랫폼 SSH 클라이언트 MVP 스캐폴드입니다. 데스크톱 UX, SSH 런타임, 동기화 API가 서로 독립적으로 진화할 수 있도록 모노레포 구조를 잡았습니다.

## 모노레포 구조

```text
apps/desktop      Electron + React 기반 데스크톱 앱
services/ssh-core stdio framed binary 기반 Go SSH 코어 프로세스
services/sync-api Go + Gin + GORM 기반 인증/암호화 동기화 API
docs/             아키텍처 및 IPC 문서
```

- `apps/desktop/src/shared` 안에 desktop 내부 공용 TypeScript 타입과 IPC 계약을 함께 둡니다.

## `ssh-core` 실행 방식

- Electron이 시작되면 `main` 프로세스가 `ssh-core`를 child process로 자동 실행합니다.
- renderer가 직접 Go 프로세스를 띄우는 구조는 아닙니다.
- 로컬 개발(`npm run dev`)에서는 `go run ./cmd/ssh-core`를 사용합니다.
- 패키지된 릴리즈 빌드에서는 `process.resourcesPath/bin` 아래에 번들된 `ssh-core` 바이너리를 실행합니다.

관련 문서:

- [아키텍처 문서](./docs/architecture.md)
- [빌드 및 배포 가이드](./docs/build-and-deploy.md)

## 현재 동작하는 범위

- xterm.js 기반 멀티 탭 터미널 UI
- Termius 스타일의 고정 `SFTP` 탭과 듀얼 패널 파일 브라우저
- 파일 기반 로컬 호스트/그룹/설정 저장소
- 비밀번호 인증과 개인키 인증 흐름
- Electron main과 Go 코어 사이의 stdio IPC 브리지
- Go SSH 세션 매니저의 `connect`, `write`, `resize`, `disconnect`
- Go SFTP endpoint 매니저의 `connect`, `list`, `mkdir`, `rename`, `delete`
- Local/Remote, Remote/Remote 파일 전송과 진행률 이벤트
- GitHub Releases 기반 수동 릴리즈 + 앱 내 자동 업데이트 확인/다운로드/재시작 적용
- 브라우저 로그인 기반 `login`, `signup`, `refresh`, `exchange`, `logout`, `sync` 엔드포인트
- GORM 기반 저장소 계층과 `sqlite/mysql` 드라이버 전환 구조

## MVP 보안 기본값

- renderer는 Node API에 직접 접근하지 않습니다.
- 호스트 비밀값과 refresh token은 Electron `safeStorage`로 보호된 로컬 encrypted store에 캐시되며, 서버에는 암호화된 `encrypted_payload`만 저장합니다.
- refresh token은 원문이 아니라 해시만 저장합니다.
- refresh token은 미사용 14일 만료(sliding idle expiration) 정책을 사용합니다.
- 운영 환경에서는 반드시 HTTPS 뒤에서 sync API를 구동해야 하며, 로컬 개발에서만 `http://localhost`를 허용합니다.

## 요구 사항

- Node.js 24+
- npm 11+
- Go 1.25+

## 설치

```bash
npm install
(cd services/ssh-core && go mod tidy)
(cd services/sync-api && go mod tidy)
```

참고:

- desktop은 monorepo hoisting을 쓰므로, 패키징 전 `sync:runtime-deps` 단계로 런타임 의존성을 `apps/desktop/node_modules`에 다시 맞춥니다.
- 이 단계는 현재 Forge 패키징 안정성을 위해 유지합니다.

## 실행

데스크톱 앱만 실행:

```bash
npm run dev:desktop
```

백엔드 API만 실행:

```bash
npm run dev:api
```

브라우저 로그인 + 동기화까지 포함한 전체 흐름:

```bash
npm run dev
```

동작 방식:

- 데스크톱 앱은 시작 시 refresh token으로 세션 복구를 먼저 시도합니다.
- 복구에 실패하면 앱 전체가 로그인 게이트로 전환되고, 브라우저에서 `https://ssh.doldolma.com/login` 로그인 후 로컬 콜백으로 세션을 교환해야 사용할 수 있습니다.
- 로그인 성공 후 `groups`, `hosts`, `secrets`, `known_hosts`, `port_forwards`가 동기화되고 나서야 홈/세션 UI가 열립니다.
- 어느 기기에서든 로그인만 하면 비밀번호, passphrase, 관리형 private key PEM까지 함께 복원되는 것을 기본 목표로 둡니다.

## 설정파일

데스크톱 앱 설정:

- Git에 올라가는 예시 파일:
  - [apps/desktop/config/development.example.json](/Users/heodoyeong/develop/dolsh/apps/desktop/config/development.example.json)
  - [apps/desktop/config/desktop.example.json](/Users/heodoyeong/develop/dolsh/apps/desktop/config/desktop.example.json)
- 실제 파일:
  - `apps/desktop/config/development.json`
  - `apps/desktop/config/desktop.json`
- 사용자 override: `~/Library/Application Support/dolssh/desktop-config.json` (macOS 기준)

현재 desktop 설정에서 가장 중요한 값은 `sync.serverUrl`입니다.

sync API 설정:

- Git에 올라가는 예시 파일: [services/sync-api/config/default.example.json](/Users/heodoyeong/develop/dolsh/services/sync-api/config/default.example.json)
- 운영 Docker 예시 파일: [services/sync-api/config/production.example.json](/Users/heodoyeong/develop/dolsh/services/sync-api/config/production.example.json)
- 운영 MySQL 예시 파일: [services/sync-api/config/production.mysql.example.json](/Users/heodoyeong/develop/dolsh/services/sync-api/config/production.mysql.example.json)
- 실제 파일: `services/sync-api/config/default.json`
- 필요하면 `DOLSSH_API_CONFIG_PATH=/absolute/path/to/config.json`으로 다른 파일을 지정할 수 있습니다.

정책:

- Git에는 `*.example.json`만 올립니다.
- 실제 secret이나 운영 URL이 들어가는 `*.json` 파일은 `.gitignore`로 제외합니다.
- 실제 파일이 없으면 앱과 서버가 자동으로 `*.example.json`을 fallback으로 읽습니다.

자세한 빌드/배포 절차는 [빌드 및 배포 가이드](./docs/build-and-deploy.md)를 참고하세요.

## sync API Docker 배포

`sync-api`는 Docker로 독립 배포할 수 있습니다.

SQLite 기준 준비:

```bash
cp services/sync-api/config/production.example.json services/sync-api/config/production.json
mkdir -p services/sync-api/data
```

실행:

```bash
cd services/sync-api/deploy
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

MySQL 기준 준비:

```bash
cp services/sync-api/config/production.mysql.example.json services/sync-api/config/production.json
mkdir -p services/sync-api/data/mysql
cd services/sync-api/deploy
cp docker-compose.mysql.example.yml docker-compose.yml
docker compose up -d --build
```

참고:

- Docker 이미지는 [services/sync-api/Dockerfile](/Users/heodoyeong/develop/dolsh/services/sync-api/Dockerfile)을 사용합니다.
- 운영 config는 `services/sync-api/config/production.json`을 `/app/config/production.json`으로 마운트합니다.
- SQLite 파일은 `services/sync-api/data/`에 유지됩니다.
- `database.url`의 `mysql:3306`은 Docker Compose 내부 서비스명일 때만 동작합니다. Docker 밖에서 실행하면 `127.0.0.1:3306`이나 실제 DB 호스트명을 써야 합니다.
- `ssh.doldolma.com`을 이 컨테이너로 연결하려면 reverse proxy가 필요합니다. 예시는 [nginx.sync-api.example.conf](/Users/heodoyeong/develop/dolsh/services/sync-api/deploy/nginx.sync-api.example.conf)를 참고하세요.

## 릴리즈 빌드와 GitHub Release 업로드

로컬 아티팩트만 생성:

```bash
npm run release:dist:mac
npm run release:dist:win
```

GitHub Release 업로드까지 수행:

```bash
npm run release:mac
npm run release:win
npm run release:all
```

업로드 명령은 다음 순서로 동작합니다.

1. GitHub Device Flow로 브라우저 로그인을 시작
2. `ssh-core`를 타깃 플랫폼용 바이너리로 빌드
3. Electron Forge로 prepackaged 앱 생성
4. electron-builder로 배포용 아티팩트와 업데이트 메타데이터 생성
5. GitHub Release `doldolma/dolssh`를 현재 버전 기준으로 생성/갱신
6. 기존 동명 asset을 교체하면서 새 아티팩트를 업로드

참고:

- 업로드용 GitHub access token은 브라우저 로그인 과정에서 이번 실행 동안만 메모리에 보관합니다.
- 대신 GitHub OAuth App의 `client_id`를 한 번 설정해야 합니다.
  - 기본 위치: [apps/desktop/scripts/github-oauth-config.cjs](/Users/heodoyeong/develop/dolsh/apps/desktop/scripts/github-oauth-config.cjs)
  - GitHub OAuth App 설정에서 `Device Flow`를 활성화해야 합니다.
- macOS 자동 업데이트는 `zip` 아티팩트와 업데이트 메타데이터를 사용합니다.
- Windows 자동 업데이트는 `nsis` 아티팩트와 `latest.yml`을 사용합니다.
- Windows 설치 프로그램은 `current user` 전용 `one-click` NSIS 설치로 배포됩니다.
- `npm run release:all`은 실제 GitHub Release 업로드를 수행합니다.
- `release:dist:*`는 브라우저 로그인 없이 로컬 아티팩트만 생성합니다.
- 데스크톱 저장소는 네이티브 모듈 없는 파일 기반 구조라서 이전보다 크로스플랫폼 빌드 안정성이 높습니다.

## 백엔드 환경 변수

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

## 테스트 및 검증

```bash
npm test
```

추가 검증:

```bash
npm run typecheck --workspace @dolssh/desktop
(cd services/ssh-core && go test ./...)
(cd services/sync-api && go test ./...)
```

## 개발 메모

- 데스크톱 앱은 로그인 전에는 Hosts/SFTP/SSH 화면으로 진입하지 않습니다.
- 백엔드 `/login` 페이지가 local 폼과 OIDC SSO 버튼을 직접 렌더링하고, 데스크톱은 이를 외부 브라우저로 엽니다.
- local/OIDC 하이브리드 모드에서는 local 로그인 폼이 기본이고, OIDC가 켜져 있으면 SSO 버튼이 아래에 추가됩니다.
- secrets sync에는 비밀번호, private key passphrase, 관리형 private key PEM이 포함됩니다.
- 기존 경로 기반 private key는 레거시 import 경로로만 유지하고, 새 sync 기준은 관리형 PEM입니다.
- SSH와 SFTP 연결은 known_hosts 기반 TOFU 검증을 사용하며, 신뢰되지 않은 서버는 연결 전에 지문 확인 모달을 표시합니다.
- SFTP는 고정 탭으로 동작하며, 기본 레이아웃은 `왼쪽 Local / 오른쪽 Host 선택`입니다.
- SFTP 연결은 SSH 터미널 세션과 별개로 열리며, 앱 `Quit` 시 함께 종료됩니다.
- macOS에서 패키징된 앱 산출물은 `apps/desktop/out/` 아래에 생성됩니다.
- sync API는 지금 SQLite를 기본으로 쓰지만, `DB_DRIVER=mysql`과 MySQL DSN으로 바꾸면 같은 store 계층을 그대로 재사용할 수 있습니다.
- 자동 업데이트는 공개 GitHub Releases `doldolma/dolssh`를 기준으로 동작하며, 릴리즈 빌드에서만 활성화됩니다.
