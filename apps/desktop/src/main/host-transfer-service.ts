import {
  getParentGroupPath,
  normalizeGroupPath,
  normalizeJumpHostIds,
  type AwsProfileMetadataRecord,
  type DnsOverrideRecord,
  type GroupRecord,
  type HostRecord,
  type KnownHostRecord,
  type ManagedAwsProfilePayload,
  type ManagedSecretPayload,
  type PortForwardRuleRecord,
  type SecretMetadataRecord,
  type SnippetRecord,
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

function parseHost(value: unknown): HostRecord {
  if (
    !isObject(value) ||
    (value.kind !== "ssh" &&
      value.kind !== "aws-ec2" &&
      value.kind !== "aws-ecs" &&
      value.kind !== "warpgate-ssh" &&
      value.kind !== "serial") ||
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

function parseDolgateBundle(value: unknown): DolgateHostBundleV1 {
  if (!isObject(value) || value.schemaVersion !== 1 || value.scope !== "hosts") {
    throw new Error(t("transfer.error.unsupportedBundle"));
  }
  const rootHostIds = requireArray(value.rootHostIds, "transfer.field.selectedHosts").map((id) =>
    requireString(id, "transfer.field.selectedHostId"),
  );
  const groups = requireArray(value.groups, "transfer.field.groups").map(parseGroup);
  const hosts = requireArray(value.hosts, "transfer.field.hosts").map(parseHost);
  const secrets = requireArray(value.secrets, "transfer.field.secrets").map(parseSecret);
  const knownHosts = requireArray(value.knownHosts, "known host").map(parseKnownHost);
  const portForwards = requireArray(value.portForwards, "transfer.field.portForwards").map((record) => {
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
  const dnsOverrides = requireArray(value.dnsOverrides, "DNS override").map((record) => {
    if (!isObject(record) || (record.type !== "linked" && record.type !== "static")) {
      throw new Error(t("transfer.error.invalidDnsKind"));
    }
    const normalized = normalizeDnsOverrideRecord(record);
    if (!normalized) {
      throw new Error(t("transfer.error.invalidDnsOverride"));
    }
    return normalized;
  });
  const awsProfiles = requireArray(value.awsProfiles, "transfer.field.awsProfiles").map(parseAwsProfile);
  const snippets = requireArray(value.snippets, "snippet").map(parseSnippet);
  const totalRecords =
    groups.length +
    hosts.length +
    secrets.length +
    knownHosts.length +
    portForwards.length +
    dnsOverrides.length +
    awsProfiles.length +
    snippets.length;
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
  if (new Set(rootHostIds).size !== rootHostIds.length) {
    throw new Error(t("transfer.error.duplicateSelectedHostId"));
  }

  const bundle: DolgateHostBundleV1 = {
    schemaVersion: 1,
    scope: "hosts",
    exportedAt: requireString(value.exportedAt, "transfer.field.exportedAt"),
    rootHostIds,
    groups,
    hosts,
    secrets,
    knownHosts,
    portForwards,
    dnsOverrides,
    awsProfiles,
    snippets,
  };
  assertBundleReferences(bundle);
  return bundle;
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
    if (host.kind === "ssh") {
      if (host.secretRef && !secretIds.has(host.secretRef)) {
        throw new Error(t("transfer.error.missingSecret", { label: host.label }));
      }
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
    if (host.kind === "ssh" && host.secretRef) {
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
  };
}

function buildSecretMetadata(secret: ManagedSecretPayload, updatedAt: string): SecretMetadataRecord {
  return {
    secretRef: secret.secretRef,
    label: secret.label,
    hasPassword: Boolean(secret.password),
    hasPassphrase: Boolean(secret.passphrase),
    hasManagedPrivateKey: Boolean(secret.privateKeyPem),
    hasCertificate: Boolean(secret.certificateText),
    privateKeyEncrypted: secret.privateKeyEncrypted,
    keyAlgorithm: secret.keyAlgorithm,
    keyCurve: secret.keyCurve,
    keyBits: secret.keyBits,
    privateKeyCipher: secret.privateKeyCipher,
    privateKeyKdfRounds: secret.privateKeyKdfRounds,
    passphraseSaved: secret.passphraseSaved,
    linkedHostCount: 0,
    updatedAt,
  };
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

  const availableHostIds = new Set([
    ...state.data.hosts.map((record) => record.id),
    ...hosts.map((record) => record.id),
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
    if (host.kind === "ssh") {
      if (host.secretRef && !availableSecretIds.has(host.secretRef)) {
        throw new Error(t("transfer.error.unresolvedSecretRef", { label: host.label }));
      }
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
    const bundle = parseDolgateBundle(await decryptDolgateHostBundle(file, password));
    const snapshotId = randomUUID();
    const plan = buildHostTransferImportPlan(bundle, this.storage.getState());
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
