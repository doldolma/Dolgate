# dolssh

dolssh는 Electron, React, xterm.js, Go, Gin, GORM으로 구성한 크로스 플랫폼 SSH 클라이언트 MVP 스캐폴드입니다. 데스크톱 UX, SSH 런타임, 동기화 API가 서로 독립적으로 진화할 수 있도록 모노레포 구조를 잡았습니다.

## 모노레포 구조

```text
apps/desktop      Electron + React 기반 데스크톱 앱
packages/shared   공용 TypeScript 타입/계약
services/ssh-core stdio framed binary 기반 Go SSH 코어 프로세스
services/sync-api Go + Gin + GORM 기반 인증/암호화 동기화 API
docs/             아키텍처 및 IPC 문서
```

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
- SQLite 기반 로컬 호스트 CRUD
- 비밀번호 인증과 개인키 인증 흐름
- Electron main과 Go 코어 사이의 stdio IPC 브리지
- Go SSH 세션 매니저의 `connect`, `write`, `resize`, `disconnect`
- Go SFTP endpoint 매니저의 `connect`, `list`, `mkdir`, `rename`, `delete`
- Local/Remote, Remote/Remote 파일 전송과 진행률 이벤트
- GitHub Releases 기반 수동 릴리즈 + 앱 내 자동 업데이트 확인/다운로드/재시작 적용
- Gin API의 `signup`, `login`, `refresh`, `sync` 엔드포인트
- GORM 기반 저장소 계층과 `sqlite/mysql` 드라이버 전환 구조

## MVP 보안 기본값

- renderer는 Node API에 직접 접근하지 않습니다.
- 호스트 비밀값은 `keytar`를 통해 OS 키체인에 저장하는 것을 기본 전제로 둡니다.
- 동기화 서버는 `encrypted_payload`만 저장합니다.
- refresh token은 원문이 아니라 해시만 저장합니다.
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

## 실행

데스크톱 앱만 실행:

```bash
npm run dev:desktop
```

참고:

- 데스크톱 앱은 실행 전에 `better-sqlite3`, `keytar`를 Electron ABI 기준으로 자동 재빌드합니다.
- Electron 버전이나 Node 버전을 바꾼 뒤 네이티브 모듈 오류가 다시 나면 `npm run rebuild:native --workspace @dolssh/desktop`로 수동 재빌드할 수 있습니다.

백엔드 API만 실행:

```bash
npm run dev:api
```

데스크톱과 백엔드를 함께 실행:

```bash
npm run dev
```

자세한 빌드/배포 절차는 [빌드 및 배포 가이드](./docs/build-and-deploy.md)를 참고하세요.

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
- `npm run release:all`은 실제 GitHub Release 업로드를 수행합니다.
- `release:dist:*`는 브라우저 로그인 없이 로컬 아티팩트만 생성합니다.
- `better-sqlite3`, `keytar` 같은 네이티브 모듈 때문에 macOS에서 Windows 크로스빌드는 환경에 따라 실패할 수 있습니다. 그 경우 Windows 전용 빌드 머신이나 VM을 fallback으로 사용하세요.

## 백엔드 환경 변수

```bash
DB_DRIVER=sqlite
PORT=8080
DATABASE_URL=file:dolssh_sync.db?_pragma=busy_timeout(5000)
JWT_SECRET=change-me-in-production
```

MySQL 전환 예시:

```bash
DB_DRIVER=mysql
DATABASE_URL=user:password@tcp(127.0.0.1:3306)/dolssh?charset=utf8mb4&parseTime=True&loc=UTC
JWT_SECRET=change-me-in-production
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

- 데스크톱 동기화 UI는 아직 연결하지 않았고, 먼저 서버와 타입 계약을 준비한 상태입니다.
- SSH와 SFTP 연결은 known_hosts 기반 TOFU 검증을 사용하며, 신뢰되지 않은 서버는 연결 전에 지문 확인 모달을 표시합니다.
- SFTP는 고정 탭으로 동작하며, 기본 레이아웃은 `왼쪽 Local / 오른쪽 Host 선택`입니다.
- SFTP 연결은 SSH 터미널 세션과 별개로 열리며, 앱 `Quit` 시 함께 종료됩니다.
- macOS에서 패키징된 앱 산출물은 `apps/desktop/out/` 아래에 생성됩니다.
- sync API는 지금 SQLite를 기본으로 쓰지만, `DB_DRIVER=mysql`과 MySQL DSN으로 바꾸면 같은 store 계층을 그대로 재사용할 수 있습니다.
- 자동 업데이트는 공개 GitHub Releases `doldolma/dolssh`를 기준으로 동작하며, 릴리즈 빌드에서만 활성화됩니다.
