# Dolgate AI 어시스턴트 설계 (v1)

> 상태: **설계 초안 · 구현 전.** SSH/EC2 연결 화면에 LLM 어시스턴트를 붙이기 위한 설계와 그 근거를 정리한다.

## 1. 목표 / 비목표

**목표** — SSH·EC2 세션에서 개발자가 앱을 떠나지 않고 다음을 해결:
- "그 명령 뭐였지" (명령 생성)
- "이 에러/로그 뭐야" (출력 해석)
- "이거 고쳐줘" (조사 → 조치, 에이전트 루프)

이미 사람들이 하고 있는 "터미널 옆 ChatGPT 탭에 복붙 왕복"을 없애는 게 본질. **세션 컨텍스트를 쥔 앱만** 잘할 수 있는 방식으로 한다.

**차별화 축**: 모델이 아니라 ① **컨텍스트 그라운딩** ② **프라이버시(BYOK·로컬 모델)**. 모델(GPT/Claude/Gemini)은 commodity라 "지능"으로는 경쟁 불가. Dolgate는 이미 컨텍스트 기관(자동완성 in-band 스냅샷 + OSC 133 명령 경계)을 갖고 있어 유리하다.

**v1 비목표**:
- 인라인(프롬프트) 명령생성 — 자동완성 위젯과 충돌, 셸/AI 입력 모드 모호성 (§2)
- raw SSM 폴백 세션에서의 AI 실행 — ssh.Client가 없음 (§7). → **v2**
- 모바일, KMS 세션 암호화, 멀티 에이전트
- OAuth·서버 프록시 인증 — v1은 **BYO API 키**. 확장은 나중(§3.5)

## 2. 핵심 설계 결정 (요약 + 근거)

| # | 결정 | 채택 | 기각한 대안과 이유 |
|---|------|------|--------------------|
| 1 | AI 입력 표면 | **별도 우측 패널(자기 입력창)** | 인라인 기각: 자동완성 ghost-text·Tab·OSC 프로브가 같은 프롬프트 줄을 써서 충돌 + "방금 친 게 셸 명령이야 AI 질문이야" 모드 모호성 |
| 2 | AI가 명령 실행하는 방식 | **AI 전용 SSH exec 채널** (패널에 트랜스크립트) | ① 인간 PTY에 타이핑 기각: 출력 뒤섞임·충돌·캡처 불가 ② raw SSM 세션 추가 기각: PTY 파싱이라 캡처 지저분 |
| 3 | 실행 트랜스포트 | **세션의 기존 `ssh.Client` 재사용 + exec 채널 추가** | 새 연결 기각. EC2도 이제 SSH-over-SSM이라 ssh.Client 보유 → SSM 터널·pubkey·agent-fwd를 이미 세워진 채로 공유 |
| 4 | 컨텍스트 주입 | **사용자 명시 첨부**(출력 선택→"AI에게" / 첨부 태그) | 자동 포커스추적 기각: 분할 워크스페이스에서 "어느 pane?" 애매 + 멀티호스트 오발사 위험. 명시하면 그 문제가 사라짐 |
| 5 | AI 실행 가용성 판정 | **"세션에 ssh.Client가 있나"** | SSH / EC2-over-SSM / Warpgate = 지원. raw SSM 폴백 = 미지원(v2) |

## 3. 설정 (Settings)

### Provider 추상화
| 어댑터 | 커버 | 비고 |
|--------|------|------|
| **OpenAI-Compatible** (기본) | OpenAI · Azure · Groq · Together · vLLM · **Ollama · LM Studio(로컬)** | `baseUrl`+`apiKey`+`model` 한 세트로 대부분 흡수 |
| **Anthropic** | Claude | 메시지 포맷 상이, 별도 어댑터 |
| **Google (선택)** | Gemini | 포맷 상이, 후순위 |

### 저장 위치 (Dolgate 기존 규칙 준수)
- **비밀값(apiKey) → `SecretStore`(OS 키체인).** `AppSettings`는 sync-api로 모바일 동기화되므로 키를 넣으면 안 됨 (AWS 시크릿·auth 토큰이 이미 키체인에 있는 것과 동일 원칙).
- **비밀 아닌 설정 → `AppSettings.ai`** (동기화 O).

```ts
// AppSettings.ai (shared-core/models.ts) — 동기화 O, 키 제외
ai?: {
  enabled: boolean;
  providerId: "openai-compat" | "anthropic" | "google";
  baseUrl?: string;         // openai-compat 전용
  model: string;
  temperature?: number;
  features: { panel: boolean; execution: boolean };
  tools: {                  // 도구별 on/off (§7.5)
    runCommand: boolean;    // 호스트 명령 실행
    webSearch: boolean;     // 클라이언트 웹 검색
    fetchUrl: boolean;      // 클라이언트 URL 조회
  };
  search?: {                // 웹 검색 백엔드 (provider 무관 BYOK)
    backend: "provider-native" | "brave" | "tavily" | "exa";
  };
  mcpServers?: Array<{      // 확장 도구 = MCP 서버 (§7.6)
    id: string;
    label: string;
    transport: "stdio" | "http";
    command?: string; args?: string[];   // stdio
    url?: string;                          // http
    enabled: boolean;
    trusted: boolean;       // 명시 신뢰(설치 시 사용자 승인) 전엔 tool 비활성
  }>;
  privacy: { localOnly: boolean };  // 로컬 모델만; localOnly면 web/fetch·http-MCP 기본 비활성
};
// SecretStore(키체인): ai:apiKey:<providerId>, ai:searchKey:<backend>, ai:mcpAuth:<serverId>
```

### LLM 클라이언트 소유
**main 프로세스가 소유.** 렌더러는 키를 절대 못 보고, 네트워크 송신(egress)이 한 곳에 모여 감사·`localOnly` 차단이 용이 (iTerm2의 "AI를 별도 컴포넌트로 격리" 설계와 동일한 이유).

## 3.5 인증 / 온보딩 모드

**v1 결정: BYO API 키.** 사용자가 provider 키를 직접 넣어 쓴다. 마찰은 UX로 줄인다 — provider 키 페이지 **딥링크 + "키 생성" 안내 + 붙여넣고 즉시 "연결 테스트"(1회 호출 검증)**. 키는 SecretStore(키체인, 동기화 X).

OAuth("Sign in with ChatGPT/Claude" 류)와 서버 프록시는 **v1 제외** — 이유: OAuth는 1st-party CLI 전용·서드파티 재사용 ToS 회색지대·provider별 상이라 리스크. 서버 프록시는 인프라 추가.

**나중 확장 (가능하면, 아니면 말고):**
- **서버 프록시 AI** — `awsSsmServerProxyEnabled`의 AI판. sync-api가 키를 쥐고, 사용자는 Dolgate 로그인만(조직키 팀 공유). 쉬운 온보딩·팀용. 되면 강력.
- **provider OAuth** — sanctioned 확인된 provider만.

로컬/자체호스팅 모델은 어차피 BYO-endpoint(baseUrl, 키 선택)로만 가능.

## 4. UX — SSH 연결 화면

### 패널
- 우측 토글(`⌘I`), **split 레이아웃 트리 바깥의 오버레이** (leaf로 넣지 않음 — tmux 레이아웃 1:1 고정과 충돌·리사이즈 셰이크 방지), **세션 탭당 1개**, **자기 입력창**.
- 대화는 탭 단위로 유지. 토글해도 안 사라짐.

### 컨텍스트 주입 (명시적)
- 터미널 출력 **드래그 선택 → "AI에게"** → 그 블록 첨부.
- 또는 질문 시 **현재 포커스 pane의 최근 출력**을 자동 첨부하되, 입력창 위 **제거 가능한 태그**("첨부: web-03 최근 50줄")로 "지금 뭘 보는지" 항상 표시.
- 어느 pane인지는 **사용자 행동이 결정**한다(앱이 추론하지 않음) → 분할/멀티호스트 애매함 소멸.

### 실행 트랜스크립트 (에이전트 루프)
명령마다 카드: **명령 + 읽기/변경 배지 + (변경이면) 승인 버튼**, 출력은 접힘.

```
┌── 터미널 (분할이든 tmux든 그대로) ──────┬── [AI] ⌘I ────────────┐
│ web-03 $ systemctl status nginx        │ You: nginx 왜 죽었어?  │
│ ● failed                               │ AI: 상태 볼게요.        │
│  ↑ 드래그 선택 → "AI에게"                 │  $ systemctl status …  │
│                                        │    [읽기전용·자동]      │
│                                        │  $ ss -ltnp | grep :80 │
│                                        │    [읽기전용·자동]      │
│                                        │  apache2가 80 점유.     │
│                                        │  $ systemctl stop …    │
│                                        │    [변경 ⚠️][실행][skip]│
│                                        │ ┌ 첨부: web-03 50줄 ×┐ │
│                                        │ [ 입력창 ]             │
└────────────────────────────────────────┴───────────────────────┘
```

## 5. 아키텍처 매핑

| 레이어 | 역할 |
|--------|------|
| **renderer** (React/zustand) | AI 패널 컴포넌트 + zustand 슬라이스, 설정 UI, 트랜스크립트 렌더, "선택→AI에게" |
| **main** (Electron) | LLM 어댑터(OpenAI-compat/Anthropic), 키체인 접근, 토큰 스트리밍, **툴콜 오케스트레이션**(컨텍스트 조립 + 승인 게이트 + 감사). egress 독점 |
| **ssh-core** (Go) | ① 컨텍스트: 자동완성 스냅샷(`ParseSnapshot`) + OSC 133 명령경계 **재사용** ② 실행: 세션 ssh.Client에 exec 채널 (§7) |
| **IPC** | 토큰 스트리밍(main→renderer), exec 요청/결과(main↔ssh-core) |

## 6. 컨텍스트 파이프라인 (= 해자)

AI가 보는 것 — **전부 기존 기관에서 소싱**:
- **호스트 메타**: OS · 라벨 · kind(ssh/aws-ec2/warpgate) — hosts 레코드
- **셸 · cwd · PATH 실행파일 · 최근 히스토리** — 자동완성 in-band 스냅샷 재사용(공짜)
- **마지막 명령 + 출력 + exit code** — OSC 133 마크로 블록 추출(셸 통합 이미 존재)
- **선택 텍스트** — 사용자 첨부

> **키/패스워드/시크릿은 컨텍스트 조립 단계에서 필터링해 LLM에 절대 보내지 않는다.**

## 7. 실행기 (Executor)

```
AI 실행기 = 세션의 기존 ssh.Client 에 exec 채널 하나 더.
```

- ssh-core에 진입점 추가: 활성 SSH 기반 세션에 대해 `client.NewSession()` → 명령 실행 → `{stdout, stderr, exitCode}` 캡처. **exec 채널이라 PTY 파싱·프롬프트 마커 곡예 불필요** — 캡처가 깨끗하다.
- **인터랙티브 세션과 같은 연결 공유** → 같은 호스트키 신뢰·agent forwarding·SSM 터널. 별도 SFTP 연결 경유 불필요.

| 호스트 | 실행 채널 | 새 연결 |
|--------|-----------|---------|
| 일반 SSH | 세션 ssh.Client + exec | ❌ |
| **EC2 (SSH-over-SSM)** | 동일 (SSM :22 터널·pubkey·agent-fwd 공유) | ❌ |
| Warpgate | 동일 | ❌ |
| EC2 raw SSM 폴백 | ssh.Client 없음 → **v2** | — |

**상태 모델 (결정 필요, §10)**: per-command exec(무상태, `cd /x && cmd`로 매번 명시 — 안전·깨끗) vs persistent shell 채널(상태 누적 — 다단계 조사 유리).

## 7.5 도구(Tools) & 에이전트 루프

도구는 **어디서 실행되느냐**로 갈린다 — 웹 검색 설계의 핵심.

### 호스트 도구 (원격 서버 — SSH exec 채널, §7)
- `run_command(cmd)` — 핵심. 읽기/변경 분류 게이트(§8).
- (선택) `read_file` / `list_dir` / `tail_log` — run_command 위 얇은 래퍼, 모델 신뢰성↑.

### 클라이언트 도구 (데스크톱 main 프로세스 — 서버 아님)
- `web_search(query)`, `fetch_url(url)`.
- **왜 서버가 아니라 앱에서?** 원격 서버는 인터넷이 막힌 경우가 흔함(프라이빗 서브넷·egress 차단). 데스크톱은 인터넷 가능 + egress가 한 곳(main)에 모여 감사·차단 용이.

### 웹 검색 = BYOK/플러그블
- provider-native 검색(OpenAI/Anthropic/Gemini 내장)은 편하지만 **로컬·OpenAI-compat 모델에선 불가**.
- → **검색 백엔드도 BYOK**(Brave/Tavily/Exa 키 → 키체인). provider 무관, 로컬 모델에서도 동작. provider-native가 설정되면 빠른 경로로 사용.

### 도구 레이어 = 레지스트리 (→ MCP 확장)
내장 도구(run_command/web_search/fetch_url)를 하드코딩하지 말고 **레지스트리**로 등록. 내장 도구와 확장 도구가 같은 인터페이스를 통과한다.

## 7.6 도구 확장 = MCP 클라이언트

**결정: 자체 플러그인 포맷을 만들지 않고 Dolgate가 MCP 클라이언트가 된다.**
- MCP는 이미 표준이라 수많은 서버(GitHub·Jira·DB·k8s·사내 API…)를 재사용 — 사용자가 tool을 새로 짤 필요 없음. 자체 포맷은 생태계 0이라 기각. (Warp 2026 방향과 동일.)
- 설정에서 MCP 서버 등록(§3 `mcpServers`): **stdio**(로컬 프로세스) 또는 **http**(원격). 서버가 광고하는 tool이 레지스트리에 편입돼 내장 도구와 동일하게 에이전트 루프에서 호출됨.
- **범위**: v1 = 레지스트리 + 내장 도구 3개(구조만 MCP-ready). 실제 MCP 연동 = **Phase 3+**. MCP 클라이언트 런타임(stdio 프로세스 관리 + JSON-RPC + HTTP 전송)은 그 자체로 큰 작업이라 분리.

### MCP 특유의 위험 (§8보다 강함)
- MCP 서버 = **임의 서드파티 코드**. stdio=로컬 프로세스 실행, http=외부 egress.
- **tool description 인젝션**: 악성 서버가 tool 설명문에 지시를 심어 에이전트를 조종(알려진 공격). → 등록 시 **명시 신뢰(`trusted`)** 전엔 tool 비활성 + tool별 on/off + 여전히 **실행 게이트 통과**(MCP tool이 "변경" 판정이면 승인 필요).
- **`localOnly` 충돌**: http MCP는 외부 전송 → localOnly면 **stdio(로컬) MCP만 허용**.

### 에이전트 루프
메시지 → LLM → 도구콜(**호스트=승인 게이트 / 클라이언트=자동+감사**) → 결과 피드백 → LLM → … → 최종 답.
- **반복 상한 + 토큰 예산 가드**(무한 루프 방지) + 정지 버튼 상시.
- provider 어댑터가 tool def / tool_call / tool_result를 provider 포맷으로 정규화.
- **모델이 function calling을 지원해야 함.** 로컬 모델은 편차가 크니, 미지원이면 도구 없이 "제안만" 모드로 degrade.

## 8. 보안 (SSH 도구라 필수)

- **읽기/변경 분류 게이트**: 읽기(`ls`·`cat`·`df`·`status`·`journalctl`)는 자동실행(인디케이터), **변경(`rm`·`restart`·`apt`·`>`·`kill`)은 명시 승인**.
- **승인 모드**: ① 매번 물어봄(기본) ② 읽기 자동·쓰기 승인 ③ 전부 자동(개발박스용).
- **정지 버튼** 상시(루프 중단), **키/시크릿 미전달**, **프롬프트 인젝션 폐회로**(서버 출력→AI→명령의 닫힌 고리; 변경 승인 게이트가 방어선).
- **감사**: AI 실행 명령 전부 activity log에 기록.
- **로컬 모델 옵션**(`privacy.localOnly`): 사내 인프라 팀 대상 강력한 셀링포인트 (Termius가 못 하는 것).
- **웹/외부 도구 인젝션 확대**: 검색·URL 콘텐츠가 LLM 컨텍스트에 들어오면 악성 페이지가 에이전트에 명령을 주입할 수 있음(에이전트가 실행 능력 보유 = 폐회로 증폭). **변경 승인 게이트가 최후 방어선.**
- **검색 쿼리 egress**: 쿼리가 외부 검색 API로 나감 → 에러 메시지의 내부 호스트명·IP 등이 유출될 수 있음. 시크릿 redact + "외부 전송" 표시.
- **`localOnly`와 외부 도구**: 로컬 모델 프라이버시 모드에서 web/fetch가 외부로 나가면 모순 → localOnly면 클라이언트 외부 도구 **기본 비활성**, 명시 opt-in만.

## 9. 단계 (Phasing)

| Phase | 내용 | 특징 |
|-------|------|------|
| **1** | 설정(provider 어댑터+키체인) + **읽기 전용 패널**(명시 컨텍스트 첨부·해석·명령 제안) + **클라이언트 도구**(web_search·fetch_url, 서버 실행 X) | 리서치 어시스턴트. 최고가치·최저위험 (서버 안 건드림) |
| **2** | **호스트 실행 도구**(`run_command`, SSH exec 채널) + 읽기 자동/변경 승인 게이트 + 감사 | 에이전트 루프 완성 |
| **3** | 승인 모드 완화 옵션 + **MCP 클라이언트**(stdio/http 서버 등록·tool 편입) | 확장 도구 |
| **v2** | raw SSM 폴백 세션 실행, 모바일, KMS | 별도 |

각 단계는 기존 이니셔티브처럼 **피처 플래그 + 병행 + 테스트** 기반으로 낸다.

## 10. 열린 결정

1. **승인 기본값** — 매번 vs 읽기자동·쓰기승인
2. **실행 상태 모델** — per-command exec(무상태) vs persistent 셸(상태 누적)
3. **Day-1 provider** — OpenAI-compat + 로컬만? Anthropic도?
4. **AI 설정 동기화** — 비밀 아닌 설정을 모바일 동기화에 포함할지 (키는 불가)
5. **패널 폭/위치** — 오버레이는 확정, 기본 폭·접힘 동작
6. **웹 검색 백엔드** — provider-native vs BYOK 검색(Brave/Tavily/Exa) 우선순위
7. **MCP 지원 시점** — 레지스트리·구조는 v1부터 MCP-ready, 실제 연동은 Phase 3 확정. 앞당길지 여부만 미정
8. **localOnly ↔ 웹검색** — 프라이버시 모드에서 외부 도구 허용 정책
9. ~~AI 인증 기본 모드~~ → **결정됨: v1 = BYO API 키.** 서버 프록시·OAuth는 확장(§3.5).

---

## 11. v1 개발 계획 (BYO API 키 기준, 순서대로)

각 단계는 **피처 플래그 + 병행 + 테스트**로 독립 출시 가능하게 (AWS 이니셔티브와 동일 방식). 각 단계 끝에 실제로 쓸 수 있는 게 나온다.

**1) 설정 & provider 배관 (토대)**
- shared-core: `AppSettings.ai` 스키마 + 키체인 `ai:apiKey:<providerId>`.
- main: provider 어댑터 인터페이스 + **OpenAI-compat 어댑터**(chat·스트리밍·tool-calling) + **Anthropic 어댑터**. LLM 클라이언트 main 소유(egress 격리).
- renderer 설정 UI: provider 선택 · baseUrl/model · **API 키 입력(딥링크 + "연결 테스트" 검증)**.
- IPC: `ai.testConnection`, `ai.chat`(스트리밍).

**2) 패널 셸 — 읽기 전용 (도구·실행 없음)**
- renderer: 우측 토글 패널(`⌘I`, split 트리 밖 오버레이, 탭당 1개, 자기 입력창) + zustand `ai` 슬라이스 + 트랜스크립트.
- 컨텍스트: "출력 선택 → AI에게" + 포커스 pane 최근 버퍼 자동첨부(제거 가능 태그). OSC 133/스냅샷 재사용.
- main: 컨텍스트 조립(호스트 메타 + 스냅샷 + 선택 블록) + **시크릿 필터** + 토큰 스트리밍.
- → **출시 가능**: "터미널과 대화하는" 어시스턴트.

**3) 클라이언트 도구 — web_search · fetch_url**
- main: 도구 레지스트리 + `web_search`(BYOK 검색 백엔드) + `fetch_url` + **에이전트 루프**(반복/토큰 가드 + 정지 버튼).
- 설정: `ai.tools` 토글 + `ai.search` 백엔드/키(키체인).
- → **출시 가능**: 리서치 어시스턴트 (서버 안 건드림).

**4) 호스트 실행 도구 — run_command (에이전트 완성)**
- ssh-core: 세션 `ssh.Client`에 exec 채널 진입점 → `{stdout, stderr, exit}`. 가용성 = ssh.Client 유무(SSH/EC2-over-SSM/Warpgate; raw SSM 폴백 = 비활성).
- main: `run_command` 도구 + **읽기/변경 분류 + 승인 게이트**(승인 모드) + activity log 감사.
- renderer: 명령 카드(읽기/변경 배지 + 승인/건너뛰기) + 정지 버튼.
- → **에이전트 루프 완성**.

**나중 (확장, 되면 · 아니면 말고):** MCP 클라이언트 · 서버 프록시 인증 · provider OAuth · raw SSM 폴백 실행 · 모바일.

### 부록: 왜 인라인이 아니라 패널인가 (결정 1 상세)
인라인(프롬프트에서 자연어→명령)은 트렌드상 매력적이지만 Dolgate에선 충돌이 크다:
- **자동완성 위젯과 경쟁** — ghost text·Tab 완성·OSC 6973 프로브가 이미 프롬프트 줄을 점유. AI 제안까지 얹으면 렌더링·키바인딩이 엉킴.
- **모드 모호성** — 프리픽스(`#`)나 특수키로 "셸 vs AI"를 구분해야 하는데 그 자체가 인지 부담.

패널은 **자기 입력창**을 가져 이 충돌이 원천 소멸한다. 인라인은 v1 이후 재검토.
