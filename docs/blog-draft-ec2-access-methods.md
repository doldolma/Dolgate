# EC2에 접속하는 4가지 방법 — 그리고 인바운드 포트를 안 여는 방법

EC2 인스턴스에 접속하는 방법은 하나가 아니다. 보안 요구사항, 네트워크 구성, 편의성에 따라 선택이 달라진다.

각각의 장단점을 정리하고, 마지막에 SSH-over-SSM을 CLI 설치 없이 쓰는 방법을 소개한다.

---

## 1. 공인 IP + SSH (가장 기본)

가장 흔한 방법이다. EC2에 공인 IP를 붙이고, Security Group에서 22번 포트 인바운드를 허용한다.

```bash
ssh -i ~/.ssh/my-key.pem ec2-user@3.xx.xx.xx
```

**장점:**
- 단순하고 익숙하다
- 추가 설치가 필요 없다

**단점:**
- 공인 IP가 필요하다
- 22번 포트가 인터넷에 노출된다
- private subnet 인스턴스에는 사용할 수 없다

개발 초기에 가장 먼저 쓰게 되지만, 프로덕션에서는 보안 감사에서 지적받는 구성이다.

---

## 2. Bastion Host (점프 서버)

퍼블릭 서브넷에 bastion을 하나 두고, private 인스턴스에는 bastion을 거쳐 접속한다.

```bash
ssh -J bastion-user@bastion.example.com ec2-user@10.0.1.50
```

**장점:**
- private 인스턴스에 접근할 수 있다
- 접속 경로를 한 곳으로 집중할 수 있다

**단점:**
- bastion 자체는 공인 IP + 인바운드 포트가 필요하다
- bastion 서버를 따로 운영·패치해야 한다
- bastion이 죽으면 전체 접속이 막힌다

오래 쓰인 방식이지만, bastion 자체가 공격 표면이 된다.

---

## 3. EC2 Instance Connect

AWS 콘솔에서 브라우저 SSH를 열거나, CLI로 임시 공개키를 인스턴스에 60초간 주입해서 접속하는 방식이다.

2023년에 **EC2 Instance Connect Endpoint**가 추가되면서 private subnet 인스턴스에도 공인 IP 없이 접속할 수 있게 됐다.

**장점:**
- 키 페어를 직접 관리하지 않아도 된다
- 콘솔에서 클릭 한 번으로 접속할 수 있다
- Endpoint를 쓰면 공인 IP 없이도 가능하다

**단점:**
- 브라우저 터미널이라 경험이 제한적이다 (복사·붙여넣기, 단축키 등)
- SFTP나 포트 포워딩은 별도로 해야 한다
- SSH 세션 관리 기능(탭, 기록, 자동완성 등)이 없다

간단한 확인 작업에는 편하지만, 일상적인 접속 도구로는 부족하다.

---

## 4. SSM Session Manager (인바운드 포트 없이)

어떻게 보면 AWS에서 제공하는 관리형 Bastion이다. 접속 중계, IAM 기반 접근 제어, CloudTrail 감사 기록까지 — bastion이 해주던 일을 AWS가 서비스로 해준다. 대신 직접 bastion을 운영할 필요가 없고, 인바운드 포트도 안 연다.

EC2에 SSM Agent만 있으면 된다. 공인 IP도 필요 없고, EC2가 SSM 엔드포인트로 outbound 연결만 열려 있으면 접속이 가능하다. Amazon Linux 2/2023과 Ubuntu 최신 AMI에는 Agent가 기본 포함되어 있다.

```bash
aws ssm start-session --target i-0abc1234def56789
```

**장점:**
- **인바운드 포트를 하나도 열지 않는다**
- 공인 IP 불필요 — private subnet에서도 접속 가능
- IAM으로 접근 제어하고, CloudTrail에 접속 기록이 자동으로 남는다
- 추가 비용 없이 바로 쓸 수 있다 (SSM 자체는 무료)
- AWS는 인바운드 SSH 포트를 직접 여는 것 대신 Session Manager 경유를 권장한다 — [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/2024-06-27/framework/sec_protect_compute_reduce_manual_management.html)

**단점:**
- AWS CLI 설치 필요
- [session-manager-plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) 별도 설치 필요 (OS마다 설치 방법이 다르다)
- SSH처럼 쓰려면 `~/.ssh/config`에 [ProxyCommand 설정](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html)이 필요하다

> SSM Session Manager가 처음이라면 [AWS 공식 가이드](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)에서 작동 방식과 [사전 요구 사항](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html)을 확인할 수 있다.

---

## 정리

| 방법 | 인바운드 포트 | 공인 IP | 준비물 |
|------|:---:|:---:|------|
| SSH 직접 | 필요 | 필요 | 키 페어 |
| Bastion | bastion만 | bastion만 | 점프 서버 운영 |
| Instance Connect | Endpoint 없으면 필요 | Endpoint 없으면 필요 | (콘솔/Endpoint) |
| SSM Session Manager | **불필요** | **불필요** | Agent + IAM + CLI + 플러그인 |

보안을 생각하면 SSM이 답이다. 인바운드를 아예 안 열어도 되니까.

---

## 그런데 SSM 기본 세션에는 한계가 있다

SSM Session Manager의 기본 셸은 완전한 SSH가 아니다:

- non-login shell이라 `.bashrc` 등 환경이 안 잡힐 수 있다
- SCP/SFTP를 직접 쓸 수 없다 — 파일 전송이 안 된다
- SSH Agent forwarding이 안 된다
- 일반 SSH 도구(자동완성, tmux 연동 등)를 그대로 쓸 수 없다
- idle 타임아웃이 기본 20분이다

그래서 실무에서는 SSM 터널 위에 SSH를 올리는 **SSH-over-SSM** 방식을 쓴다. SSM의 보안 장점(인바운드 포트 제로)은 유지하면서, 접속 후에는 일반 SSH처럼 쓸 수 있다.

문제는 이걸 직접 설정하려면:

1. AWS CLI 설치
2. session-manager-plugin 설치 (macOS는 brew, Linux는 deb/rpm, Windows는 msi)
3. `~/.ssh/config`에 ProxyCommand 추가
4. AWS SSO를 쓰면 토큰 만료·갱신 관리까지

새 PC마다 이걸 반복해야 하고, 모바일에서는 방법이 아예 없다.

---

## Dolgate에서 해결하는 방법

[Dolgate](https://github.com/doldolma/dolgate)라는 SSH 클라이언트에서는 이 과정을 앱이 처리한다.

SSH-over-SSM에 필요한 ProxyCommand 설정이나 session-manager-plugin 설치 없이, AWS 프로필을 선택하고 인스턴스를 고르면 바로 접속된다.

내부적으로는 EC2 Instance Connect로 임시 키를 주입하고, SSM 터널을 열어 그 위로 SSH를 연결한다 — 3번과 4번을 조합한 방식인데, 앱이 이 과정을 한 번에 처리한다.

처음 한 번:

1. 앱에서 AWS 프로필 추가 (SSO 로그인도 앱 안에서)
2. EC2 인스턴스 가져오기

이후 접속:

- 호스트 목록에서 인스턴스 선택 → 접속

공인 IP 없고, 인바운드 포트 없고, 터미널 설정 없이 그냥 붙는다. iOS/Android에서도 같은 방식으로 접속할 수 있어서, 모바일에서 private EC2에 붙어야 할 때도 쓸 수 있다.

SSH-over-SSM 외에도 SSM 터널 위에서 되는 것들:

- **SFTP** — SSM 경유 파일 전송
- **포트 포워딩** — 로컬에서 private RDS, ElastiCache 등에 접근
- **ECS Exec** — ECS 컨테이너에 셸 접속
- **RDP over SSM** — Windows EC2에 원격 데스크톱

### 전제 조건

SSM 자체의 요구사항은 동일하다:

- EC2에 SSM Agent가 설치돼 있어야 한다 (Amazon Linux/Ubuntu 기본 포함)
- [Default Host Management Configuration](https://docs.aws.amazon.com/systems-manager/latest/userguide/fleet-manager-default-host-management-configuration.html)을 켜두면 IAM 인스턴스 프로파일을 따로 안 붙여도 리전 내 EC2가 자동으로 SSM에 등록된다
- IAM 사용자/역할에 SSM 세션 시작과 EC2 Instance Connect 관련 권한이 필요하다

자세한 IAM 권한 목록은 [Dolgate의 AWS 가이드 문서](https://github.com/doldolma/dolgate/blob/main/docs/aws.md)에 정리되어 있다.

---

## 마무리

- **빠르게 시작하려면** → 공인 IP + SSH
- **private 인스턴스라면** → Bastion 또는 SSM
- **보안이 중요하면** → SSM (인바운드 포트 제로)
- **SSM을 쓰되 CLI+플러그인 설정 없이** → SSH-over-SSM을 앱에서 처리

- GitHub: https://github.com/doldolma/dolgate
- 다운로드: https://doldolma.github.io/Dolgate/#download
