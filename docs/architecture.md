# KeyTerm 아키텍처

KeyTerm은 세 개의 런타임 경계로 나뉩니다.

1. UX, 로컬 저장소, OS 연동을 담당하는 Electron 데스크톱 앱
2. SSH 세션 생명주기와 터미널 스트림을 담당하는 Go SSH 코어 프로세스
3. 인증과 암호화된 메타데이터 동기화를 담당하는 Go + Gin + GORM sync API

## 데스크톱 앱

- `main`: 브라우저 윈도우, 로컬 SQLite, 키체인 접근, Go 코어 프로세스 수명주기를 관리합니다.
- `preload`: `contextBridge`를 통해 renderer에 필요한 최소 API만 노출합니다.
- `renderer`: Zustand 상태와 xterm.js 기반 탭 UI, 호스트 목록, 검색 인터페이스, 고정 `SFTP` 워크스페이스를 담당합니다.
- 앱 시작 시 Electron `main`이 `ssh-core` child process를 자동 실행합니다.
- 로컬 파일 브라우징은 Electron main의 파일 서비스가 담당하고, 원격 SFTP 작업과 파일 전송은 Go 코어가 담당합니다.

## SSH 코어

- Electron `main`이 단일 child process로 실행합니다.
- Electron과는 stdio 위의 framed binary 프로토콜로 통신합니다.
- control 명령은 metadata JSON frame으로, 터미널 입출력은 raw byte stream frame으로 주고받습니다.
- SSH 터미널 세션은 `sessionId`, SFTP endpoint는 `endpointId`, 전송 작업은 `jobId`로 구분합니다.
- 터미널 세션 매니저와 별도로 SFTP endpoint 매니저를 두어 브라우징과 전송을 독립적으로 처리합니다.
- 현재 구현은 `go run ./cmd/ssh-core` 기반이며, 일반 사용자용 데스크톱 배포를 위해서는 추후 플랫폼별 바이너리 번들링이 필요합니다.

## Sync API

- 서버는 호스트와 스니펫의 암호화된 payload만 저장합니다.
- 인증은 이메일/비밀번호 + access token + refresh token 구조를 사용합니다.
- refresh token은 해시만 저장하며, 클라이언트 비밀값은 서버에 평문으로 저장하지 않습니다.
- 저장소 계층은 GORM으로 구현하고, 기본 드라이버는 SQLite지만 추후 MySQL로 교체할 수 있게 열어 둡니다.

## 보안 기본값

- renderer는 Node 권한을 직접 가지지 않습니다.
- 호스트 자격 증명과 키 passphrase는 가능하면 OS 키체인에 둡니다.
- 백엔드는 HTTPS 전용 배포를 기준으로 설계했고, 평문 HTTP는 로컬 개발에만 허용합니다.
