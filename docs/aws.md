# AWS / SSM Setup Guide

**English** | [한국어](./aws.ko.md)

This page collects the prerequisites and example IAM permissions for Dolgate's AWS features (EC2 import, EC2 SSH-over-SSM, SSM shell connections, AWS SFTP, SSM port forwarding, ECS Exec/tunneling).
For a quick check, see the summary in the root [README](../README.md#before-using-aws--ssm).

## Before you start

Every AWS feature is built into the app. EC2 terminals try SSH-over-SSM first, and can fall back to an SSM shell when SSH cannot be prepared. Session-based features run over the built-in SSM data channel, and profile authentication (SSO browser login, credential validation, AssumeRole) and AWS API calls are handled through the AWS SDK.

- AWS EC2 import
- AWS EC2 SSH-over-SSM connections
- AWS SSM shell connections
- AWS ECS Exec shells
- AWS SFTP
- AWS SSM port forwarding
- AWS-based container tunnels
- AWS profile creation, validation, and SSO browser login

Profiles you have been managing in a local `~/.aws` config can be copied into the app's own profile store via **import**.

For EC2 access, start with an **SSM managed instance** and the basic user permissions below. We recommend **Default Host Management Configuration (DHMC)** to provide the instance's SSM permissions. This is enough for basic SSM shell access; SSH-over-SSM and SFTP are an additional setup step.

| What you want to use | Setup |
| --- | --- |
| EC2 discovery and basic SSM shell access | [Basic SSM access](#1-basic-ssm-access-dhmc-recommended) |
| SSH-over-SSM and AWS SFTP | Basic access plus [SSH-over-SSM permissions and prerequisites](#2-add-ssh-over-ssm-and-aws-sftp) |
| SSM port forwarding | Basic access plus the `StartSsmTunnels` statement in [section 2](#2-add-ssh-over-ssm-and-aws-sftp) |
| SSM access without DHMC | The same user permissions, plus an [EC2 instance profile](#3-if-you-do-not-enable-dhmc) |
| KMS-encrypted SSM shells | Also apply [KMS session encryption permissions](#kms-session-encryption) |
| ECS Exec | Separate [user permissions and ECS task role](#aws-ecs-exec-permissions) |

The EC2 SSH setup below targets **Linux/UNIX instances**. Windows instances are not SSH import targets.

## 1. Basic SSM access (DHMC recommended)

### Prepare the instance

The target must appear in Systems Manager as a managed instance with SSM Agent **Online**. We recommend enabling [Default Host Management Configuration (DHMC)](https://docs.aws.amazon.com/systems-manager/latest/userguide/fleet-manager-default-host-management-configuration.html) in each AWS account and Region you use.

DHMC requires **IMDSv2** and **SSM Agent 3.2.582.0 or later**. It supplies the agent's permissions through a shared role, normally `AWSSystemsManagerDefaultEC2InstanceManagementRole` with `AmazonSSMManagedEC2InstanceDefaultPolicy`, so a separate SSM instance profile is not needed on every EC2 instance. Registration can take up to 30 minutes after enabling it.

The agent also needs outbound HTTPS access to the regional Systems Manager endpoints, through internet/NAT access or VPC endpoints. DHMC does not configure this network access. See [SSM Agent connectivity requirements](https://docs.aws.amazon.com/systems-manager/latest/userguide/troubleshooting-ssm-agent.html).

### Grant the app user permission to connect

**DHMC provides instance-side permissions. It does not grant the person running Dolgate permission to connect.** Attach the following policy to the user or role used by the app's AWS profile, including the target role when using AssumeRole.

The EC2 policy examples use `ap-northeast-2` and the placeholder account ID `123456789012`. Replace them with your Region and account, and narrow `instance/*` to the intended instances where appropriate. Keep `${aws:userid}` as an IAM policy variable; it is not an account ID placeholder.

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

The read actions let Dolgate list Regions and instances and check their SSM status. The other statements allow shell sessions and access to the caller's own session channels. The session ARN pattern follows the [AWS Session Manager policy examples](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-restrict-access-quickstart.html); `ssm:ResumeSession` is included for session management, although Dolgate does not currently call that API.

Dolgate also uses `sts:GetCallerIdentity` to validate credentials. AWS does [not require an explicit permission grant for that operation](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html), so it is omitted here.

With the instance Online and these user permissions in place, **basic SSM shell access is ready**. You do not need EC2 Instance Connect or a running SSH server for an SSM shell. Dolgate tries SSH-over-SSM first and can fall back to the SSM shell when public-key injection or SSH preparation fails. Host-key trust or mismatch errors are surfaced instead of triggering fallback.

SSH username/port auto-detection is optional: it uses Run Command and the additional permissions in the next section. You can instead enter the SSH username and port manually in the host settings. If Session Manager KMS encryption is enabled, also apply the [KMS permissions](#kms-session-encryption).

## 2. Add SSH-over-SSM and AWS SFTP

### Prepare SSH on the instance

Keep the basic SSM setup above, then ensure the Linux/UNIX instance has:

- A running `sshd` and a valid OS login user, such as `ec2-user` or `ubuntu`.
- EC2 Instance Connect configured so `sshd` can accept the temporary public key.

**Common official AMIs already include EC2 Instance Connect**: AL2023 standard, Amazon Linux 2 2.0.20190618 or later, and Ubuntu 20.04 or later. These images do not need a separate installation. For AL2023 minimal, ECS-optimized, or custom AMIs, check the package and SSH configuration and [install or configure it only if needed](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-set-up.html).

Dolgate sends a temporary public key through EC2 Instance Connect, opens an SSM port-forwarding tunnel to the instance's SSH port, and runs SSH/SFTP through that tunnel. An inbound SSH security-group rule from your computer and an EC2 Instance Connect Endpoint are not required for this transport.

### Add these user/role permissions

Attach this policy **in addition to the basic policy above**, to the same app user or role. Together they cover EC2 discovery, SSM shell fallback, SSH auto-detection, temporary SSH keys, and SSM tunnels. The two auto-detection statements are optional when you configure the SSH username and port manually, as explained below.

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

| Additional permission | Used for |
| --- | --- |
| `ssm:StartSession` with `AWS-StartPortForwardingSession` | SSH-over-SSM, AWS SFTP, and forwarding to a port on the managed instance |
| `ssm:StartSession` with `AWS-StartPortForwardingSessionToRemoteHost` | Forwarding through the managed instance to a remote host; omit this document if you do not use remote-host forwarding |
| `ssm:SendCommand` with `AWS-RunShellScript` | Optional: detecting the SSH username and port; omit when entering them manually |
| `ssm:GetCommandInvocation` | Optional: reading the auto-detection result; required together with `SendCommand` when using auto-detection |
| `ec2-instance-connect:SendSSHPublicKey` | Supplying the temporary key for SSH and SFTP |

**To use SSH-over-SSM without auto-detection permissions**, remove the `InspectSshConfiguration` and `ReadSshInspectionResult` statements (`ssm:SendCommand` and `ssm:GetCommandInvocation`) from the example. In the host settings, enter the instance's actual **SSH username** (such as `ec2-user` or `ubuntu`) and **SSH port** (normally `22`). The SSM tunnel and EC2 Instance Connect key-injection permissions are still required.

For port forwarding alone, add only `StartSsmTunnels` to the basic policy. Forwarding an arbitrary service port does not require SSH setup, SSH auto-detection, or EC2 Instance Connect permissions. For remote-host forwarding, the managed instance must be able to reach the destination host and port.

The AWS-owned documents have an **empty account field** in their ARNs (`ap-northeast-2::document/...`). The account's `SSM-SessionManagerRunShell` document includes the account ID. Scope `StartSession` and `SendCommand` to both the target instances and their respective documents. `GetCommandInvocation` has no resource-level scope, so its statement uses `"Resource": "*"`. See the [SSM authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html).

Dolgate uses `AWS-StartPortForwardingSession` for SSH-over-SSM; this path does not require `AWS-StartSSHSession`. The basic policy already supplies the session-channel and session-control permissions, so they do not need to be added again. Inventory read permissions are still needed for EC2 discovery; command-result read permission is needed only when using SSH auto-detection.

`ec2-instance-connect:SendSSHPublicKey` belongs to the **app user/role**, not the DHMC role or EC2 instance profile. It can also be restricted to approved OS users with `ec2:osuser`; see the [EC2 Instance Connect authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2-instance-connect.html).

SSH Agent Forwarding is available once SSH-over-SSM works. Enabling it passes your local ssh-agent (1Password, `ssh-add`, and so on) into the EC2 session — use it only on instances you trust.

## 3. If you do not enable DHMC

Provide the SSM Agent's permissions with an **EC2 instance profile** instead:

1. Create or use an IAM role trusted by `ec2.amazonaws.com`.
2. Attach the AWS managed policy [`AmazonSSMManagedInstanceCore`](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html) to that role.
3. Attach the role to the EC2 instance through an instance profile.
4. Keep SSM Agent installed and running, ensure the network access described above, and confirm the instance is Online in Systems Manager.

These are **instance-side changes**. Use the same basic user policy from section 1 and, for SSH-over-SSM/SFTP, the additional user policy from section 2. Disabling DHMC does not require a different set of Dolgate user permissions, and `AmazonSSMManagedInstanceCore` is not a substitute for those permissions.

| Agent credential source | Role and managed policy |
| --- | --- |
| DHMC | The configured Systems Manager role, normally with `AmazonSSMManagedEC2InstanceDefaultPolicy` |
| EC2 instance profile | The role attached to the instance, with `AmazonSSMManagedInstanceCore` |

If an existing instance profile allows `ssm:UpdateInstanceInformation`, SSM Agent prefers it over DHMC even when DHMC is enabled. Keep this precedence in mind when checking which role needs additional permissions. See [AWS's instance permission setup](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html).

For KMS-encrypted SSM shells, the role the agent actually uses also needs `kms:Decrypt`, as described next.

## KMS session encryption

Session Manager can encrypt session data with a KMS key
(**Session Manager → Preferences → KMS encryption**), in addition to the TLS
encryption used by default. See [AWS's KMS session encryption setup](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-preferences-enable-encryption.html).

**It is mandatory once enabled.** The agent asks for the `KMSEncryption` action during
the session handshake, and any answer other than success makes the agent cancel the
session — a client cannot opt out and fall back to plaintext.

Which sessions it applies to:

| Feature | Session type | Affected |
| --- | --- | --- |
| SSM shell (EC2 shell, PowerShell on Windows) | `SSM-SessionManagerRunShell` (Standard_Stream) | **Yes** |
| SSH-over-SSM, port forwarding, SFTP, container tunnels, RDP over SSM | `AWS-StartPortForwardingSession*` (Port) | No |

Port-type sessions do not read the session preferences document, which is also why
CloudWatch/S3 session logs never capture port forwarding traffic.

Permissions needed when it is enabled:

- **User/role running Dolgate**: `kms:GenerateDataKey` on the key, and `ssm:GetDocument`
  on `SSM-SessionManagerRunShell` so Dolgate can tell that encryption is enabled and
  which key to use. Dolgate generates one data key per session, before opening the
  data channel.
- **The role the SSM Agent runs as**: `kms:Decrypt` on the same key. The agent receives
  the encrypted data key and decrypts it to derive the same session keys.

Grant `kms:Decrypt` to the role the agent **actually uses**: the DHMC role when it uses
DHMC credentials, or the EC2 instance profile role otherwise. An instance profile with
`ssm:UpdateInstanceInformation` takes precedence even when DHMC is enabled. An administrator
can inspect the configured DHMC role for the relevant account and Region with:

```
aws ssm get-service-setting \
  --region ap-northeast-2 \
  --setting-id /ssm/managed-instance/default-ec2-instance-management-role
```

The returned role name identifies the DHMC configuration; it does not prove that every
instance uses it. Check the instance-profile precedence above before choosing the role.
Neither `AmazonSSMManagedInstanceCore` nor `AmazonSSMManagedEC2InstanceDefaultPolicy`
includes `kms:Decrypt`. The KMS key policy must also allow the relevant user and agent roles.

If `kms:GenerateDataKey` is missing, the session fails at the handshake and Dolgate
reports that the data key could not be created — check the key policy and the profile's
permissions first. If `ssm:GetDocument` is missing, Dolgate cannot tell that encryption
is required and the agent rejects the session for the same reason.

If `kms:Decrypt` is missing on the agent's role, the failure reason cannot reach the
client at all: the agent treats encryption as on from the start of the handshake, so it
tries to encrypt even its own error message with a cipher it never initialized. Dolgate
turns that silent cancellation into a message naming `kms:Decrypt`, and the exact reason
is in the agent log on the instance (`Fetching data key failed`), which Run Command can
read without a session.

## AWS ECS Exec permissions

ECS Exec permissions are also split into two categories, separate from the general AWS/SSM permissions.

### 1) User/role permissions

The user/role using ECS `shell access` in Dolgate needs at least:

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

Production setups usually add the following read permissions for browsing ECS resources:

- `ecs:ListClusters`
- `ecs:DescribeClusters`
- `ecs:ListServices`
- `ecs:DescribeServices`
- `ecs:ListTasks`
- `ecs:DescribeTaskDefinition`

### 2) ECS task role

ECS Exec requires the **task role** to be attached correctly.
The permissions below are not optional — they are a condition for ECS Exec to work at all.

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

Additional notes:

- The ECS service/task must have `enableExecuteCommand` enabled.
- Check the `ssmmessages:*Channel` permissions above against the **task role**, not the **task execution role**.
- If the container image has no `/bin/sh` or `bash`, the interactive shell may exit immediately after ECS Exec connects.
- The `cloudshell:ApproveCommand` permission that appears in AWS Console CloudShell tests is not part of Dolgate's own required permissions.
