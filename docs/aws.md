# AWS / SSM Setup Guide

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

Additionally, AWS import requires target instances to be **SSM managed instances**, and uses SSM Run Command to auto-detect the SSH username/port.
AWS import currently targets **Linux/UNIX EC2 instances**; Windows instances are not supported as SSH import targets.

EC2 SSH-over-SSM and AWS SFTP inject a temporary public key through EC2 Instance Connect, then open SSH/SFTP over the SSM tunnel. The target instance therefore needs a running sshd, and the user/role needs the `ec2-instance-connect:SendSSHPublicKey` permission.

SSH Agent Forwarding is an SSH channel feature, so it works independently of the SSM tunnel / server proxy transport. Enabling forwarding on an AWS EC2 host passes your local ssh-agent (1Password, `ssh-add`, and so on) into the EC2 session — use it only on instances you trust.

## Example AWS permissions

AWS/SSM permissions fall into two categories.

1. **Permissions for the user/role running the app**
   What Dolgate calls through the AWS SDK.
2. **Roles on the target resource side**
   Permissions that must be attached to the target, such as the EC2 instance profile or the ECS task role.

### 1) User/role permissions

The example below applies to the AWS profile user running Dolgate, or the role targeted by AssumeRole.
In production, narrow the scope by region, instance, and document name.

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

What each permission is for:

- `sts:GetCallerIdentity`: checking the current profile's authentication state
- `ec2:DescribeRegions`, `ec2:DescribeInstances`: listing profiles/regions/instances during AWS import
- `ssm:DescribeInstanceInformation`: checking whether an instance is SSM managed
- `ssm:StartSession`, `ssm:TerminateSession`, `ssmmessages:OpenDataChannel`: AWS shell, SSH-over-SSM tunnels, SFTP, port forwarding, container tunnels
- `ssm:SendCommand`, `ssm:GetCommandInvocation`: auto-detecting the SSH username/port
- `ec2-instance-connect:SendSSHPublicKey`: injecting the temporary public key for AWS SFTP and SSH-over-SSM connections

When building a least-privilege policy, also consider splitting by SSM document.
The main documents Dolgate uses are:

- `ssm:StartSession`: `AWS-StartPortForwardingSession`
- `ssm:SendCommand`: `AWS-RunShellScript`

In a least-privilege setup, include the SSM document ARNs in scope alongside `instance/*`.

### 2) EC2 instance profile (role)

The target EC2 instance must be an **SSM managed instance**.
The simplest setup attaches the AWS managed policy `AmazonSSMManagedInstanceCore` to the instance profile.

How the two sides divide up:

- User/role permissions: what Dolgate needs to start sessions, run commands, and inject public keys through the AWS SDK
- EC2 instance profile: the role the SSM Agent needs to handle Session Manager / Run Command

Notes:

- `ec2-instance-connect:SendSSHPublicKey` belongs to the **user/role permissions**.
- On the instance side, check the **SSM Agent / instance profile / OS support status** before individual IAM actions.
- SSH-over-SSM features are described for Linux/UNIX-based instances.
- If SSH-over-SSM fails before it is ready, Dolgate can fall back to an SSM shell for plain EC2 shell access. Host key trust/mismatch errors never trigger this fallback — for security, they are surfaced to the user as-is.

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
