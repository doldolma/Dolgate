# AWS / SSM 설정 가이드

Dolgate의 AWS 관련 기능(EC2 import, EC2 SSH-over-SSM, SSM shell 연결, AWS SFTP, SSM 포트 포워딩, ECS Exec/터널링)을 쓰기 위한 사전 조건과 IAM 권한 예시를 정리합니다.
빠른 점검만 필요하면 루트 [README](../README.md#aws--ssm-사용-전-확인)의 요약을 참고하세요.

## 사용 전 확인

AWS 관련 기능은 전부 앱에 내장되어 있습니다. EC2 터미널은 먼저 SSH-over-SSM을 시도하고, SSH 준비가 불가능한 경우 SSM shell로 fallback할 수 있습니다. 세션 계열 기능은 내장 SSM 데이터 채널로 동작하고, 프로필 인증(SSO 브라우저 로그인, 자격 증명 검증, AssumeRole)과 AWS API 호출은 AWS SDK로 처리합니다.

- AWS EC2 Import
- AWS EC2 SSH-over-SSM 연결
- AWS SSM shell 연결
- AWS ECS Exec 셸
- AWS SFTP
- AWS SSM 포트 포워딩
- AWS 기반 container tunnel
- AWS 프로필 생성·검증·SSO 브라우저 로그인

기존에 로컬 `~/.aws` 설정 파일로 관리하던 프로필은 **가져오기**로 앱 전용 프로필 저장소에 복사해 사용할 수 있습니다.

추가로 AWS Import는 대상 인스턴스가 **SSM managed instance** 상태여야 하고, SSH username/port 자동 확인을 위해 SSM Run Command를 사용합니다.
현재 AWS Import는 **Linux/UNIX 계열 EC2 인스턴스 기준**으로 동작하며, Windows 인스턴스는 SSH import 대상으로 지원하지 않습니다.

EC2 SSH-over-SSM과 AWS SFTP는 EC2 Instance Connect로 임시 공개키를 주입한 뒤 SSM 터널 위에서 SSH/SFTP를 엽니다. 따라서 대상 인스턴스에 sshd가 동작하고 있어야 하며, 사용자/역할에는 `ec2-instance-connect:SendSSHPublicKey` 권한이 필요합니다.

SSH Agent Forwarding은 SSH 채널 기능이라 SSM 터널/서버 프록시 전송 방식과 별개로 동작합니다. AWS EC2 호스트에서 forwarding을 켜면 로컬 ssh-agent(1Password, `ssh-add` 등)를 EC2 세션 안으로 전달할 수 있으므로 신뢰하는 인스턴스에서만 사용하세요.

## AWS 권한 예시

AWS/SSM 계열 권한은 아래 두 범주로 구분합니다.

1. **앱을 실행하는 사용자/역할 권한**
   Dolgate가 AWS SDK로 호출하는 권한입니다.
2. **대상 리소스 쪽 역할**
   EC2 인스턴스 프로파일이나 ECS task role처럼, 대상 쪽에 붙어 있어야 하는 권한입니다.

### 1) 사용자/역할 권한

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
- `ssm:StartSession`, `ssm:TerminateSession`, `ssmmessages:OpenDataChannel`: AWS shell, SSH-over-SSM 터널, SFTP, 포트 포워딩, container tunnel
- `ssm:SendCommand`, `ssm:GetCommandInvocation`: SSH username/port 자동 확인
- `ec2-instance-connect:SendSSHPublicKey`: AWS SFTP 및 SSH-over-SSM 계열 연결에서 임시 공개키 주입

최소 권한 정책을 구성할 때는 SSM document 기준 분리를 함께 고려합니다.
Dolgate에서 사용하는 대표 문서는 아래와 같습니다.

- `ssm:StartSession`: `AWS-StartPortForwardingSession`
- `ssm:SendCommand`: `AWS-RunShellScript`

최소 권한 구성에서는 `instance/*`뿐 아니라 해당 SSM document ARN도 함께 범위에 포함합니다.

### 2) EC2 인스턴스 프로파일(Role)

대상 EC2 인스턴스는 **SSM managed instance** 상태여야 합니다.
가장 단순한 구성은 인스턴스 프로파일에 AWS 관리형 정책 `AmazonSSMManagedInstanceCore`를 연결하는 방식입니다.

구성 기준:

- 사용자/역할 권한: Dolgate가 AWS SDK로 세션 시작, Run Command, 공개키 주입을 수행하는 데 필요한 권한
- EC2 인스턴스 프로파일: SSM Agent가 Session Manager / Run Command를 처리하는 데 필요한 역할

참고:

- `ec2-instance-connect:SendSSHPublicKey`는 **사용자/역할 권한**에 해당합니다.
- 인스턴스 측 구성에서는 개별 IAM 액션보다 **SSM Agent / 인스턴스 프로파일 / OS 지원 상태**가 우선 확인 대상입니다.
- SSH-over-SSM 계열 기능은 Linux/UNIX 기반 인스턴스를 기준으로 설명합니다.
- SSH-over-SSM이 준비 전 실패하면 Dolgate는 일반 EC2 shell 접속에서 SSM shell fallback을 시도할 수 있습니다. host key trust/mismatch 계열 오류는 보안상 fallback하지 않고 사용자에게 그대로 노출됩니다.

## AWS ECS Exec 권한

ECS Exec 권한도 일반 AWS/SSM 권한과 별도로 두 범주로 구분합니다.

### 1) 사용자/역할 권한

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

### 2) ECS task role

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
