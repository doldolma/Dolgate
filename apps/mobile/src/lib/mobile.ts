import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import * as Keychain from "react-native-keychain";
import type {
  AuthSession,
  AuthState,
  AwsSsoMobileLoginHandoffRequest,
  AwsSsoMobileHandoffResponse,
  AwsSsoMobileLoginStartRequest,
  AwsSsoMobileLoginStartResponse,
  AwsEc2HostRecord,
  ManagedAwsProfilePayload,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  ManagedSecretPayload,
  SecretMetadataRecord,
  SshHostRecord,
  SyncPayloadV2,
  SyncRecord,
  SyncStatus,
  ServerInfoResponse,
} from "@dolssh/shared-core";
import {
  isAwsEc2HostRecord,
  getServerUrlValidationMessage,
  isSshHostRecord,
  normalizeServerUrl,
  type HostSecretInput,
  type MobileSettings,
} from "@dolssh/shared-core";
import { fromByteArray, toByteArray } from "base64-js";

export const DEFAULT_SERVER_URL = "https://ssh.doldolma.com";
export const AUTH_REDIRECT_URI = "dolgate://auth/callback";
export const AUTH_CLIENT_ID = "dolgate-mobile";
export const AWS_SSO_APP_CALLBACK_URI = "dolgate://aws-sso/callback";

const AUTH_SESSION_SERVICE = "dolgate.mobile.auth-session";
const MANAGED_SECRETS_SERVICE = "dolgate.mobile.managed-secrets";
const MANAGED_AWS_PROFILES_SERVICE = "dolgate.mobile.managed-aws-profiles";
const AWS_SSO_TOKENS_SERVICE = "dolgate.mobile.aws-sso-tokens";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface SyncEnvelope {
  v: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface FetchRequestOptions {
  timeoutMs?: number;
  timeoutMessage?: string;
}

type ManagedSecretsMap = Record<string, LoadedManagedSecretPayload>;

export interface StoredAwsSsoTokenRecord {
  profileId: string;
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
}

export interface MobileServerPublicKeyInfo {
  host: string;
  port: number;
  remoteIp?: string;
  algorithm: string;
  fingerprintSha256: string;
  keyBase64: string;
}

export function createDefaultMobileSettings(): MobileSettings {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    theme: "system",
  };
}

export function createDefaultSyncStatus(): SyncStatus {
  return {
    status: "idle",
    pendingPush: false,
    lastSuccessfulSyncAt: null,
    errorMessage: null,
    awsProfilesServerSupport: "unknown",
    awsSsmServerSupport: "unknown",
  };
}

export function createUnauthenticatedState(): AuthState {
  return {
    status: "unauthenticated",
    session: null,
    offline: null,
    errorMessage: null,
  };
}

export function buildBrowserLoginUrl(serverUrl: string, state: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  const loginUrl = new URL("/login", normalized);
  loginUrl.searchParams.set("client", AUTH_CLIENT_ID);
  loginUrl.searchParams.set("redirect_uri", AUTH_REDIRECT_URI);
  loginUrl.searchParams.set("state", state);
  return loginUrl.toString();
}

export function buildAwsSsoRedirectUri(serverUrl: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  const callbackUrl = new URL("/auth/aws-sso/callback", normalized);
  return callbackUrl.toString();
}

export async function startAwsSsoBrowserLogin(
  serverUrl: string,
  accessToken: string,
  payload: AwsSsoMobileLoginStartRequest,
): Promise<AwsSsoMobileLoginStartResponse> {
  return fetchJson<AwsSsoMobileLoginStartResponse>(
    new URL("/api/aws-sso/mobile/start", normalizeServerUrl(serverUrl)).toString(),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function fetchAwsSsoLoginHandoff(
  serverUrl: string,
  accessToken: string,
  loginId: string,
): Promise<AwsSsoMobileHandoffResponse> {
  return fetchJson<AwsSsoMobileHandoffResponse>(
    new URL(
      `/api/aws-sso/mobile/handoff/${encodeURIComponent(loginId)}`,
      normalizeServerUrl(serverUrl),
    ).toString(),
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function completeAwsSsoLoginHandoff(
  serverUrl: string,
  accessToken: string,
  loginId: string,
  payload: AwsSsoMobileLoginHandoffRequest,
): Promise<AwsSsoMobileHandoffResponse> {
  return fetchJson<AwsSsoMobileHandoffResponse>(
    new URL(
      `/api/aws-sso/mobile/handoff/${encodeURIComponent(loginId)}`,
      normalizeServerUrl(serverUrl),
    ).toString(),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function cancelAwsSsoBrowserLogin(
  serverUrl: string,
  accessToken: string,
  loginId: string,
): Promise<void> {
  await fetchEmpty(
    new URL("/api/aws-sso/mobile/cancel", normalizeServerUrl(serverUrl)).toString(),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ loginId }),
    },
  );
}

export function buildEmptySyncPayload(): SyncPayloadV2 {
  return {
    groups: [],
    hosts: [],
    secrets: [],
    knownHosts: [],
    portForwards: [],
    dnsOverrides: [],
    preferences: [],
    awsProfiles: [],
  };
}

export function createRandomStateToken(): string {
  return `state-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatRelativeTime(input: string | null | undefined): string {
  if (!input) {
    return "방금";
  }

  const value = new Date(input).getTime();
  if (Number.isNaN(value)) {
    return "방금";
  }

  const diffMs = Date.now() - value;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes <= 0) {
    return "방금";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}분 전`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}시간 전`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}일 전`;
}

export function getSettingsValidationMessage(serverUrl: string): string | null {
  return getServerUrlValidationMessage(serverUrl);
}

export async function loadStoredAuthSession(): Promise<AuthSession | null> {
  const credentials = await Keychain.getGenericPassword({
    service: AUTH_SESSION_SERVICE,
  });
  if (!credentials) {
    return null;
  }

  try {
    return JSON.parse(credentials.password) as AuthSession;
  } catch {
    return null;
  }
}

export async function saveStoredAuthSession(session: AuthSession): Promise<void> {
  await Keychain.setGenericPassword("dolgate", JSON.stringify(session), {
    service: AUTH_SESSION_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredAuthSession(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: AUTH_SESSION_SERVICE,
  });
}

export async function loadStoredSecrets(): Promise<ManagedSecretsMap> {
  const credentials = await Keychain.getGenericPassword({
    service: MANAGED_SECRETS_SERVICE,
  });
  if (!credentials) {
    return {};
  }

  try {
    return JSON.parse(credentials.password) as ManagedSecretsMap;
  } catch {
    return {};
  }
}

export async function saveStoredSecrets(
  secretsByRef: ManagedSecretsMap,
): Promise<void> {
  await Keychain.setGenericPassword("dolgate", JSON.stringify(secretsByRef), {
    service: MANAGED_SECRETS_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredSecrets(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: MANAGED_SECRETS_SERVICE,
  });
}

export async function loadStoredAwsProfiles(): Promise<
  ManagedAwsProfilePayload[]
> {
  const credentials = await Keychain.getGenericPassword({
    service: MANAGED_AWS_PROFILES_SERVICE,
  });
  if (!credentials) {
    return [];
  }

  try {
    return JSON.parse(credentials.password) as ManagedAwsProfilePayload[];
  } catch {
    return [];
  }
}

export async function saveStoredAwsProfiles(
  profiles: ManagedAwsProfilePayload[],
): Promise<void> {
  await Keychain.setGenericPassword("dolgate", JSON.stringify(profiles), {
    service: MANAGED_AWS_PROFILES_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredAwsProfiles(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: MANAGED_AWS_PROFILES_SERVICE,
  });
}

export async function loadStoredAwsSsoTokens(): Promise<
  Record<string, StoredAwsSsoTokenRecord>
> {
  const credentials = await Keychain.getGenericPassword({
    service: AWS_SSO_TOKENS_SERVICE,
  });
  if (!credentials) {
    return {};
  }

  try {
    return JSON.parse(credentials.password) as Record<
      string,
      StoredAwsSsoTokenRecord
    >;
  } catch {
    return {};
  }
}

export async function saveStoredAwsSsoTokens(
  tokensByProfileId: Record<string, StoredAwsSsoTokenRecord>,
): Promise<void> {
  await Keychain.setGenericPassword("dolgate", JSON.stringify(tokensByProfileId), {
    service: AWS_SSO_TOKENS_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredAwsSsoTokens(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: AWS_SSO_TOKENS_SERVICE,
  });
}

export async function fetchExchangeSession(
  serverUrl: string,
  code: string,
): Promise<AuthSession> {
  return fetchJson<AuthSession>(new URL("/auth/exchange", normalizeServerUrl(serverUrl)).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
}

export async function refreshAuthSession(
  serverUrl: string,
  session: AuthSession,
  options?: FetchRequestOptions,
): Promise<AuthSession> {
  return fetchJson<AuthSession>(new URL("/auth/refresh", normalizeServerUrl(serverUrl)).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      refreshToken: session.tokens.refreshToken,
    }),
  }, options);
}

export async function logoutRemoteSession(
  serverUrl: string,
  session: AuthSession | null,
): Promise<void> {
  if (!session?.tokens.refreshToken) {
    return;
  }

  await fetchEmpty(new URL("/auth/logout", normalizeServerUrl(serverUrl)).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      refreshToken: session.tokens.refreshToken,
    }),
  });
}

export async function fetchSyncSnapshot(
  serverUrl: string,
  accessToken: string,
): Promise<SyncPayloadV2> {
  return fetchJson<SyncPayloadV2>(new URL("/sync", normalizeServerUrl(serverUrl)).toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
}

export async function fetchServerInfo(
  serverUrl: string,
): Promise<ServerInfoResponse> {
  return fetchJson<ServerInfoResponse>(
    new URL("/api/info", normalizeServerUrl(serverUrl)).toString(),
  );
}

export async function postSyncSnapshot(
  serverUrl: string,
  accessToken: string,
  payload: SyncPayloadV2,
): Promise<void> {
  await fetchEmpty(new URL("/sync", normalizeServerUrl(serverUrl)).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export function decodeSyncRecords<T>(
  records: SyncRecord[],
  keyBase64: string,
): T[] {
  return records
    .filter((record) => !record.deleted_at)
    .map((record) => decodeEncryptedPayload<T>(record.encrypted_payload, keyBase64));
}

export function decodeSshHosts(
  payload: SyncPayloadV2,
  keyBase64: string,
): SshHostRecord[] {
  return decodeSyncRecords<HostRecord>(payload.hosts, keyBase64).filter(
    isSshHostRecord,
  );
}

export function decodeSupportedHosts(
  payload: SyncPayloadV2,
  keyBase64: string,
): Array<SshHostRecord | AwsEc2HostRecord> {
  return decodeSyncRecords<HostRecord>(payload.hosts, keyBase64).filter(
    (host): host is SshHostRecord | AwsEc2HostRecord =>
      isSshHostRecord(host) || isAwsEc2HostRecord(host),
  );
}

export function decodeGroups(
  payload: SyncPayloadV2,
  keyBase64: string,
): GroupRecord[] {
  return decodeSyncRecords<GroupRecord>(payload.groups, keyBase64);
}

export function decodeKnownHosts(
  payload: SyncPayloadV2,
  keyBase64: string,
): KnownHostRecord[] {
  return decodeSyncRecords<KnownHostRecord>(payload.knownHosts, keyBase64);
}

export function decodeManagedSecrets(
  payload: SyncPayloadV2,
  keyBase64: string,
): ManagedSecretsMap {
  const next: ManagedSecretsMap = {};
  for (const record of decodeSyncRecords<ManagedSecretPayload>(
    payload.secrets,
    keyBase64,
  )) {
    next[record.secretRef] = record;
  }
  return next;
}

export function decodeAwsProfiles(
  payload: SyncPayloadV2,
  keyBase64: string,
): ManagedAwsProfilePayload[] {
  return decodeSyncRecords<ManagedAwsProfilePayload>(
    payload.awsProfiles,
    keyBase64,
  ).sort((left, right) => left.name.localeCompare(right.name));
}

export function buildKnownHostsSyncPayload(
  knownHosts: KnownHostRecord[],
  keyBase64: string,
): SyncPayloadV2 {
  return {
    ...buildEmptySyncPayload(),
    knownHosts: knownHosts.map((record) => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
  };
}

export function buildKnownHostRecord(
  info: MobileServerPublicKeyInfo,
  existing?: KnownHostRecord | null,
): KnownHostRecord {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? createLocalId("known-host"),
    host: info.host,
    port: info.port,
    algorithm: info.algorithm,
    publicKeyBase64: info.keyBase64,
    fingerprintSha256: info.fingerprintSha256,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: now,
    updatedAt: now,
  };
}

export function deriveSecretMetadata(
  hosts: HostRecord[],
  secretsByRef: ManagedSecretsMap,
): SecretMetadataRecord[] {
  return Object.values(secretsByRef)
    .map((record) => ({
      secretRef: record.secretRef,
      label: record.label,
      hasPassword: Boolean(record.password),
      hasPassphrase: Boolean(record.passphrase),
      hasManagedPrivateKey: Boolean(record.privateKeyPem),
      hasCertificate: Boolean(record.certificateText),
      linkedHostCount: hosts.filter(
        (host) => isSshHostRecord(host) && host.secretRef === record.secretRef,
      ).length,
      updatedAt: record.updatedAt,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function mergePromptedSecrets(
  previous: LoadedManagedSecretPayload | undefined,
  host: SshHostRecord,
  prompt: HostSecretInput,
): LoadedManagedSecretPayload | null {
  if (!host.secretRef) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    secretRef: host.secretRef,
    label: previous?.label ?? `${host.label} credentials`,
    password: prompt.password ?? previous?.password,
    passphrase: prompt.passphrase ?? previous?.passphrase,
    privateKeyPem: prompt.privateKeyPem ?? previous?.privateKeyPem,
    certificateText: prompt.certificateText ?? previous?.certificateText,
    updatedAt: now,
  };
}

export function sanitizeTerminalSnapshot(input: string): string {
  return input.replace(/\u0000/g, "").replace(/\r/g, "");
}

function encodeEncryptedPayload<T>(value: T, keyBase64: string): string {
  const key = toByteArray(keyBase64);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const sealed = gcm(key, iv).encrypt(plaintext);
  const tag = sealed.slice(sealed.length - 16);
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const envelope: SyncEnvelope = {
    v: 1,
    iv: fromByteArray(iv),
    tag: fromByteArray(tag),
    ciphertext: fromByteArray(ciphertext),
  };
  return JSON.stringify(envelope);
}

function decodeEncryptedPayload<T>(payload: string, keyBase64: string): T {
  const envelope = JSON.parse(payload) as SyncEnvelope;
  const key = toByteArray(keyBase64);
  const iv = toByteArray(envelope.iv);
  const tag = toByteArray(envelope.tag);
  const ciphertext = toByteArray(envelope.ciphertext);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  const plaintext = gcm(key, iv).decrypt(sealed);
  return JSON.parse(Buffer.from(plaintext).toString("utf8")) as T;
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  options?: FetchRequestOptions,
): Promise<T> {
  const response = await fetchWithOptions(url, init, options);
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

async function fetchEmpty(
  url: string,
  init?: RequestInit,
  options?: FetchRequestOptions,
): Promise<void> {
  const response = await fetchWithOptions(url, init, options);
  if (!response.ok) {
    throw await toApiError(response);
  }
}

async function fetchWithOptions(
  url: string,
  init?: RequestInit,
  options?: FetchRequestOptions,
): Promise<Response> {
  if (!options?.timeoutMs || options.timeoutMs <= 0) {
    return fetch(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(options.timeoutMessage ?? "요청 시간이 초과되었습니다.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const raw = await response.text();
  const trimmed = raw.trim();
  const message =
    extractApiErrorMessage(trimmed) ||
    `요청이 실패했습니다. (${response.status})`;
  return new ApiError(message, response.status);
}

function extractApiErrorMessage(raw: string): string | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    return raw;
  }

  return raw;
}

export {
  AsyncStorage,
  Keychain,
};
