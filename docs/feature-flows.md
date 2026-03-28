# Dolgate 기능 흐름

이 문서는 최근 추가된 복잡한 사용자 흐름을 빠르게 이해하기 위한 요약 문서입니다.
세부 빌드와 배포는 [build-and-deploy](./build-and-deploy.md), 런타임 경계는 [architecture](./architecture.md)를 참고하세요.

## Session Share

### owner

- 터미널 세션에서 share를 시작하면 viewer URL이 생성됩니다.
- owner는 읽기 전용 또는 입력 허용 모드를 전환할 수 있습니다.
- viewer가 채팅을 보내면 owner 데스크톱 우하단에 토스트가 쌓입니다.
- `채팅 기록` 버튼을 누르면 별도 창에서 최근 메시지를 실시간으로 볼 수 있습니다.

### viewer

- 브라우저 viewer는 session share URL로 접속합니다.
- 터미널 화면과 채팅 패널을 함께 사용합니다.
- 채팅 패널은 기본적으로 접힌 상태로 시작하고, 열면 참여자끼리 실시간 채팅이 가능합니다.
- 세션이 종료되면 viewer 연결과 채팅 기록이 함께 정리됩니다.

## AWS Import + AWS SFTP

### import

- AWS profile을 고르면 인증 상태를 확인합니다.
- profile에 기본 리전이 있으면 그 리전을 자동 선택하고 EC2 목록을 불러옵니다.
- 기본 리전이 없으면 리전 목록만 먼저 보여주고, 사용자가 고른 뒤에만 EC2 목록을 조회합니다.
- Linux 인스턴스는 `SSH 정보 확인`을 눌러 SSH username/port 추천값을 확인합니다.
- 자동 확인 결과는 수정 가능하고, 값을 비운 채로도 Host를 최종 등록할 수 있습니다.

### SFTP

- AWS SFTP는 Linux 인스턴스만 지원합니다.
- 전제 조건:
  - SSM managed
  - sshd/SFTP enabled
  - EC2 Instance Connect 가능
  - `aws-cli`와 `session-manager-plugin` 사용 가능
- 연결 시 진행 단계가 UI에 표시됩니다.
  - profile 확인
  - 브라우저 로그인 필요 시 로그인
  - SSM 확인
  - 인스턴스 메타데이터 확인
  - host key probe
  - ephemeral key 생성과 공개 키 전송
  - 실제 SFTP 연결
- 자동 추천값이 맞지 않으면 username/port를 다시 입력해 재시도할 수 있습니다.

## Warpgate Import

- Warpgate import는 내부 브라우저 인증 창으로 로그인합니다.
- 중단 후에도 import 다이얼로그는 그대로 남아 URL 수정이나 재시도가 가능합니다.
- 로그인 성공 후 target 목록을 가져와 Host로 추가합니다.

## Auth / Offline

- 앱 시작 시 refresh token으로 온라인 세션 복구를 먼저 시도합니다.
- 온라인 복구가 실패해도 offline lease가 유효하면 `offline-authenticated` 상태로 홈 화면을 엽니다.
- offline 상태에서는 기존 로컬 캐시와 설정을 사용할 수 있고, 백그라운드에서 재동기화를 재시도합니다.
- 로그인은 외부 브라우저를 열어 처리하며, 데스크톱은 loopback callback 또는 `dolgate://auth/callback` 식별자를 통해 세션을 교환합니다.
