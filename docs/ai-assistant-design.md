# Dolgate AI 어시스턴트

> 상태: 현재 기능 가이드. SSH/EC2 세션 옆에서 동작하는 AI 패널의 provider, 컨텍스트, 도구, 보안 경계를 정리합니다.

## 목표

AI 어시스턴트는 터미널 옆에서 복붙 왕복을 줄이는 기능입니다. 사용자는 현재 세션에 대해 질문하고, AI는 제공된 호스트 정보와 터미널 출력을 바탕으로 설명하거나 필요한 조회 명령을 실행해 결과를 요약합니다.

주요 사용 사례:

- 에러 로그, 명령 출력, 서비스 상태 해석
- 디스크/메모리/포트/컨테이너/로그 등 read-only 진단
- 사용자가 명시한 변경 작업의 실행 보조
- 오래된 터미널 scrollback 확인

## Provider와 설정

AI 설정은 데스크톱 **Settings > AI**에서 관리합니다.

| Provider | 인증 방식 | 비고 |
|---|---|---|
| OpenAI-compatible | Base URL + API key | OpenAI, Ollama, LM Studio, vLLM 등. 로컬 서버는 키가 없을 수 있습니다. |
| Anthropic | Claude API key | 현재는 API 키 기반 Claude API로 연결합니다. |
| Codex | ChatGPT 계정 브라우저 로그인 | API 키 없이 Codex 로그인 세션을 사용하고, 모델은 선택 목록에서 고릅니다. |

- API key는 OS 키체인에 저장하며 sync-api로 동기화하지 않습니다.
- Base URL, provider, model 같은 비밀이 아닌 설정만 앱 설정으로 관리합니다.
- provider 호출과 외부 네트워크 egress는 Electron main 프로세스에서만 수행합니다. renderer는 키를 직접 보지 않습니다.

## 패널과 컨텍스트

AI 패널은 터미널 오른쪽에 열리는 세션 단위 패널입니다. 우측 AI 버튼이나 `Cmd/Ctrl+I` 단축키로 열고 닫을 수 있으며, 터미널 입력줄과 분리되어 있어 셸 자동완성, tmux control mode, 일반 키 입력과 충돌하지 않습니다.

질문을 보낼 때 함께 들어가는 기본 컨텍스트:

- 현재 세션 정보: 탭 제목, source, 연결 상태
- 호스트 요약: label, kind, 주소/프로필/리전/인스턴스 정보, jump host, mosh, agent forwarding 등
- 최근 터미널 출력 100줄
- 사용자가 명시적으로 첨부한 텍스트

터미널 출력은 질문 시점의 snapshot을 기준으로 고정합니다. 이후 사용자가 터미널에 새 출력을 만들어도 해당 질문의 AI 도구가 읽는 범위는 밀리지 않습니다.

## 도구

AI는 provider가 tool/function calling을 지원하는 경우 아래 도구를 사용할 수 있습니다. Codex provider는 같은 도구를 로컬 MCP bridge로 연결합니다.

| 도구 | 실행 위치 | 용도 |
|---|---|---|
| `inspect_command` | 숨은 SSH exec 채널 | 진단·조회용 read-only 명령 실행. 약 15초 timeout과 출력 길이 제한이 있습니다. |
| `run_in_terminal` | 사용자가 보는 활성 터미널 | 변경 작업, interactive/streaming/장기 실행 명령, 사용자가 직접 봐야 하는 명령 실행. |
| `read_terminal_output` | renderer terminal snapshot | 자동 첨부된 최근 100줄보다 이전 scrollback 읽기. 기본 200줄, 최대 500줄 단위입니다. |
| `web_search` | Electron main | 웹 검색. 검색 키가 있으면 설정된 backend를 사용합니다. |
| `fetch_url` | Electron main | URL 내용을 가져와 요약 또는 분석에 사용합니다. |

도구 사용 기준:

- 정보 확인, 원인 분석, 상태 조회는 `inspect_command`가 기본입니다.
- `systemctl restart`, `docker restart`, `apt install`, 파일 수정, 삭제, 권한 변경, redirect, `sed -i`처럼 상태를 바꾸는 명령은 `run_in_terminal`을 사용하고 사용자 승인을 받습니다.
- `tail -f`, `journalctl -f`, `docker logs -f`, `watch`, `top`, 편집기, REPL 같은 streaming/interactive 명령은 `inspect_command`로 실행하지 않습니다.
- 오래된 터미널 출력이 필요할 때만 `read_terminal_output`을 사용합니다. 최신 호스트 상태 확인은 `inspect_command`를 우선합니다.

호스트 exec 도구는 세션에 SSH client가 있을 때만 노출됩니다. 일반 SSH, Warpgate SSH, EC2 SSH-over-SSM은 기존 SSH 연결을 공유할 수 있고, raw SSM shell fallback처럼 SSH client가 없는 세션에서는 실행 도구가 제한될 수 있습니다.

## 안전장치와 프라이버시

- 컨텍스트와 도구 결과는 LLM으로 보내기 전 시크릿 redaction을 거칩니다.
- 비밀번호, private key, token, cookie, API key, connection string은 답변에 노출하지 않는 것이 기본 규칙입니다.
- 변경 가능성이 있는 명령은 승인 프롬프트를 거친 뒤 실행합니다.
- 진행 중인 응답과 도구 루프는 AI 패널의 정지 버튼으로 중단할 수 있습니다.
- 터미널 출력, 로그, 파일 내용, 웹 페이지 내용은 모두 untrusted data로 취급합니다. 그 안의 지시문은 사용자가 명시하지 않는 한 따르지 않습니다.
- AI 도구 사용 내역은 AI 패널의 작업 상태로 보여주며, 일반 Logs 화면을 도구 호출로 채우지 않습니다.

## 런타임 경계

| 레이어 | 역할 |
|---|---|
| renderer | AI 패널 UI, 대화 상태, 질문 시점 터미널 snapshot, 오래된 scrollback 응답 |
| preload | AI IPC bridge와 main→renderer client tool bridge |
| main | provider adapter, 키체인 접근, tool loop, 외부 egress, 승인/취소 처리 |
| ssh-core | 기존 SSH client 기반 exec, visible terminal stream, SFTP/SSM/tmux 런타임 |

이 구조 때문에 API key와 provider 네트워크 요청은 main 밖으로 새지 않고, xterm buffer처럼 renderer에만 있는 데이터는 필요한 범위만 client tool bridge로 main에 전달됩니다.

## 사용 흐름

1. Settings > AI에서 AI 어시스턴트를 켜고 provider를 설정합니다.
2. SSH/EC2/Warpgate 세션에서 우측 AI 버튼 또는 `Cmd/Ctrl+I`로 패널을 엽니다.
3. 질문을 입력하면 현재 세션 컨텍스트와 최근 터미널 출력이 함께 전달됩니다.
4. AI가 추가 조회가 필요하면 read-only 도구로 상태를 확인하고 요약합니다.
5. 변경 명령이 필요하면 승인 요청을 표시하고, 승인된 경우 사용자가 보는 터미널에서 실행합니다.
6. 응답 완료, 오류, 취소 시 질문에 묶인 터미널 snapshot과 임시 도구 상태를 정리합니다.
