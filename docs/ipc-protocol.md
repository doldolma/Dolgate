# SSH 코어 IPC 프로토콜

이 문서는 Electron `main`과 Go `ssh-core` 사이의 framed stdio 프로토콜만 다룹니다.
Electron IPC, preload API, session share WebSocket은 범위에 포함하지 않습니다.

Electron `main` 프로세스는 stdio 위의 framed binary 프로토콜로 Go SSH 코어와 통신합니다.

프레임 형식은 다음과 같습니다.

- `1 byte`: frame kind
- `4 bytes`: metadata 길이 (big-endian)
- `4 bytes`: payload 길이 (big-endian)
- `N bytes`: metadata JSON
- `M bytes`: raw payload

frame kind는 두 가지입니다.

- `1`: control frame
- `2`: stream frame

## 요청 Envelope

```json
{
  "id": "req_1",
  "type": "connect",
  "sessionId": "optional-session",
  "endpointId": "optional-endpoint",
  "jobId": "optional-job",
  "payload": {}
}
```

위 요청은 `control frame`의 metadata에 JSON으로 담기고, payload는 비어 있습니다.

## 이벤트 Envelope

```json
{
  "type": "connected",
  "requestId": "req_1",
  "sessionId": "session_1",
  "endpointId": "optional-endpoint",
  "jobId": "optional-job",
  "payload": {}
}
```

이 역시 `control frame`의 metadata에 JSON으로 담깁니다.

## 명령 종류

- `health`
- `connect`
- `resize`
- `disconnect`
- `sftpConnect`
- `sftpDisconnect`
- `sftpList`
- `sftpMkdir`
- `sftpRename`
- `sftpDelete`
- `sftpChmod`
- `sftpReadFile`
- `sftpWriteFile`
- `sftpTransferStart`
- `sftpTransferCancel`
- `tailnetTest`
- `tailnetForget`

## 이벤트 종류

- `status`
- `connected`
- `error`
- `closed`
- `sftpConnected`
- `sftpDisconnected`
- `sftpListed`
- `sftpFileRead`
- `sftpAck`
- `sftpError`
- `sftpTransferProgress`
- `sftpTransferCompleted`
- `sftpTransferFailed`
- `sftpTransferCancelled`
- `tailnetStatus`
- `tailnetForgot`

## stream frame

터미널 입출력은 control 이벤트와 분리된 `stream frame`으로 전달합니다. 이 경로는 base64를 사용하지 않고 raw bytes를 그대로 실어 보내므로, 문자열 변환 오버헤드와 UTF-8 깨짐 문제를 줄일 수 있습니다.

```json
{
  "type": "data",
  "sessionId": "session_1"
}
```

위 JSON은 stream frame의 metadata이고, 실제 터미널 바이트는 frame payload에 담깁니다.

입력 스트림은 `type: "write"`, 출력 스트림은 `type: "data"`를 사용합니다.

## `connect` payload

renderer는 비밀값 자체가 아니라 참조값만 들고 있고, Electron `main`이 키체인에서 실제 값을 복원한 뒤 Go 코어로 전달합니다. 이렇게 하면 renderer에 비밀번호나 passphrase가 오래 머물지 않도록 제어할 수 있습니다.

## tailnet

노드 상태를 둘 위치는 요청이 아니라 **프로세스 환경변수**로 정해집니다. spawn 시점에
결정되는 값이고 요청마다 달라지지 않기 때문입니다.

```
DOLGATE_TAILNET_STATE_DIR=<앱 데이터>/tailnet
```

비어 있으면 `tailnetTest`·`tailnetForget` 만 거절되고 나머지 기능은 그대로 동작합니다.
값을 주지 않으면 tsnet 이 `os.UserConfigDir()` 밑에 앱과 무관한 경로를 만들어, 사용자가
찾을 수도 등록 해제로 지울 수도 없게 됩니다. 노드키가 들어가므로 이 디렉터리는 **기기
로컬 전용**이며 동기화 대상이 아닙니다.

### `tailnetTest`

노드를 올려 `running` 까지 가는지 확인하고, 그 과정을 **같은 `requestId` 로 여러 번**
`tailnetStatus` 이벤트로 흘립니다. 단일 응답이 아닌 이유는 브라우저 로그인처럼 사람이
개입하는 구간이 있기 때문입니다.

`state` 값:

| 값 | 뜻 |
|---|---|
| `needsAuth` | 인증 필요. `authUrl` 이 함께 오면 브라우저에서 인가해야 한다 |
| `needsApproval` | 등록됐고 관리자 인가 대기 |
| `starting` | 올라오는 중 |
| `running` | 완료 |
| `stopped` | 멈춤. `error` 에 이유가 담긴다 |

같은 상태는 중복 방출하지 않습니다. `running` 에 도달하거나 시간이 다하면 끝납니다.

### `tailnetForget`

노드 등록을 해제합니다 — 컨트롤 플레인에서 노드를 지우고(logout), 서버를 닫고, 로컬 상태
디렉터리까지 삭제합니다. tailnet 설정 자체는 남으므로 다시 연결하면 최초 등록과 같은
흐름을 탑니다. 결과는 `tailnetForgot` 로 옵니다.

## SFTP 관련 식별자

- `sessionId`: 인터랙티브 터미널 세션 식별자
- `endpointId`: 원격 SFTP 연결 식별자
- `jobId`: 파일 전송 작업 식별자

SFTP 브라우징은 control frame만으로 처리하고, 파일 전송 진행률은 `sftpTransfer*` 이벤트로 전달합니다. 로컬 파일 경로를 payload로 넘기면 Go 코어가 직접 복사 작업을 수행합니다.
