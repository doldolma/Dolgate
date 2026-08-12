import {
  getParentGroupPath,
  isKnownHostKind,
  normalizeGroupPath,
  normalizeJumpHostIds,
  projectSecretMetadata,
  type AwsProfileMetadataRecord,
  type DnsOverrideRecord,
  type GroupRecord,
  type HostRecord,
  type KnownHostRecord,
  type RdpHostRecord,
  type SshHostRecord,
  type VncHostRecord,
  type ManagedAwsProfilePayload,
  type ManagedSecretPayload,
  type PortForwardRuleRecord,
  type SecretMetadataRecord,
  type SnippetRecord,
  type TailnetPayload,
  type SyncKind,
} from "@shared";
import { randomUUID } from "node:crypto";
import type {
  DolgateImportItemCounts,
  DolgateImportPreview,
  DolgateImportResult,
  HostExportPreview,
} from "../shared/ipc";
import {
  decryptDolgateHostBundle,
  encryptDolgateHostBundle,
  MAX_DOLGATE_RECORDS,
  type DolgateHostBundleV1,
} from "./host-transfer-format";
import { buildOpenSshConfig, type OpenSshExportBuild } from "./openssh-export";
import {
  getDesktopStateStorage,
  normalizeDnsOverrideRecord,
  normalizeHostRecord,
  normalizePortForwardRule,
  type DesktopStateFile,
  type StoredEncryptedValue,
} from "./state-storage";
import {
  decodeSecretFromStorage,
  encodeSecretForStorage,
} from "./secret-store";
import { t } from "./i18n";

const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

interface ImportSnapshot {
  bundle: DolgateHostBundleV1;
  expiresAt: number;
}

interface ImportPlan {
  groups: GroupRecord[];
  hosts: HostRecord[];
  secrets: ManagedSecretPayload[];
  secretMetadata: SecretMetadataRecord[];
  knownHosts: KnownHostRecord[];
  portForwards: PortForwardRuleRecord[];
  dnsOverrides: DnsOverrideRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  awsProfileMetadata: AwsProfileMetadataRecord[];
  snippets: SnippetRecord[];
  tailnets: TailnetPayload[];
  skippedCount: number;
  skippedCounts: DolgateImportItemCounts;
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, labelKey: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(t("transfer.error.invalidValue", { field: t(labelKey) }));
  }
  return value;
}

function requireArray(value: unknown, labelKey: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(t("transfer.error.invalidList", { field: t(labelKey) }));
  }
  return value;
}

function assertUniqueIds<T>(items: T[], idOf: (item: T) => string, labelKey: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    const id = idOf(item);
    if (ids.has(id)) {
      throw new Error(t("transfer.error.duplicateId", { field: t(labelKey) }));
    }
    ids.add(id);
  }
}

function parseGroup(value: unknown): GroupRecord {
  if (!isObject(value)) {
    throw new Error(t("transfer.error.invalidGroup"));
  }
  const path = normalizeGroupPath(requireString(value.path, "transfer.field.groupPath"));
  if (!path) {
    throw new Error(t("transfer.error.invalidGroupPath"));
  }
  return {
    id: requireString(value.id, "transfer.field.groupId"),
    name: requireString(value.name, "transfer.field.groupName"),
    path,
    parentPath: normalizeGroupPath(
      typeof value.parentPath === "string" ? value.parentPath : null,
    ),
    createdAt: requireString(value.createdAt, "transfer.field.groupCreatedAt"),
    updatedAt: requireString(value.updatedAt, "transfer.field.groupUpdatedAt"),
  };
}

/**
 * 자격증명·tailnet 을 **참조로** 갖는 호스트 종류인가.
 *
 * 종류를 늘릴 때 여기를 빼먹으면 그 호스트의 자격증명이 내보내기에서 조용히 빠진다 — 참조를 세지
 * 않으니 "아무도 안 쓰는 자격증명" 으로 걸러지고, 가져오기 쪽 검증도 건너뛴다. VNC 가 실제로
 * 그랬다. 조건을 여섯 곳에 흩어 두지 않고 이 함수 하나만 고치게 한다.
 */
function hasCredentialRefs(
  host: HostRecord,
): host is SshHostRecord | RdpHostRecord | VncHostRecord {
  return host.kind === "ssh" || host.kind === "rdp" || host.kind === "vnc";
}

function parseHost(value: unknown): HostRecord {
  if (
    !isObject(value) ||
    !isKnownHostKind(value.kind) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error(t("transfer.error.invalidHost"));
  }
  const host = normalizeHostRecord(value);
  if (!host || !host.id.trim() || !host.label.trim()) {
    throw new Error(t("transfer.error.invalidHost"));
  }
  return host;
}

function parseSecret(value: unknown): ManagedSecretPayload {
  if (!isObject(value)) {
    throw new Error(t("transfer.error.invalidSecret"));
  }
  const secretRef = requireString(value.secretRef, "transfer.field.secretId");
  if (!secretRef.startsWith("secret:")) {
    throw new Error(t("transfer.error.invalidSecretId"));
  }
  const label = requireString(value.label, "transfer.field.secretLabel");
  const updatedAt = requireString(value.updatedAt, "transfer.field.secretUpdatedAt");
  const stringFields = [
    "password",
    "passphrase",
    "privateKeyPem",
    "certificateText",
    "publicKey",
    "publicKeyFingerprintSha256",
    "keyAlgorithm",
    "keyCurve",
    "privateKeyCipher",
    // RDP 자격증명 — 계정이 호스트가 아니라 자격증명에 있다(DOMAIN\user+비밀번호가 한 묶음).
    "username",
    "domain",
  ];
  const booleanFields = [
    "privateKeyEncrypted",
    "passphraseSaved",
    "generatedByApp",
  ];
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(t("transfer.error.invalidSecret"));
    }
  }
  for (const field of booleanFields) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new Error(t("transfer.error.invalidSecret"));
    }
  }
  if (
    value.keyBits !== undefined &&
    (typeof value.keyBits !== "number" || !Number.isFinite(value.keyBits))
  ) {
    throw new Error(t("transfer.error.invalidSecret"));
  }
  if (
    value.privateKeyKdfRounds !== undefined &&
    (typeof value.privateKeyKdfRounds !== "number" ||
      !Number.isFinite(value.privateKeyKdfRounds))
  ) {
    throw new Error(t("transfer.error.invalidSecret"));
  }
  return {
    ...value,
    secretRef,
    label,
    updatedAt,
  } as unknown as ManagedSecretPayload;
}

function parseAwsProfile(value: unknown): ManagedAwsProfilePayload {
  if (!isObject(value)) {
    throw new Error(t("transfer.error.invalidAwsProfile"));
  }
  if (value.region !== undefined && value.region !== null && typeof value.region !== "string") {
    throw new Error(t("transfer.error.invalidAwsProfileRegion"));
  }
  const base = {
    id: requireString(value.id, "transfer.field.awsProfileId"),
    name: requireString(value.name, "transfer.field.awsProfileName"),
    region: typeof value.region === "string" ? value.region : null,
    updatedAt: requireString(value.updatedAt, "transfer.field.awsProfileUpdatedAt"),
  };
  if (value.kind === "static") {
    return {
      ...base,
      kind: "static",
      accessKeyId: requireString(value.accessKeyId, "AWS access key"),
      secretAccessKey: requireString(value.secretAccessKey, "AWS secret key"),
    };
  }
  if (value.kind === "sso") {
    return {
      ...base,
      kind: "sso",
      ssoStartUrl: requireString(value.ssoStartUrl, "AWS SSO URL"),
      ssoRegion: requireString(value.ssoRegion, "transfer.field.ssoRegion"),
      ssoAccountId: requireString(value.ssoAccountId, "transfer.field.ssoAccount"),
      ssoRoleName: requireString(value.ssoRoleName, "transfer.field.ssoRole"),
    };
  }
  if (value.kind === "role") {
    return {
      ...base,
      kind: "role",
      sourceProfileId: requireString(value.sourceProfileId, "transfer.field.awsSourceProfileId"),
      roleArn: requireString(value.roleArn, "transfer.field.awsRoleArn"),
    };
  }
  throw new Error(t("transfer.error.invalidAwsProfileKind"));
}

function parseKnownHost(value: unknown): KnownHostRecord {
  if (!isObject(value)) {
    throw new Error(t("transfer.error.invalidKnownHost"));
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port)) {
    throw new Error(t("transfer.error.invalidKnownHostPort"));
  }
  return {
    id: requireString(value.id, "known host ID"),
    host: requireString(value.host, "transfer.field.knownHostAddress"),
    port: value.port,
    algorithm: requireString(value.algorithm, "transfer.field.knownHostAlgorithm"),
    publicKeyBase64: requireString(value.publicKeyBase64, "transfer.field.knownHostPublicKey"),
    fingerprintSha256: requireString(value.fingerprintSha256, "known host fingerprint"),
    createdAt: requireString(value.createdAt, "transfer.field.knownHostCreatedAt"),
    lastSeenAt: requireString(value.lastSeenAt, "transfer.field.knownHostLastSeenAt"),
    updatedAt: requireString(value.updatedAt, "transfer.field.knownHostUpdatedAt"),
  };
}

function parseSnippet(value: unknown): SnippetRecord {
  if (!isObject(value)) {
    throw new Error(t("transfer.error.invalidSnippet"));
  }
  return {
    id: requireString(value.id, "snippet ID"),
    label: requireString(value.label, "transfer.field.snippetLabel"),
    command: requireString(value.command, "transfer.field.snippetCommand"),
    keyword: typeof value.keyword === "string" ? value.keyword : null,
    createdAt: requireString(value.createdAt, "transfer.field.snippetCreatedAt"),
    updatedAt: requireString(value.updatedAt, "transfer.field.snippetUpdatedAt"),
  };
}

/**
 * tailnet 등록 정보를 읽는다. auth key 는 있을 수도, 없을 수도 있다(브라우저 로그인 방식).
 *
 * hasAuthKey 는 파일 값을 믿지 않고 키의 유무로 다시 세운다 — 저장이 레코드와 키 두 곳으로
 * 나뉘어서, 파일이 말하는 것과 실제가 어긋나면 "키가 있다는데 없는" 상태가 만들어진다.
 */
function parseTailnet(value: unknown): TailnetPayload {
  if (!isObject(value)) {
    throw new Error(t("transfer.error.invalidTailnet"));
  }
  const authKey =
    typeof value.authKey === "string" && value.authKey ? value.authKey : undefined;
  return {
    id: requireString(value.id, "transfer.field.tailnetId"),
    label: requireString(value.label, "transfer.field.tailnetLabel"),
    ...(typeof value.controlUrl === "string" ? { controlUrl: value.controlUrl } : {}),
    ...(typeof value.tailnetName === "string" ? { tailnetName: value.tailnetName } : {}),
    ...(typeof value.loginName === "string" ? { loginName: value.loginName } : {}),
    ephemeral: value.ephemeral === true,
    hasAuthKey: Boolean(authKey),
    ...(authKey ? { authKey } : {}),
    createdAt: requireString(value.createdAt, "transfer.field.tailnetCreatedAt"),
    updatedAt: requireString(value.updatedAt, "transfer.field.tailnetUpdatedAt"),
  };
}

export interface ParsedDolgateBundle {
  bundle: DolgateHostBundleV1;
  /** 거부하지 않고 건너뛴 항목 안내. 가져오기 미리보기의 경고 목록에 그대로 얹는다. */
  warnings: string[];
}

export function parseDolgateBundle(value: unknown): ParsedDolgateBundle {
  if (!isObject(value) || value.schemaVersion !== 1 || value.scope !== "hosts") {
    throw new Error(t("transfer.error.unsupportedBundle"));
  }
  const rootHostIds = requireArray(value.rootHostIds, "transfer.field.selectedHosts").map((id) =>
    requireString(id, "transfer.field.selectedHostId"),
  );
  const groups = requireArray(value.groups, "transfer.field.groups").map(parseGroup);

  // 이 버전이 모르는 종류의 호스트는 파일 전체를 거부하지 않고 그 호스트만 건너뛴다.
  // 종류는 계속 추가되므로(RDP 가 그랬다) 거부하면 새 버전에서 내보낸 파일이 옛 버전에서
  // 통째로 열리지 않는다. 형식이 깨진 항목은 여전히 거부한다 — 깨진 파일과 새 파일은 다르다.
  const rawHosts = requireArray(value.hosts, "transfer.field.hosts");
  const skippedHostIds = new Set<string>();
  const orphanedSecretRefs = new Set<string>();
  const orphanedTailnetIds = new Set<string>();
  let unknownKindHostCount = 0;
  const hosts: HostRecord[] = [];
  for (const raw of rawHosts) {
    if (isObject(raw) && typeof raw.kind === "string" && !isKnownHostKind(raw.kind)) {
      unknownKindHostCount += 1;
      if (typeof raw.id === "string") {
        skippedHostIds.add(raw.id);
      }
      // 같이 실려 온 자격증명·tailnet 은 이 호스트 몫일 수 있다. 남는 호스트가 같은 것을
      // 참조하지 않으면 가져오지 않는다 — 주인 없는 자격증명을 심지 않기 위해서다.
      if (typeof raw.secretRef === "string") {
        orphanedSecretRefs.add(raw.secretRef);
      }
      if (typeof raw.tailnetId === "string") {
        orphanedTailnetIds.add(raw.tailnetId);
      }
      continue;
    }
    hosts.push(parseHost(raw));
  }

  // 건너뛴 호스트를 점프(베스천)로 쓰는 호스트도 함께 내린다. 체인(A→B→C)이 있으므로
  // 더 빠지는 것이 없을 때까지 반복한다.
  let dependentHostCount = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let index = hosts.length - 1; index >= 0; index -= 1) {
      const host = hosts[index];
      if (host.kind !== "ssh") {
        continue;
      }
      const jumpIds = normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId);
      if (!jumpIds.some((id) => skippedHostIds.has(id))) {
        continue;
      }
      dependentHostCount += 1;
      skippedHostIds.add(host.id);
      if (host.secretRef) {
        orphanedSecretRefs.add(host.secretRef);
      }
      if (host.tailnetId?.trim()) {
        orphanedTailnetIds.add(host.tailnetId.trim());
      }
      hosts.splice(index, 1);
      changed = true;
    }
  }

  const parsedSecrets = requireArray(value.secrets, "transfer.field.secrets").map(parseSecret);
  const survivingSecretRefs = new Set<string>();
  const survivingTailnetIds = new Set<string>();
  for (const host of hosts) {
    if (hasCredentialRefs(host) && host.secretRef) {
      survivingSecretRefs.add(host.secretRef);
    }
    if (hasCredentialRefs(host) && host.tailnetId?.trim()) {
      survivingTailnetIds.add(host.tailnetId.trim());
    }
  }
  const secrets = parsedSecrets.filter(
    (record) =>
      !orphanedSecretRefs.has(record.secretRef) ||
      survivingSecretRefs.has(record.secretRef),
  );
  const knownHosts = requireArray(value.knownHosts, "known host").map(parseKnownHost);
  const parsedPortForwards = requireArray(value.portForwards, "transfer.field.portForwards").map((record) => {
    if (
      !isObject(record) ||
      (record.transport !== "ssh" &&
        record.transport !== "aws-ssm" &&
        record.transport !== "ecs-task" &&
        record.transport !== "container")
    ) {
      throw new Error(t("transfer.error.invalidPortForwardKind"));
    }
    const normalized = normalizePortForwardRule(record);
    if (!normalized) {
      throw new Error(t("transfer.error.invalidPortForward"));
    }
    return normalized;
  });
  // 건너뛴 호스트에 붙은 규칙과, 그 규칙에 연결된 DNS 도 같이 내린다 — 남기면 참조 검증에서
  // 파일 전체가 거부된다.
  const droppedRuleIds = new Set<string>();
  const portForwards = parsedPortForwards.filter((rule) => {
    if (skippedHostIds.has(rule.hostId)) {
      droppedRuleIds.add(rule.id);
      return false;
    }
    return true;
  });
  let droppedDnsCount = 0;
  const dnsOverrides = requireArray(value.dnsOverrides, "DNS override")
    .map((record) => {
      if (!isObject(record) || (record.type !== "linked" && record.type !== "static")) {
        throw new Error(t("transfer.error.invalidDnsKind"));
      }
      const normalized = normalizeDnsOverrideRecord(record);
      if (!normalized) {
        throw new Error(t("transfer.error.invalidDnsOverride"));
      }
      return normalized;
    })
    .filter((record) => {
      if (record.type === "linked" && droppedRuleIds.has(record.portForwardRuleId)) {
        droppedDnsCount += 1;
        return false;
      }
      return true;
    });
  const awsProfiles = requireArray(value.awsProfiles, "transfer.field.awsProfiles").map(parseAwsProfile);
  const snippets = requireArray(value.snippets, "snippet").map(parseSnippet);
  // 이 필드가 생기기 전에 만든 파일에는 없다. 없으면 빈 목록으로 읽는다 — 예전 파일을
  // 거부하면 잃는 것이 얻는 것보다 크다.
  const tailnets = (
    value.tailnets === undefined
      ? []
      : requireArray(value.tailnets, "transfer.field.tailnets")
  )
    .map(parseTailnet)
    .filter(
      (record) => !orphanedTailnetIds.has(record.id) || survivingTailnetIds.has(record.id),
    );
  // 건너뛴 호스트도 상한에는 포함한다 — 모르는 종류라고 해서 상한 밖이 되면 안 된다.
  const totalRecords =
    groups.length +
    hosts.length +
    unknownKindHostCount +
    secrets.length +
    knownHosts.length +
    portForwards.length +
    dnsOverrides.length +
    awsProfiles.length +
    snippets.length +
    tailnets.length;
  if (totalRecords > MAX_DOLGATE_RECORDS) {
    throw new Error(t("transfer.error.tooManyItems"));
  }

  assertUniqueIds(groups, (record) => record.id, "transfer.field.groups");
  assertUniqueIds(hosts, (record) => record.id, "transfer.field.hosts");
  assertUniqueIds(secrets, (record) => record.secretRef, "transfer.field.secrets");
  assertUniqueIds(knownHosts, (record) => record.id, "known host");
  assertUniqueIds(portForwards, (record) => record.id, "transfer.field.portForwards");
  assertUniqueIds(dnsOverrides, (record) => record.id, "DNS override");
  assertUniqueIds(awsProfiles, (record) => record.id, "transfer.field.awsProfiles");
  assertUniqueIds(snippets, (record) => record.id, "snippet");
  assertUniqueIds(tailnets, (record) => record.id, "transfer.field.tailnets");
  if (new Set(rootHostIds).size !== rootHostIds.length) {
    throw new Error(t("transfer.error.duplicateSelectedHostId"));
  }

  const bundle: DolgateHostBundleV1 = {
    schemaVersion: 1,
    scope: "hosts",
    exportedAt: requireString(value.exportedAt, "transfer.field.exportedAt"),
    rootHostIds: rootHostIds.filter((id) => !skippedHostIds.has(id)),
    groups,
    hosts,
    secrets,
    knownHosts,
    portForwards,
    dnsOverrides,
    awsProfiles,
    snippets,
    tailnets,
  };
  assertBundleReferences(bundle);

  const warnings: string[] = [];
  if (unknownKindHostCount > 0) {
    warnings.push(t("transfer.error.unknownHostKindSkipped", { count: unknownKindHostCount }));
  }
  const dependentCount = dependentHostCount + droppedRuleIds.size + droppedDnsCount;
  if (dependentCount > 0) {
    warnings.push(t("transfer.error.unknownHostKindDependentsSkipped", { count: dependentCount }));
  }
  return { bundle, warnings };
}

function assertBundleReferences(bundle: DolgateHostBundleV1): void {
  const hostIds = new Set(bundle.hosts.map((record) => record.id));
  const secretIds = new Set(bundle.secrets.map((record) => record.secretRef));
  const profileIds = new Set(bundle.awsProfiles.map((record) => record.id));
  const snippetIds = new Set(bundle.snippets.map((record) => record.id));
  const portForwardIds = new Set(bundle.portForwards.map((record) => record.id));
  for (const id of bundle.rootHostIds) {
    if (!hostIds.has(id)) {
      throw new Error(t("transfer.error.invalidSelectedHostRef"));
    }
  }
  for (const host of bundle.hosts) {
    // 자격증명을 참조로 갖는 종류는 번들 안에 그 자격증명이 실제로 있어야 한다.
    if (hasCredentialRefs(host) && host.secretRef && !secretIds.has(host.secretRef)) {
      throw new Error(t("transfer.error.missingSecret", { label: host.label }));
    }
    if (host.kind === "ssh") {
      for (const jumpId of normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)) {
        if (!hostIds.has(jumpId)) {
          throw new Error(t("transfer.error.missingJumpHost", { label: host.label }));
        }
      }
    }
    if (
      (host.kind === "aws-ec2" || host.kind === "aws-ecs") &&
      host.awsProfileId &&
      !profileIds.has(host.awsProfileId)
    ) {
      throw new Error(t("transfer.error.missingAwsProfile", { label: host.label }));
    }
    if (
      "startupCommand" in host &&
      host.startupCommand?.type === "snippet" &&
      !snippetIds.has(host.startupCommand.snippetId)
    ) {
      throw new Error(t("transfer.error.missingSnippet", { label: host.label }));
    }
  }
  for (const profile of bundle.awsProfiles) {
    if (profile.kind === "role" && !profileIds.has(profile.sourceProfileId)) {
      throw new Error(t("transfer.error.missingSourceProfile", { label: profile.name }));
    }
  }
  for (const rule of bundle.portForwards) {
    if (!hostIds.has(rule.hostId)) {
      throw new Error(t("transfer.error.missingRuleHost", { label: rule.label }));
    }
  }
  for (const record of bundle.dnsOverrides) {
    if (record.type === "linked" && !portForwardIds.has(record.portForwardRuleId)) {
      throw new Error(t("transfer.error.missingDnsRule", { label: record.hostname }));
    }
  }
}

function decodeJsonRecord<T>(record: StoredEncryptedValue | undefined, label: string): T {
  if (!record) {
    throw new Error(t("transfer.error.secureValueMissing", { label }));
  }
  const raw = decodeSecretFromStorage(record);
  if (!raw) {
    throw new Error(t("transfer.error.secureValueUnreadable", { label }));
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(t("transfer.error.secureValueCorrupt", { label }));
  }
}

export function buildDolgateHostBundle(
  state: DesktopStateFile,
  requestedHostIds: string[],
): DolgateHostBundleV1 {
  const rootHostIds = [...new Set(requestedHostIds)];
  if (rootHostIds.length === 0) {
    throw new Error(t("transfer.error.selectHostRequired"));
  }
  const hostsById = new Map(state.data.hosts.map((record) => [record.id, record]));
  const includedHostIds = new Set<string>();
  const collectHost = (hostId: string, visiting: Set<string>) => {
    const host = hostsById.get(hostId);
    if (!host) {
      throw new Error(t("transfer.error.selectedHostMissing"));
    }
    if (includedHostIds.has(hostId)) {
      return;
    }
    if (visiting.has(hostId)) {
      throw new Error(t("transfer.error.jumpHostCycle", { label: host.label }));
    }
    visiting.add(hostId);
    if (host.kind === "ssh") {
      for (const jumpId of normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)) {
        collectHost(jumpId, visiting);
      }
    }
    // VNC 는 SSH 호스트를 골라 터널로 거친다. 그 호스트를 함께 담지 않으면 받는 쪽에서 "경유할
    // SSH 호스트를 찾을 수 없습니다" 로 죽는다 — tailnet 등록 정보를 함께 담는 것과 같은 이유다.
    //
    // 있을 때만 따라간다. 가리키는 SSH 호스트를 지웠을 수 있고(폼이 경고로 보여 준다), 그 하나
    // 때문에 내보내기 전체를 막을 이유는 없다.
    if (host.kind === "vnc" && host.sshTunnelHostId && hostsById.has(host.sshTunnelHostId)) {
      collectHost(host.sshTunnelHostId, visiting);
    }
    visiting.delete(hostId);
    includedHostIds.add(hostId);
  };
  for (const hostId of rootHostIds) {
    collectHost(hostId, new Set<string>());
  }
  const selectedHosts = state.data.hosts.filter((record) => includedHostIds.has(record.id));
  const profileMetadataById = new Map(
    state.data.awsProfiles.map((record) => [record.id, record]),
  );

  const secretRefs = new Set<string>();
  const profileIds = new Set<string>();
  const availableProfileIdsByHostId = new Map<string, string>();
  const snippetIds = new Set<string>();
  for (const host of selectedHosts) {
    if (hasCredentialRefs(host) && host.secretRef) {
      secretRefs.add(host.secretRef);
    }
    if (host.kind === "aws-ec2" || host.kind === "aws-ecs") {
      if (host.awsProfileId && profileMetadataById.has(host.awsProfileId)) {
        profileIds.add(host.awsProfileId);
        availableProfileIdsByHostId.set(host.id, host.awsProfileId);
      }
    }
    if (
      "startupCommand" in host &&
      host.startupCommand?.type === "snippet"
    ) {
      snippetIds.add(host.startupCommand.snippetId);
    }
  }

  const awsProfiles: ManagedAwsProfilePayload[] = [];
  const loadedProfileIds = new Set<string>();
  const unavailableProfileIds = new Set<string>();
  const collectProfile = (profileId: string, visiting: Set<string>): boolean => {
    if (loadedProfileIds.has(profileId)) {
      return true;
    }
    if (unavailableProfileIds.has(profileId)) {
      return false;
    }
    if (visiting.has(profileId)) {
      throw new Error(t("transfer.error.awsRoleCycle"));
    }
    const metadata = profileMetadataById.get(profileId);
    const storedProfile = state.secure.managedAwsProfilesById[profileId];
    if (!metadata || !storedProfile) {
      unavailableProfileIds.add(profileId);
      return false;
    }
    const payload = parseAwsProfile(
      decodeJsonRecord<ManagedAwsProfilePayload>(
        storedProfile,
        metadata.name,
      ),
    );
    visiting.add(profileId);
    if (payload.kind === "role" && !collectProfile(payload.sourceProfileId, visiting)) {
      visiting.delete(profileId);
      unavailableProfileIds.add(profileId);
      return false;
    }
    visiting.delete(profileId);
    awsProfiles.push({ ...payload, id: metadata.id, name: metadata.name });
    loadedProfileIds.add(profileId);
    return true;
  };
  for (const profileId of profileIds) {
    collectProfile(profileId, new Set<string>());
  }
  const hosts = selectedHosts.map((host) => {
    if (host.kind === "aws-ec2" || host.kind === "aws-ecs") {
      const availableProfileId = availableProfileIdsByHostId.get(host.id);
      return {
        ...host,
        awsProfileId:
          availableProfileId && loadedProfileIds.has(availableProfileId)
            ? availableProfileId
            : null,
        awsProfileName:
          availableProfileId && loadedProfileIds.has(availableProfileId)
            ? host.awsProfileName
            : "",
      };
    }
    return host;
  });

  const secrets = [...secretRefs].map((secretRef) => {
    const payload = parseSecret(
      decodeJsonRecord<ManagedSecretPayload>(
        state.secure.managedSecretsByRef[secretRef],
        secretRef,
      ),
    );
    if (payload.secretRef !== secretRef) {
      throw new Error(t("transfer.error.secretIdMismatch"));
    }
    return payload;
  });
  const snippetsById = new Map(state.data.snippets.map((record) => [record.id, record]));
  const snippets = [...snippetIds].map((id) => {
    const snippet = snippetsById.get(id);
    if (!snippet) {
      throw new Error(t("transfer.error.startupSnippetMissing"));
    }
    return snippet;
  });

  const groupPaths = new Set<string>();
  for (const host of hosts) {
    let path = normalizeGroupPath(host.groupName);
    while (path) {
      groupPaths.add(path);
      path = getParentGroupPath(path);
    }
  }
  const groups = state.data.groups.filter((record) => groupPaths.has(record.path));
  const portForwards = state.data.portForwards.filter((record) =>
    includedHostIds.has(record.hostId),
  );
  const portForwardIds = new Set(portForwards.map((record) => record.id));
  const dnsOverrides = state.data.dnsOverrides.filter(
    (record) => record.type === "linked" && portForwardIds.has(record.portForwardRuleId),
  );

  // 호스트가 경유하는 tailnet 을 함께 담는다. 이것이 없으면 받는 쪽에서 호스트의 tailnetId 가
  // 가리킬 곳이 없어 연결이 "is not configured" 로 죽는다 — AWS 프로필과 같은 이유다.
  //
  // auth key 도 담는다: 파일은 이미 사용자 암호로 암호화되고 SSH 비밀번호·개인키가 그 안에
  // 들어간다. 키만 빼면 받는 쪽이 재인증해야 해서 "가져오면 바로 된다"가 성립하지 않는다.
  const tailnetIds = new Set<string>();
  for (const host of hosts) {
    if (hasCredentialRefs(host) && host.tailnetId?.trim()) {
      tailnetIds.add(host.tailnetId.trim());
    }
  }
  const tailnetsById = new Map(state.data.tailnets.map((record) => [record.id, record]));
  const tailnets: TailnetPayload[] = [];
  for (const id of tailnetIds) {
    const record = tailnetsById.get(id);
    // 이미 지워진 tailnet 을 가리키는 호스트가 있을 수 있다. tailnetId 를 비우지는 않는다 —
    // 비우면 그 호스트는 tailnet 밖 일반 네트워크로 조용히 붙는다. 그대로 두면 받는 쪽에서
    // 연결이 분명하게 실패하고, 사용자가 tailnet 을 다시 등록하면 살아난다.
    if (!record) {
      continue;
    }
    const stored = state.secure.tailnetAuthKeysById[record.id];
    const authKey = stored ? decodeSecretFromStorage(stored) : null;
    tailnets.push({
      ...record,
      hasAuthKey: Boolean(authKey),
      ...(authKey ? { authKey } : {}),
    });
  }

  // known_hosts are intentionally NOT exported: they are machine-local TOFU trust
  // records. Carried to another machine (or re-imported) a stale/mismatched
  // fingerprint only blocks the connection (host key mismatch); a matching one is
  // redundant since first-connect TOFU re-establishes it. Imported hosts re-trust
  // on first connect.
  const knownHosts: KnownHostRecord[] = [];

  return {
    schemaVersion: 1,
    scope: "hosts",
    exportedAt: new Date().toISOString(),
    rootHostIds,
    groups,
    hosts,
    secrets,
    knownHosts,
    portForwards,
    dnsOverrides,
    awsProfiles,
    snippets,
    tailnets,
  };
}

/** 가져온 자격증명의 목록용 메타데이터. 시각은 번들에 적힌 값을 쓴다(페이로드의 값이 아니다). */
function buildSecretMetadata(secret: ManagedSecretPayload, updatedAt: string): SecretMetadataRecord {
  return projectSecretMetadata(secret, { linkedHostCount: 0, updatedAt });
}

export function buildHostTransferImportPlan(
  bundle: DolgateHostBundleV1,
  state: DesktopStateFile,
): ImportPlan {
  const now = new Date().toISOString();
  const warnings: string[] = [];
  let skippedCount = 0;
  const skippedCounts: DolgateImportItemCounts = {
    hosts: 0,
    groups: 0,
    secrets: 0,
    awsProfiles: 0,
    snippets: 0,
    portForwards: 0,
    dnsOverrides: 0,
    knownHosts: 0,
    tailnets: 0,
  };
  const recordSkip = (kind: keyof DolgateImportItemCounts) => {
    skippedCount += 1;
    skippedCounts[kind] += 1;
  };
  const takeNew = <T>(
    items: T[],
    existingIds: Set<string>,
    idOf: (item: T) => string,
    kind: keyof DolgateImportItemCounts,
  ) =>
    items.filter((item) => {
      if (existingIds.has(idOf(item))) {
        recordSkip(kind);
        return false;
      }
      return true;
    });

  const existingGroupIds = new Set(state.data.groups.map((record) => record.id));
  const existingGroupPaths = new Set(state.data.groups.map((record) => record.path));
  const groups = takeNew(bundle.groups, existingGroupIds, (record) => record.id, "groups")
    .filter((record) => {
      if (existingGroupPaths.has(record.path)) {
        recordSkip("groups");
        return false;
      }
      existingGroupPaths.add(record.path);
      return true;
    })
    .map((record) => ({ ...record, updatedAt: now }));

  const existingProfileIds = new Set(state.data.awsProfiles.map((record) => record.id));
  const usedProfileNames = new Set(state.data.awsProfiles.map((record) => record.name));
  const profileNameById = new Map(state.data.awsProfiles.map((record) => [record.id, record.name]));
  const awsProfiles = takeNew(
    bundle.awsProfiles,
    existingProfileIds,
    (record) => record.id,
    "awsProfiles",
  ).map((record) => {
    let name = record.name;
    if (usedProfileNames.has(name)) {
      const base = `${name}-conflict-${record.id.slice(0, 8)}`;
      name = base;
      let suffix = 1;
      while (usedProfileNames.has(name)) {
        name = `${base}-${suffix}`;
        suffix += 1;
      }
      warnings.push(t("transfer.error.awsProfileRenamed", { from: record.name, to: name }));
    }
    usedProfileNames.add(name);
    profileNameById.set(record.id, name);
    return { ...record, name, updatedAt: now } as ManagedAwsProfilePayload;
  });
  const awsProfileMetadata = awsProfiles.map((record) => ({
    id: record.id,
    name: record.name,
    kind: record.kind,
    updatedAt: now,
  }));

  const secrets = takeNew(
    bundle.secrets,
    new Set(state.data.secretMetadata.map((record) => record.secretRef)),
    (record) => record.secretRef,
    "secrets",
  ).map((record) => ({ ...record, updatedAt: now }));
  const secretMetadata = secrets.map((record) => buildSecretMetadata(record, now));
  const snippets = takeNew(
    bundle.snippets,
    new Set(state.data.snippets.map((record) => record.id)),
    (record) => record.id,
    "snippets",
  ).map((record) => ({ ...record, updatedAt: now }));
  const hosts = takeNew(
    bundle.hosts,
    new Set(state.data.hosts.map((record) => record.id)),
    (record) => record.id,
    "hosts",
  ).map((record) => {
    if (record.kind !== "aws-ec2" && record.kind !== "aws-ecs") {
      return { ...record, updatedAt: now };
    }
    const profileName = record.awsProfileId
      ? profileNameById.get(record.awsProfileId)
      : null;
    return {
      ...record,
      awsProfileId: profileName ? record.awsProfileId : null,
      awsProfileName: profileName ?? "",
      updatedAt: now,
    };
  });
  const portForwards = takeNew(
    bundle.portForwards,
    new Set(state.data.portForwards.map((record) => record.id)),
    (record) => record.id,
    "portForwards",
  ).map((record) => ({ ...record, updatedAt: now }));

  // known_hosts are intentionally NOT imported (see export). An imported fingerprint
  // that does not match the live server would block the connection (host key
  // mismatch); a matching one is redundant. Imported hosts re-trust on first connect.
  const knownHosts: KnownHostRecord[] = [];

  const dnsHostnames = new Set(
    state.data.dnsOverrides.map((record) => record.hostname.toLocaleLowerCase()),
  );
  const dnsOverrides = takeNew(
    bundle.dnsOverrides,
    new Set(state.data.dnsOverrides.map((record) => record.id)),
    (record) => record.id,
    "dnsOverrides",
  )
    .filter((record) => {
      const key = record.hostname.toLocaleLowerCase();
      if (!dnsHostnames.has(key)) {
        dnsHostnames.add(key);
        return true;
      }
      recordSkip("dnsOverrides");
      warnings.push(t("transfer.error.dnsOverrideSkipped", { hostname: record.hostname }));
      return false;
    })
    .map((record) => ({ ...record, updatedAt: now }));

  // 이미 같은 id 로 등록돼 있으면 건드리지 않는다. 로컬 등록이 더 최신일 수 있고(재인증한
  // auth key 등), 가져오기가 그것을 덮어쓰면 되던 연결이 끊긴다.
  const tailnets = takeNew(
    bundle.tailnets,
    new Set(state.data.tailnets.map((record) => record.id)),
    (record) => record.id,
    "tailnets",
  ).map((record) => ({ ...record, updatedAt: now }));

  const availableHostIds = new Set([
    ...state.data.hosts.map((record) => record.id),
    ...hosts.map((record) => record.id),
  ]);
  const availableTailnetIds = new Set([
    ...state.data.tailnets.map((record) => record.id),
    ...tailnets.map((record) => record.id),
  ]);
  const availableSecretIds = new Set([
    ...state.data.secretMetadata.map((record) => record.secretRef),
    ...secrets.map((record) => record.secretRef),
  ]);
  const availableProfileIds = new Set([...existingProfileIds, ...awsProfiles.map((record) => record.id)]);
  const availableSnippetIds = new Set([
    ...state.data.snippets.map((record) => record.id),
    ...snippets.map((record) => record.id),
  ]);
  const availablePortIds = new Set([
    ...state.data.portForwards.map((record) => record.id),
    ...portForwards.map((record) => record.id),
  ]);
  for (const host of hosts) {
    if (hasCredentialRefs(host)) {
      if (host.secretRef && !availableSecretIds.has(host.secretRef)) {
        throw new Error(t("transfer.error.unresolvedSecretRef", { label: host.label }));
      }
      // tailnet 은 다른 참조와 달리 막지 않고 알리기만 한다. 이 필드가 생기기 전에 만든
      // 파일에는 tailnet 이 아예 없어서, 막으면 그런 파일을 통째로 못 가져온다. 그리고
      // 사용자가 그 tailnet 을 나중에 등록하면 호스트는 그대로 살아난다.
      if (host.tailnetId?.trim() && !availableTailnetIds.has(host.tailnetId.trim())) {
        warnings.push(t("transfer.error.tailnetMissing", { label: host.label }));
      }
    }
    if (host.kind === "ssh") {
      for (const jumpId of normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)) {
        if (!availableHostIds.has(jumpId)) {
          throw new Error(t("transfer.error.unresolvedJumpHostRef", { label: host.label }));
        }
      }
    }
    if (
      (host.kind === "aws-ec2" || host.kind === "aws-ecs") &&
      host.awsProfileId &&
      !availableProfileIds.has(host.awsProfileId)
    ) {
      throw new Error(t("transfer.error.unresolvedAwsProfileRef", { label: host.label }));
    }
    if (
      "startupCommand" in host &&
      host.startupCommand?.type === "snippet" &&
      !availableSnippetIds.has(host.startupCommand.snippetId)
    ) {
      throw new Error(t("transfer.error.unresolvedSnippetRef", { label: host.label }));
    }
  }
  for (const profile of awsProfiles) {
    if (profile.kind === "role" && !availableProfileIds.has(profile.sourceProfileId)) {
      throw new Error(t("transfer.error.unresolvedSourceProfileRef", { label: profile.name }));
    }
  }
  for (const rule of portForwards) {
    if (!availableHostIds.has(rule.hostId)) {
      throw new Error(t("transfer.error.unresolvedRuleHostRef", { label: rule.label }));
    }
  }
  for (const record of dnsOverrides) {
    if (record.type === "linked" && !availablePortIds.has(record.portForwardRuleId)) {
      throw new Error(t("transfer.error.unresolvedDnsRuleRef", { label: record.hostname }));
    }
  }

  return {
    groups,
    hosts,
    secrets,
    secretMetadata,
    knownHosts,
    portForwards,
    dnsOverrides,
    awsProfiles,
    awsProfileMetadata,
    snippets,
    tailnets,
    skippedCount,
    skippedCounts,
    warnings,
  };
}

function toImportPreview(snapshotId: string, plan: ImportPlan): DolgateImportPreview {
  return {
    snapshotId,
    hostCount: plan.hosts.length,
    groupCount: plan.groups.length,
    secretCount: plan.secrets.length,
    awsProfileCount: plan.awsProfiles.length,
    snippetCount: plan.snippets.length,
    portForwardCount: plan.portForwards.length,
    dnsOverrideCount: plan.dnsOverrides.length,
    knownHostCount: plan.knownHosts.length,
    tailnetCount: plan.tailnets.length,
    skippedCount: plan.skippedCount,
    skippedCounts: plan.skippedCounts,
    warnings: plan.warnings,
  };
}

function toImportResult(plan: ImportPlan): DolgateImportResult {
  return {
    importedHostCount: plan.hosts.length,
    importedGroupCount: plan.groups.length,
    importedSecretCount: plan.secrets.length,
    importedAwsProfileCount: plan.awsProfiles.length,
    importedSnippetCount: plan.snippets.length,
    importedPortForwardCount: plan.portForwards.length,
    importedDnsOverrideCount: plan.dnsOverrides.length,
    importedKnownHostCount: plan.knownHosts.length,
    importedTailnetCount: plan.tailnets.length,
    skippedCount: plan.skippedCount,
    skippedCounts: plan.skippedCounts,
    warnings: plan.warnings,
  };
}

function clearImportedTombstones(state: DesktopStateFile, plan: ImportPlan): void {
  const restored = new Set<string>();
  const add = (kind: SyncKind, ids: string[]) => {
    for (const id of ids) {
      restored.add(`${kind}\u0000${id}`);
    }
  };
  add("groups", plan.groups.map((record) => record.id));
  add("hosts", plan.hosts.map((record) => record.id));
  add("secrets", plan.secrets.map((record) => record.secretRef));
  add("knownHosts", plan.knownHosts.map((record) => record.id));
  add("portForwards", plan.portForwards.map((record) => record.id));
  add("dnsOverrides", plan.dnsOverrides.map((record) => record.id));
  add("tailnets", plan.tailnets.map((record) => record.id));
  add("awsProfiles", plan.awsProfiles.map((record) => record.id));
  add("snippets", plan.snippets.map((record) => record.id));
  state.data.syncOutbox = state.data.syncOutbox.filter(
    (record) => !restored.has(`${record.kind}\u0000${record.recordId}`),
  );
}

export class HostTransferService {
  private readonly storage = getDesktopStateStorage();
  private readonly importSnapshots = new Map<string, ImportSnapshot>();

  previewExport(hostIds: string[]): HostExportPreview {
    const state = this.storage.getState();
    const bundle = buildDolgateHostBundle(state, hostIds);
    const openssh = buildOpenSshConfig(state.data.hosts, hostIds);
    return {
      selectedHostCount: [...new Set(hostIds)].length,
      dolgateHostCount: bundle.hosts.length,
      opensshHostCount: openssh.exportedRootCount,
      opensshDependencyCount: openssh.dependencyCount,
      opensshSkippedCount: openssh.skippedCount,
      opensshWarnings: openssh.warnings,
    };
  }

  async createDolgateExport(
    hostIds: string[],
    password: string,
    appVersion: string,
  ): Promise<{ bytes: Buffer; hostCount: number }> {
    const bundle = buildDolgateHostBundle(this.storage.getState(), hostIds);
    return {
      bytes: await encryptDolgateHostBundle(bundle, password, appVersion),
      hostCount: bundle.hosts.length,
    };
  }

  createOpenSshExport(hostIds: string[]): OpenSshExportBuild {
    return buildOpenSshConfig(this.storage.getState().data.hosts, hostIds);
  }

  async probeImport(file: Buffer, password: string): Promise<DolgateImportPreview> {
    this.pruneSnapshots();
    const { bundle, warnings } = parseDolgateBundle(
      await decryptDolgateHostBundle(file, password),
    );
    const snapshotId = randomUUID();
    const plan = buildHostTransferImportPlan(bundle, this.storage.getState());
    // 파싱 단계 경고(모르는 종류 건너뜀 등)를 계획 경고보다 앞에 보여 준다.
    plan.warnings.unshift(...warnings);
    this.importSnapshots.set(snapshotId, {
      bundle,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    });
    return toImportPreview(snapshotId, plan);
  }

  commitImport(snapshotId: string): DolgateImportResult {
    this.pruneSnapshots();
    const snapshot = this.importSnapshots.get(snapshotId);
    if (!snapshot) {
      throw new Error(t("transfer.error.importStateExpired"));
    }
    try {
      const plan = buildHostTransferImportPlan(snapshot.bundle, this.storage.getState());
      const encodedSecrets = new Map(
        plan.secrets.map((record) => [
          record.secretRef,
          encodeSecretForStorage(JSON.stringify(record)),
        ]),
      );
      const encodedProfiles = new Map(
        plan.awsProfiles.map((record) => [
          record.id,
          encodeSecretForStorage(JSON.stringify(record)),
        ]),
      );
      // 레코드에서 키를 떼어 낸다 — 레코드는 평문 저장소, 키는 암호화 저장소로 간다.
      const encodedTailnetKeys = new Map(
        plan.tailnets
          .filter((record) => Boolean(record.authKey))
          .map((record) => [record.id, encodeSecretForStorage(record.authKey as string)]),
      );
      this.storage.updateState((state) => {
        state.data.groups.push(...plan.groups);
        state.data.hosts.push(...plan.hosts);
        state.data.secretMetadata.push(...plan.secretMetadata);
        state.data.knownHosts.push(...plan.knownHosts);
        state.data.portForwards.push(...plan.portForwards);
        state.data.dnsOverrides.push(...plan.dnsOverrides);
        state.data.awsProfiles.push(...plan.awsProfileMetadata);
        state.data.snippets.push(...plan.snippets);
        for (const [secretRef, record] of encodedSecrets) {
          state.secure.managedSecretsByRef[secretRef] = record;
        }
        for (const [profileId, record] of encodedProfiles) {
          state.secure.managedAwsProfilesById[profileId] = record;
        }
        for (const payload of plan.tailnets) {
          const { authKey: _authKey, ...record } = payload;
          state.data.tailnets.push(record);
        }
        for (const [tailnetId, record] of encodedTailnetKeys) {
          state.secure.tailnetAuthKeysById[tailnetId] = record;
        }
        clearImportedTombstones(state, plan);
      });
      return toImportResult(plan);
    } finally {
      this.importSnapshots.delete(snapshotId);
    }
  }

  discardImport(snapshotId: string): void {
    this.importSnapshots.delete(snapshotId);
  }

  private pruneSnapshots(): void {
    const now = Date.now();
    for (const [snapshotId, snapshot] of this.importSnapshots) {
      if (snapshot.expiresAt <= now) {
        this.importSnapshots.delete(snapshotId);
      }
    }
  }
}
