import { randomUUID } from "node:crypto";
import {
  getGroupLabel,
  getParentGroupPath,
  isGroupWithinPath,
  normalizeGroupPath,
  normalizeJumpHostIds,
  projectSecretMetadata,
  type DnsOverrideRecord,
  type GroupRecord,
  type HostRecord,
  type HostStartupCommand,
  type KnownHostRecord,
  type ManagedAwsProfilePayload,
  type ManagedSecretPayload,
  type PortForwardRuleRecord,
  type SavedWorkspaceNode,
  type SavedWorkspaceRecord,
  type SecretMetadataRecord,
  type SnippetRecord,
  type TailnetPayload,
  type TerminalThemeId,
  type VaultCopyCounts,
  type VaultCopySelection,
} from "@shared";
import { buildDolgateHostBundle } from "./host-transfer-service";
import type { DesktopVaultContents } from "./state-storage";
import {
  normalizeTeamAwsProfileCredentials,
  normalizeTeamHostCredentials,
  overlayHostMemberPrefs,
  stripHostMemberPrefs,
  type TeamAwsProfileCredentials,
  type TeamHostCredentials,
  type TeamMemberPrefs,
  type TeamMemberPrefsStore,
  type TeamTailnetCredentials,
} from "./team-member-prefs";

// 볼트 사이 복사(공유 = 복사). 원본은 그대로 두고, 고른 것과 그것이 쓰는 것(점프 호스트·비밀값·known
// hosts·포트 포워딩·DNS 덮어쓰기·스니펫·AWS 프로필·tailnet)을 새 id 로 만들어 복사본끼리 다시 잇는다.
// 여기서는 계획만 만든다 — 쓰기는 상태 저장소가 한 번에 한다.

export interface VaultCopyOptions {
  /** 대상 볼트에서 놓을 그룹 경로. 없으면 맨 위. */
  targetGroupPath: string | null;
  /** 대상이 팀 볼트면 사람마다 다른 값을 레코드에서 빼서 따로 돌려준다(복사한 사람의 칸으로 간다). */
  targetIsTeam: boolean;
  /**
   * 대상이 팀일 때 호스트의 비밀번호·SSH 키를 팀에 함께 넣는다. 끄면 팀에는 넣지 않고 복사한 사람의 내 칸에
   * 둔다 — 그 사람은 그대로 붙고, 다른 멤버는 자기 것을 넣는다. 기본 켬. AWS 정적 프로필의 키와 tailnet auth
   * key 는 사람의 인증 정보라 이 값과 상관없이 늘 내 칸으로 간다.
   */
  shareSecrets?: boolean;
  /** 원본이 팀 볼트면 내 개인 칸 — 복사본에 내 즐겨찾기·agent forwarding·테마를 얹는다. */
  sourceMemberPrefs?: TeamMemberPrefs | null;
  /**
   * 원본이 팀 볼트면 그 팀에 둔 내 자격 증명. 복사본으로 따라간다 — 개인으로 가면 복사본의 비밀값이 되고,
   * 팀으로 가면 그 팀의 내 칸에 간다(팀 비밀값이 되지 않는다).
   */
  sourceMyCredentials?: Pick<
    TeamMemberPrefsStore,
    "readHostCredentials" | "readAwsProfileCredentials" | "readTailnetCredentials"
  > | null;
  now?: string;
  newId?: () => string;
}

/** 복사한 사람에게만 둘 값(대상이 팀일 때). */
export interface VaultCopyMemberValues {
  hostId: string;
  favorite: boolean | null;
  agentForwarding: boolean | null;
  terminalThemeId: TerminalThemeId | null;
}

export interface VaultCopyPlan {
  groups: GroupRecord[];
  hosts: HostRecord[];
  secrets: ManagedSecretPayload[];
  secretMetadata: SecretMetadataRecord[];
  knownHosts: KnownHostRecord[];
  portForwards: PortForwardRuleRecord[];
  dnsOverrides: DnsOverrideRecord[];
  snippets: SnippetRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  tailnets: TailnetPayload[];
  savedWorkspaces: SavedWorkspaceRecord[];
  memberValues: VaultCopyMemberValues[];
  /** 복사한 사람의 내 칸에 둘 자격 증명(대상이 팀일 때). id 는 복사본의 id 다. */
  memberCredentials: {
    hostCredentials: Array<{ id: string; credentials: TeamHostCredentials }>;
    awsProfileCredentials: Array<{ id: string; credentials: TeamAwsProfileCredentials }>;
    tailnetCredentials: Array<{ id: string; credentials: TeamTailnetCredentials }>;
  };
  /** 원본 호스트 id → 복사본 id. */
  hostIdMap: Record<string, string>;
  /** 원본 워크스페이스 id → 복사본 id. */
  workspaceIdMap: Record<string, string>;
  counts: VaultCopyCounts;
}

/** 창이 가리키는 호스트 id(로컬 창 빼고). */
function workspaceHostIds(node: SavedWorkspaceNode): string[] {
  if (node.kind === "leaf") {
    return node.target.kind === "host" ? [node.target.hostId] : [];
  }
  return [...workspaceHostIds(node.first), ...workspaceHostIds(node.second)];
}

/** SSH 의 비밀값 칸. 사용자 이름은 호스트 레코드에 있다. */
const SSH_SECRET_FIELDS = ["password", "passphrase", "privateKeyPem", "certificateText"] as const;
/** RDP·VNC 는 계정(사용자 이름·도메인)도 비밀값에 딸린다. */
const ACCOUNT_SECRET_FIELDS = ["username", "domain", ...SSH_SECRET_FIELDS] as const;
type SecretField = (typeof ACCOUNT_SECRET_FIELDS)[number];
/** 개인키에서 나온 부가 정보. 개인키가 바뀌면 함께 버린다(키체인 편집과 같은 규칙). */
const KEY_METADATA_FIELDS = [
  "publicKey",
  "publicKeyFingerprintSha256",
  "keyAlgorithm",
  "privateKeyEncrypted",
  "keyCurve",
  "keyBits",
  "privateKeyCipher",
  "privateKeyKdfRounds",
  "passphraseSaved",
  "generatedByApp",
] as const satisfies ReadonlyArray<keyof ManagedSecretPayload>;

function pickSecretFields(
  source: Partial<Record<SecretField, string | undefined>>,
  fields: readonly SecretField[],
): Partial<Record<SecretField, string>> {
  const picked: Partial<Record<SecretField, string>> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value) {
      picked[field] = value;
    }
  }
  return picked;
}

const tailnetScope = (tailnetId?: string | null) => (tailnetId ?? "").trim();

const knownHostKey = (record: KnownHostRecord) =>
  [record.host, record.port, tailnetScope(record.tailnetId), record.algorithm].join("\u0000");

/** 대상 볼트에 같은 이름의 AWS 프로필이 있으면 뒤에 번호를 붙인다(프로필 이름은 볼트 안에서 겹치면 안 된다). */
function uniqueProfileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export function planVaultCopy(
  source: DesktopVaultContents,
  target: DesktopVaultContents,
  selection: VaultCopySelection,
  options: VaultCopyOptions,
): VaultCopyPlan {
  const now = options.now ?? new Date().toISOString();
  const newId = options.newId ?? randomUUID;
  const targetGroupPath = normalizeGroupPath(options.targetGroupPath);
  const selectedGroupPath = selection.kind === "group" ? normalizeGroupPath(selection.groupPath) : null;
  if (selection.kind === "group" && !selectedGroupPath) {
    throw new Error("vault copy needs a group path");
  }

  // 1. 고른 것과 그것이 쓰는 것. 모으기는 내보내기와 같은 것을 쓴다. 워크스페이스는 창의 호스트를 고른 것으로 본다
  //    (원본 볼트에 있는 것만 — 지워진 호스트를 가리키는 창도 있다).
  const selectedWorkspaces =
    selection.kind === "workspaces"
      ? source.data.savedWorkspaces.filter((workspace) => selection.workspaceIds.includes(workspace.id))
      : [];
  if (selection.kind === "workspaces" && selectedWorkspaces.length === 0) {
    throw new Error("vault copy needs at least one workspace");
  }
  const sourceHostIds = new Set(source.data.hosts.map((host) => host.id));
  const rootHostIds =
    selection.kind === "hosts"
      ? [...new Set(selection.hostIds)]
      : selection.kind === "workspaces"
        ? [...new Set(selectedWorkspaces.flatMap((workspace) => workspaceHostIds(workspace.root)))].filter((id) =>
            sourceHostIds.has(id),
          )
        : source.data.hosts
            .filter((host) => isGroupWithinPath(normalizeGroupPath(host.groupName), selectedGroupPath))
            .map((host) => host.id);
  if (selection.kind === "hosts" && rootHostIds.length === 0) {
    throw new Error("vault copy needs at least one host");
  }
  const bundle =
    rootHostIds.length > 0
      ? buildDolgateHostBundle(source, rootHostIds, { includeRdpAwsSsmProfiles: true })
      : null;
  const sourceHosts = (bundle?.hosts ?? []).map((host) =>
    options.sourceMemberPrefs ? overlayHostMemberPrefs(host, options.sourceMemberPrefs) : host,
  );

  // 2. 새 id.
  const hostIdMap = new Map(sourceHosts.map((host) => [host.id, newId()]));
  const secretRefMap = new Map((bundle?.secrets ?? []).map((secret) => [secret.secretRef, `secret:${newId()}`]));
  const snippetIdMap = new Map((bundle?.snippets ?? []).map((snippet) => [snippet.id, newId()]));
  const tailnetIdMap = new Map((bundle?.tailnets ?? []).map((tailnet) => [tailnet.id, newId()]));
  const portForwardIdMap = new Map((bundle?.portForwards ?? []).map((rule) => [rule.id, newId()]));
  const takenProfileNames = new Set(target.data.awsProfiles.map((profile) => profile.name));
  const profileMap = new Map<string, { id: string; name: string }>();
  for (const profile of bundle?.awsProfiles ?? []) {
    const name = uniqueProfileName(profile.name, takenProfileNames);
    takenProfileNames.add(name);
    profileMap.set(profile.id, { id: newId(), name });
  }

  // 3. 자리. 고른 그룹 안의 것은 그 그룹 이름부터 놓은 자리 아래로, 나머지(고른 호스트·딸려 온 호스트)는
  //    놓은 자리에 둔다.
  const selectedGroupParent = selectedGroupPath ? getParentGroupPath(selectedGroupPath) : null;
  const reroot = (path: string | null): string | null => {
    if (selectedGroupPath && path && isGroupWithinPath(path, selectedGroupPath)) {
      const relative = selectedGroupParent ? path.slice(selectedGroupParent.length + 1) : path;
      return targetGroupPath ? `${targetGroupPath}/${relative}` : relative;
    }
    return targetGroupPath;
  };

  const mapSecretRef = (secretRef?: string | null) => (secretRef ? (secretRefMap.get(secretRef) ?? null) : null);
  const mapTailnet = (tailnetId?: string | null) => {
    const scope = tailnetScope(tailnetId);
    return scope ? (tailnetIdMap.get(scope) ?? null) : null;
  };
  const mapStartupCommand = (command?: HostStartupCommand | null): HostStartupCommand | null => {
    if (command?.type !== "snippet") {
      return command ?? null;
    }
    const snippetId = snippetIdMap.get(command.snippetId);
    return snippetId ? { type: "snippet", snippetId } : null;
  };

  // 4. 호스트.
  const remapHost = (host: HostRecord): HostRecord => {
    const base = {
      ...host,
      id: hostIdMap.get(host.id) as string,
      groupName: reroot(normalizeGroupPath(host.groupName)),
      createdAt: now,
      updatedAt: now,
    };
    switch (base.kind) {
      case "ssh": {
        const jumpHostIds = normalizeJumpHostIds(base.jumpHostIds, base.jumpHostId).map(
          (jumpHostId) => hostIdMap.get(jumpHostId) as string,
        );
        return {
          ...base,
          secretRef: mapSecretRef(base.secretRef),
          jumpHostId: jumpHostIds[0] ?? null,
          jumpHostIds: jumpHostIds.length > 0 ? jumpHostIds : null,
          tailnetId: mapTailnet(base.tailnetId),
          startupCommand: mapStartupCommand(base.startupCommand),
          // 키 파일 경로는 그 기기의 파일이다 — 팀 레코드에 두지 않는다(키는 비밀값에 들어 있다).
          privateKeyPath: options.targetIsTeam ? null : (base.privateKeyPath ?? null),
          certificatePath: options.targetIsTeam ? null : (base.certificatePath ?? null),
        };
      }
      case "rdp": {
        const profile = base.awsSsm?.profileId ? profileMap.get(base.awsSsm.profileId) : undefined;
        return {
          ...base,
          secretRef: mapSecretRef(base.secretRef),
          tailnetId: mapTailnet(base.tailnetId),
          awsSsm: base.awsSsm
            ? { ...base.awsSsm, profileId: profile?.id ?? null, profileName: profile?.name ?? base.awsSsm.profileName }
            : base.awsSsm,
        };
      }
      case "vnc":
        return {
          ...base,
          secretRef: mapSecretRef(base.secretRef),
          tailnetId: mapTailnet(base.tailnetId),
          sshTunnelHostId: base.sshTunnelHostId ? (hostIdMap.get(base.sshTunnelHostId) ?? null) : null,
        };
      case "aws-ec2": {
        const profile = base.awsProfileId ? profileMap.get(base.awsProfileId) : undefined;
        return {
          ...base,
          awsProfileId: profile?.id ?? null,
          awsProfileName: profile?.name ?? base.awsProfileName,
          startupCommand: mapStartupCommand(base.startupCommand),
        };
      }
      case "aws-ecs": {
        const profile = base.awsProfileId ? profileMap.get(base.awsProfileId) : undefined;
        return { ...base, awsProfileId: profile?.id ?? null, awsProfileName: profile?.name ?? base.awsProfileName };
      }
      case "warpgate-ssh":
        return { ...base, startupCommand: mapStartupCommand(base.startupCommand) };
      default:
        return base;
    }
  };
  // 자격 증명을 어디에 둘지. 호스트가 쓰던 비밀값과, 팀에서 가져올 때는 그 팀에 둔 내 자격 증명이 대상이다.
  //  - 개인으로: 복사본은 내 것이다. 내 자격 증명을 비밀값 위에 얹어 복사본의 비밀값으로 만든다.
  //  - 팀으로: 내 자격 증명은 팀 비밀값이 되지 않고 그 팀의 내 칸에 간다. 비밀번호·키를 빼고 공유하면 호스트가
  //    쓰던 비밀값도 팀에 넣지 않고 내 칸에 둔다(그래야 나는 그대로 붙는다). 키 파일 경로는 늘 내 칸이다.
  const withholdSecrets = options.targetIsTeam && options.shareSecrets === false;
  const mine = options.sourceMyCredentials ?? null;
  const sourceSecretByRef = new Map((bundle?.secrets ?? []).map((secret) => [secret.secretRef, secret]));
  const ownSecrets: ManagedSecretPayload[] = [];
  const memberHostCredentials: VaultCopyPlan["memberCredentials"]["hostCredentials"] = [];
  const placeCredentials = (source: HostRecord, copy: HostRecord): HostRecord => {
    if ((copy.kind !== "ssh" && copy.kind !== "rdp" && copy.kind !== "vnc") || source.kind !== copy.kind) {
      return copy;
    }
    const sourceSecretRef = "secretRef" in source ? source.secretRef : null;
    const vaultSecret = sourceSecretRef ? (sourceSecretByRef.get(sourceSecretRef) ?? null) : null;
    const myCredentials = mine?.readHostCredentials(source.id) ?? null;
    const secretFields = copy.kind === "ssh" ? SSH_SECRET_FIELDS : ACCOUNT_SECRET_FIELDS;
    if (!options.targetIsTeam) {
      if (!myCredentials) {
        return copy;
      }
      const withMine =
        copy.kind === "ssh"
          ? {
              ...copy,
              username: myCredentials.username ?? copy.username,
              authType: myCredentials.authType ?? copy.authType,
              privateKeyPath: myCredentials.privateKeyPath ?? copy.privateKeyPath ?? null,
              certificatePath: myCredentials.certificatePath ?? copy.certificatePath ?? null,
            }
          : copy;
      const overlay = pickSecretFields(myCredentials, secretFields);
      if (Object.keys(overlay).length === 0) {
        return withMine;
      }
      const secretRef = `secret:${newId()}`;
      // 내 키가 팀 키를 갈아 끼우면 팀 키의 공개키·지문은 버린다 — 남기면 키 설치가 내 키 대신 그 공개키를
      // 설치한다(키 재료를 비밀값의 공개키에서 먼저 읽는다).
      const keepKeyMetadata = !overlay.privateKeyPem || overlay.privateKeyPem === vaultSecret?.privateKeyPem;
      const base =
        vaultSecret && !keepKeyMetadata
          ? Object.fromEntries(
              Object.entries(vaultSecret).filter(([field]) => !(KEY_METADATA_FIELDS as readonly string[]).includes(field)),
            )
          : vaultSecret;
      ownSecrets.push({
        ...base,
        ...overlay,
        kind: vaultSecret?.kind ?? copy.kind,
        secretRef,
        label: vaultSecret?.label ?? copy.label,
        updatedAt: now,
      });
      return { ...withMine, secretRef };
    }
    const keyPaths =
      source.kind === "ssh"
        ? { privateKeyPath: source.privateKeyPath ?? undefined, certificatePath: source.certificatePath ?? undefined }
        : {};
    const withheld = withholdSecrets && vaultSecret ? pickSecretFields(vaultSecret, secretFields) : {};
    const credentials = normalizeTeamHostCredentials({ ...withheld, ...keyPaths, ...myCredentials });
    if (credentials) {
      memberHostCredentials.push({ id: copy.id, credentials });
    }
    return withholdSecrets ? { ...copy, secretRef: null } : copy;
  };

  const memberValues: VaultCopyMemberValues[] = [];
  const hosts = sourceHosts.map((host) => placeCredentials(host, remapHost(host))).map((host) => {
    if (!options.targetIsTeam) {
      return host;
    }
    const favorite = host.favorite === true ? true : null;
    const agentForwarding =
      (host.kind === "ssh" || host.kind === "aws-ec2") && host.agentForwarding === true ? true : null;
    const terminalThemeId = host.terminalThemeId ?? null;
    if (favorite || agentForwarding || terminalThemeId) {
      memberValues.push({ hostId: host.id, favorite, agentForwarding, terminalThemeId });
    }
    return stripHostMemberPrefs(host);
  });

  // 5. 그룹. 대상에 같은 경로가 있으면 합친다(새로 만들지 않는다).
  const neededPaths = new Set<string>();
  const sourceGroupByNewPath = new Map<string, GroupRecord>();
  const addWithAncestors = (path: string | null) => {
    for (let current = normalizeGroupPath(path); current; current = getParentGroupPath(current)) {
      neededPaths.add(current);
    }
  };
  if (selectedGroupPath) {
    addWithAncestors(reroot(selectedGroupPath));
    for (const group of source.data.groups) {
      if (isGroupWithinPath(group.path, selectedGroupPath)) {
        const newPath = reroot(group.path);
        addWithAncestors(newPath);
        if (newPath) {
          sourceGroupByNewPath.set(newPath, group);
        }
      }
    }
  }
  for (const host of hosts) {
    addWithAncestors(host.groupName ?? null);
  }
  if (selectedWorkspaces.length > 0) {
    addWithAncestors(targetGroupPath);
  }
  const targetGroupPaths = new Set(target.data.groups.map((group) => group.path));
  const groups: GroupRecord[] = [...neededPaths]
    .filter((path) => !targetGroupPaths.has(path))
    .sort()
    .map((path) => ({
      id: newId(),
      name: getGroupLabel(path),
      path,
      parentPath: getParentGroupPath(path),
      sortRank: sourceGroupByNewPath.get(path)?.sortRank ?? null,
      createdAt: now,
      updatedAt: now,
    }));

  // 6. 비밀값·AWS 프로필·스니펫·tailnet·포트 포워딩·DNS. 비밀값은 복사본이 쓰는 것만 — 빼고 공유했거나
  //    내 자격 증명으로 바꾼 호스트만 쓰던 것은 넣지 않는다.
  const usedSecretRefs = new Set(hosts.flatMap((host) => ("secretRef" in host && host.secretRef ? [host.secretRef] : [])));
  const secrets = [
    ...(bundle?.secrets ?? [])
      .map((secret) => ({ ...secret, secretRef: secretRefMap.get(secret.secretRef) as string, updatedAt: now }))
      .filter((secret) => usedSecretRefs.has(secret.secretRef)),
    ...ownSecrets,
  ];
  const secretMetadata = secrets.map((secret) => projectSecretMetadata(secret, { linkedHostCount: 0, updatedAt: now }));
  // AWS 정적 프로필의 키와 tailnet auth key 는 사람의 인증 정보다(IAM 키는 그 사람으로 찍히고, auth key 는 그
  // 사람 기기를 tailnet 에 넣는다). 팀에는 설정만 보내고 키는 늘 복사한 사람의 내 칸에 둔다 — 내 것이 먼저, 없으면
  // 원래 것. 개인으로 가져올 때는 내 것이 먼저다.
  const memberAwsProfileCredentials: VaultCopyPlan["memberCredentials"]["awsProfileCredentials"] = [];
  const awsProfiles = (bundle?.awsProfiles ?? []).map((profile): ManagedAwsProfilePayload => {
    const mapped = profileMap.get(profile.id) as { id: string; name: string };
    const base = { ...profile, id: mapped.id, name: mapped.name, updatedAt: now };
    if (base.kind === "role") {
      return { ...base, sourceProfileId: profileMap.get(base.sourceProfileId)?.id ?? base.sourceProfileId };
    }
    if (base.kind !== "static") {
      return base;
    }
    const myKeys = mine?.readAwsProfileCredentials(profile.id) ?? null;
    if (!options.targetIsTeam) {
      return myKeys ? { ...base, ...myKeys } : base;
    }
    const keep = myKeys ?? normalizeTeamAwsProfileCredentials(base);
    if (keep) {
      memberAwsProfileCredentials.push({ id: base.id, credentials: keep });
    }
    return { ...base, accessKeyId: "", secretAccessKey: "" };
  });
  const snippets = (bundle?.snippets ?? []).map((snippet) => ({
    ...snippet,
    id: snippetIdMap.get(snippet.id) as string,
    createdAt: now,
    updatedAt: now,
  }));
  // 마지막으로 인증한 계정(loginName)은 그 기기의 것이라 옮기지 않는다.
  const memberTailnetCredentials: VaultCopyPlan["memberCredentials"]["tailnetCredentials"] = [];
  const tailnets = (bundle?.tailnets ?? []).map(({ loginName: _loginName, authKey, ...tailnet }): TailnetPayload => {
    const copy = { ...tailnet, id: tailnetIdMap.get(tailnet.id) as string, createdAt: now, updatedAt: now };
    const myKey = mine?.readTailnetCredentials(tailnet.id) ?? null;
    const vaultKey = authKey?.trim() ? { authKey: authKey.trim() } : null;
    if (!options.targetIsTeam) {
      const key = myKey ?? vaultKey;
      return key ? { ...copy, authKey: key.authKey } : copy;
    }
    const keep = myKey ?? vaultKey;
    if (keep) {
      memberTailnetCredentials.push({ id: copy.id, credentials: keep });
    }
    return copy;
  });
  const portForwards = (bundle?.portForwards ?? []).map(
    (rule) =>
      ({
        ...rule,
        id: portForwardIdMap.get(rule.id) as string,
        hostId: hostIdMap.get(rule.hostId) as string,
        createdAt: now,
        updatedAt: now,
      }) as PortForwardRuleRecord,
  );
  // DNS 이름은 볼트 안에서 겹치면 안 된다 — 대상에 이미 있는 이름은 넣지 않는다.
  const targetDnsHostnames = new Set(target.data.dnsOverrides.map((record) => record.hostname));
  const dnsOverrides = (bundle?.dnsOverrides ?? []).flatMap((record): DnsOverrideRecord[] => {
    if (record.type !== "linked" || targetDnsHostnames.has(record.hostname)) {
      return [];
    }
    return [
      {
        ...record,
        id: newId(),
        portForwardRuleId: portForwardIdMap.get(record.portForwardRuleId) as string,
        createdAt: now,
        updatedAt: now,
      },
    ];
  });

  // 7. known hosts — 복사하는 SSH 호스트의 주소(호스트·포트·tailnet)로 찾고, 대상에 같은 것이 없을 때만.
  //    AWS SSM 경유 호스트 키는 펼친 프로필 이름이 열쇠에 들어가 볼트를 넘으면 맞지 않으므로 옮기지 않는다
  //    (처음 접속할 때 한 번 묻는다).
  const targetKnownHostKeys = new Set(target.data.knownHosts.map(knownHostKey));
  const knownHosts: KnownHostRecord[] = [];
  for (const host of sourceHosts) {
    if (host.kind !== "ssh") {
      continue;
    }
    for (const record of source.data.knownHosts) {
      if (
        record.host !== host.hostname ||
        record.port !== host.port ||
        tailnetScope(record.tailnetId) !== tailnetScope(host.tailnetId)
      ) {
        continue;
      }
      const tailnetId = mapTailnet(record.tailnetId);
      const { tailnetId: _sourceTailnetId, ...rest } = record;
      const copy: KnownHostRecord = {
        ...rest,
        ...(tailnetId ? { tailnetId } : {}),
        id: newId(),
        createdAt: now,
        updatedAt: now,
      };
      const key = knownHostKey(copy);
      if (!targetKnownHostKeys.has(key)) {
        targetKnownHostKeys.add(key);
        knownHosts.push(copy);
      }
    }
  }

  // 8. 워크스페이스 — 놓은 자리에, 창은 복사본 호스트로 다시 잇는다. 원본 볼트에 없는 호스트(지워졌거나 다른 볼트
  //    것)를 가리키던 창은 어디에도 없는 id 로 바꿔 "없는 호스트" 창으로 남긴다 — 복사본이 원본 볼트를 가리키지
  //    않게. 즐겨찾기·연 시각은 사람마다 다르니 비운다.
  const workspaceIdMap = new Map(selectedWorkspaces.map((workspace) => [workspace.id, newId()]));
  const remapNode = (node: SavedWorkspaceNode): SavedWorkspaceNode => {
    if (node.kind === "split") {
      return { ...node, first: remapNode(node.first), second: remapNode(node.second) };
    }
    if (node.target.kind !== "host") {
      return node;
    }
    return { ...node, target: { ...node.target, hostId: hostIdMap.get(node.target.hostId) ?? newId() } };
  };
  const savedWorkspaces = selectedWorkspaces.map(
    (workspace): SavedWorkspaceRecord => ({
      ...workspace,
      id: workspaceIdMap.get(workspace.id) as string,
      root: remapNode(workspace.root),
      favorite: false,
      groupName: targetGroupPath,
      lastOpenedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const plan: VaultCopyPlan = {
    groups,
    hosts,
    secrets,
    secretMetadata,
    knownHosts,
    portForwards,
    dnsOverrides,
    snippets,
    awsProfiles,
    tailnets,
    savedWorkspaces,
    memberValues,
    memberCredentials: {
      hostCredentials: memberHostCredentials,
      awsProfileCredentials: memberAwsProfileCredentials,
      tailnetCredentials: memberTailnetCredentials,
    },
    hostIdMap: Object.fromEntries(hostIdMap),
    workspaceIdMap: Object.fromEntries(workspaceIdMap),
    counts: {
      groups: groups.length,
      hosts: hosts.length,
      dependencyHosts: sourceHosts.filter((host) => !rootHostIds.includes(host.id)).length,
      // 비밀번호와 키 — 대상 볼트에 들어가는 것만 센다.
      secrets:
        secrets.length +
        awsProfiles.filter((profile) => profile.kind === "static" && normalizeTeamAwsProfileCredentials(profile)).length +
        tailnets.filter((tailnet) => Boolean(tailnet.authKey)).length,
      knownHosts: knownHosts.length,
      portForwards: portForwards.length,
      dnsOverrides: dnsOverrides.length,
      snippets: snippets.length,
      awsProfiles: awsProfiles.length,
      tailnets: tailnets.length,
      workspaces: savedWorkspaces.length,
    },
  };
  assertNoOutsideReferences(plan);
  return plan;
}

/**
 * 복사본이 묶음 밖(원본 볼트)을 가리키면 거절한다. 남기면 팀 쪽이 개인을 — 또는 그 반대를 — 가리키게
 * 된다(완전 분리). 모으기와 다시 잇기가 맞으면 일어나지 않는다.
 */
export function assertNoOutsideReferences(plan: VaultCopyPlan): void {
  const hostIds = new Set(plan.hosts.map((host) => host.id));
  const secretRefs = new Set(plan.secrets.map((secret) => secret.secretRef));
  const profileIds = new Set(plan.awsProfiles.map((profile) => profile.id));
  const snippetIds = new Set(plan.snippets.map((snippet) => snippet.id));
  const tailnetIds = new Set(plan.tailnets.map((tailnet) => tailnet.id));
  const ruleIds = new Set(plan.portForwards.map((rule) => rule.id));
  const outside: string[] = [];
  const check = (owner: string, field: string, id: string | null | undefined, inside: ReadonlySet<string>) => {
    if (id && !inside.has(id)) {
      outside.push(`${owner}.${field}`);
    }
  };
  for (const host of plan.hosts) {
    if (host.kind === "ssh") {
      for (const jumpHostId of normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)) {
        check(host.id, "jumpHostIds", jumpHostId, hostIds);
      }
    }
    if (host.kind === "ssh" || host.kind === "rdp" || host.kind === "vnc") {
      check(host.id, "secretRef", host.secretRef, secretRefs);
      check(host.id, "tailnetId", host.tailnetId, tailnetIds);
    }
    if (host.kind === "vnc") {
      check(host.id, "sshTunnelHostId", host.sshTunnelHostId, hostIds);
    }
    if (host.kind === "rdp") {
      check(host.id, "awsSsm.profileId", host.awsSsm?.profileId, profileIds);
    }
    if (host.kind === "aws-ec2" || host.kind === "aws-ecs") {
      check(host.id, "awsProfileId", host.awsProfileId, profileIds);
    }
    if ("startupCommand" in host && host.startupCommand?.type === "snippet") {
      check(host.id, "startupCommand", host.startupCommand.snippetId, snippetIds);
    }
  }
  for (const profile of plan.awsProfiles) {
    if (profile.kind === "role") {
      check(profile.id, "sourceProfileId", profile.sourceProfileId, profileIds);
    }
  }
  for (const rule of plan.portForwards) {
    check(rule.id, "hostId", rule.hostId, hostIds);
  }
  for (const record of plan.dnsOverrides) {
    if (record.type === "linked") {
      check(record.id, "portForwardRuleId", record.portForwardRuleId, ruleIds);
    }
  }
  for (const record of plan.knownHosts) {
    check(record.id, "tailnetId", record.tailnetId, tailnetIds);
  }
  if (outside.length > 0) {
    throw new Error(`vault copy would point outside the copied set: ${outside.join(", ")}`);
  }
}
