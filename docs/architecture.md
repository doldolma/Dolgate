# Dolgate 아키텍처

Dolgate는 세 개의 런타임 경계로 나뉩니다.

1. UX, 로컬 저장소, OS 연동을 담당하는 Electron 데스크톱 앱
2. SSH 세션과 SFTP 런타임을 담당하는 Go `ssh-core` 프로세스
3. 인증, 동기화, session share viewer를 담당하는 Go `sync-api`

복잡한 사용자 흐름은 [feature-flows](./feature-flows.md) 문서를 함께 참고하는 편이 좋습니다.

## 데스크톱 앱

- `main`
  브라우저 윈도우, 로컬 파일 저장소, encrypted secret store, 브라우저 로그인, 서버 동기화, Go 코어 프로세스 수명주기, GitHub Releases 기반 auto update를 관리합니다.
- `preload`
  `contextBridge`를 통해 renderer에 필요한 최소 API만 노출합니다.
- `renderer`
  Zustand 상태와 xterm.js 기반 탭 UI, 로그인 게이트, 호스트 목록, 검색 인터페이스, 고정 `SFTP` 워크스페이스를 담당합니다.

주요 런타임 특징:

- 앱 시작 시 먼저 refresh token으로 로그인 복구를 시도합니다.
- 온라인 복구가 실패해도 offline lease가 유효하면 `offline-authenticated` 상태로 홈 화면을 열고, 이후 백그라운드에서 재동기화를 재시도합니다.
- 새 로그인은 backend `/login` 페이지를 외부 브라우저로 열고, 성공 시 로컬 loopback callback 또는 `dolgate://auth/callback` 식별자를 통해 세션을 교환합니다.
- `ssh-core`는 앱 시작 시 항상 떠 있지 않고, 실제 SSH/SFTP/포트 포워딩 경로가 필요할 때 lazily 시작합니다.
- 로컬 파일 브라우징은 Electron main의 파일 서비스가 담당하고, 원격 SFTP 작업과 파일 전송은 Go 코어가 담당합니다.

## SSH 코어

- Electron `main`이 단일 child process로 실행합니다.
- Electron과는 stdio 위의 framed binary 프로토콜로 통신합니다.
- control 명령은 metadata JSON frame으로, 터미널 입출력은 raw byte stream frame으로 주고받습니다.
- SSH 터미널 세션은 `sessionId`, SFTP endpoint는 `endpointId`, 전송 작업은 `jobId`로 구분합니다.
- 터미널 세션 매니저와 별도로 SFTP endpoint 매니저를 두어 브라우징과 전송을 독립적으로 처리합니다.
- 개발 모드에서는 `go run ./cmd/ssh-core`, 패키지된 앱에서는 번들된 플랫폼별 바이너리를 사용합니다.

## Sync API

- 서버는 `/login` 브라우저 페이지와 인증 API, 그리고 암호화된 동기화 레코드 저장소를 함께 제공합니다.
- 인증은 local login + optional OIDC SSO를 동시에 지원할 수 있습니다.
- refresh token은 해시만 저장하며, 미사용 14일 만료와 rotation 정책을 사용합니다.
- 동기화 레코드는 `groups`, `hosts`, `secrets`, `known_hosts`, `port_forwards`, `preferences` 단위의 generic `sync_records` 구조에 저장합니다.
- secrets는 비밀번호, passphrase, 관리형 private key PEM까지 포함하지만 서버에는 ciphertext만 저장합니다.
- session share는 별도의 in-memory hub와 viewer asset으로 제공되며, 브라우저 viewer는 WebSocket으로 owner 세션을 구독합니다.
- 저장소 계층은 GORM으로 구현하고, SQLite와 MySQL을 모두 지원합니다.

## Session Share 서브시스템

- desktop `SessionShareService`가 owner 측 세션 공유 생명주기를 관리합니다.
- `sync-api`는 session share 생성, owner/viewer WebSocket, viewer 정적 자산을 함께 제공합니다.
- 브라우저 viewer는 터미널 스트림, 스냅샷, viewer 채팅, viewer count를 같은 공유 세션 범위 안에서 처리합니다.
- owner는 데스크톱에서 우하단 토스트 알림을 받고, 필요하면 별도 `채팅 기록` 창으로 누적 메시지를 확인합니다.
- 세션 종료 시 viewer 연결, 채팅 기록, owner 알림을 함께 정리합니다.

## AWS Import / AWS SFTP

- AWS import는 프로필 인증 확인, 리전 조회, EC2 목록 조회, `SSH 정보 확인` 단계를 통해 Host를 생성합니다.
- 프로필 기본 리전이 있으면 자동 선택하고, 없으면 사용자가 리전을 고를 때까지 인스턴스 조회를 미룹니다.
- Linux 인스턴스는 SSM 기반 inspection으로 SSH username/port 추천값을 불러오고, 사용자가 수정한 뒤 최종 등록할 수 있습니다.
- AWS SFTP는 숨겨진 SSM loopback tunnel과 EC2 Instance Connect 공개 키 주입을 이용해 기존 SSH/SFTP 파이프라인을 재사용합니다.
- 연결 과정에서는 preflight 결과를 endpoint 단위로 잠시 캐시해, host key 확인 뒤 실제 connect에서 같은 인증/메타데이터 확인을 반복하지 않습니다.

## Warpgate Import

- Warpgate import는 내부 브라우저 인증 창으로 로그인을 진행합니다.
- 로그인 완료 후 target 목록을 받아 renderer에서 HostDraft로 변환합니다.
- 인증 창은 import 다이얼로그와 분리되어 있으며, 대기 중에 중단하고 다시 시도할 수 있습니다.

## 보안 기본값

- renderer는 Node 권한을 직접 가지지 않습니다.
- 호스트 자격 증명과 key passphrase는 Electron `safeStorage` 기반 encrypted local store에 캐시합니다.
- 서버 복원 기준은 로그인 세션이 전달하는 vault bootstrap입니다.
- backend는 HTTPS 전용 배포를 기준으로 설계했고, 평문 HTTP는 로컬 개발에만 허용합니다.
