# 모바일 SSH 엔진 Rust(russh) → Go 전환 계획

브랜치: `feat/mobile-go-engine`

## 목적과 스코프

**목적**: 모바일 SSH 엔진을 russh(Rust)에서 Go로 옮기고, 모바일이 Go 엔진으로 동작하게 한다. Rust 의존을 전부 제거한다.

**스코프 밖(이후 작업)**: tsnet 도입. 이 계획은 tsnet을 포함하지 않으며, ssh-core에 `tailscale.com` 의존을 추가하지 않는다. 따라서 sync-api로의 의존성 파급도 이 단계에서는 발생하지 않는다.

## 근거 실측치 (2026-07-27)

| 항목 | 값 |
|---|---|
| 교체 대상 1st-party Rust | 1,705 LOC (5개 파일) |
| 모바일 TS의 russh import 지점 | 2개 (`lib/vault.ts`, `store/useMobileAppStore.ts`) |
| 네이티브 크기 (arm64, stripped) | russh `.so` 4.2MB → Go 4.8MB (**중립**) |
| CI 절감 | `mobile native artifact check` 9.9분 중 Rust 493초(83%). 워크플로 임계경로 |
| gomobile bind (로컬 M-시리즈) | android/arm64 10.6초, ios/arm64 7.5초 |

검증 완료: `services/ssh-core/mobile/` 서브패키지가 모듈 루트 안이므로 `internal/sshconn`을 **그대로 import 가능**(android/arm64·ios/arm64 bind 성공). `pkg/` 승격이나 별도 모듈이 필요 없다.

## 재사용 / 신규 경계

경계는 데몬 결합도(`protocol.`·`emit(` 참조 수)로 갈린다.

| 대상 | 결합도 | 처리 |
|---|---|---|
| `internal/sshconn` (~1,236 LOC) | **0** | 그대로 재사용. russh `ssh_connection.rs`+`private_key.rs`(748 LOC)를 상위집합으로 흡수 |
| `pkg/coretypes` | — | 그대로 재사용 |
| `internal/sshsession/manager` | 34 | push-over-stdio 데몬 모양 → 재사용 불가 |
| `internal/sftp/service` | 88 | 동일 → 재사용 불가 |

**신규 작성 ≈ 700 LOC**: 링버퍼/커서(`ssh_shell.rs` 548 LOC 이식, ~500) + SFTP 얇은 래퍼(~150) + Argon2id(~30). 여기에 RN Turbo Module 브리지 한 겹(uniffi가 자동 생성해 주던 부분, 순증).

## 전체 단계

| 단계 | 내용 | 위험 | 앱 영향 |
|---|---|---|---|
| **1** | Go 엔진 코어 — 링버퍼 + 셸 세션 + bind 표면. Go 테스트까지 | 낮음 | 없음(순수 추가) |
| **2** | RN 브리지 + 엔진 인터페이스. **셸만** 수직 슬라이스로 실기기 검증, 플래그 다크런치 | **높음** | 플래그 off 시 없음 |
| **3** | 잔여 표면 이관 — SFTP, vault KDF(Argon2id), 키 검증·생성 | 중간 | 플래그 off 시 없음 |
| **4** | 기본값 전환 → 검증 → Rust 패키지 2개·CI 스텝 삭제 | 중간 | 전환 |
| 이후 | tsnet 도입(별건) | — | — |

단계 2를 가장 작은 표면으로 앞세우는 이유: 브리지가 이 작업의 최대 미지수이므로 가장 이른 시점에 실기기로 증명한다. 브리지가 검증된 뒤 단계 3에서 나머지 표면을 같은 통로로 얹는다.

---

# 단계 1 세부 계획

목표: **앱을 전혀 건드리지 않고**, bind 가능한 Go 셸 엔진을 링버퍼까지 완성하고 Go 테스트로 등가성을 증명한다.

## 1-1. 모듈 준비

- `services/ssh-core/go.mod`에 `golang.org/x/mobile` 추가 (gomobile bind 요구사항).
- **주의**: 프로브에서 이 추가가 기존 의존 버전을 올렸다 — `x/sync 0.19.0→0.22.0`, `x/sys 0.46.0→0.47.0`, `x/tools 0.11.0→0.48.0`. 따라서 같은 커밋에서:
  - `services/sync-api`도 `go mod tidy` (local replace 때문. 안 하면 `missing go.sum entry`로 깨짐)
  - ssh-core·sync-api·데스크톱 테스트 전체 재실행으로 회귀 확인
- `scripts/build-mobile-engine.sh` 신규: android 4 ABI + ios/arm64 bind. 산출물 경로와 `-ldflags="-s -w"` 고정.

## 1-2. 링버퍼 (`services/ssh-core/mobile/ringbuf/`)

SSH와 무관한 순수 자료구조로 분리해 단위테스트를 쉽게 한다.

`ssh_shell.rs`의 상수를 **그대로** 보존한다:

| 상수 | 값 |
|---|---|
| 링 용량 | 2 MiB |
| 최대 청크 크기 | 16 KB |
| `readBuffer` 기본 상한 | 512 KB |
| 코얼레싱 기본 | 16 ms |
| 브로드캐스트 용량 | 1024 청크 |

타입:
- `Chunk{Seq uint64, TMs float64, Stream StreamKind, Bytes []byte}` (내부는 uint64 유지, bind 표면에서만 int64)
- `Cursor`: `Head` / `TailBytes{bytes}` / `Seq{seq}` / `TimeMs{tMs}` / `Live`
- `Stats{RingBytesCount, UsedBytes, ChunksCount, HeadSeq, TailSeq, DroppedBytesTotal}`
- `ReadResult{Chunks, NextSeq, Dropped *DroppedRange}`

동작:
- `Append(stream, data)` — 16KB 단위로 분할, 용량 초과 시 앞에서 축출하며 `DroppedBytesTotal`·`HeadSeq` 갱신
- `Read(cursor, maxBytes) → ReadResult` — 커서가 축출 구간을 가리키면 `Dropped` 범위를 채워 반환
- `CurrentSeq() = TailSeq + 1`

테스트: 축출 경계, seq 연속성, `Dropped` 범위 정확성, `TailBytes` 경계(청크 중간에 걸릴 때), 빈 링, `maxBytes` 절단, 동시 Append/Read 레이스(`-race`).

## 1-3. 라이브 브로드캐스트 + 리스너 코얼레싱

Rust는 tokio `broadcast`(cap 1024) + 리스너별 task. Go는 리스너별 goroutine + 버퍼 채널(1024)로 옮긴다.

- 채널 오버플로 = Rust의 `Lagged` → `OnDropped(from, to)` 이벤트로 승격
- `coalesceMs`(기본 16) 창 안의 청크를 모아 콜백 1회로 합침 → 브리지 크로싱을 초당 62회 이하로 억제
- `AddListener(l, cursor, coalesceMs) uint64` / `RemoveListener(id)`

**핵심 등가성 테스트**: TS가 쓰는 시퀀스를 그대로 재현한다.
```
r := Read(Head)                      // 리플레이
AddListener(cb, Seq{r.NextSeq}, 16)  // 이어받기
```
이 조합에서 **유실 0·중복 0**이어야 한다. 리플레이와 라이브 사이 경계에서 쓰기가 계속되는 상황을 넣어 검증한다(현행 앱의 `subscribeToSessionTerminal`이 정확히 이 패턴).

## 1-4. 셸 세션 (`mobile/shell.go`)

- `sshconn.DialClient(target, config, responder)` → `*ssh.Client` (재사용)
- `ssh.Session` + `RequestPty(term, h, w, modes)` + `Shell()`
- stdout/stderr 리더 goroutine → `ring.Append`
- `TerminalType` 7종 매핑 유지: `vanilla/vt100/vt102/vt220/ansi/xterm/xterm-256color`
- 기본 PTY 모드 보존: `ECHO/ECHOK/ECHOE/ICANON/ISIG/ICRNL/ONLCR` + `TTY_OP_ISPEED/OSPEED 38400`, 기본 24×80
- `SendData`, `Close`, `BufferStats`, `CurrentSeq`, onClosed 콜백
- `Resize` 추가 — russh 쪽엔 없지만 ssh-core에 있으므로 이 기회에 포함

테스트: `internal/sshconn/jump_test.go`의 인프로세스 `ssh.ServerConfig` 하니스를 차용해 실제 SSH 핸드셰이크 → PTY → 에코 왕복까지 검증.

## 1-5. bind 표면 (`mobile/bind.go`)

gomobile 제약을 API 형태로 흡수한다. 프로브로 확인한 제약:

| 제약 | 대응 |
|---|---|
| `uint64`/`uint32`/`uint` 미지원 | 표면은 `int64`, 내부는 uint64 유지 |
| struct 슬라이스 미지원 | 리플레이는 **연결된 단일 `[]byte`** + 결과 핸들 객체. 현행 TS도 `chunk.bytes`만 쓰고 청크별 seq/tMs는 안 씀 |
| Rust식 enum 미지원 | 콜백을 2메서드로 분리: `OnChunk(seq, tMs, stream, data)` / `OnDropped(from, to)` |
| 반환값 2개 제한(2번째는 error) | `*ReadResult` 핸들 + 접근자(`Data()`, `NextSeq()`, `HasDropped()`…) |
| 재귀 struct (`Target.Jump *Target`) | 접속 옵션은 **JSON 문자열 in**, Go 내부에서 `sshconn.Target`으로 언마샬 |
| bind마다 Go 런타임 1개 | **bind 타깃은 `mobile` 단일 패키지로 고정.** AAR을 쪼개면 런타임 중복 적재 |

## 1-6. 수용 기준

- [ ] `go test ./mobile/... -race` 통과
- [ ] `gomobile bind` android(arm64/armv7/x86_64/x86) + ios/arm64 전부 성공
- [ ] 커서 등가성 테스트(1-3) 통과 — 유실·중복 0
- [ ] `libgojni.so` 크기 기록, 기준선 4.8MB 대비 회귀 가드
- [ ] ssh-core·sync-api·데스크톱 기존 테스트 전부 통과(1-1의 의존 버전 상승 회귀 확인)
- [ ] **앱·CI의 Rust 경로 무변경** — 이 단계는 순수 추가

## 단계 1에서 하지 않는 것

RN 브리지(Kotlin/Swift/TS), 앱 코드 수정, SFTP, vault KDF, Rust 삭제, tsnet. 전부 이후 단계.

---

# 단계 1 결과 (완료)

## 만들어진 것

| 경로 | 내용 |
|---|---|
| `mobile/ringbuf/ring.go` | 링버퍼 — 청크 분할·축출·커서 해석 |
| `mobile/ringbuf/subscription.go` | 스냅샷+구독 원자 등록, 지연 리스너 감지 |
| `mobile/ringbuf/follower.go` | 리플레이→라이브 추종, 코얼레싱, 갭 보고 |
| `mobile/session/terminal.go` | TerminalType 7종, PTY 기본 모드 |
| `mobile/session/shell.go` | PTY 셸, 출력 펌프, 수명 관리 |
| `mobile/session/conn.go` | `sshconn.DialClient` 기반 연결, 셸 레지스트리 |
| `mobile/bind.go` | gomobile 표면 |
| `mobile/internal/sshtest/server.go` | 인프로세스 SSH 픽스처(PTY+에코 셸) |
| `apps/mobile/scripts/build-engine.cjs` | bind 스크립트 (`npm run mobile:engine:build`) |

## 크기 실측 (arm64)

| | 비압축 | 압축(deflate) |
|---|---|---|
| russh `.so` (stripped) | 4.21 MB | 1.92 MB |
| Go 엔진 `libgojni.so` | **6.51 MB** | **2.48 MB** |
| 릴리스 AAR (arm64 단일, classes.jar 포함) | — | 2.58 MB |

**앱 다운로드 증가분은 약 +0.6 MB**입니다(APK는 `.so`를 압축 저장하므로 압축 기준이 사용자가 실제로 받는 값). 4 ABI 전체 AAR은 11.0 MB, iOS XCFramework는 7.9 MB.

계획 작성 시 적어둔 "기준선 4.8MB"는 의존이 거의 없는 프로브에서 나온 값이었고, 실제 엔진(`sshconn` 전체 + `gorilla/websocket` 경유 WSProxy 지원 포함)은 6.51 MB다. 회귀 가드 기준선은 이 값으로 대체한다.

## Rust 대비 의도적 차이 3건

1. **스냅샷과 구독을 원자적으로 등록한다.** russh의 `add_listener`는 `read_buffer` → `subscribe()` 순서라 그 사이에 도착한 청크가 리플레이에도 구독에도 없어 유실됐다. `Ring.Subscribe`가 같은 락 안에서 둘을 처리해 이 창을 없앴다. 유실만 줄어들 뿐이라 앱 계약은 그대로다.
2. **갭을 플래그가 아니라 seq 불연속으로 탐지한다.** 큐가 넘칠 때 버려지는 건 최신 청크인데 리스너는 아직 과거를 소화 중이므로, "밀렸다" 플래그가 서는 시점은 실제 구멍보다 훨씬 앞이다. 수신한 청크의 seq를 기대값과 비교하면 구멍의 위치가 정확해진다.
3. **`CursorTimeMs`에 해당 청크가 없으면 아무것도 재생하지 않는다.** russh는 이 경우 인덱스 0으로 떨어져 링 전체를 재생했다. 앱이 쓰지 않는 커서라 영향은 없다.

## 검증 결과

- `go test ./mobile/... -race` — ringbuf / session / mobile 3개 패키지 통과
- 커서 등가성 — `Read(Head)` → `Follow(Seq{NextSeq})` 인계를, 쓰기가 지속되는 상태로 20회 반복해 **유실 0·중복 0** 확인
- 큐 오버플로 — 전달된 청크와 보고된 드롭 범위의 합이 기록 전체와 정확히 일치(중복·누락 0)
- `gomobile bind` — android arm64/armv7/x86_64/x86 + ios/arm64 **전부 성공** (로컬 각 ~5.5초)
- 바인딩된 표면 — `Engine`/`Conn`/`Shell`/`ReadResult` + 호스트 구현용 프록시(`Listener`/`InteractiveResponder`/`ShellClosedCallback`)
- 기존 회귀 — ssh-core 전체, sync-api 전체, 데스크톱 ssh-core 바이너리 빌드 모두 통과
- Rust 경로 변경 0

**32비트 ABI가 실제 버그를 잡았다**: `clampUint32`가 `int`(32비트)와 `math.MaxUint32`를 비교해 armeabi-v7a/x86에서 컴파일이 깨졌다. arm64만 빌드했다면 릴리스까지 살아남았을 문제다. 4 ABI 전부를 CI에서 컴파일 대상으로 유지할 근거.

---

# 단계 2 진행 상황

2-1 ~ 2-4 완료·검증. 2-5(스토어 배선)만 남았고, 앱 코드는 아직 변경 0이다.

## 2-1 bind 표면 확장 (완료)

connect 경로에서 Phase 1에 없던 것이 드러나 추가했다.

- **`Engine.ProbeHostKey`** — russh는 핸드셰이크 중 `onServerKey` 콜백으로 신뢰를 묻지만 `sshconn`은 미리 받은 키 목록으로 strict 검사만 한다. 그래서 **probe → 사용자 승인 → 승인된 키만 신뢰해 connect** 순서가 필요하다(데스크톱과 동일).
- **`Conn` 연결 끊김 콜백** — `client.Wait()` 감시. 폰이 신호를 잃으면 disconnect 메시지가 오지 않으므로 이것만이 유일한 신호다. 명시적 `Close()`에는 발화하지 않는다(호출자가 이미 안다).
- **`InspectPrivateKey` / `InspectCertificate`** — 연결 전 자격증명 사전 검증.
- `session.Dial`을 `DialOptions`로 정리.

**russh는 keyboard-interactive를 지원하지 않는다**(TS API·Rust 양쪽 확인). 따라서 responder를 nil로 두는 것이 정확한 동등이며, `sshconn`이 이미 지원하므로 나중에 추가할 수 있는 상향 여지다.

## 2-2 Android (완료)

`GoSshEngineModule.kt` — 앱 로컬 네이티브 모듈(`AwsSsoBridgePackage`에 등록, 기존 선례와 동일 방식). AAR은 `implementation files(...)`로 연결하고, 없으면 명확한 메시지로 실패하게 했다.

검증: `:app:compileDebugKotlin` 통과(AAR의 Java API 해석 확인), `:app:mergeDebugNativeLibs`에서 **4개 ABI `.so` 전부 병합 확인**.

## 2-3 iOS (완료)

로컬 CocoaPods pod(`ios/GoSshEngine/`)로 XCFramework를 vendoring. CocoaPods는 pod 내부의 프레임워크만 받으므로 빌드 스크립트가 복사해 넣는다.

검증: `pod install` 성공, `xcodebuild -target GoSshEngine` **BUILD SUCCEEDED**(`libGoSshEngine.a` 산출).

**Swift ObjC 인터롭이 3가지를 바꿨다** — 컴파일로만 잡히는 것들:
1. ObjC 프로토콜에 동명 클래스가 있어 Swift에서 `MobileListenerProtocol` 등으로 접미사가 붙는다.
2. `sendData`→`send`, `addListener`→`add` (첫 인자 라벨 중복 제거 규칙).
3. **`_Nonnull NSString`을 반환하는 메서드는 `throws`로 임포트되지 않는다** — 반환값에 실패를 표현할 여지가 없어 `NSErrorPointer`가 그대로 노출된다. `callReturningString` 헬퍼로 처리.

## 2-4 TS 엔진 계층 (완료)

`src/engine/` — `MobileSshEngine` 인터페이스 + Go/russh 어댑터 + 선택 플래그. **기본값은 russh**이고, Go는 명시적으로 선택해야 하며 네이티브 모듈이 없으면 러쉬로 폴백한다.

설계상 좋았던 점 둘:
- **자격증명·호스트키 타입이 이미 엔진 중립적**이었다. `ServerPublicKeyInfo`를 `MobileServerPublicKeyInfo`와 같은 형태(`keyBase64` 포함)로 맞춰 스토어 경계에서 매핑이 0이다.
- 네이티브 모듈을 **호출 시점에 지연 조회**하도록 해서 import 순서에 무관하고 테스트도 쉬워졌다.

capability 차이 1건: **russh에는 resize가 없다**(window-change 요청 미노출). 어댑터에서 no-op이며 문서화했다. Go 엔진은 지원한다.

검증: jest 24개 통과, `tsc --noEmit` 통과, 모바일 전체 21 스위트/229 테스트 통과.

## 2-5 스토어 배선 (완료)

`subscribeToSessionTerminal`이 `SessionScreen`의 `useEffect` cleanup으로 직접 쓰이므로 **동기적으로** unsubscribe를 반환해야 한다. 반면 엔진의 `readBuffer`/`follow`는 브리지를 건너므로 비동기다.

**동기 계약을 유지했다.** `readBuffer(head)`→`onReplay`, 이어 `follow(seq: nextSeq)`→`onData`를 백그라운드로 시작하고 unsubscribe는 즉시 반환한다. 두 호출 사이 출력은 네이티브 링버퍼가 보관하고 커서 인계가 유실·중복 0을 보장하므로(단계 1에서 검증) 안전하다. `SessionScreen`은 변경 0.

부착 도중 unsubscribe되는 경우를 `cancelled` 플래그로 처리한다 — 리스너가 늦게 붙으면 즉시 떼서 누수시키지 않는다.

배선한 곳 5곳: `SshRuntimeSession` 타입(`engineName` 추가, 세션은 열릴 때의 엔진을 유지), `connectSshSessionRecord`, `subscribeToSessionTerminal`, `disconnectRuntimeSession`, `writeToSession`.

`validateRusshSecurity`는 **의도적으로 russh에 남겼다.** 동기 함수라 엔진 경유로 바꾸면 async 파급이 생기고, SFTP 경로가 아직 russh이므로 검증만 Go로 옮기면 오히려 엔진이 섞인다. Phase 3에서 SFTP·vault와 함께 옮긴다.

`disconnect()`는 인터페이스와 russh의 메서드명이 같아 변경이 필요 없었다.

## 단계 2 검증 결과

- 루트 `npm run typecheck` (데스크톱+모바일) 통과
- 모바일 jest **21 스위트 / 229 테스트 전부 통과**
- `gomobile bind` android 4 ABI + ios/arm64 성공, `:app:compileDebugKotlin` 통과, `xcodebuild -target GoSshEngine` BUILD SUCCEEDED
- ssh-core `go test ./... -cover` (CI와 동일 방식) 통과

**가장 의미 있는 증거**: 기존 스토어 테스트가 `RnRussh.connect`/`startShell`에 넘어가는 인자 형태를 직접 검증하는데, 엔진 추상화를 거친 뒤에도 그대로 통과한다. 플래그 off 경로가 동작상 완전히 동일하다는 뜻이다.

### 검증 중 발견한 기존 문제 (이 작업과 무관)

`go test ./internal/sshsession/ -race -run TestReinjectShellIntegrationInjectsAfterPromptSettles`가 **100% 재현되는 데이터 레이스**로 실패한다. base(`main` 8474ac37)에서 동일하게 실패하므로 기존 문제다. CI가 ssh-core 잡을 `-race` 없이(`go test ./... -cover`) 돌려서 드러나지 않았다. `-race`는 sync-api 일부에만 적용된다. 별건으로 분리했다.

(`internal/ssmforward`도 `-race` 하에서 한 번 실패했으나 base·현재 브랜치 양쪽에서 재실행 시 통과 — 타이밍 플래키로 판단.)

## 남은 것

**실기기 검증**이 남았다. 코드·빌드·단위 테스트는 모두 통과했지만, 플래그를 Go로 켠 상태에서 실제 접속·터미널 입출력·재연결을 확인한 적은 없다. `selectEngine('go')`로 전환한 뒤 확인할 항목:

- 접속(비밀번호/키/인증서), 미신뢰 호스트에서 프로브→승인 프롬프트
- 터미널 리플레이와 라이브 출력의 이음새, 한글·유니코드 폭
- 백그라운드 복귀, 네트워크 끊김 시 `onDisconnected`
- base64 왕복의 체감 지연(필요하면 JSI로 교체 — TS 인터페이스는 그대로)

이후 Phase 3(SFTP·vault KDF·키 검증 이관) → Phase 4(기본값 전환 후 Rust 삭제).
