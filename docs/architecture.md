# dolssh 아키텍처

dolssh는 세 개의 런타임 경계로 나뉩니다.

1. UX, 로컬 저장소, OS 연동을 담당하는 Electron 데스크톱 앱
2. SSH 세션 생명주기와 터미널 스트림을 담당하는 Go SSH 코어 프로세스
3. 인증과 암호화된 메타데이터 동기화를 담당하는 Go + Gin + GORM sync API

## 데스크톱 앱

- `main`: 브라우저 윈도우, 로컬 파일 저장소, encrypted secret store, 브라우저 로그인, 서버 동기화, Go 코어 프로세스 수명주기, GitHub Releases 기반 auto update를 관리합니다.
- `preload`: `contextBridge`를 통해 renderer에 필요한 최소 API만 노출합니다.
- `renderer`: Zustand 상태와 xterm.js 기반 탭 UI, 로그인 게이트, 호스트 목록, 검색 인터페이스, 고정 `SFTP` 워크스페이스를 담당합니다.
- 앱 시작 시 먼저 refresh token으로 로그인 복구를 시도하고, 성공 후에만 실제 workspace를 마운트합니다.
- 새 로그인은 데스크톱이 backend `/login` 페이지를 외부 브라우저로 열고, 성공 시 로컬 loopback 콜백으로 세션을 교환합니다.
- 앱 시작 시 Electron `main`이 `ssh-core`를 즉시 띄우는 대신, 실제 연결 시점에 child process를 lazily 시작합니다.
- 개발 모드에서는 `go run`을, 패키지된 릴리즈 앱에서는 번들된 `ssh-core` 바이너리를 실행합니다.
- 로컬 파일 브라우징은 Electron main의 파일 서비스가 담당하고, 원격 SFTP 작업과 파일 전송은 Go 코어가 담당합니다.

## SSH 코어

- Electron `main`이 단일 child process로 실행합니다.
- Electron과는 stdio 위의 framed binary 프로토콜로 통신합니다.
- control 명령은 metadata JSON frame으로, 터미널 입출력은 raw byte stream frame으로 주고받습니다.
- SSH 터미널 세션은 `sessionId`, SFTP endpoint는 `endpointId`, 전송 작업은 `jobId`로 구분합니다.
- 터미널 세션 매니저와 별도로 SFTP endpoint 매니저를 두어 브라우징과 전송을 독립적으로 처리합니다.
- 개발 모드에서는 `go run ./cmd/ssh-core`, 패키지된 릴리즈 앱에서는 번들된 플랫폼별 바이너리를 사용합니다.
- 자동 업데이트는 `electron-updater`가 GitHub Releases를 조회하는 구조로 붙고, 사용자가 앱 우측 상단 알림 메뉴에서 다운로드와 재시작 적용을 직접 승인합니다.

## Sync API

- 서버는 `/login` 브라우저 페이지와 인증 API, 그리고 암호화된 동기화 레코드 저장소를 함께 제공합니다.
- 인증은 local login + optional OIDC SSO를 동시에 지원할 수 있습니다.
- refresh token은 해시만 저장하며, 미사용 14일 만료(sliding idle expiration)와 rotation 정책을 사용합니다.
- 동기화 레코드는 `groups`, `hosts`, `secrets`, `known_hosts`, `port_forwards` 단위의 generic `sync_records` 구조에 저장합니다.
- secrets는 비밀번호, passphrase, 관리형 private key PEM까지 포함하지만 서버에는 ciphertext만 저장합니다.
- 저장소 계층은 GORM으로 구현하고, 기본 드라이버는 SQLite지만 추후 MySQL로 교체할 수 있게 열어 둡니다.

## 보안 기본값

- renderer는 Node 권한을 직접 가지지 않습니다.
- 호스트 자격 증명과 키 passphrase는 로컬 OS 키체인에 캐시하되, 서버 복원 기준은 로그인 세션이 전달하는 vault bootstrap입니다.
- 백엔드는 HTTPS 전용 배포를 기준으로 설계했고, 평문 HTTP는 로컬 개발에만 허용합니다.
