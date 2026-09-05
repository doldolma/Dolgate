# Dolgate

[English](./README.md) | **한국어**

Dolgate는 별도 도구 설치 없이 사설 인프라에 접속합니다. **Tailscale을 설치하지 않고 tailnet에 참여**하고, **AWS CLI나 session-manager-plugin 없이 EC2에 SSM으로 접속**하며, **SSH 옆에서 RDP·VNC 원격 화면**을 엽니다 — Windows, macOS, Linux, iOS, Android 한 워크스페이스에서.

호스트·시크릿·스니펫은 **종단간 암호화**로 기기 간 동기화되고, **동기화 서버를 직접 운영**해 접속 정보가 외부로 나가지 않게 할 수 있습니다.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/hosts-workspace-dark.png">
  <img alt="Dolgate 홈 화면" src="./docs/images/hosts-workspace.png">
</picture>

### 대표 기능

- **SSH 워크스페이스** — 다중 세션 터미널, SFTP, 포트 포워딩을 한 앱에서 다룹니다. SSH Agent 인증과 Agent Forwarding, 점프 호스트(베스천) 경유도 지원합니다.
- **RDP · VNC 원격 데스크톱** — 데스크톱 앱에서 RDP와 VNC 화면을 SSH 세션과 같은 워크스페이스에 엽니다. RDP의 여러 모니터를 한 화면에서 보거나 로컬 모니터별 창으로 펼칠 수 있고, Tailscale 직접 연결, RDP over SSM, VNC SSH 터널도 지원합니다.
- **AWS SSM 통합** — AWS CLI나 session-manager-plugin 설치 없이, 공인 IP·인바운드 포트가 없는 EC2에 접속합니다. SSH-over-SSM, SSM shell fallback, AWS SFTP, SSM 포트 포워딩, ECS Exec을 지원합니다.
- **Tailscale 내장** — Tailscale 설치 없이 앱 자체가 tailnet 노드가 되고, OS 네트워크 설정은 건드리지 않습니다. 여러 tailnet에 동시에 참여해, 망이 달라도 전환 없이 한 창에서 오갈 수 있습니다.
- **명령 블록** — 실행한 명령마다 성공·실패와 소요 시간을 표시합니다. 출력만 복사하거나 바로 재실행하고, 실패한 명령만 골라 이동할 수 있습니다.
- **tmux control mode** — 원격 tmux 윈도우를 앱 탭으로, 패인을 분할 화면으로 보여주고 detach된 세션에 다시 붙습니다.
- **AI 어시스턴트** — `Cmd/Ctrl+I`로 열어 현재 SSH 세션의 호스트 정보와 최근 터미널 출력을 바탕으로 질문하고, 승인된 도구로 조회·실행을 도와줍니다.
- **세션 녹화 및 재생** — 종료된 터미널 세션을 로컬에만 저장하고, 타임라인으로 다시 볼 수 있습니다.
- **셀프호스팅 동기화 & 종단간 암호화** — 호스트·세션·스니펫을 데스크톱↔모바일로 동기화하는 `sync-api`를 직접 띄울 수 있습니다. 데이터는 업로드 전에 기기에서 암호화되고 복호화 키는 사용자의 동기화 암호로 보호되므로, 서버에는 암호문만 남습니다(zero-knowledge).
- **세션 공유 & 협업** — 실행 중인 세션을 브라우저 viewer 링크로 공유하고 실시간 채팅으로 함께 봅니다.

## 구성

- **Desktop** — Windows · macOS · Linux (Electron). 멀티 세션 터미널, RDP·VNC 원격 화면, SFTP, 포트 포워딩, 세션 공유, AWS/컨테이너 작업을 다루는 메인 앱입니다.
- **Mobile** — iOS · Android (React Native). 동기화된 호스트/그룹과 세션 탭 워크스페이스를 중심으로 원격 세션에 접근합니다.
- **sync-api** — 브라우저 로그인, 동기화 저장소, session share viewer, AWS SSM 브로커를 담당하는 서버입니다. 직접 띄울 수 있습니다(아래 [자체 호스팅](#자체-sync-api-호스팅) 참고).

저장소 전체는 하나의 `vX.Y.Z` 버전으로 함께 릴리즈됩니다.

## 빠른 시작

### 다운로드

[**다운로드 페이지**](https://doldolma.github.io/Dolgate/#download)에서 쓰는 OS에 맞는 설치 파일을 바로 받을 수 있습니다 — Windows(exe), macOS(dmg), Linux(deb/rpm), Android(APK). iOS(AppStore)

Linux `deb`와 ARM64 빌드는 [GitHub Releases](https://github.com/doldolma/dolgate/releases)에 있습니다.

데스크톱 앱은 자동 업데이트를 지원합니다. 한 번 설치하면 새 버전이 나올 때 앱 안에서 바로 업데이트할 수 있습니다.

개발 환경 구성, 로컬 실행, 릴리즈 빌드는 [빌드 및 배포 문서](./docs/build-and-deploy.md)를 참고해 주세요.

## 기능 전체

**터미널 & 세션**

- 다중 SSH 세션과 분할 워크스페이스(탭 기반)
- tmux control mode — 윈도우→탭, 패인→분할로 보여주고 단축키 없이 조작, detach 지원
- mosh 연결 — 네트워크 전환·절전 복귀에 강한 UDP 연결 (원격 `mosh-server` 필요, 셸 통합 기능은 비활성)
- 명령어 자동완성 — Fig 스펙 + 원격 generator 동적 값 + 파일/폴더 경로 + 스니펫
- 명령어 스니펫 — `{{변수}}` 치환 지원
- 세션 녹화 및 재생 — 로컬 저장, 서버 동기화 없음
- 명령 완료 OS 알림 — 오래 걸리거나 실패한 명령이 끝났을 때 (기준 시간·조건 설정)
- 명령 블록 — 셸 통합 기반으로 명령 단위 상태 표시, hover 액션(출력/명령 복사·재실행·AI), 명령 팔레트(`Cmd/Ctrl+Shift+P`)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/terminal-workspace-dark.png">
  <img alt="분할 세션과 세션 패널이 열린 Dolgate 터미널 워크스페이스" src="./docs/images/terminal-workspace.png">
</picture>

**원격 데스크톱 (데스크톱 앱)**

- RDP·VNC 원격 화면을 SSH 세션과 같은 탭 워크스페이스에서 사용
- RDP 다중 모니터 — 한 화면에 함께 표시하거나 로컬 모니터별 별도 창으로 펼치기
- RDP 오디오·클립보드·로컬 폴더 공유, VNC 보기 전용·화질 설정·클립보드
- Tailscale 직접 연결, RDP over SSM, VNC SSH 터널

<img alt="한 RDP 탭에 나란히 놓인 원격 모니터 두 대" src="./docs/images/rdp-multimonitor.png">

**AI 어시스턴트**

- 우측 AI 패널 — AI 버튼 또는 `Cmd/Ctrl+I`로 열고, 현재 세션의 호스트 정보와 최근 터미널 출력 100줄을 컨텍스트로 사용
- Provider — OpenAI-compatible API(OpenAI·Ollama·LM Studio·vLLM 등), Anthropic Claude API, Codex(ChatGPT 계정 로그인)
- 도구 — 웹 검색/URL 읽기, 숨은 SSH exec 조회, 보이는 터미널 실행, 질문 시점 기준 이전 터미널 scrollback 읽기
- 안전장치 — 시크릿 redaction, 변경 명령 승인, 정지 버튼

**파일 전송**

- 듀얼 패널 SFTP 브라우저
- 터미널 파일 전송 — 로컬 드래그 → SFTP 업로드 / 원격 `sz` → ZMODEM 다운로드 자동 수신
- SFTP 원격 파일 내장 편집 — 앱에서 바로 열어 수정·저장(변경 충돌 감지, root 소유 파일은 sudo 저장)

**연결 & 네트워크**

- SSH Agent 인증 — 로컬 `ssh-agent`, 1Password, `ssh-add`에 등록된 키로 연결
- SSH Agent Forwarding — 신뢰하는 호스트에서 원격 hop에 로컬 키를 전달
- 점프 호스트(베스천) 경유 연결 — 저장된 SSH 호스트를 ProxyJump로 지정
- Local / Remote / Dynamic 포트 포워딩
- Tailscale 내장 — Tailscale 클라이언트 설치 없이 앱 자체가 tailnet 노드로 참여
- OS 네트워크에 영향 없음 — 앱 내부 네트워크 스택에서만 동작. 시스템 라우팅·DNS 변경도, 관리자 권한도 필요 없음
- 여러 tailnet 동시 연결 — 서로 다른 tailnet을 함께 등록하고, 호스트마다 경유할 tailnet을 지정

**AWS & 컨테이너**

- AWS EC2 import, EC2 SSH-over-SSM, SSM shell fallback, AWS SFTP, SSM 포트 포워딩, ECS Exec shell, ECS 터널링
- SSM 데이터 채널 내장 — AWS CLI·session-manager-plugin 설치 불필요
- Docker / Podman 컨테이너 모니터링·로그·메트릭·셸·터널링

**공유 · 내보내기 & 가져오기**

- Session Share, 브라우저 viewer, 실시간 채팅
- 호스트 내보내기 — 암호로 암호화한 Dolgate 파일(`.dolgate`) 또는 OpenSSH config
- OpenSSH / Xshell / Termius import, Dolgate 파일 가져오기

**동기화 & 보안**

- 패스키(WebAuthn) 로그인 — 생체 인증·보안 키로 비밀번호 없이 로그인 (서버에서 켠 경우)
- 종단간 암호화(E2EE) — 호스트·자격 증명·스니펫 등은 기기에서 암호화되어 서버에는 암호문만 저장됩니다
- Zero-knowledge — 암호화 키는 동기화 암호(Argon2id)로 감싸 보관되고 서버는 원문 키를 갖지 않습니다. 암호를 잊으면 서버도 복구해 줄 수 없습니다

자세한 설계는 [데이터 보호 문서](./docs/data-protection.md)를 참고하세요.

**그 외**

- 자동 업데이트 · 셀프호스팅 sync-api

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/port-forwarding-dark.png">
  <img alt="Dolgate 포트 포워딩 화면" src="./docs/images/port-forwarding.png">
</picture>

## 자체 sync-api 호스팅

브라우저 로그인과 동기화를 직접 운영하려면 `sync-api`를 별도 서버에 띄우면 됩니다.
단일 컨테이너라 `docker run` 한 줄이면 시작할 수 있습니다.

```bash
docker run -d --name dolgate-sync-api \
  -p 8080:8080 -v dolgate-sync-api-data:/app/data \
  ghcr.io/doldolma/dolgate-sync-api

curl http://127.0.0.1:8080/healthz
```

운영에서는 `latest` 대신 버전 태그 고정(`ghcr.io/doldolma/dolgate-sync-api:X.Y.Z`)을
권장합니다. Docker Compose 구성, 리버스 프록시, MySQL 등 상세 설정과 운영 가이드는
[sync-api 자체 호스팅 가이드](./docs/sync-api-self-hosting.md)를 참고해 주세요.

데스크톱 앱에서는 로그인 화면의 톱니바퀴를 눌러 `Login Server`를 self-host 주소로 바꾸면 됩니다.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/login-dark.png">
  <img alt="Login Server 설정 화면" src="./docs/images/login.png">
</picture>

## 중요한 사항

### AWS / SSM 사용 전 확인

EC2 터미널은 SSH-over-SSM을 먼저 시도합니다. 공개키 주입이나 SSH 준비 단계에서 일반 SSH 연결을 열 수 없으면 SSM shell로 fallback할 수 있고, AWS SFTP · SSM 포트 포워딩 · ECS Exec/터널링은 내장 SSM 데이터 채널로 동작합니다. 프로필 인증(SSO 브라우저 로그인, 자격 증명 검증, AssumeRole)은 AWS SDK로 처리하며, 기존 로컬 `~/.aws` 프로필은 가져오기로 그대로 사용할 수 있습니다.

대상 EC2는 **SSM managed instance** 상태여야 하고, AWS Import는 Linux/UNIX 인스턴스를 기준으로 동작합니다.
SSH-over-SSM과 AWS SFTP에는 EC2 Instance Connect 공개키 주입 권한이 필요합니다. 필요한 IAM 권한(사용자/역할 · EC2 인스턴스 프로파일 · ECS task role)과 정책 JSON 예시는 [AWS / SSM 설정 가이드](./docs/aws.ko.md)를 참고하세요.

### 그 외

- Session Replay는 **로컬에만 저장**되며 서버 동기화 대상이 아닙니다.
- SSH / AWS / Warpgate host를 추가하면, 해당 호스트 아래의 **Docker 또는 Podman 컨테이너를 함께 모니터링**할 수 있습니다.
- Containers 기능과 container tunnel은 원격 호스트에 **Docker 또는 Podman**이 실제로 설치되어 있고, 로그인 셸에서 실행 가능해야 합니다.
- 브라우저 로그인/동기화를 직접 운영하려면 위의 `sync-api`를 self-host 하고 앱 로그인 화면의 `Login Server`를 원하는 서버로 바꿔야 합니다.

## 문서

- [Desktop 문서](./docs/desktop.md)
- [Tailscale / Headscale 가이드](./docs/tailscale.md)
- [AI 어시스턴트](./docs/ai-assistant-design.md)
- [AWS / SSM 설정 가이드](./docs/aws.ko.md)
- [아키텍처](./docs/architecture.md)
- [데이터 보호 (E2EE)](./docs/data-protection.md)
- [빌드 및 배포](./docs/build-and-deploy.md)
- [sync-api 자체 호스팅 가이드](./docs/sync-api-self-hosting.md)
- [ssh-core IPC 프로토콜](./docs/ipc-protocol.md)

## 라이선스

MIT © 2026 doldolma

명령어 자동완성의 generator 런타임과 번들 스펙은 Amazon Q Developer CLI(Apache-2.0/MIT)와 withfig/autocomplete(MIT)에서 가져왔으며, 해당 구성요소는 각자의 라이선스를 따릅니다.

번들 터미널 색 테마는 MIT 라이선스로 가져온 외부 저작물이며 각 저작자에게 권리가 있습니다: Kanagawa(© 2021 Tommaso Laurenzi), Everforest(© 2019 sainnhe), Night Owl·Night Owl Light(© 2018 Sarah Drasner), Rosé Pine(© 2023 Rosé Pine).
