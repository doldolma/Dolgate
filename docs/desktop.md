# Dolgate Desktop

Dolgate Desktop은 macOS와 Windows를 위한 Electron 기반 SSH 워크스페이스입니다.  
여러 세션을 한 화면에서 다루고, 파일 전송과 포트 포워딩, 세션 공유, AWS/컨테이너 작업까지 하나의 UI에서 처리하는 것이 현재 데스크톱 앱의 중심 역할입니다.

## 현재 기능

- 멀티 세션 터미널과 탭 기반 워크스페이스
- tmux control mode 연동 (원격 윈도우→탭, 패인→분할 워크스페이스, detach 지원)
- mosh 연결 (UDP 기반, 네트워크 전환·절전 복귀에 강함)
- 명령어 자동완성 (Fig 스펙 + generator + 경로 + 스니펫)
- 명령어 스니펫 (변수 지원, 자동완성·관리 UI 연동)
- 명령 완료 OS 알림 (오래 걸리거나 실패한 명령 종료 시, 셸 통합 기반)
- AI 어시스턴트 (세션 컨텍스트 기반 질문, 조회/실행 도구, provider 선택)
- 듀얼 패널 SFTP 브라우저와 파일 전송
- 터미널 파일 전송 (드래그 SFTP 업로드 / 원격 `sz` ZMODEM 다운로드)
- SFTP 원격 파일 내장 편집 (텍스트 파일 인앱 편집·저장, 변경 충돌 감지, sudo 저장)
- SSH Agent 인증 (1Password / `ssh-add` / OS ssh-agent)
- SSH Agent Forwarding (`ssh -A` 계열, 신뢰하는 호스트에서만 권장)
- 점프 호스트(베스천) 경유 연결 (ProxyJump / `ssh -J`)
- Local / Remote / Dynamic 포트 포워딩
- 세션 녹화 및 재생 (로컬 저장, 서버 동기화 없음)
- Session Share, 브라우저 viewer, 실시간 채팅
- AWS EC2 import, EC2 SSH-over-SSM, SSM shell fallback, AWS SFTP, SSM 포트 포워딩, ECS Exec shell, ECS 터널링
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
  - **스니펫** — 저장한 명령을 keyword(없으면 label) 접두사로 매칭해 전체 명령을 삽입 (변수 `{{name}}`은 삽입 시 입력)
- **동적 완성 동작**: SSH/로컬은 보조 채널(별도 SSH exec / 로컬 서브프로세스)로 짧은 명령을 실행해 값을 가져오고, 결과는 프롬프트 단위로 캐시합니다(명령 실행 시 갱신, 같은 디렉터리 내 추가 입력은 재조회 없이 필터). AWS SSM은 보조 채널이 없어 동적 값 없이 정적 추천 + history로 degrade합니다.
- **키보드**: `↓`/`↑` 이동, `Tab` 또는 `→` 선택, `Enter`는 화살표로 고른 항목 선택(맨 위면 명령 실행), `Esc` 닫기.

generator 실행 엔진은 Amazon Q Developer CLI(오픈소스 Fig 후신, Apache-2.0/MIT)의 generator 런타임을 이식한 것으로, 로컬 실행 대신 우리 보조 채널로 **원격 호스트에서** 실행하도록 바꿨습니다. 번들 스펙/generator는 `npm run generate:specs`로 생성합니다 (`apps/desktop/src/renderer/generated/command-specs*`, withfig/autocomplete MIT).

### 추천 점수 체계

각 후보는 **출처별 기본 점수 + 보너스**로 점수를 매기고, 같은 결과는 더 높은 점수로 합쳐(dedup) **점수순 최대 20개**를 추립니다. 오버레이에는 **한 번에 5개**만 보이고, 방향키(↓/↑)로 나머지를 스크롤합니다. 입력은 **최소 2글자**부터, 커서가 줄 끝일 때만 추천합니다.

출처별 기본 점수:

| 출처 | 오버레이 라벨 | 기본 점수 |
|---|---|---|
| 저장한 Snippet — 키워드/라벨 **정확히 일치** | Snippet | `20000` (최상위) |
| 실행파일 (원격 `$PATH`) | Command | `6000 − 글자수` |
| 이번 세션에 실행한 명령(전체 줄) | History | `4500` + 보너스 |
| 저장한 Snippet — 키워드/라벨 prefix 매칭 | Snippet | `4000` |
| 파일/폴더 경로 | Path | `2000 − 글자수` |
| generator 동적 값 | Value | `1800 − 글자수` |
| 저장한 Snippet — 키워드/라벨 부분(substring) 매칭 | Snippet | `1500` |
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

## 명령 완료 알림

오래 걸리거나 실패한 명령이 끝나면 OS 네이티브 알림으로 알려줍니다. 명령 경계·소요 시간·종료 코드는 명령어 자동완성과 동일하게 셸 통합(OSC 133)에서 얻으므로, 셸 통합이 감지된 세션(SSH / 로컬 / AWS SSM)에서 동작합니다.

- **설정 위치**: 설정 > General의 **Notifications** 그룹.
  - **명령 완료 알림**: 기능 on/off. 켤 때 OS 알림 권한이 미결정이면 권한을 요청합니다.
  - **알림 기준 시간(초)**: 이 시간 이상 걸린 명령이 끝나면 알립니다. (기본 30초)
  - **비활성 상태일 때만 알림**: 앱이 포커스되어 있고 해당 세션이 활성 탭이면(=지금 보고 있으면) 알리지 않습니다. (기본 켜짐)
  - **실패한 명령은 항상 알림**: 종료 코드가 0이 아니면 소요 시간과 무관하게 알립니다. (기본 꺼짐)
  - **소리**: 알림 사운드 on/off.
- **알림 내용**: 제목은 호스트 라벨, 본문은 `명령 · 완료/실패(exit N) · 소요시간`. 알림을 클릭하면 앱 창이 다시 앞으로 옵니다.
- 표시 여부 판정(임계 시간·실패·포커스)은 렌더러에서 끝내고, 실제 OS 알림 표시는 Electron main의 notification 서비스가 담당합니다.

## AI 어시스턴트

터미널 우측의 AI 패널에서 현재 세션에 대해 질문하고, 필요한 경우 도구로 호스트 상태를 조회하거나 사용자가 보는 터미널에 명령을 실행할 수 있습니다. 패널은 우측 AI 버튼이나 `Cmd/Ctrl+I` 단축키로 열고 닫을 수 있으며, 세션 탭 단위로 유지됩니다. 터미널 입력 영역과 분리되어 자동완성·tmux 조작과 충돌하지 않습니다.

- **Provider**: OpenAI-compatible API(OpenAI, Ollama, LM Studio, vLLM 등), Anthropic Claude API, Codex(ChatGPT 계정 로그인)를 지원합니다. OpenAI-compatible/Anthropic은 API 키를 OS 키체인에 저장하고, Codex는 API 키 없이 브라우저 로그인 세션을 사용합니다.
- **자동 컨텍스트**: 질문 시점의 호스트 요약, 현재 세션 정보, 최근 터미널 출력 100줄을 함께 보냅니다. 더 이전 출력이 필요하면 AI가 질문 시점에 고정된 scrollback snapshot에서 추가 범위를 읽을 수 있습니다.
- **도구**: `inspect_command`는 숨은 SSH exec 채널로 읽기 전용 조회를 수행하고, `run_in_terminal`은 사용자가 보는 터미널에 명령을 입력해 실행합니다. 웹 검색과 URL 읽기도 provider와 별개로 사용할 수 있습니다.
- **안전장치**: 컨텍스트와 도구 결과는 시크릿 redaction을 거치며, 변경 가능성이 있는 명령은 사용자 승인 후 실행합니다. 진행 중인 응답과 도구 루프는 패널의 정지 버튼으로 중단할 수 있습니다.
- **제약**: 호스트 exec 도구는 세션에 SSH client가 있는 경우에만 노출됩니다. 일반 SSH, Warpgate SSH, EC2 SSH-over-SSM은 같은 SSH 연결을 공유하고, raw SSM shell fallback처럼 SSH client가 없는 경로는 실행 도구가 제한될 수 있습니다.

## SSH Agent 인증과 Forwarding

호스트 생성/수정 화면에서 **Auth Type = SSH Agent**를 선택하면 비밀번호나 키 파일을 Dolgate에 저장하지 않고 로컬 ssh-agent로 인증합니다. macOS의 `SSH_AUTH_SOCK`, launchctl agent, Windows OpenSSH agent, 1Password SSH Agent, `ssh-add`로 등록한 키를 사용할 수 있습니다.

- **상태 확인**: SSH Agent 인증을 선택하면 로컬 agent 연결 가능 여부와 키 개수를 설정 화면에서 확인합니다.
- **저장 방식**: agent 인증은 로컬 agent에 서명을 위임하므로 개인키 자체를 Dolgate 저장소나 sync-api에 저장하지 않습니다.
- **Agent Forwarding**: SSH 호스트와 AWS EC2 호스트에서 **SSH Agent Forwarding**을 켜면 원격 호스트에서 다시 다른 서버로 hop할 때 로컬 키를 사용할 수 있습니다. `ssh -A`와 같은 성격이므로 신뢰하는 호스트에서만 켜는 것을 권장합니다.
- **제약**: mosh 연결에서는 agent forwarding을 지원하지 않아 토글이 비활성화됩니다.

## 점프 호스트 (베스천)

프라이빗 서브넷처럼 직접 닿지 않는 호스트를, 중간 **베스천(SSH 서버)을 경유**해 접속하는 기능입니다. 표준 SSH의 `direct-tcpip` 포워딩(`ssh -J`)을 쓰므로 베스천에는 평범한 sshd만 있으면 되고, 모든 처리는 클라이언트(`ssh-core`)에서 일어납니다(sync-api 무관).

- **설정**: 호스트 생성/수정 창의 Connection 섹션 **Jump host** 선택기에서 **저장된 다른 SSH 호스트**를 베스천으로 고릅니다. 베스천의 자격증명·known-host는 그 저장 호스트 것을 재사용합니다.
- **적용 범위**: 터미널 · SFTP · 포트 포워딩 · 컨테이너 — 4개 연결 전부 동일하게 경유합니다. (내부적으로 모든 연결이 거치는 단일 dial 지점 `sshconn.DialClient`에 점프를 주입)
- **신뢰(TOFU)**: 베스천을 먼저 신뢰한 뒤, 타깃 호스트 키는 **신뢰된 베스천을 경유해** probe합니다. 베스천이 신뢰돼 있지 않으면 자동으로 지문 프롬프트가 떠 신뢰 후 진행합니다. 베스천 뒤의(직접 닿지 않는) 타깃 키도 이 경유 probe로 확인/신뢰할 수 있습니다.
- **인증**: 베스천이 password / privateKey / certificate / keyboard-interactive 어느 방식이든 연결됩니다(두 홉을 순차 인증). 단, 베스천 경유 **키 probe**는 비대화형 인증(password/key/certificate)만 지원합니다.
- **다단 체인**: 여러 jump host를 위에서부터 순서대로 지정할 수 있습니다. 첫 번째 홉은 클라이언트에서 직접 연결하는 베스천이고, 마지막 홉은 타깃 바로 앞 홉입니다.
- **제약**: 점프 대상은 일반 SSH 호스트만 가능하며 AWS-SSM/Warpgate 호스트는 점프로 쓸 수 없습니다.

## 명령어 스니펫 (Snippets)

자주 쓰는 명령을 저장해 두고 터미널에서 꺼내 씁니다. 사이드바 **Snippets** 섹션에서 추가/편집/삭제하며, 호스트·그룹처럼 암호화 클라우드 동기화에 포함됩니다.

- **자동완성 연동**: 입력이 `keyword`·label과 **정확히 일치(20000·최상위) → 접두사(4000) → 부분 문자열(1500)** 순으로 매칭돼 후보로 뜨고, 선택하면 현재 줄을 비우고 **전체 명령**을 삽입합니다(실행은 사용자가 Enter). 정확히 일치하면 무엇보다 위로, 접두사 매칭은 이번 세션에 실행한 명령보다는 아래로, 부분 문자열은 발견용 하위 티어로 뜹니다. keyword와 label **양쪽**을 매칭하므로 라벨 단어로도 찾을 수 있습니다. 자동완성에는 단일 라인 스니펫만 노출됩니다.
- **변수**: 명령에 `{{name}}` 또는 `{{name=기본값}}`을 넣으면, 삽입 시 값 입력 모달이 떠서 치환합니다.
- **저장 필드**: label(표시명), keyword(자동완성 매칭용, 선택), command(멀티라인 가능).

## SFTP 원격 파일 편집

SFTP 패널에서 원격 텍스트 파일을 더블클릭하거나 우클릭 **편집**을 누르면 앱 안의 코드 에디터(CodeMirror)가 열립니다. 별도 다운로드 없이 메모리로 읽어 편집하고, 저장하면 원격에 바로 반영합니다.

- **열기 대상**: 설정한 최대 크기(기본 5MB) 이하의 텍스트 파일. 바이너리·용량 초과 파일은 편집 대상에서 제외됩니다. (`ssh-core`가 앞부분 NUL 바이트로 바이너리를 최종 판별)
- **저장**: `Cmd/Ctrl+S`. 같은 디렉터리에 임시 파일을 쓴 뒤 원자적으로 교체(temp + rename)해 중간 실패로 원본이 깨지지 않으며, 권한·수정 시각을 유지합니다.
- **충돌 감지**: 열 때의 크기·수정 시각을 스냅샷으로 잡아두고 저장 직전 원격과 비교합니다. 그 사이 파일이 바뀌었으면 *다시 불러오기 / 덮어쓰기*를 고를 수 있습니다.
- **sudo 저장**: 권한이 없는(예: root 소유) 파일은 sudo 비밀번호를 입력하면 `sudo`로 저장합니다. 비밀번호는 명령 문자열이 아니라 stdin으로만 전달합니다.
- 최대 편집 크기는 설정 > SFTP의 **Editor Max File Size (MB)**에서 조정합니다.

## tmux control mode

tmux는 보통 터미널에서 prefix 단축키로만 다뤄야 해 진입장벽이 높습니다. Dolgate는 원격 tmux의 윈도우를 상단 탭으로, 패인을 분할 화면으로 보여주고, 마우스(클릭·경계 드래그)나 익숙한 `Ctrl-b` 단축키로 조작합니다. 단축키를 외우지 않아도 tmux 세션을 쓸 수 있고, 연결이 끊겨도 서버 세션은 살아 있어(detach) 다시 붙으면 그대로 이어집니다.

호스트 우클릭 메뉴의 **tmux로 연결**을 고르면 tmux control mode(`tmux -CC`)로 붙습니다. 일반 SSH 자격증명을 그대로 쓰고 원격엔 tmux만 있으면 됩니다.

- **조작**: 새 윈도우·좌우/상하 분할·윈도우/패인 선택·이름변경·kill을 앱에서 직접 하고, 변경은 서버 tmux와 양방향 동기화됩니다.
- **키보드 단축키**: **tmux prefix 단축키**(설정, 기본 켜짐)로 마우스 없이 조작합니다. prefix 다음 방향키(pane 이동)·`Ctrl+방향키`(크기 조절)·`c`(새 창)·`%`/`"`(분할)·`n`/`p`/숫자/`l`(창 전환)·`w`(창 목록)·`z`(zoom)·`{`/`}`(swap)·`!`(break)·`Space`(레이아웃)·`x`/`&`(종료)·`[`/`]`(복사/붙여넣기)·`,`/`$`(이름 변경)·`:`(명령 입력)·`d`(detach). prefix 키는 기본 `Ctrl-b`이며 설정에서 `Ctrl-a`/`Ctrl-Space` 등으로 바꿀 수 있습니다. 매핑 안 된 키는 tmux에 그대로 전달됩니다.
- **닫기 = detach**: 탭의 `×`는 kill이 아니라 detach라 원격 세션이 살아 있어, 다시 tmux로 연결하면 이어집니다.
- **tmux 버전별 동작**: **2.6 이상**이면 GUI control mode로 붙고, 입력 방식은 버전에 맞춰 앱이 자동 처리합니다(2.6~3.0은 `send-keys -l`, 3.0a+는 더 빠른 `-H` hex). 따라서 구버전 서버라고 따로 설정할 게 없습니다. **2.6 미만**은 control mode의 사이즈 모델이 없어, GUI 통합 대신 일반 SSH 셸에서 tmux를 실행(passthrough)합니다.
- **제약**: SSH 호스트 전용 · 점프 호스트와 병용 불가.

## mosh 연결

SSH로 한 번 부트스트랩한 뒤 **UDP**로 전환해, 네트워크 전환(Wi-Fi↔셀룰러)이나 절전/복귀에도 끊기지 않는 연결입니다.

- **사용**: 호스트 생성/수정 창에서 **Mosh로 연결** 토글을 켜고 평소처럼 연결합니다.
- **흐름**: SSH가 원격에서 `mosh-server`를 기동 → `MOSH CONNECT <port> <key>`를 받아 UDP 세션을 열고 → 부트스트랩 SSH는 닫힙니다. 이후 입출력은 UDP로 흐릅니다.
- **상태 표시**: 터미널 하단 바에 **연결됨 / 재연결 중(마지막 응답 N초 전) / 끊김**을 표시합니다(약 4초 무응답 → 재연결 중, 12초 → 끊김).
- **전제**: 원격에 `mosh-server` 설치, 원격 UTF-8 로케일, 클라이언트→원격 UDP 트래픽 허용.
- **제약**: 점프 호스트(베스천)와 병용 불가 — UDP를 프록시할 수 없어 점프가 설정돼 있으면 자동으로 일반 SSH로 폴백합니다. keyboard-interactive 인증은 미지원입니다.

## 터미널 파일 전송

SFTP 패널을 열지 않고 **터미널에서 직접** 파일을 주고받는 두 경로입니다 — 로컬 파일 드래그 업로드와 원격 `sz`(ZMODEM) 다운로드.

- **드래그 업로드(SFTP)**: 연결된 터미널(SSH / AWS EC2 / Warpgate)에 로컬 파일을 끌어다 놓으면, 그 세션의 **현재 작업 디렉터리**로 SFTP 업로드합니다(작업 디렉터리를 알 수 없으면 홈으로). 진행률은 우하단 토스트로 보이며, 폴더(디렉터리) 업로드는 지원하지 않습니다.
- **ZMODEM 다운로드**: 원격에서 `sz <파일>`을 실행하면 터미널 스트림에서 ZMODEM 전송을 자동 감지해 **로컬 Downloads** 폴더에 저장합니다(완료 후 *폴더 열기* 버튼).
- **제한**: ZMODEM 다운로드는 **512MB까지**이며, 초과 시 SFTP 사용을 권하는 메시지로 중단됩니다. `rz`(ZMODEM 업로드)는 지원하지 않으며, 업로드는 드래그 업로드로 대체합니다.
- **레이어**: 드래그 업로드는 렌더러가 SFTP 전송 작업(`sftp:start-transfer`)으로 처리하고, ZMODEM은 렌더러가 스트림에서 감지해 Electron main이 Downloads에 저장합니다.

## 세션 녹화와 Replay

터미널 세션이 종료되면 입출력과 화면 크기 변경을 로컬 replay 데이터로 남겨 나중에 다시 볼 수 있습니다. Replay 창에서는 재생/일시정지, scrubber 이동, 속도 조절, 확대/축소를 사용할 수 있습니다.

- **저장 위치**: 세션 replay는 데스크톱 로컬 저장소에만 보관되며 sync-api로 동기화되지 않습니다.
- **보관 개수**: 설정 > General의 **Session Replay Retention**에서 로컬에 남길 종료 세션 replay 개수를 조정합니다.
- **용도**: 장애 조사, 작업 복기, 다른 사람에게 전달하기 전 화면 흐름 확인에 적합합니다. 실시간 공유가 필요하면 Session Share를 사용합니다.

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

EC2 터미널은 SSH-over-SSM을 먼저 시도합니다. 공개키 주입이나 SSH 준비 단계에서 일반 SSH 연결을 열 수 없으면 SSM shell로 fallback할 수 있고, AWS SFTP · SSM 포트 포워딩 · ECS Exec/터널은 내장 SSM 데이터 채널로 동작합니다. AWS 프로필 인증(프로필 생성·검증, SSO 브라우저 로그인, AssumeRole)은 AWS SDK로 처리합니다. 기존 로컬 `~/.aws` 프로필은 가져오기로 사용할 수 있습니다.

추가 운영 전제와 IAM 권한 예시는 [AWS / SSM 설정 가이드](./aws.md)를 참고하면 됩니다.
