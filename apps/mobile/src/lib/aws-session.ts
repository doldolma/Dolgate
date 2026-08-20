import { Linking } from "react-native";
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import type {
  AwsEc2HostRecord,
  AwsSessionEnvSpec,
  AwsSsoMobileLoginHandoffRequest,
  AwsSsoMobileLoginStartRequest,
  AwsTemporaryCredentialPayload,
  ManagedAwsProfilePayload,
  ManagedAwsRoleProfilePayload,
  ManagedAwsSsoProfilePayload,
  ManagedAwsStaticProfilePayload,
} from "@dolssh/shared-core";
import {
  cancelAwsSsoBrowserLogin,
  completeAwsSsoLoginHandoff,
  startAwsSsoBrowserLogin,
} from "./mobile";
import { assertAwsRuntimeReady } from "./aws-runtime";
import {
  closeAwsSsoBrowser,
  openAwsSsoBrowser,
  startAwsSsoLoopback,
  stopAwsSsoLoopback,
} from "./aws-sso-bridge";
import { t } from '../i18n';

type AwsCredentialSet = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

type AwsProfileResolutionContext = {
  seenProfileIds: Set<string>;
  depth: number;
  resolvedSsoProfileId?: string | null;
};

export interface AwsSsoBrowserLoginPrompt {
  loginId: string;
  browserUrl: string;
  hostLabel: string;
  targetProfileName: string;
  sourceProfileName: string;
  chainSummary: string;
  onCancel: () => void;
}

/** SSM API 를 부를 때 쓰는 자격증명. 기기 밖으로 나가지 않는다. */
export interface ResolvedAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ResolvedAwsSessionResult {
  envSpec: AwsSessionEnvSpec;
  /**
   * envSpec 과 같은 값이지만 API 호출용 모양이다.
   *
   * **서버 경유 경로는 envSpec 을 서버로 보내고, 직접 경로는 이 값으로 기기에서 SSM 을 부른다.**
   * 두 경로가 같은 해석기를 쓰도록 여기서 함께 돌려준다 — 자격증명을 두 번 만들면 SSO 토큰
   * 갱신이 한쪽에만 반영되는 일이 생긴다.
   */
  credentials: ResolvedAwsCredentials;
  profileName: string;
  region: string;
  connectionDetails: string;
}

const AWS_ENV_UNSET_KEYS = [
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
];

const AWS_DEFAULT_REGION = "us-east-1";
const AWS_SSO_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const AWS_PROFILE_CHAIN_DEPTH_LIMIT = 5;
let queuedAwsSsoCallbackPayload: AwsSsoMobileLoginHandoffRequest | null = null;

export async function resolveAwsSessionForHost(input: {
  host: AwsEc2HostRecord;
  profiles: ManagedAwsProfilePayload[];
  serverUrl: string;
  authAccessToken: string;
  presentLoginPrompt?: (prompt: AwsSsoBrowserLoginPrompt) => void;
  dismissLoginPrompt?: () => void;
}): Promise<ResolvedAwsSessionResult> {
  assertAwsRuntimeReady();

  const profile = resolveManagedProfileForHost(input.profiles, input.host);
  if (!profile) {
    throw new Error(t('aws.profileNotFound'));
  }

  const credentials = await resolveManagedProfileCredentials({
    profile,
    profiles: input.profiles,
    host: input.host,
    serverUrl: input.serverUrl,
    authAccessToken: input.authAccessToken,
    presentLoginPrompt: input.presentLoginPrompt,
    dismissLoginPrompt: input.dismissLoginPrompt,
    context: {
      seenProfileIds: new Set<string>(),
      depth: 0,
      resolvedSsoProfileId: null,
    },
    targetProfileName: profile.name,
  });

  const envSpec = createAwsSessionEnvSpec(credentials.credentials, credentials.region);
  return {
    envSpec,
    credentials: {
      accessKeyId: credentials.credentials.accessKeyId,
      secretAccessKey: credentials.credentials.secretAccessKey,
      sessionToken: credentials.credentials.sessionToken,
    },
    profileName: profile.name,
    region: credentials.region,
    connectionDetails: [
      profile.name,
      credentials.region,
      input.host.awsInstanceName?.trim() || input.host.awsInstanceId,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function resolveManagedProfileForHost(
  profiles: ManagedAwsProfilePayload[],
  host: AwsEc2HostRecord,
): ManagedAwsProfilePayload | null {
  if (!host.awsProfileId) {
    return null;
  }
  return profiles.find((profile) => profile.id === host.awsProfileId) ?? null;
}

async function resolveManagedProfileCredentials(input: {
  profile: ManagedAwsProfilePayload;
  profiles: ManagedAwsProfilePayload[];
  host: AwsEc2HostRecord;
  serverUrl: string;
  authAccessToken: string;
  presentLoginPrompt?: (prompt: AwsSsoBrowserLoginPrompt) => void;
  dismissLoginPrompt?: () => void;
  context: AwsProfileResolutionContext;
  targetProfileName: string;
}): Promise<{
  credentials: AwsCredentialSet;
  region: string;
}> {
  const nextDepth = input.context.depth + 1;
  if (nextDepth > AWS_PROFILE_CHAIN_DEPTH_LIMIT) {
    throw new Error(t('aws.profileChainFailed'));
  }
  if (input.context.seenProfileIds.has(input.profile.id)) {
    throw new Error(t('aws.profileChainFailed'));
  }

  input.context.seenProfileIds.add(input.profile.id);
  try {
    switch (input.profile.kind) {
      case "static":
        return resolveStaticProfileCredentials(input.profile, input.host);
      case "sso":
        return resolveSsoProfileCredentials({
          profile: input.profile,
          host: input.host,
          serverUrl: input.serverUrl,
          authAccessToken: input.authAccessToken,
          presentLoginPrompt: input.presentLoginPrompt,
          dismissLoginPrompt: input.dismissLoginPrompt,
          context: {
            ...input.context,
            depth: nextDepth,
          },
          targetProfileName: input.targetProfileName,
        });
      case "role":
        return resolveRoleProfileCredentials({
          profile: input.profile,
          profiles: input.profiles,
          host: input.host,
          serverUrl: input.serverUrl,
          authAccessToken: input.authAccessToken,
          presentLoginPrompt: input.presentLoginPrompt,
          dismissLoginPrompt: input.dismissLoginPrompt,
          context: {
            ...input.context,
            depth: nextDepth,
          },
          targetProfileName: input.targetProfileName,
        });
      default:
        throw new Error(t('aws.profileKindUnsupported'));
    }
  } finally {
    input.context.seenProfileIds.delete(input.profile.id);
  }
}

function resolveStaticProfileCredentials(
  profile: ManagedAwsStaticProfilePayload,
  host: AwsEc2HostRecord,
): Promise<{
  credentials: AwsCredentialSet;
  region: string;
}> {
  const region = resolveAwsRegion(host.awsRegion, profile.region);
  const credentials: AwsCredentialSet = {
    accessKeyId: profile.accessKeyId,
    secretAccessKey: profile.secretAccessKey,
  };
  return validateIdentity(credentials, region).then(() => ({
    credentials,
    region,
  }));
}

async function resolveSsoProfileCredentials(input: {
  profile: ManagedAwsSsoProfilePayload;
  host: AwsEc2HostRecord;
  serverUrl: string;
  authAccessToken: string;
  presentLoginPrompt?: (prompt: AwsSsoBrowserLoginPrompt) => void;
  dismissLoginPrompt?: () => void;
  context: AwsProfileResolutionContext;
  targetProfileName: string;
}): Promise<{
  credentials: AwsCredentialSet;
  region: string;
}> {
  if (
    input.context.resolvedSsoProfileId &&
    input.context.resolvedSsoProfileId !== input.profile.id
  ) {
    throw new Error(t('aws.profileChainFailed'));
  }

  const startPayload: AwsSsoMobileLoginStartRequest = {
    targetProfileName: input.targetProfileName,
    sourceProfileName: input.profile.name,
    sourceProfileFingerprint: buildAwsSsoProfileFingerprint(input.profile),
    ssoStartUrl: input.profile.ssoStartUrl,
    ssoRegion: input.profile.ssoRegion,
    ssoAccountId: input.profile.ssoAccountId,
    ssoRoleName: input.profile.ssoRoleName,
    redirectUri: "",
  };

  const loopback = await startAwsSsoLoopback();
  startPayload.redirectUri = loopback.redirectUri;

  const startResponse = await startAwsSsoBrowserLogin(
    input.serverUrl,
    input.authAccessToken,
    startPayload,
  );
  if (startResponse.status === "ready" && startResponse.credential) {
    await stopAwsSsoLoopback().catch(() => undefined);
    return finalizeSsoCredentialResult(
      input.profile,
      input.host,
      startResponse.credential,
    );
  }

  const loginId = startResponse.loginId;
  const browserUrl = startResponse.browserUrl?.trim();
  if (!loginId || !browserUrl) {
    throw new Error(
      startResponse.message?.trim() ||
        t('aws.ssoBrowserFailed'),
    );
  }

  let cancelled = false;
  const cancelLogin = () => {
    cancelled = true;
    void closeAwsSsoBrowser().catch(() => undefined);
    void stopAwsSsoLoopback().catch(() => undefined);
    void cancelAwsSsoBrowserLogin(
      input.serverUrl,
      input.authAccessToken,
      loginId,
    ).catch(() => undefined);
  };

  input.presentLoginPrompt?.({
    loginId,
    browserUrl,
    hostLabel: input.host.label,
    targetProfileName: input.targetProfileName,
    sourceProfileName: input.profile.name,
    chainSummary: buildProfileChainSummary(
      input.targetProfileName,
      input.profile.name,
      input.host.awsInstanceName?.trim() || input.host.awsInstanceId,
    ),
    onCancel: cancelLogin,
  });

  try {
    const callbackPromise = waitForAwsSsoCallback(AWS_SSO_LOGIN_TIMEOUT_MS);
    await openAwsSsoBrowser(browserUrl);
    const callbackPayload = await callbackPromise;
    if (cancelled) {
      throw new Error(t('aws.ssoCancelled'));
    }

    const handoff = await completeAwsSsoLoginHandoff(
      input.serverUrl,
      input.authAccessToken,
      loginId,
      callbackPayload,
    );
    if (handoff.status === "ready" && handoff.credential) {
      return finalizeSsoCredentialResult(
        input.profile,
        input.host,
        handoff.credential,
      );
    }
    if (handoff.status === "cancelled") {
      throw new Error(handoff.message?.trim() || t('aws.ssoCancelled'));
    }
    if (handoff.status === "expired") {
      throw new Error(
        handoff.message?.trim() ||
          t('aws.ssoTimeout'),
      );
    }
    throw new Error(
      handoff.message?.trim() || t('aws.ssoIncomplete'),
    );
  } catch (error) {
    throw normalizeAwsError(error, t('aws.ssoIncomplete'));
  } finally {
    await closeAwsSsoBrowser().catch(() => undefined);
    await stopAwsSsoLoopback().catch(() => undefined);
    input.dismissLoginPrompt?.();
  }
}

async function resolveRoleProfileCredentials(input: {
  profile: ManagedAwsRoleProfilePayload;
  profiles: ManagedAwsProfilePayload[];
  host: AwsEc2HostRecord;
  serverUrl: string;
  authAccessToken: string;
  presentLoginPrompt?: (prompt: AwsSsoBrowserLoginPrompt) => void;
  dismissLoginPrompt?: () => void;
  context: AwsProfileResolutionContext;
  targetProfileName: string;
}): Promise<{
  credentials: AwsCredentialSet;
  region: string;
}> {
  const sourceProfile = input.profiles.find(
    (profile) => profile.id === input.profile.sourceProfileId,
  );
  if (!sourceProfile) {
    throw new Error(t('aws.roleSourceNotFound'));
  }

  const source = await resolveManagedProfileCredentials({
    profile: sourceProfile,
    profiles: input.profiles,
    host: input.host,
    serverUrl: input.serverUrl,
    authAccessToken: input.authAccessToken,
    presentLoginPrompt: input.presentLoginPrompt,
    dismissLoginPrompt: input.dismissLoginPrompt,
    context: input.context,
    targetProfileName: input.targetProfileName,
  });
  const region = resolveAwsRegion(
    input.host.awsRegion,
    input.profile.region,
    source.region,
  );
  const stsClient = new STSClient({
    region,
    credentials: source.credentials,
  });
  const response = await sendAwsCommand(
    () =>
      stsClient.send(
        new AssumeRoleCommand({
          RoleArn: input.profile.roleArn,
          RoleSessionName: `dolgate-mobile-${Date.now()}`,
        }),
      ),
    t('aws.roleCredentialFailed'),
  );
  if (
    !response.Credentials?.AccessKeyId ||
    !response.Credentials.SecretAccessKey ||
    !response.Credentials.SessionToken
  ) {
    throw new Error(t('aws.roleCredentialFailed'));
  }

  const credentials: AwsCredentialSet = {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
  };
  await validateIdentity(credentials, region);
  return { credentials, region };
}

async function finalizeSsoCredentialResult(
  profile: ManagedAwsSsoProfilePayload,
  host: AwsEc2HostRecord,
  credential: AwsTemporaryCredentialPayload,
): Promise<{
  credentials: AwsCredentialSet;
  region: string;
}> {
  if (!credential.accessKeyId || !credential.secretAccessKey) {
    throw new Error(t('aws.ssoRoleCredentialFailed'));
  }

  const region = resolveAwsRegion(host.awsRegion, profile.region, profile.ssoRegion);
  const credentials: AwsCredentialSet = {
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    sessionToken: credential.sessionToken,
  };
  await validateIdentity(credentials, region);
  return { credentials, region };
}

function buildAwsSsoProfileFingerprint(
  profile: ManagedAwsSsoProfilePayload,
): string {
  return [
    profile.name.trim(),
    profile.ssoStartUrl.trim().toLowerCase(),
    profile.ssoRegion.trim().toLowerCase(),
    profile.ssoAccountId.trim(),
    profile.ssoRoleName.trim(),
  ].join("::");
}

function buildProfileChainSummary(
  targetProfileName: string,
  sourceProfileName: string,
  hostLabel: string,
): string {
  if (targetProfileName === sourceProfileName) {
    return `${sourceProfileName} · ${hostLabel}`;
  }
  return `${targetProfileName} ← ${sourceProfileName} · ${hostLabel}`;
}

async function validateIdentity(
  credentials: AwsCredentialSet,
  region: string,
): Promise<void> {
  const client = new STSClient({
    region,
    credentials,
  });
  await sendAwsCommand(
    () => client.send(new GetCallerIdentityCommand({})),
    t('aws.credentialVerifyFailed'),
  );
}

function createAwsSessionEnvSpec(
  credentials: AwsCredentialSet,
  region: string,
): AwsSessionEnvSpec {
  const env: Record<string, string> = {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
  };
  if (credentials.sessionToken) {
    env.AWS_SESSION_TOKEN = credentials.sessionToken;
  }
  return {
    env,
    unsetEnv: AWS_ENV_UNSET_KEYS,
  };
}

function resolveAwsRegion(...candidates: Array<string | null | undefined>): string {
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return AWS_DEFAULT_REGION;
}

function getAwsErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const namedError = error as { name?: unknown };
  return typeof namedError.name === "string" ? namedError.name : undefined;
}

function appendAwsErrorMessage(target: string[], value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized || normalized === "UnknownError") {
    return;
  }
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function describeAwsError(error: unknown): string | undefined {
  const messages: string[] = [];

  if (typeof error === "string") {
    appendAwsErrorMessage(messages, error);
  }

  if (error instanceof Error) {
    appendAwsErrorMessage(messages, error.message);
    appendAwsErrorMessage(messages, error.name);
    const causedBy = (error as Error & { cause?: unknown }).cause;
    if (causedBy !== undefined) {
      appendAwsErrorMessage(messages, describeAwsError(causedBy));
    }
  }

  if (typeof error !== "object" || error === null) {
    return messages.length > 0 ? messages.join(" · ") : undefined;
  }

  const candidate = error as Record<string, unknown>;
  appendAwsErrorMessage(messages, candidate.message);
  appendAwsErrorMessage(messages, candidate.Message);
  appendAwsErrorMessage(messages, candidate.reason);
  appendAwsErrorMessage(messages, candidate.detail);
  appendAwsErrorMessage(messages, candidate.details);
  appendAwsErrorMessage(messages, candidate.error);
  appendAwsErrorMessage(messages, candidate.error_description);
  appendAwsErrorMessage(messages, candidate.errorDescription);
  appendAwsErrorMessage(messages, candidate.code);
  appendAwsErrorMessage(messages, candidate.Code);
  appendAwsErrorMessage(messages, candidate.__type);

  const metadata = candidate.$metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const statusCode = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
    if (typeof statusCode === "number") {
      appendAwsErrorMessage(messages, `HTTP ${statusCode}`);
    }
  }

  const response = candidate.$response;
  if (typeof response === "object" && response !== null) {
    appendAwsErrorMessage(
      messages,
      (response as { statusText?: unknown }).statusText,
    );
  }

  return messages.length > 0 ? messages.join(" · ") : undefined;
}

function normalizeAwsError(error: unknown, fallbackMessage: string): Error {
  const details = describeAwsError(error);

  if (error instanceof Error) {
    const message = error.message.trim();
    if (message && message !== "UnknownError") {
      return error;
    }
    if (details) {
      return new Error(details);
    }
  }

  if (details) {
    return new Error(details);
  }

  return new Error(fallbackMessage);
}

async function sendAwsCommand<T>(
  request: () => Promise<T>,
  fallbackMessage: string,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw normalizeAwsError(error, fallbackMessage);
  }
}

async function waitForAwsSsoCallback(
  timeoutMs: number,
): Promise<AwsSsoMobileLoginHandoffRequest> {
  const queuedPayload = consumeQueuedAwsSsoCallbackPayload();
  if (queuedPayload) {
    return queuedPayload;
  }

  try {
    const initialUrl = await Linking.getInitialURL();
    const initialPayload = parseAwsSsoCallbackUrl(initialUrl);
    if (initialPayload) {
      return initialPayload;
    }
  } catch {}

  return await new Promise<AwsSsoMobileLoginHandoffRequest>((resolve, reject) => {
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      subscription.remove();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    };

    const resolveWithUrl = (url: string | null | undefined) => {
      const payload = parseAwsSsoCallbackUrl(url);
      if (!payload) {
        return false;
      }
      cleanup();
      resolve(payload);
      return true;
    };

    const subscription = Linking.addEventListener("url", ({ url }) => {
      resolveWithUrl(url);
    });

    timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error(t('aws.ssoTimeout')));
    }, Math.max(timeoutMs, 1_000));
  });
}

export function recordAwsSsoCallbackUrl(
  rawUrl: string | null | undefined,
): boolean {
  const payload = parseAwsSsoCallbackUrl(rawUrl);
  if (!payload) {
    return false;
  }
  queuedAwsSsoCallbackPayload = payload;
  return true;
}

function consumeQueuedAwsSsoCallbackPayload():
  | AwsSsoMobileLoginHandoffRequest
  | null {
  const payload = queuedAwsSsoCallbackPayload;
  queuedAwsSsoCallbackPayload = null;
  return payload;
}

function parseAwsSsoCallbackUrl(
  rawUrl: string | null | undefined,
): AwsSsoMobileLoginHandoffRequest | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "dolgate:" || parsed.host !== "aws-sso") {
    return null;
  }
  if (parsed.pathname !== "/callback") {
    return null;
  }

  return {
    code: parsed.searchParams.get("code") ?? undefined,
    state: parsed.searchParams.get("state") ?? undefined,
    error: parsed.searchParams.get("error") ?? undefined,
    errorDescription:
      parsed.searchParams.get("error_description") ??
      parsed.searchParams.get("errorDescription") ??
      undefined,
  };
}
