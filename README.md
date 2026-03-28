# Dolgate

Dolgate는 macOS와 Windows를 위한 크로스 플랫폼 SSH 클라이언트입니다.
멀티 세션 터미널, SFTP 파일 브라우저, 포트 포워딩, 세션 공유, 브라우저 로그인 기반 동기화를 하나의 데스크톱 앱으로 제공합니다.

## 핵심 기능

- 다중 SSH 세션과 분할 Workspace
- 듀얼 패널 SFTP 브라우저와 파일 전송
- Local / Remote / Dynamic 포트 포워딩
- Known Hosts 검증과 관리
- Session Share, 브라우저 viewer, 실시간 채팅
- AWS EC2 import와 Linux 전용 AWS SFTP
- Warpgate 브라우저 로그인 기반 import
- 브라우저 로그인과 서버 동기화

## 빠른 시작

### 요구 사항

- Node.js 24+
- npm 11+
- Go 1.25+

### 설치

```bash
npm install
(cd services/ssh-core && go mod tidy)
(cd services/sync-api && go mod tidy)
```

### 실행

데스크톱 앱만 실행:

```bash
npm run dev:desktop
```

로그인 + 동기화까지 포함한 전체 흐름:

```bash
npm run dev
```

## 문서

- [기능 흐름](./docs/feature-flows.md)
- [아키텍처](./docs/architecture.md)
- [빌드 및 배포](./docs/build-and-deploy.md)
- [ssh-core IPC 프로토콜](./docs/ipc-protocol.md)

## 릴리즈

- GitHub Releases: `doldolma/dolgate`
- 로컬 아티팩트 빌드:

```bash
npm run release:dist:mac
npm run release:dist:win
```

## 보안 기본값

- renderer는 Node 권한에 직접 접근하지 않습니다.
- secret과 refresh token은 로컬 encrypted store에 캐시됩니다.
- 서버에는 plaintext secret 대신 암호화된 payload만 저장합니다.
- 운영 환경에서는 `sync-api`를 반드시 HTTPS 뒤에서 구동해야 합니다.
