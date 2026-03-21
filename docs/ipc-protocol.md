# SSH 코어 IPC 프로토콜

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
- `sftpTransferStart`
- `sftpTransferCancel`

## 이벤트 종류

- `status`
- `connected`
- `error`
- `closed`
- `sftpConnected`
- `sftpDisconnected`
- `sftpListed`
- `sftpAck`
- `sftpError`
- `sftpTransferProgress`
- `sftpTransferCompleted`
- `sftpTransferFailed`
- `sftpTransferCancelled`

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

## SFTP 관련 식별자

- `sessionId`: 인터랙티브 터미널 세션 식별자
- `endpointId`: 원격 SFTP 연결 식별자
- `jobId`: 파일 전송 작업 식별자

SFTP 브라우징은 control frame만으로 처리하고, 파일 전송 진행률은 `sftpTransfer*` 이벤트로 전달합니다. 현재 구현은 로컬 파일 경로를 payload로 넘기고 Go 코어가 직접 복사 작업을 수행하는 구조입니다.
