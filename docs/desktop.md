# Dolgate Desktop

Dolgate Desktop은 macOS와 Windows를 위한 Electron 기반 SSH 워크스페이스입니다.  
여러 세션을 한 화면에서 다루고, 파일 전송과 포트 포워딩, 세션 공유, AWS/컨테이너 작업까지 하나의 UI에서 처리하는 것이 현재 데스크톱 앱의 중심 역할입니다.

## 현재 기능

- 멀티 세션 터미널과 탭 기반 워크스페이스
- 명령어 자동완성 (Fig 스펙 + generator + 경로)
- 듀얼 패널 SFTP 브라우저와 파일 전송
- 점프 호스트(베스천) 경유 연결 (ProxyJump / `ssh -J`)
- Local / Remote / Dynamic 포트 포워딩
- 세션 녹화 및 재생
- Session Share, 브라우저 viewer, 실시간 채팅
- AWS EC2 import, AWS SFTP, SSM 포트 포워딩, ECS Exec shell, ECS 터널링
- Docker / Podman 컨테이너 모니터링, 로그, 메트릭, 셸, 터널링
- OpenSSH / Xshell / Termius import
- GitHub Releases 기반 업데이트 배포

## 명령어 자동완성

터미널 입력 중에 명령어·옵션·경로·동적 값(컨테이너 이름, git 브랜치 등)을 추천합니다. 설정 > General의 **Command autocomplete** 토글로 켜고 끌 수 있으며 기본값은 켜짐입니다.

- **활성 조건**: 셸 통합(OSC 133)이 감지된 세션에서만 동작합니다. 접속 시 bash/zsh에 프롬프트 마커를 주입해 프롬프트 경계를 인식하고, 마커가 확인되면 추천이 시작됩니다. (SSH / 로컬 / AWS SSM 모두 통합이 되면 동작)
- **추천 출처**
  - 실행파일 이름(원격 `$PATH`)과 셸 history
  - **Fig 스펙** 기반 옵션·서브커맨드 — withfig/autocomplete에서 변환, 입력한 적 없어도 표시
  - **파일/폴더 경로** — 현재 디렉터리를 실제로 조회해 추천 (`cd`/`ls`/`cat` 등). 경로 인자일 땐 stale한 history 경로 대신 실제 파일시스템이 우선
  - **generator 동적 값** — `docker logs <컨테이너>`, `git checkout <브랜치>`처럼 호스트에서 read-only 명령을 돌려 실제 값을 추천
- **동적 완성 동작**: SSH/로컬은 보조 채널(별도 SSH exec / 로컬 서브프로세스)로 짧은 명령을 실행해 값을 가져오고, 결과는 프롬프트 단위로 캐시합니다(명령 실행 시 갱신, 같은 디렉터리 내 추가 입력은 재조회 없이 필터). AWS SSM은 보조 채널이 없어 동적 값 없이 정적 추천 + history로 degrade합니다.
- **키보드**: `↓`/`↑` 이동, `Tab` 또는 `→` 선택, `Enter`는 화살표로 고른 항목 선택(맨 위면 명령 실행), `Esc` 닫기.

generator 실행 엔진은 Amazon Q Developer CLI(오픈소스 Fig 후신, Apache-2.0/MIT)의 generator 런타임을 이식한 것으로, 로컬 실행 대신 우리 보조 채널로 **원격 호스트에서** 실행하도록 바꿨습니다. 번들 스펙/generator는 `npm run generate:specs`로 생성합니다 (`apps/desktop/src/renderer/generated/command-specs*`, withfig/autocomplete MIT).

### 추천 점수 체계

각 후보는 **출처별 기본 점수 + 보너스**로 점수를 매기고, 같은 결과는 더 높은 점수로 합쳐(dedup) **상위 5개**만 표시합니다. 입력은 **최소 2글자**부터, 커서가 줄 끝일 때만 추천합니다.

출처별 기본 점수:

| 출처 | 오버레이 라벨 | 기본 점수 |
|---|---|---|
| 실행파일 (원격 `$PATH`) | Command | `6000 − 글자수` |
| 이번 세션에 실행한 명령(전체 줄) | History | `4500` + 보너스 |
| 파일/폴더 경로 | Path | `2000 − 글자수` |
| generator 동적 값 | Value | `1800 − 글자수` |
| Fig 스펙 옵션·서브커맨드 | Spec | `1000` |
| `~/.bash_history` 줄 | History | `150` + 보너스 |

보너스(history/세션 전체 줄에만 가산):

| 보너스 | 값 | 조건 |
|---|---|---|
| recency(최근성) | 최대 `+550` | 최근일수록 (비율 0~1) |
| frequency(빈도) | `+350 × log₂(1+횟수)` | 자주 쓸수록 |
| exitSuccess | `+1500` | 세션에서 exit 0 |
| cwdMatch | `+2000` | 세션 + 같은 디렉터리 |

추가 규칙:

- 이번 세션에서 **실패(exit ≠ 0)** 한 명령은 추천에서 제외합니다.
- **경로 인자**(`cd`/`ls` 등)일 땐 raw history 전체 줄 추천을 억제해 실제 파일시스템(Path)이 우선합니다 — stale한 history 경로가 묻어 나오지 않게.
- raw history는 일부러 약하게(150) 둬서, 매우 자주 쓰는 줄(횟수 ~20+)만 Path/Value 위로 올라옵니다.

가중치 상수는 `apps/desktop/src/renderer/lib/terminal-autocomplete.ts`의 `SCORE_WEIGHTS` 한 곳에서 조정합니다.

## 점프 호스트 (베스천)

프라이빗 서브넷처럼 직접 닿지 않는 호스트를, 중간 **베스천(SSH 서버)을 경유**해 접속하는 기능입니다. 표준 SSH의 `direct-tcpip` 포워딩(`ssh -J`)을 쓰므로 베스천에는 평범한 sshd만 있으면 되고, 모든 처리는 클라이언트(`ssh-core`)에서 일어납니다(sync-api 무관).

- **설정**: 호스트 생성/수정 창의 Connection 섹션 **Jump host** 선택기에서 **저장된 다른 SSH 호스트**를 베스천으로 고릅니다. 베스천의 자격증명·known-host는 그 저장 호스트 것을 재사용합니다.
- **적용 범위**: 터미널 · SFTP · 포트 포워딩 · 컨테이너 — 4개 연결 전부 동일하게 경유합니다. (내부적으로 모든 연결이 거치는 단일 dial 지점 `sshconn.DialClient`에 점프를 주입)
- **신뢰(TOFU)**: 베스천을 먼저 신뢰한 뒤, 타깃 호스트 키는 **신뢰된 베스천을 경유해** probe합니다. 베스천이 신뢰돼 있지 않으면 자동으로 지문 프롬프트가 떠 신뢰 후 진행합니다(Termius 스타일). 베스천 뒤의(직접 닿지 않는) 타깃 키도 이 경유 probe로 확인/신뢰할 수 있습니다.
- **인증**: 베스천이 password / privateKey / certificate / keyboard-interactive 어느 방식이든 연결됩니다(두 홉을 순차 인증). 단, 베스천 경유 **키 probe**는 비대화형 인증(password/key/certificate)만 지원합니다.
- **제약(v1)**: 단일 홉만 지원합니다(`h1,h2,h3` 같은 다단 체인 UI는 범위 밖 — Go 코어는 재귀 구조로 표현 가능). 점프 대상은 일반 SSH 호스트만 가능하며 AWS-SSM/Warpgate 호스트는 점프로 쓸 수 없습니다.

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
