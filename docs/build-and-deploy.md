# KeyTerm 빌드 및 배포 가이드

## 한눈에 보기

- 데스크톱 앱은 Electron이 뜰 때 `ssh-core`를 함께 실행합니다.
- `ssh-core`는 현재 Electron `main` 프로세스가 child process로 자동 실행합니다.
- sync API는 데스크톱과 별개로 독립 배포합니다.
- 현재 저장소는 로컬 개발과 로컬 패키징까지는 바로 가능하지만, 데스크톱 앱의 “완전한 프로덕션 배포”를 위해서는 `ssh-core` 바이너리 번들링이 한 단계 더 필요합니다.

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

## 중요한 현재 제약

지금 `ssh-core` 실행 방식은 `go run ./cmd/ssh-core`입니다.  
그래서 현재 패키징 결과물은 “개발 머신에서의 로컬 패키징”에는 적합하지만, 일반 사용자에게 바로 배포하는 완전한 self-contained 앱은 아닙니다.

현재 구조가 의미하는 바:

- 로컬 개발 환경에서는 잘 동작합니다.
- Go 툴체인과 저장소 소스가 있는 환경에서는 패키징 앱 검증도 가능합니다.
- 하지만 일반 배포용 데스크톱 앱이라면 target OS/arch용 `ssh-core` 실행 파일을 미리 빌드해 앱 리소스에 포함해야 합니다.

권장 다음 단계:

1. `services/ssh-core`를 플랫폼별로 미리 빌드
2. Electron 앱 리소스(`resources/bin` 등)에 포함
3. `CoreManager`가 `go run` 대신 번들된 바이너리를 실행하도록 변경
4. Electron Forge maker, 코드 서명, macOS notarization/Windows signing 설정 추가

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
npm run typecheck --workspace @keyterm/desktop
(cd services/ssh-core && go test ./...)
(cd services/ssh-core && go build ./...)
(cd services/sync-api && go test ./...)
(cd services/sync-api && go build ./...)
```

## 데스크톱 앱 빌드

로컬 패키징:

```bash
npm run build --workspace @keyterm/desktop
```

산출물:

- macOS 기준 `apps/desktop/out/` 아래에 패키징 결과가 생성됩니다.

현재 이 명령이 하는 일:

- Electron main/preload/renderer 번들을 빌드
- Electron Forge로 앱 패키징
- 로컬 머신 기준으로 실행 가능한 앱 번들 생성

아직 하지 않는 일:

- 플랫폼별 installer 생성
- 코드 서명
- notarization
- `ssh-core` 바이너리 번들링

즉, 현재 `npm run build --workspace @keyterm/desktop`은 “릴리스 아티팩트의 초안”에 가깝습니다.

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

## sync API 실행 환경 변수

SQLite 개발 기본값:

```bash
DB_DRIVER=sqlite
PORT=8080
DATABASE_URL=file:keyterm_sync.db?_pragma=busy_timeout(5000)
JWT_SECRET=change-me-in-production
```

MySQL 전환 예시:

```bash
DB_DRIVER=mysql
PORT=8080
DATABASE_URL=user:password@tcp(127.0.0.1:3306)/keyterm?charset=utf8mb4&parseTime=True&loc=UTC
JWT_SECRET=change-me-in-production
```

실행:

```bash
cd services/sync-api
DB_DRIVER=sqlite \
DATABASE_URL=file:keyterm_sync.db?_pragma=busy_timeout(5000) \
JWT_SECRET=change-me-in-production \
go run ./cmd/api
```

또는 빌드한 바이너리 실행:

```bash
cd services/sync-api
DB_DRIVER=sqlite \
DATABASE_URL=file:keyterm_sync.db?_pragma=busy_timeout(5000) \
JWT_SECRET=change-me-in-production \
./dist/sync-api
```

참고:

- 저장소 초기화는 앱 시작 시 GORM `AutoMigrate`로 처리됩니다.
- 운영에서는 SQLite보다 MySQL을 권장합니다.
- 운영에서는 반드시 HTTPS 뒤에 두고, JWT secret은 강한 값으로 교체해야 합니다.

## 권장 배포 시나리오

### 데스크톱 앱

현재 바로 가능한 범위:

1. 로컬에서 Electron 앱 패키징
2. 개발 머신에서 실행 검증

실제 사용자 배포 전 권장 작업:

1. `ssh-core`를 타깃 플랫폼별로 미리 빌드
2. Electron 앱에 함께 번들
3. `CoreManager`가 번들 바이너리를 실행하도록 변경
4. macOS notarization / Windows signing 설정
5. Electron Forge maker 설정으로 `.dmg`, `.zip`, `.exe`, `.AppImage` 등 릴리스 형식 추가
6. CI에서 플랫폼별 아티팩트 생성

### sync API

권장 운영 흐름:

1. MySQL 준비
2. `services/sync-api` 바이너리 빌드
3. 환경 변수 주입
4. systemd, Docker, 혹은 프로세스 매니저로 실행
5. Nginx/ALB/Cloudflare Tunnel 등 HTTPS reverse proxy 뒤에 배치

## 릴리스 체크리스트

- `npm test` 통과
- `npm run typecheck --workspace @keyterm/desktop` 통과
- `services/ssh-core` 테스트/빌드 통과
- `services/sync-api` 테스트/빌드 통과
- `JWT_SECRET` 운영값 적용
- sync API를 HTTPS 뒤에 배치
- 데스크톱 앱에 번들된 `ssh-core`가 타깃 플랫폼에서 실제 실행되는지 확인
- 호스트 키 검증을 `InsecureIgnoreHostKey()`에서 known_hosts 기반으로 교체
