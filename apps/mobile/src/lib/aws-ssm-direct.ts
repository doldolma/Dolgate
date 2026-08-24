import { Buffer } from 'buffer';

import { GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import {
  DescribeInstanceInformationCommand,
  GetDocumentCommand,
  SSMClient,
  StartSessionCommand,
} from '@aws-sdk/client-ssm';

import {
  EC2InstanceConnectClient,
  SendSSHPublicKeyCommand,
} from '@aws-sdk/client-ec2-instance-connect';

import type { ResolvedAwsCredentials } from './aws-session';
import { t } from '../i18n';

/**
 * SSM 세션을 **기기에서 직접** 시작한다.
 *
 * 서버(sync-api)를 거치던 경로와 다른 점은 하나다: 자격증명이 기기를 떠나지 않는다. 지금까지는
 * 앱이 만든 임시 자격증명을 서버로 보내고 서버가 `ssm:StartSession` 을 불렀다.
 *
 * **코어는 자격증명을 받지 않는다.** 여기서 받은 `streamUrl`·`tokenValue`(와 세션 암호화를 켠
 * 계정이면 KMS 자료)만 넘기면 Go 코어가 MGS 데이터채널을 열고 그 위를 말한다 — 데스크톱과 같은
 * 분담이고, 그래서 Go 쪽에는 AWS SDK 의존성이 없다.
 *
 * 호출 순서·타임아웃·KMS 처리는 데스크톱(`aws-service.ts`)과 같게 맞췄다. 두 플랫폼이 갈리면
 * 한쪽에서만 나는 실패를 재현할 수 없다.
 */

/** 코어에 넘길 세션 토큰. 필드 이름은 coretypes 의 JSON 그대로다. */
export interface SsmSessionToken {
  sessionId: string;
  streamUrl: string;
  tokenValue: string;
  kmsKeyId?: string;
  kmsCipherTextBlobBase64?: string;
  kmsPlainTextKeyBase64?: string;
}

interface ClientInput {
  credentials: ResolvedAwsCredentials;
  region: string;
}

const START_SESSION_TIMEOUT_MS = 30_000;
const SUPPORT_CALL_TIMEOUT_MS = 15_000;

/**
 * 시간 제한 신호.
 *
 * **`AbortSignal.timeout` 을 쓰지 않는다 — React Native 에 없다.** Hermes 는 `AbortController`
 * 는 주지만 그 정적 메서드는 없어서, 그대로 부르면 "undefined is not a function" 으로 죽는다.
 * SSM 호출 전체가 그 한 줄에 걸려 두 경로(SSH·셸)가 같은 문구로 실패했다(실측).
 *
 * 타이머는 반드시 정리한다. 안 하면 요청이 끝난 뒤에도 30초짜리 타이머가 남아 앱이 그만큼
 * 깨어 있다.
 */
function callTimeout(limitMs: number): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  return { signal: controller.signal, release: () => clearTimeout(timer) };
}

function ssmClient(input: ClientInput): SSMClient {
  return new SSMClient({ region: input.region, credentials: input.credentials });
}

/** PingStatus 는 계정마다 대소문자가 다르게 온다. */
function isSsmAgentOnline(status?: string | null): boolean {
  return status?.trim().toLowerCase() === 'online';
}

/**
 * 이 인스턴스에 지금 SSM 으로 붙을 수 있는지 **세션을 시작하기 전에** 확인한다.
 *
 * 데스크톱은 연결 전에 이 확인을 한다 — 하지 않으면 SSM Agent 가 죽은 인스턴스에 붙어 보다가
 * 실패하고, 그 실패 문구는 "세션을 시작하지 못했습니다" 라서 무엇을 고쳐야 하는지 알 수 없다.
 * 왕복 한 번을 더 쓰는 대신 원인을 먼저 말해 준다(에이전트인지, 아예 관리 대상이 아닌지).
 *
 * 조회 자체가 실패하면(권한·네트워크) 그 오류를 그대로 올린다 — 데스크톱과 같은 판단이다.
 * `ssm:DescribeInstanceInformation` 이 거부된 경우 그 문장에 액션 이름이 들어 있어서, 화면이
 * 정책에 무엇을 추가해야 하는지까지 말해 준다.
 */
export async function assertSsmManagedInstance(input: {
  credentials: ResolvedAwsCredentials;
  region: string;
  instanceId: string;
}): Promise<void> {
  const limit = callTimeout(SUPPORT_CALL_TIMEOUT_MS);
  const output = await ssmClient(input)
    .send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: 'InstanceIds', Values: [input.instanceId] }],
      }),
      { abortSignal: limit.signal },
    )
    .finally(limit.release);
  const entry = (output.InstanceInformationList ?? []).find(
    item => item.InstanceId?.trim() === input.instanceId,
  );
  if (!entry) {
    throw new Error(t('store.ssmNotManaged'));
  }
  if (!isSsmAgentOnline(entry.PingStatus)) {
    throw new Error(
      t('store.ssmAgentOffline', {
        status: entry.PingStatus?.trim() || 'unknown',
      }),
    );
  }
}

/**
 * 세션 암호화에 쓸 KMS 키. 없으면 null.
 *
 * **실패해도 끊지 않는다.** 문서가 없거나 `ssm:GetDocument` 권한이 없는 계정이 대부분이고, 실제로
 * 암호화가 켜져 있으면 에이전트가 handshake 에서 요구하면서 분명한 이유로 실패한다.
 */
async function readSessionKmsKeyId(input: ClientInput): Promise<string | null> {
  const limit = callTimeout(SUPPORT_CALL_TIMEOUT_MS);
  try {
    const output = await ssmClient(input).send(
      new GetDocumentCommand({ Name: 'SSM-SessionManagerRunShell' }),
      { abortSignal: limit.signal },
    );
    if (!output.Content) {
      return null;
    }
    const parsed = JSON.parse(output.Content) as {
      inputs?: { kmsKeyId?: unknown };
    };
    const keyId = parsed.inputs?.kmsKeyId;
    return typeof keyId === 'string' && keyId.trim() ? keyId.trim() : null;
  } catch {
    return null;
  } finally {
    limit.release();
  }
}

/**
 * 이 세션에 쓸 데이터 키를 만든다.
 *
 * 64바이트와 EncryptionContext 두 항목은 규격이다(공식 session-manager-plugin·amazon-ssm-agent
 * 와 같아야 한다). 컨텍스트가 다르면 인스턴스 역할의 `kms:Decrypt` 가 실패한다.
 */
async function generateSessionDataKey(
  input: ClientInput,
  kmsKeyId: string,
  sessionId: string,
  targetId: string,
): Promise<{ cipherTextBlobBase64: string; plainTextKeyBase64: string }> {
  const limit = callTimeout(SUPPORT_CALL_TIMEOUT_MS);
  const output = await new KMSClient({
    region: input.region,
    credentials: input.credentials,
  })
    .send(
      new GenerateDataKeyCommand({
        KeyId: kmsKeyId,
        NumberOfBytes: 64,
        EncryptionContext: {
          'aws:ssm:SessionId': sessionId,
          'aws:ssm:TargetId': targetId,
        },
      }),
      { abortSignal: limit.signal },
    )
    .finally(limit.release);
  if (!output.CiphertextBlob || !output.Plaintext) {
    throw new Error('SSM 세션 암호화 키를 만들지 못했습니다.');
  }
  return {
    cipherTextBlobBase64: toBase64(output.CiphertextBlob),
    plainTextKeyBase64: toBase64(output.Plaintext),
  };
}

async function startSession(
  input: ClientInput,
  command: StartSessionCommand,
): Promise<{ sessionId: string; streamUrl: string; tokenValue: string }> {
  const limit = callTimeout(START_SESSION_TIMEOUT_MS);
  const output = await ssmClient(input)
    .send(command, { abortSignal: limit.signal })
    .finally(limit.release);
  const sessionId = output.SessionId?.trim();
  const streamUrl = output.StreamUrl?.trim();
  const tokenValue = output.TokenValue?.trim();
  if (!sessionId || !streamUrl || !tokenValue) {
    throw new Error('SSM 세션 정보를 받지 못했습니다.');
  }
  return { sessionId, streamUrl, tokenValue };
}

/** SSM 셸 세션(ssm-user 로 들어가는 그 세션). */
export async function startSsmShellSession(input: {
  credentials: ResolvedAwsCredentials;
  region: string;
  instanceId: string;
}): Promise<SsmSessionToken> {
  // **환경설정 조회를 StartSession 과 같이 시작한다.** 순서대로 부르면 그 왕복이 그대로 연결
  // 지연이 된다 — 에이전트는 StartSession 직후 협상 요청을 채널에 올려놓고 기다리므로, 우리가
  // 늦게 붙는 만큼 셸이 늦게 뜬다. 이 조회는 실패해도 null 을 주므로 떠 있는 rejection 이 없다.
  const kmsKeyIdPromise = readSessionKmsKeyId(input);
  const session = await startSession(
    input,
    new StartSessionCommand({ Target: input.instanceId }),
  );

  // EncryptionContext 에 sessionId 가 들어가므로 데이터 키는 StartSession 뒤에야 만들 수 있다.
  const kmsKeyId = await kmsKeyIdPromise;
  if (!kmsKeyId) {
    return session;
  }
  const dataKey = await generateSessionDataKey(
    input,
    kmsKeyId,
    session.sessionId,
    input.instanceId,
  );
  return {
    ...session,
    kmsKeyId,
    kmsCipherTextBlobBase64: dataKey.cipherTextBlobBase64,
    kmsPlainTextKeyBase64: dataKey.plainTextKeyBase64,
  };
}

/**
 * SSH 를 태울 포트포워딩 세션.
 *
 * 이 채널 위로 평범한 SSH 가 붙는다(코어가 로컬 리스너를 열어 준다). 그래서 실제 계정으로
 * 들어가고 SFTP·점프가 그대로 살아난다 — SSM 셸은 `ssm-user` 로 들어가서 그것들이 없다.
 *
 * 포트포워딩 세션에는 세션 암호화(KMS)가 적용되지 않는다 — 셸 세션 문서에만 걸린다.
 */
export async function startSsmPortForwardSession(input: {
  credentials: ResolvedAwsCredentials;
  region: string;
  instanceId: string;
  remotePort: number;
  /** 코어가 열 로컬 포트. 0 이면 커널이 빈 포트를 고른다. */
  localPort: number;
}): Promise<{ sessionId: string; streamUrl: string; tokenValue: string }> {
  return startSession(
    input,
    new StartSessionCommand({
      Target: input.instanceId,
      DocumentName: 'AWS-StartPortForwardingSession',
      Parameters: {
        portNumber: [String(input.remotePort)],
        localPortNumber: [String(input.localPort)],
      },
    }),
  );
}

/** SDK 가 주는 바이트를 코어가 기대하는 base64 로. RN 의 buffer 폴리필을 쓴다(aws-sftp.ts 와 같다). */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * EC2 Instance Connect 로 공개키를 인스턴스에 올린다.
 *
 * 이 키는 **60초만** 유효하다 — 그래서 세션마다 새로 만든다. 실패는 대개 권한
 * (`ec2-instance-connect:SendSSHPublicKey`)이거나 계정이 인스턴스에 없는 경우다.
 */
export async function pushEc2InstanceConnectKey(input: {
  credentials: ResolvedAwsCredentials;
  region: string;
  instanceId: string;
  availabilityZone?: string | null;
  osUser: string;
  publicKey: string;
}): Promise<void> {
  const limit = callTimeout(SUPPORT_CALL_TIMEOUT_MS);
  const output = await new EC2InstanceConnectClient({
    region: input.region,
    credentials: input.credentials,
  })
    .send(
      new SendSSHPublicKeyCommand({
        InstanceId: input.instanceId,
        AvailabilityZone: input.availabilityZone ?? undefined,
        InstanceOSUser: input.osUser,
        SSHPublicKey: input.publicKey,
      }),
      { abortSignal: limit.signal },
    )
    .finally(limit.release);
  if (!output.Success) {
    throw new Error('EC2 Instance Connect 가 공개키를 받아들이지 않았습니다.');
  }
}
