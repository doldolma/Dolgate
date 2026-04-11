# Dolgate

Dolgate는 macOS와 Windows를 위한 크로스 플랫폼 SSH 클라이언트입니다.
멀티 세션 터미널, SFTP 파일 브라우저, 포트 포워딩, 세션 공유, 자체 호스팅 서버를 통한 동기화를 제공합니다.

![Dolgate 홈 화면](./docs/hosts-workspace.png)

## 핵심 기능

- 다중 SSH 세션과 분할 Workspace
- 듀얼 패널 SFTP 브라우저와 파일 전송
- Local / Remote / Dynamic 포트 포워딩
- 세션 녹화 및 재생
- Session Share, 브라우저 viewer, 실시간 채팅
- AWS EC2 import와 AWS SFTP, SSM 포트포워딩, ECS Exec shell, ECS 터널링
- Docker / Podman 컨테이너 모니터링, 로그, 메트릭, 셸, 터널링
- OpenSSH, Xshell, Termius import
- 자동 업데이트
- 셀프호스팅 서버

![Dolgate 포트 포워딩 화면](./docs/port-forwarding.png)

## 빠른 시작

### 다운로드

- 최신 macOS / Windows 빌드는 [GitHub Releases](https://github.com/doldolma/dolgate/releases)에서 받을 수 있습니다.

macOS 빌드는 Apple 공증이 포함되지 않았습니다.
앱을 `Applications`로 옮긴 뒤 실행이 막히면 아래 명령으로 quarantine 속성을 제거한 후 다시 실행해 주세요.

```bash
xattr -dr com.apple.quarantine /Applications/dolgate.app
```

또한 위의 문제로 인해 현재는 **macOS에서 자동 업데이트를 지원하지 않습니다.**
새 버전은 GitHub Releases에서 직접 다시 다운로드해 설치해야 합니다.

개발 환경 구성, 로컬 실행, 릴리즈 빌드는 [빌드 및 배포 문서](./docs/build-and-deploy.md)를 참고해 주세요.

## 자체 sync-api 호스팅

브라우저 로그인과 동기화를 직접 운영하려면 `sync-api`를 별도 서버에 띄우면 됩니다.
가장 단순한 시작점은 Docker Compose로 `sync-api` 단일 컨테이너를 실행하는 것입니다.

상세 설정과 운영 가이드는 [sync-api 자체 호스팅 가이드](./docs/sync-api-self-hosting.md)를 참고해 주세요.

```yaml
services:
  sync-api:
    image: ghcr.io/doldolma/dolgate-sync-api:latest
    container_name: dolgate-sync-api
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - dolgate-sync-api-data:/app/data

volumes:
  dolgate-sync-api-data:
```

실행:

```bash
docker compose up -d
curl http://127.0.0.1:8080/healthz
```

운영에서는 `latest` 대신 버전 태그 고정을 권장합니다.

```yaml
image: ghcr.io/doldolma/dolgate-sync-api:1.2.4
```

데스크톱 앱에서는 로그인 화면의 톱니바퀴를 눌러 `Login Server`를 self-host 주소로 바꾸면 됩니다.
![Login Server 설정 화면](docs/login.png)

## 중요한 사항

### AWS Import / AWS SSM 사용 전 확인

Dolgate의 AWS 기능은 로컬에 설치된 `aws` CLI와 `session-manager-plugin`을 사용합니다.
다음 기능들은 두 도구가 모두 PATH에서 실행 가능해야 정상 동작합니다.

- AWS EC2 Import
- AWS SSM shell 연결
- AWS SFTP
- AWS SSM 포트 포워딩
- AWS 기반 container tunnel

최소 확인:

```bash
aws --version
session-manager-plugin --version
```

macOS 예시:

```bash
brew install awscli
brew install --cask session-manager-plugin
```

추가로 AWS Import는 대상 인스턴스가 **SSM managed instance** 상태여야 하고, SSH username/port 자동 확인을 위해 SSM Run Command를 사용합니다.
현재 AWS Import는 **Linux/UNIX 계열 EC2 인스턴스 기준**으로 동작하며, Windows 인스턴스는 SSH import 대상으로 지원하지 않습니다.

### AWS 권한 예시

AWS/SSM 계열 권한은 아래 두 범주로 구분합니다.

1. **앱을 실행하는 사용자/역할 권한**
   Dolgate가 로컬의 `aws` CLI로 호출하는 권한입니다.
2. **대상 리소스 쪽 역할**
   EC2 인스턴스 프로파일이나 ECS task role처럼, 대상 쪽에 붙어 있어야 하는 권한입니다.

#### 1) 사용자/역할 권한

다음 예시는 Dolgate를 실행하는 AWS 프로필 사용자 또는 AssumeRole 대상 역할 기준입니다.
운영 환경에서는 리전, 인스턴스, 문서 이름 기준으로 범위를 축소하는 구성을 권장합니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "ec2:DescribeRegions",
        "ec2:DescribeInstances",
        "ssm:DescribeInstanceInformation",
        "ssm:StartSession",
        "ssm:TerminateSession",
        "ssm:SendCommand",
        "ssm:GetCommandInvocation"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssmmessages:OpenDataChannel"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2-instance-connect:SendSSHPublicKey"
      ],
      "Resource": "*"
    }
  ]
}
```

권한 용도:

- `sts:GetCallerIdentity`: 현재 프로필 인증 상태 확인
- `ec2:DescribeRegions`, `ec2:DescribeInstances`: AWS import에서 프로필/리전/인스턴스 목록 조회
- `ssm:DescribeInstanceInformation`: 인스턴스가 SSM managed 상태인지 확인
- `ssm:StartSession`, `ssm:TerminateSession`, `ssmmessages:OpenDataChannel`: AWS shell, SFTP, 포트 포워딩, container tunnel
- `ssm:SendCommand`, `ssm:GetCommandInvocation`: SSH username/port 자동 확인
- `ec2-instance-connect:SendSSHPublicKey`: AWS SFTP 및 SSH-over-SSM 계열 연결에서 임시 공개키 주입

최소 권한 정책을 구성할 때는 SSM document 기준 분리를 함께 고려합니다.
Dolgate에서 사용하는 대표 문서는 아래와 같습니다.

- `ssm:StartSession`: `AWS-StartPortForwardingSession`
- `ssm:SendCommand`: `AWS-RunShellScript`

최소 권한 구성에서는 `instance/*`뿐 아니라 해당 SSM document ARN도 함께 범위에 포함합니다.

#### 2) EC2 인스턴스 프로파일(Role)

대상 EC2 인스턴스는 **SSM managed instance** 상태여야 합니다.
가장 단순한 구성은 인스턴스 프로파일에 AWS 관리형 정책 `AmazonSSMManagedInstanceCore`를 연결하는 방식입니다.

구성 기준:

- 사용자/역할 권한: Dolgate가 `aws` CLI로 세션 시작, Run Command, 공개키 주입을 수행하는 데 필요한 권한
- EC2 인스턴스 프로파일: SSM Agent가 Session Manager / Run Command를 처리하는 데 필요한 역할

참고:

- `ec2-instance-connect:SendSSHPublicKey`는 **사용자/역할 권한**에 해당합니다.
- 인스턴스 측 구성에서는 개별 IAM 액션보다 **SSM Agent / 인스턴스 프로파일 / OS 지원 상태**가 우선 확인 대상입니다.
- SSH-over-SSM 계열 기능은 Linux/UNIX 기반 인스턴스를 기준으로 설명합니다.

### AWS ECS Exec 권한 참고

ECS Exec 권한도 일반 AWS/SSM 권한과 별도로 두 범주로 구분합니다.

#### 1) 사용자/역할 권한

Dolgate에서 ECS `쉘 접속`을 실행하는 사용자/역할에는 최소한 아래 권한이 필요합니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:ExecuteCommand",
        "ecs:DescribeTasks"
      ],
      "Resource": "*"
    }
  ]
}
```

운영 환경에서는 ECS 리소스 조회를 위해 아래 읽기 권한을 함께 포함하는 구성이 일반적입니다.

- `ecs:ListClusters`
- `ecs:DescribeClusters`
- `ecs:ListServices`
- `ecs:DescribeServices`
- `ecs:ListTasks`
- `ecs:DescribeTaskDefinition`

#### 2) ECS task role

ECS Exec는 **task role**이 올바르게 연결되어 있어야 합니다.
아래 권한은 선택사항이 아니라 ECS Exec 동작 조건에 해당합니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel"
      ],
      "Resource": "*"
    }
  ]
}
```

추가 참고:

- ECS 서비스/태스크에는 `enableExecuteCommand`가 활성화되어 있어야 합니다.
- 위 `ssmmessages:*Channel` 권한은 **task execution role**이 아니라 **task role** 기준으로 확인합니다.
- 컨테이너 이미지에 `/bin/sh` 또는 `bash`가 없으면 ECS Exec 연결 후 interactive shell이 즉시 종료될 수 있습니다.
- AWS Console의 CloudShell 테스트에서 보이는 `cloudshell:ApproveCommand`는 Dolgate 앱 자체의 필수 권한에 포함되지 않습니다.

### 그 외 알아두면 좋은 점

- Session Replay는 **로컬에만 저장**되며 서버 동기화 대상이 아닙니다.
- SSH / AWS / Warpgate host를 추가하면, 해당 호스트 아래의 **Docker 또는 Podman 컨테이너를 함께 모니터링**할 수 있습니다.
- Containers 기능과 container tunnel은 원격 호스트에 **Docker 또는 Podman**이 실제로 설치되어 있고, 로그인 셸에서 실행 가능해야 합니다.
- 브라우저 로그인/동기화를 직접 운영하려면 위의 `sync-api`를 self-host 하거나, 앱 로그인 화면의 `Login Server`를 원하는 서버로 바꿔야 합니다.

## 문서

- [기능 흐름](./docs/feature-flows.md)
- [아키텍처](./docs/architecture.md)
- [빌드 및 배포](./docs/build-and-deploy.md)
- [sync-api 자체 호스팅 가이드](./docs/sync-api-self-hosting.md)
- [ssh-core IPC 프로토콜](./docs/ipc-protocol.md)
