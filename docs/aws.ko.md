# AWS / SSM 설정 가이드

[English](./aws.md) | **한국어**

Dolgate의 AWS 기능(EC2 가져오기, EC2 SSH-over-SSM, SSM 셸 접속, AWS SFTP, SSM 포트 포워딩, ECS Exec/터널링)에 필요한 사전 준비와 IAM 권한 예시를 정리한 문서입니다.
간단히 확인하려면 루트 [README의 요약](../README.ko.md#aws--ssm-사용-전-확인)을 참고하세요.

## 시작하기 전에

AWS 기능은 모두 앱에 내장되어 있습니다. EC2 터미널은 SSH-over-SSM을 먼저 시도하고, SSH 연결을 준비할 수 없으면 SSM 셸로 대체 접속할 수 있습니다. 세션 기반 기능은 내장 SSM 데이터 채널을 사용하며, 프로파일 인증(SSO 브라우저 로그인, 자격 증명 확인, AssumeRole)과 AWS API 호출은 AWS SDK로 처리합니다.

- AWS EC2 가져오기
- AWS EC2 SSH-over-SSM 접속
- AWS SSM 셸 접속
- AWS ECS Exec 셸
- AWS SFTP
- AWS SSM 포트 포워딩
- AWS 기반 컨테이너 터널
- AWS 프로파일 생성·검증 및 SSO 브라우저 로그인

로컬 `~/.aws` 설정에서 관리하던 프로파일은 **가져오기**를 통해 앱의 프로파일 저장소로 복사할 수 있습니다.

EC2 접속은 **SSM 관리 인스턴스**와 아래의 기본 사용자 권한부터 준비하면 됩니다. 인스턴스의 SSM 권한은 **Default Host Management Configuration**(DHMC)으로 제공하는 것을 권장합니다. 여기까지 준비하면 기본 SSM 셸 접속이 가능하고, SSH-over-SSM과 SFTP는 추가 설정을 통해 사용할 수 있습니다.

| 사용하려는 기능 | 필요한 설정 |
| --- | --- |
| EC2 목록 조회 및 기본 SSM 셸 접속 | [기본 SSM 사용](#1-기본-ssm-사용-dhmc-권장) |
| SSH-over-SSM 및 AWS SFTP | 기본 설정 + [SSH-over-SSM 권한 및 사전 준비](#2-ssh-over-ssm과-aws-sftp-추가) |
| SSM 포트 포워딩 | 기본 설정 + [2절](#2-ssh-over-ssm과-aws-sftp-추가)의 `StartSsmTunnels` 정책 구문 |
| DHMC 없이 SSM 사용 | 동일한 사용자 권한 + [EC2 인스턴스 프로파일](#3-dhmc를-사용하지-않는-경우) |
| KMS로 암호화한 SSM 셸 | [KMS 세션 암호화 권한](#kms-세션-암호화)도 추가 |
| ECS Exec | 별도의 [사용자 권한 및 ECS 태스크 역할](#aws-ecs-exec-권한) |

아래 EC2 SSH 설정은 **Linux/UNIX 인스턴스**를 대상으로 합니다. Windows 인스턴스는 SSH 가져오기 대상이 아닙니다.

## 1. 기본 SSM 사용 (DHMC 권장)

### 인스턴스 준비

대상 인스턴스가 Systems Manager의 관리 인스턴스로 표시되고, SSM Agent가 **Online** 상태여야 합니다. 사용하는 AWS 계정과 리전마다 [Default Host Management Configuration(DHMC)](https://docs.aws.amazon.com/systems-manager/latest/userguide/fleet-manager-default-host-management-configuration.html)을 활성화하는 것을 권장합니다.

DHMC를 사용하려면 **IMDSv2**와 **SSM Agent 3.2.582.0 이상**이 필요합니다. DHMC는 공통 역할을 통해 에이전트 권한을 제공합니다. 일반적으로 `AWSSystemsManagerDefaultEC2InstanceManagementRole` 역할에 `AmazonSSMManagedEC2InstanceDefaultPolicy` 정책을 연결하므로, EC2마다 SSM용 인스턴스 프로파일을 따로 붙일 필요가 없습니다. 활성화 후 등록까지 최대 30분이 걸릴 수 있습니다.

에이전트는 인터넷/NAT 또는 VPC 엔드포인트를 통해 해당 리전의 Systems Manager 엔드포인트로 HTTPS 아웃바운드 통신이 가능해야 합니다. DHMC가 이 네트워크 설정까지 처리해 주지는 않습니다. [SSM Agent 연결 요구 사항](https://docs.aws.amazon.com/systems-manager/latest/userguide/troubleshooting-ssm-agent.html)을 참고하세요.

### 앱 사용자에게 접속 권한 부여

**DHMC는 인스턴스 측 권한을 제공합니다. Dolgate를 사용하는 사람에게 접속 권한을 부여하지는 않습니다.** 앱의 AWS 프로파일이 사용하는 사용자 또는 역할에 아래 정책을 연결하세요. AssumeRole을 사용한다면 전환 대상 역할에 연결합니다.

EC2 정책 예시에는 `ap-northeast-2`와 예시 계정 ID `123456789012`를 사용합니다. 실제 리전과 계정으로 바꾸고, 필요한 경우 `instance/*`도 접속할 인스턴스로 범위를 좁히세요. `${aws:userid}`는 IAM 정책 변수이므로 그대로 둡니다. 계정 ID로 바꾸는 자리가 아닙니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadEc2AndSsmInventory",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeRegions",
        "ec2:DescribeInstances",
        "ssm:DescribeInstanceInformation"
      ],
      "Resource": "*"
    },
    {
      "Sid": "StartSsmShell",
      "Effect": "Allow",
      "Action": "ssm:StartSession",
      "Resource": [
        "arn:aws:ec2:ap-northeast-2:123456789012:instance/*",
        "arn:aws:ssm:ap-northeast-2:123456789012:document/SSM-SessionManagerRunShell"
      ]
    },
    {
      "Sid": "OwnSessionChannelAndControl",
      "Effect": "Allow",
      "Action": [
        "ssmmessages:OpenDataChannel",
        "ssm:TerminateSession",
        "ssm:ResumeSession"
      ],
      "Resource": "arn:aws:ssm:*:*:session/${aws:userid}-*"
    }
  ]
}
```

조회 권한은 Dolgate가 리전·인스턴스 목록을 읽고 SSM 상태를 확인하는 데 사용합니다. 나머지 정책 구문은 셸 세션을 시작하고 본인의 세션 채널에 접근하도록 허용합니다. 세션 ARN 패턴은 [AWS Session Manager 정책 예시](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-restrict-access-quickstart.html)를 따릅니다. `ssm:ResumeSession`은 세션 관리용으로 포함했으며, 현재 Dolgate가 직접 호출하는 API는 아닙니다.

Dolgate는 자격 증명 확인에 `sts:GetCallerIdentity`도 사용합니다. AWS는 [이 작업에 명시적인 권한 부여를 요구하지 않으므로](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html) 예시 정책에서는 제외했습니다.

인스턴스가 Online이고 이 사용자 권한이 준비되면 **기본 SSM 셸 접속을 사용할 수 있습니다**. SSM 셸에는 EC2 Instance Connect나 실행 중인 SSH 서버가 필요하지 않습니다. Dolgate는 SSH-over-SSM을 먼저 시도하고, 공개키 주입이나 SSH 연결 준비에 실패하면 SSM 셸로 대체 접속할 수 있습니다. 호스트 키 신뢰 확인 또는 불일치 오류는 대체 접속하지 않고 사용자에게 표시합니다.

SSH 사용자명·포트 자동 감지는 선택 기능입니다. Run Command와 다음 절의 추가 권한을 사용하며, 대신 호스트 설정에서 SSH 사용자명과 포트를 직접 입력해도 됩니다. Session Manager의 KMS 암호화가 활성화되어 있다면 [KMS 권한](#kms-세션-암호화)도 추가하세요.

## 2. SSH-over-SSM과 AWS SFTP 추가

### 인스턴스의 SSH 준비

위 기본 SSM 설정에 더해, Linux/UNIX 인스턴스에 다음 사항이 준비되어 있어야 합니다.

- 실행 중인 `sshd`와 `ec2-user`, `ubuntu` 같은 유효한 OS 로그인 사용자
- 임시 공개키를 `sshd`가 받아들일 수 있도록 EC2 Instance Connect가 구성된 상태

**흔히 사용하는 공식 AMI에는 EC2 Instance Connect가 기본 설치되어 있습니다**. AL2023 표준 AMI, Amazon Linux 2 2.0.20190618 이상, Ubuntu 20.04 이상은 별도로 설치할 필요가 없습니다. AL2023 minimal, ECS 최적화 AMI, 커스텀 AMI는 패키지와 SSH 설정을 확인하고 [필요한 경우에만 설치·설정](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-set-up.html)하세요.

Dolgate는 EC2 Instance Connect로 임시 공개키를 전송하고, 인스턴스의 SSH 포트까지 SSM 포트 포워딩 터널을 연 다음 그 안에서 SSH/SFTP를 실행합니다. 이 방식에는 사용자 컴퓨터에서 인스턴스로 접근하기 위한 SSH 인바운드 보안 그룹 규칙이나 EC2 Instance Connect Endpoint가 필요하지 않습니다.

### 사용자/역할에 추가할 권한

동일한 앱 사용자 또는 역할에 **앞의 기본 정책과 함께** 아래 정책을 연결하세요. 두 정책을 합치면 EC2 목록 조회, SSM 셸 대체 접속, SSH 설정 자동 감지, 임시 SSH 키 전송, SSM 터널을 사용할 수 있습니다. SSH 사용자명과 포트를 수동으로 설정한다면 자동 감지용 정책 구문 두 개는 생략할 수 있습니다. 자세한 내용은 아래에 설명합니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StartSsmTunnels",
      "Effect": "Allow",
      "Action": "ssm:StartSession",
      "Resource": [
        "arn:aws:ec2:ap-northeast-2:123456789012:instance/*",
        "arn:aws:ssm:ap-northeast-2::document/AWS-StartPortForwardingSession",
        "arn:aws:ssm:ap-northeast-2::document/AWS-StartPortForwardingSessionToRemoteHost"
      ]
    },
    {
      "Sid": "InspectSshConfiguration",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:ap-northeast-2:123456789012:instance/*",
        "arn:aws:ssm:ap-northeast-2::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadSshInspectionResult",
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    },
    {
      "Sid": "InstanceConnectSshKey",
      "Effect": "Allow",
      "Action": "ec2-instance-connect:SendSSHPublicKey",
      "Resource": "arn:aws:ec2:ap-northeast-2:123456789012:instance/*"
    }
  ]
}
```

| 추가 권한 | 용도 |
| --- | --- |
| `ssm:StartSession` + `AWS-StartPortForwardingSession` | SSH-over-SSM, AWS SFTP, 관리 인스턴스의 포트로 포워딩 |
| `ssm:StartSession` + `AWS-StartPortForwardingSessionToRemoteHost` | 관리 인스턴스를 경유한 원격 호스트 포워딩. 사용하지 않으면 이 문서는 제외 가능 |
| `ssm:SendCommand` + `AWS-RunShellScript` | 선택: SSH 사용자명과 포트 자동 감지. 수동 입력 시 생략 가능 |
| `ssm:GetCommandInvocation` | 선택: 자동 감지 결과 조회. 자동 감지를 사용하면 `SendCommand`와 함께 필요 |
| `ec2-instance-connect:SendSSHPublicKey` | SSH/SFTP용 임시 공개키 전송 |

**자동 감지 권한 없이 SSH-over-SSM을 사용하려면**, 예시에서 `InspectSshConfiguration`과 `ReadSshInspectionResult` 정책 구문(`ssm:SendCommand`, `ssm:GetCommandInvocation`)을 제외하세요. 호스트 설정에서 인스턴스의 실제 **SSH 사용자 이름**(`ec2-user`, `ubuntu` 등)과 **SSH 포트**(일반적으로 `22`)를 직접 입력하면 됩니다. SSM 터널과 EC2 Instance Connect 공개키 주입 권한은 여전히 필요합니다.

포트 포워딩만 사용한다면 기본 정책에 `StartSsmTunnels`만 추가하면 됩니다. 일반 서비스 포트를 포워딩할 때는 SSH 설정, SSH 자동 감지, EC2 Instance Connect 권한이 필요하지 않습니다. 원격 호스트 포워딩에서는 관리 인스턴스가 목적지 호스트와 포트에 접근할 수 있어야 합니다.

AWS 소유 문서의 ARN에는 **계정 필드가 비어 있습니다**(`ap-northeast-2::document/...`). 계정의 `SSM-SessionManagerRunShell` 문서에는 계정 ID가 들어갑니다. `StartSession`과 `SendCommand`의 리소스 범위에는 대상 인스턴스와 해당 문서를 모두 포함하세요. `GetCommandInvocation`은 리소스 단위로 범위를 지정할 수 없으므로 `"Resource": "*"`를 사용합니다. [SSM 권한 참조](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html)를 참고하세요.

Dolgate의 SSH-over-SSM은 `AWS-StartPortForwardingSession`을 사용하므로 이 경로에 `AWS-StartSSHSession`은 필요하지 않습니다. 세션 채널과 세션 제어 권한은 기본 정책에 이미 포함되어 있어 다시 추가할 필요가 없습니다. EC2 목록 조회 권한은 여전히 필요하며, 명령 결과 조회 권한은 SSH 자동 감지를 사용할 때만 필요합니다.

`ec2-instance-connect:SendSSHPublicKey`는 DHMC 역할이나 EC2 인스턴스 프로파일이 아닌 **앱 사용자/역할**에 부여합니다. `ec2:osuser` 조건으로 허용할 OS 사용자를 제한할 수도 있습니다. [EC2 Instance Connect 권한 참조](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2-instance-connect.html)를 참고하세요.

SSH-over-SSM이 동작하면 SSH Agent Forwarding도 사용할 수 있습니다. 활성화하면 로컬 ssh-agent(1Password, `ssh-add` 등)를 EC2 세션에서 사용할 수 있으므로, 신뢰할 수 있는 인스턴스에서만 사용하세요.

## 3. DHMC를 사용하지 않는 경우

**EC2 인스턴스 프로파일**로 SSM Agent 권한을 제공하세요.

1. `ec2.amazonaws.com`을 신뢰하는 IAM 역할을 만들거나 기존 역할을 사용합니다.
2. 해당 역할에 AWS 관리형 정책 [`AmazonSSMManagedInstanceCore`](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html)를 연결합니다.
3. 인스턴스 프로파일을 통해 EC2 인스턴스에 역할을 연결합니다.
4. SSM Agent가 설치·실행 중인지, 앞에서 설명한 네트워크 통신이 가능한지 확인하고, Systems Manager에서 인스턴스가 Online인지 확인합니다.

이것은 **인스턴스 측 설정**입니다. 사용자에게는 1절의 기본 정책을 그대로 적용하고, SSH-over-SSM/SFTP를 사용하려면 2절의 추가 정책도 적용합니다. DHMC를 사용하지 않는다고 해서 Dolgate 사용자 권한이 달라지는 것은 아니며, `AmazonSSMManagedInstanceCore`가 사용자 권한을 대신하지도 않습니다.

| 에이전트 자격 증명 제공 방식 | 역할 및 관리형 정책 |
| --- | --- |
| DHMC | 설정된 Systems Manager 역할. 일반적으로 `AmazonSSMManagedEC2InstanceDefaultPolicy` 사용 |
| EC2 인스턴스 프로파일 | 인스턴스에 연결된 역할에 `AmazonSSMManagedInstanceCore` 사용 |

기존 인스턴스 프로파일이 `ssm:UpdateInstanceInformation`을 허용하면, DHMC가 켜져 있어도 SSM Agent는 인스턴스 프로파일을 우선 사용합니다. 어느 역할에 추가 권한을 부여할지 확인할 때 이 우선순위를 고려하세요. [AWS의 인스턴스 권한 설정](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html)을 참고하세요.

KMS로 암호화한 SSM 셸에는 에이전트가 실제로 사용하는 역할에 `kms:Decrypt`도 필요합니다. 다음 절에서 설명합니다.

## KMS 세션 암호화

Session Manager에서는 기본 TLS 암호화에 더해 KMS 키로 세션 데이터를 암호화할 수 있습니다(**Session Manager → Preferences → KMS encryption**). [AWS의 KMS 세션 암호화 설정](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-preferences-enable-encryption.html)을 참고하세요.

**활성화한 뒤에는 반드시 사용해야 합니다.** 에이전트는 세션 핸드셰이크에서 `KMSEncryption` 작업을 요청하며, 성공 응답을 받지 못하면 세션을 취소합니다. 클라이언트가 암호화를 거부하고 평문으로 대체 접속할 수는 없습니다.

적용 대상은 다음과 같습니다.

| 기능 | 세션 유형 | KMS 세션 암호화 적용 |
| --- | --- | --- |
| SSM 셸(EC2 셸, Windows PowerShell) | `SSM-SessionManagerRunShell` (Standard_Stream) | **적용** |
| SSH-over-SSM, 포트 포워딩, SFTP, 컨테이너 터널, SSM 경유 RDP | `AWS-StartPortForwardingSession*` (Port) | 적용 안 됨 |

Port 유형 세션은 세션 환경설정 문서를 읽지 않습니다. CloudWatch/S3 세션 로그가 포트 포워딩 트래픽을 기록하지 않는 것도 이 때문입니다.

활성화했을 때 필요한 권한은 다음과 같습니다.

- **Dolgate를 사용하는 사용자/역할**: 해당 키에 대한 `kms:GenerateDataKey`와 `SSM-SessionManagerRunShell`에 대한 `ssm:GetDocument`. Dolgate가 암호화 활성화 여부와 사용할 키를 확인하는 데 필요합니다. Dolgate는 데이터 채널을 열기 전에 세션마다 데이터 키를 하나 생성합니다.
- **SSM Agent가 사용하는 역할**: 동일한 키에 대한 `kms:Decrypt`. 에이전트는 암호화된 데이터 키를 받아 복호화한 뒤 같은 세션 키를 만듭니다.

`kms:Decrypt`는 에이전트가 **실제로 사용하는 역할**에 부여하세요. DHMC 자격 증명을 사용하면 DHMC 역할에, 그렇지 않으면 EC2 인스턴스 프로파일 역할에 부여합니다. 인스턴스 프로파일에 `ssm:UpdateInstanceInformation`이 있으면 DHMC가 켜져 있어도 그 프로파일이 우선합니다. 관리자는 다음 명령으로 해당 계정·리전에 설정된 DHMC 역할을 조회할 수 있습니다.

```
aws ssm get-service-setting \
  --region ap-northeast-2 \
  --setting-id /ssm/managed-instance/default-ec2-instance-management-role
```

반환된 역할 이름은 DHMC 설정을 나타낼 뿐, 모든 인스턴스가 그 역할을 사용한다는 뜻은 아닙니다. 앞에서 설명한 인스턴스 프로파일 우선순위를 확인한 뒤 권한을 부여할 역할을 선택하세요. `AmazonSSMManagedInstanceCore`와 `AmazonSSMManagedEC2InstanceDefaultPolicy`에는 모두 `kms:Decrypt`가 포함되어 있지 않습니다. KMS 키 정책에서도 해당 사용자와 에이전트 역할의 접근을 허용해야 합니다.

`kms:GenerateDataKey`가 없으면 세션 핸드셰이크에 실패하고, Dolgate에 데이터 키를 생성하지 못했다는 오류가 표시됩니다. 키 정책과 프로파일 권한부터 확인하세요. `ssm:GetDocument`가 없으면 Dolgate가 암호화 필요 여부를 알 수 없어, 같은 이유로 에이전트가 세션을 거부합니다.

에이전트 역할에 `kms:Decrypt`가 없으면 실패 원인 자체가 클라이언트에 전달되지 못합니다. 에이전트는 핸드셰이크 시작부터 암호화가 켜져 있다고 판단하므로, 초기화하지 못한 암호화 객체로 오류 메시지까지 암호화하려고 합니다. Dolgate는 이렇게 이유 없이 취소된 세션에 대해 `kms:Decrypt`를 확인하도록 안내합니다. 정확한 원인은 인스턴스의 에이전트 로그에 `Fetching data key failed`로 남으며, 세션을 열지 않고도 Run Command로 확인할 수 있습니다.

## AWS ECS Exec 권한

ECS Exec 권한도 일반 AWS/SSM 권한과 별도로, 사용자 측과 리소스 측으로 나눕니다.

### 1) 사용자/역할 권한

Dolgate에서 ECS 셸 접속을 사용하는 사용자/역할에는 최소한 다음 권한이 필요합니다.

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

실제 운영 환경에서는 ECS 리소스를 탐색하기 위해 다음 조회 권한도 보통 추가합니다.

- `ecs:ListClusters`
- `ecs:DescribeClusters`
- `ecs:ListServices`
- `ecs:DescribeServices`
- `ecs:ListTasks`
- `ecs:DescribeTaskDefinition`

### 2) ECS 태스크 역할

ECS Exec을 사용하려면 **태스크 역할(task role)**이 올바르게 연결되어 있어야 합니다. 아래 권한은 선택 사항이 아니라 ECS Exec이 동작하기 위한 필수 조건입니다.

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

추가 확인 사항:

- ECS 서비스/태스크의 `enableExecuteCommand`가 활성화되어 있어야 합니다.
- 위 `ssmmessages:*Channel` 권한은 **태스크 실행 역할(task execution role)**이 아닌 **태스크 역할(task role)**에 부여해야 합니다.
- 컨테이너 이미지에 `/bin/sh`나 `bash`가 없으면 ECS Exec 연결 직후 대화형 셸이 종료될 수 있습니다.
- AWS Console의 CloudShell 테스트에 등장하는 `cloudshell:ApproveCommand` 권한은 Dolgate 자체의 필수 권한에 포함되지 않습니다.
