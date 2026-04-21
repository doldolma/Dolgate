# Dolgate Desktop

Dolgate Desktop은 macOS와 Windows를 위한 Electron 기반 SSH 워크스페이스입니다.  
여러 세션을 한 화면에서 다루고, 파일 전송과 포트 포워딩, 세션 공유, AWS/컨테이너 작업까지 하나의 UI에서 처리하는 것이 현재 데스크톱 앱의 중심 역할입니다.

## 현재 기능

- 멀티 세션 터미널과 탭 기반 워크스페이스
- 듀얼 패널 SFTP 브라우저와 파일 전송
- Local / Remote / Dynamic 포트 포워딩
- 세션 녹화 및 재생
- Session Share, 브라우저 viewer, 실시간 채팅
- AWS EC2 import, AWS SFTP, SSM 포트 포워딩, ECS Exec shell, ECS 터널링
- Docker / Podman 컨테이너 모니터링, 로그, 메트릭, 셸, 터널링
- OpenSSH / Xshell / Termius import
- GitHub Releases 기반 업데이트 배포

## 로컬 실행

```bash
npm run dev:desktop
```

관련 개발 명령:

- `npm run build --workspace @dolssh/desktop`
- `npm run test:desktop`
- `npm run typecheck:desktop`

## 릴리즈 빌드

macOS universal:

```bash
npm run release:dist:mac
```

Windows x64:

```bash
npm run release:dist:win
```

GitHub Release 업로드:

```bash
npm run release:publish:mac
npm run release:publish:win
npm run release:all
```

릴리즈 태그와 저장소 공통 버전 정책은 [build-and-deploy](./build-and-deploy.md) 문서를 따릅니다.

## 런타임 메모

- 데스크톱은 `ssh-core`를 항상 상주시켜 두지 않고, 실제 SSH/SFTP/포트 포워딩 작업이 필요할 때 lazily 시작합니다.
- 데스크톱은 `cmd/ssh-core` child process와 stdio framed protocol로 통신합니다.
- `sync-api`는 로그인, 동기화, session share viewer를 담당합니다.
- macOS 빌드는 현재 Apple 공증이 포함되지 않습니다.
- 자동 업데이트는 GitHub Releases를 기준으로 동작하지만, macOS 설치 경험에는 별도 제약이 있을 수 있습니다.

## AWS 사용 전 확인

데스크톱의 AWS 관련 기능은 로컬 `aws` CLI와 `session-manager-plugin`에 의존합니다.

최소 확인:

```bash
aws --version
session-manager-plugin --version
```

추가 운영 전제와 권한 예시는 루트 [README.md](/Users/heodoyeong/develop/dolsh/README.md)와 [build-and-deploy](./build-and-deploy.md) 문서를 참고하면 됩니다.
