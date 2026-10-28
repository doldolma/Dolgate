/**
 * 볼트를 넘어 **찾는** 입구.
 *
 * 스토어의 `hosts`·`secretsByRef`·`knownHosts`·`awsProfiles`·`tailnets`·`snippets` 는 개인 볼트의
 * 것이다. 팀 볼트는 그것과 섞지 않고 따로 담는다(`teamVaults`·`teamSecrets`, store/team-sync.ts) — 개인
 * 동기화는 목록을 통째로 올리고 갈아 끼우므로, 섞으면 팀 것이 개인 볼트로 올라가거나 지워진다. 그래서 개인
 * 동기화·저장·개인 편집은 위 칸을 그대로 읽고, **팀 호스트도 찾아야 하는 곳**(접속·SFTP·원격 데스크톱·점프
 * 사슬·tailnet 판정·호스트 키 확인·자격 증명·요청 창·세션 화면)은 이 파일을 지난다. 데스크톱 메인의
 * `vault-catalog.ts` 와 같은 자리다.
 *
 * 호스트 하나가 어느 볼트에 있는지는 id 로 가린다. 볼트를 넘어 id 가 겹치지 않게 받을 때 지키므로(개인이
 * 이긴다) 한 곳에만 있다. 그 호스트가 쓰는 것(점프 호스트·비밀값·호스트 키·AWS 프로필·tailnet·스니펫)은 그
 * 볼트 안에서만 찾는다.
 *
 * 화면이 고르기(selector)로 쓰는 것은 같은 입력이면 같은 배열을 돌려줘야 한다 — zustand 5 는 고르기가
 * 매번 새 배열을 주면 화면을 끝없이 다시 그린다.
 */
import {
  isAwsEc2HostRecord,
  isRdpHostRecord,
  isSshHostRecord,
  type GroupRecord,
  type HostRecord,
  type KnownHostRecord,
  type LoadedManagedSecretPayload,
  type ManagedAwsProfilePayload,
  type SnippetRecord,
  type TailnetPayload,
  type TeamHostCredentials,
  type TeamHostPrefsRecord,
} from '@dolssh/shared-core';
import type {
  MobileTeamSecrets,
  MobileTeamVault,
  TeamSyncSlice,
} from './team-sync';

/** 찾기가 읽는 스토어 칸. */
export interface VaultCatalogSource extends TeamSyncSlice {
  hosts: HostRecord[];
  groups: GroupRecord[];
  secretsByRef: Record<string, LoadedManagedSecretPayload>;
  knownHosts: KnownHostRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  tailnets: TailnetPayload[];
  snippets: SnippetRecord[];
}

/** 그 호스트가 있는 팀 볼트. 개인 호스트거나 모르는 호스트면 없다(개인으로 본다). */
function teamOfHost(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults'>,
  hostId: string,
): MobileTeamVault | undefined {
  if (source.hosts.some(host => host.id === hostId)) {
    return undefined;
  }
  return source.teamVaults.find(vault =>
    vault.hosts.some(host => host.id === hostId),
  );
}

/** 팀 호스트 하나에 내 값을 얹는다. 얹을 것이 없으면 그 레코드 그대로다. */
function withMyValues(
  host: HostRecord,
  prefs: TeamHostPrefsRecord | undefined,
  mine: TeamHostCredentials | undefined,
): HostRecord {
  let view = host;
  if (prefs?.favorite === true) {
    view = { ...view, favorite: true };
  }
  if (isSshHostRecord(view) && (mine?.username || mine?.authType)) {
    view = {
      ...view,
      ...(mine.username ? { username: mine.username } : {}),
      ...(mine.authType ? { authType: mine.authType } : {}),
    };
  }
  if (isRdpHostRecord(view) && prefs?.rdpCertificateFingerprint) {
    view = { ...view, certificateFingerprint: prefs.rdpCertificateFingerprint };
  }
  return view;
}

const hostViewByVault = new WeakMap<
  MobileTeamVault,
  { secrets: MobileTeamSecrets | undefined; hosts: HostRecord[] }
>();

/**
 * 팀 호스트에 내 값을 얹은 것 — 화면과 접속이 모두 이것을 본다(데스크톱과 같다). 팀 레코드에는 사람마다 다른 값이
 * 없다(받을 때 뺀다).
 * - 별표·RDP 인증서 지문: 내 개인 칸의 호스트 설정
 * - SSH 사용자 이름·인증 방식: 내 자격 증명(비운 칸은 팀 것)
 * 팀이나 그 팀의 내 자격 증명이 바뀌면 새 객체가 오므로 그때만 다시 만든다.
 */
function teamHostView(
  vault: MobileTeamVault,
  secrets: MobileTeamSecrets | undefined,
): HostRecord[] {
  const cached = hostViewByVault.get(vault);
  if (cached && cached.secrets === secrets) {
    return cached.hosts;
  }
  const prefsById = new Map(vault.hostPrefs.map(prefs => [prefs.id, prefs]));
  const credentials = secrets?.hostCredentials ?? {};
  let changed = false;
  const hosts = vault.hosts.map(host => {
    const view = withMyValues(
      host,
      prefsById.get(host.id),
      credentials[host.id],
    );
    changed ||= view !== host;
    return view;
  });
  const result = changed ? hosts : vault.hosts;
  hostViewByVault.set(vault, { secrets, hosts: result });
  return result;
}

let listHostsMemo: {
  hosts: HostRecord[];
  teamVaults: MobileTeamVault[];
  teamSecrets: TeamSyncSlice['teamSecrets'];
  result: HostRecord[];
} | null = null;

/**
 * 볼트를 가리지 않는 목록(검색·즐겨찾기·세션 화면)과 즉석 접속(같은 주소의 호스트 찾기)이 보는 호스트 — 개인 것
 * 다음에 팀 것. 팀이 없으면 개인 목록 그대로다.
 */
export function listHosts(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'teamSecrets'>,
): HostRecord[] {
  if (source.teamVaults.length === 0) {
    return source.hosts;
  }
  if (
    listHostsMemo?.hosts !== source.hosts ||
    listHostsMemo.teamVaults !== source.teamVaults ||
    listHostsMemo.teamSecrets !== source.teamSecrets
  ) {
    listHostsMemo = {
      hosts: source.hosts,
      teamVaults: source.teamVaults,
      teamSecrets: source.teamSecrets,
      result: [
        ...source.hosts,
        ...source.teamVaults.flatMap(vault =>
          teamHostView(vault, source.teamSecrets[vault.id]),
        ),
      ],
    };
  }
  return listHostsMemo.result;
}

/** 홈 맨 윗단의 볼트 하나 — 그 볼트의 그룹·호스트만 든다. 데스크톱 사이드바의 볼트 줄(`BrowserVault`)과 같은 자리다. */
export interface VaultView {
  /** 개인은 null, 팀은 팀 id. */
  id: string | null;
  /** 팀 이름. 개인은 null — 화면이 정한 이름으로 그린다. */
  name: string | null;
  /** 동기화가 막혀 손봐야 할 때만(다시 들어와야 함·업데이트 필요). 평소엔 null 이라 아무것도 안 단다. */
  blocked: 'needs-rejoin' | 'outdated' | null;
  groups: GroupRecord[];
  hosts: HostRecord[];
}

let listVaultsMemo: {
  hosts: HostRecord[];
  groups: GroupRecord[];
  teamVaults: MobileTeamVault[];
  teamSecrets: TeamSyncSlice['teamSecrets'];
  result: VaultView[];
} | null = null;

/**
 * 홈이 늘어놓는 볼트 — 개인 먼저, 그다음 받은 팀 순서. 팀이 없으면 개인 하나뿐이라 화면은 볼트 카드 없이 지금처럼
 * 그린다. 같은 경로(`Prod`)가 개인과 팀에 다 있어도 볼트마다 따로 담아 섞이지 않는다.
 */
export function listVaults(
  source: Pick<
    VaultCatalogSource,
    'hosts' | 'groups' | 'teamVaults' | 'teamSecrets'
  >,
): VaultView[] {
  if (
    listVaultsMemo?.hosts !== source.hosts ||
    listVaultsMemo.groups !== source.groups ||
    listVaultsMemo.teamVaults !== source.teamVaults ||
    listVaultsMemo.teamSecrets !== source.teamSecrets
  ) {
    listVaultsMemo = {
      hosts: source.hosts,
      groups: source.groups,
      teamVaults: source.teamVaults,
      teamSecrets: source.teamSecrets,
      result: [
        {
          id: null,
          name: null,
          blocked: null,
          groups: source.groups,
          hosts: source.hosts,
        },
        ...source.teamVaults.map(vault => ({
          id: vault.id,
          name: vault.name,
          blocked:
            vault.state === 'needs-rejoin' || vault.state === 'outdated'
              ? vault.state
              : null,
          groups: vault.groups,
          hosts: teamHostView(vault, source.teamSecrets[vault.id]),
        })),
      ],
    };
  }
  return listVaultsMemo.result;
}

let teamNamesMemo: {
  hosts: HostRecord[];
  teamVaults: MobileTeamVault[];
  result: ReadonlyMap<string, string>;
} | null = null;

/** 팀 호스트 id → 그 팀 이름. 섞인 목록이 팀 호스트에 어느 팀인지 단다(개인 호스트는 없다). */
export function teamNamesByHostId(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults'>,
): ReadonlyMap<string, string> {
  if (
    teamNamesMemo?.hosts !== source.hosts ||
    teamNamesMemo.teamVaults !== source.teamVaults
  ) {
    const personal = new Set(source.hosts.map(host => host.id));
    const names = new Map<string, string>();
    for (const vault of source.teamVaults) {
      for (const host of vault.hosts) {
        if (!personal.has(host.id)) {
          names.set(host.id, vault.name);
        }
      }
    }
    teamNamesMemo = {
      hosts: source.hosts,
      teamVaults: source.teamVaults,
      result: names,
    };
  }
  return teamNamesMemo.result;
}

/** 어느 볼트에 있든 그 호스트 — 접속·세션·요청 창이 쓴다. 팀 호스트는 내 값을 얹은 것이다(teamHostView). */
export function findHost(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'teamSecrets'>,
  hostId: string,
): HostRecord | undefined {
  const personal = findPersonalHost(source, hostId);
  if (personal) {
    return personal;
  }
  const team = teamOfHost(source, hostId);
  return team
    ? teamHostView(team, source.teamSecrets[team.id]).find(
        host => host.id === hostId,
      )
    : undefined;
}

/**
 * 개인 볼트의 호스트만 — 개인 편집(고치기·지우기·별표·사용자 이름·RDP 인증서 고정·물어서 넣은
 * 비밀번호·호스트 키 신뢰)이 쓴다. 팀 호스트면 없다고 답한다: 그 편집은 개인 볼트에 쓰고 개인 동기화로
 * 올라가므로, 팀 호스트를 그 길로 고치면 팀 것이 개인 볼트로 샌다.
 */
export function findPersonalHost(
  source: Pick<VaultCatalogSource, 'hosts'>,
  hostId: string,
): HostRecord | undefined {
  return source.hosts.find(host => host.id === hostId);
}

/** 그 호스트와 같은 볼트의 호스트들 — 점프 사슬과 tailnet 판정은 볼트를 넘지 않는다. 점프 홉도 내 값을 얹는다. */
export function hostsInVaultOf(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'teamSecrets'>,
  hostId: string,
): HostRecord[] {
  const team = teamOfHost(source, hostId);
  return team ? teamHostView(team, source.teamSecrets[team.id]) : source.hosts;
}

/** 그 호스트가 있는 팀의 id — 개인 호스트면 없다. 폰에서 생긴 내 것을 내 개인 칸에 둘 때 쓴다. */
export function teamIdOfHost(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults'>,
  hostId: string,
): string | undefined {
  return teamOfHost(source, hostId)?.id;
}

/** 팀 호스트에 쓰는 내 자격 증명(내 개인 칸). 개인 호스트거나 아직 없으면 없다. */
export function myCredentialsForHost(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'teamSecrets'>,
  hostId: string,
): TeamHostCredentials | undefined {
  const team = teamOfHost(source, hostId);
  return team
    ? source.teamSecrets[team.id]?.hostCredentials[hostId]
    : undefined;
}

/** 그 호스트가 쓸 비밀값 — 자격 증명은 그 호스트의 볼트에서 찾는다. */
export function secretForHost(
  source: Pick<
    VaultCatalogSource,
    'hosts' | 'teamVaults' | 'secretsByRef' | 'teamSecrets'
  >,
  hostId: string,
  secretRef: string,
): LoadedManagedSecretPayload | undefined {
  const team = teamOfHost(source, hostId);
  return team
    ? source.teamSecrets[team.id]?.secretsByRef[secretRef]
    : source.secretsByRef[secretRef];
}

/**
 * 붙을 때 쓸 비밀값 — 팀 호스트면 내 자격 증명이 먼저고, 비운 칸은 팀 비밀값을 쓴다(데스크톱과 같다: 내 것 → 팀 것
 * → 요청 창). 개인 호스트는 그 비밀값 그대로다.
 */
export function connectSecretForHost(
  source: Pick<
    VaultCatalogSource,
    'hosts' | 'teamVaults' | 'secretsByRef' | 'teamSecrets'
  >,
  host: Pick<HostRecord, 'id'> & { secretRef?: string | null },
): LoadedManagedSecretPayload | undefined {
  const vaultSecret = host.secretRef
    ? secretForHost(source, host.id, host.secretRef)
    : undefined;
  const mine = myCredentialsForHost(source, host.id);
  if (!mine) {
    return vaultSecret;
  }
  return {
    ...(vaultSecret ?? {
      secretRef: host.secretRef ?? '',
      label: '',
      updatedAt: '',
    }),
    username: mine.username ?? vaultSecret?.username,
    domain: mine.domain ?? vaultSecret?.domain,
    password: mine.password ?? vaultSecret?.password,
    passphrase: mine.passphrase ?? vaultSecret?.passphrase,
    privateKeyPem: mine.privateKeyPem ?? vaultSecret?.privateKeyPem,
    certificateText: mine.certificateText ?? vaultSecret?.certificateText,
  };
}

/** 개인 볼트의 비밀값 — 개인 편집이 이어 쓸 값을 읽는다. */
export function findPersonalSecret(
  source: Pick<VaultCatalogSource, 'secretsByRef'>,
  secretRef: string,
): LoadedManagedSecretPayload | undefined {
  return source.secretsByRef[secretRef];
}

/** 개인 볼트의 호스트 키 — 개인 편집이 신뢰한 키를 갈아 끼울 때 쓴다. */
export function personalKnownHosts(
  source: Pick<VaultCatalogSource, 'knownHosts'>,
): KnownHostRecord[] {
  return source.knownHosts;
}

function knownHostSlot(record: KnownHostRecord): string {
  return [
    record.tailnetId?.trim() || '',
    record.host,
    String(record.port),
    record.algorithm,
  ].join('\u0000');
}

/**
 * 팀 호스트에서 신뢰한 호스트 키를 내 개인 칸 목록에 넣는다. 같은 자리(tailnet·주소·포트·알고리즘)에 있던 것은 갈아
 * 끼우되 그 기록의 id·처음 본 때는 이어 쓴다.
 */
export function withTrustedKnownHost(
  knownHosts: KnownHostRecord[],
  trusted: KnownHostRecord,
): KnownHostRecord[] {
  const slot = knownHostSlot(trusted);
  const existing = knownHosts.find(record => knownHostSlot(record) === slot);
  return [
    ...knownHosts.filter(record => knownHostSlot(record) !== slot),
    existing
      ? { ...trusted, id: existing.id, createdAt: existing.createdAt }
      : trusted,
  ];
}

/**
 * 그 호스트의 호스트 키를 견줄 목록 — 그 호스트의 볼트 것. 팀 호스트면 내가 신뢰한 것(내 개인 칸)이 먼저고,
 * 같은 자리(tailnet·주소·포트·알고리즘)의 팀 것은 뺀다 — 데스크톱 TeamKnownHostRepository 와 같다.
 */
export function knownHostsForHost(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'knownHosts'>,
  hostId: string,
): KnownHostRecord[] {
  const team = teamOfHost(source, hostId);
  if (!team) {
    return source.knownHosts;
  }
  const mine = team.hostPrefs.flatMap(prefs => prefs.knownHosts);
  const taken = new Set(mine.map(knownHostSlot));
  return [
    ...mine,
    ...team.knownHosts.filter(record => !taken.has(knownHostSlot(record))),
  ];
}

/**
 * 그 호스트가 고를 수 있는 AWS 프로필 — 그 호스트의 볼트 것. 팀 정적 프로필에는 이 기기에서 넣은 키를 얹는다(팀에는
 * 설정만 가고 키는 기기마다다).
 */
export function awsProfilesForHost(
  source: Pick<
    VaultCatalogSource,
    'hosts' | 'teamVaults' | 'awsProfiles' | 'teamSecrets'
  >,
  hostId: string,
): ManagedAwsProfilePayload[] {
  const team = teamOfHost(source, hostId);
  if (!team) {
    return source.awsProfiles;
  }
  const keys = source.teamSecrets[team.id]?.awsKeys;
  return keys
    ? team.awsProfiles.map(profile =>
        profile.kind === 'static' && keys[profile.id]
          ? { ...profile, ...keys[profile.id] }
          : profile,
      )
    : team.awsProfiles;
}

/** 그 호스트가 쓰는 AWS 프로필 — aws-ec2 는 그 프로필, SSM 으로 닿는 원격 데스크톱은 그 터널의 프로필. */
function awsProfileOfHost(
  profiles: ManagedAwsProfilePayload[],
  host: HostRecord,
): ManagedAwsProfilePayload | undefined {
  if (isAwsEc2HostRecord(host)) {
    return host.awsProfileId
      ? profiles.find(profile => profile.id === host.awsProfileId)
      : undefined;
  }
  const awsSsm = isRdpHostRecord(host) ? host.awsSsm : null;
  if (!awsSsm) {
    return undefined;
  }
  const profileId = awsSsm.profileId?.trim();
  return profileId
    ? profiles.find(profile => profile.id === profileId)
    : profiles.find(profile => profile.name === awsSsm.profileName);
}

/** 이 기기에서 키를 넣어야 붙는 팀 정적 AWS 프로필. */
export interface TeamAwsKeyMissing {
  teamId: string;
  teamName: string;
  profileId: string;
  /** 팀에서의 이름(화면에 보이는 이름). */
  profileName: string;
  region: string | null;
}

/**
 * 이 기기에 키가 없어 붙을 수 없는 팀 정적 AWS 프로필 — 키는 동기화하지 않아 기기마다 넣는다(데스크톱
 * findTeamProfileMissingKey 와 같다). role 이면 그 원본을 본다. 개인 호스트거나 AWS 를 안 쓰거나 키가 있으면 없다.
 */
export function teamAwsKeyMissing(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'teamSecrets'>,
  hostId: string,
): TeamAwsKeyMissing | null {
  const team = teamOfHost(source, hostId);
  const host = team?.hosts.find(item => item.id === hostId);
  if (!team || !host) {
    return null;
  }
  const profile = awsProfileOfHost(team.awsProfiles, host);
  const keyHolder =
    profile?.kind === 'role'
      ? team.awsProfiles.find(item => item.id === profile.sourceProfileId)
      : profile;
  if (
    keyHolder?.kind !== 'static' ||
    source.teamSecrets[team.id]?.awsKeys?.[keyHolder.id] ||
    (keyHolder.accessKeyId.trim() && keyHolder.secretAccessKey.trim())
  ) {
    return null;
  }
  return {
    teamId: team.id,
    teamName: team.name,
    profileId: keyHolder.id,
    profileName: keyHolder.name,
    region: keyHolder.region?.trim() || null,
  };
}

/** 그 호스트가 지날 수 있는 tailnet — 그 호스트의 볼트 것. */
export function tailnetsForHost(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'tailnets'>,
  hostId: string,
): TailnetPayload[] {
  return teamOfHost(source, hostId)?.tailnets ?? source.tailnets;
}

let sessionSnippetsMemo: {
  hosts: HostRecord[];
  teamVaults: MobileTeamVault[];
  snippets: SnippetRecord[];
  hostId: string | null;
  result: SnippetRecord[];
} | null = null;

/**
 * 세션 자동 완성이 볼 스니펫 — 그 세션 호스트의 볼트 것이 먼저, 그다음 나머지(개인·다른 팀)다. 데스크톱
 * useSessionSnippets(orderByVault)와 같은 순서다. 팀이 없으면 개인 목록 그대로다.
 */
export function snippetsForSession(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'snippets'>,
  hostId: string | null,
): SnippetRecord[] {
  if (source.teamVaults.length === 0) {
    return source.snippets;
  }
  if (
    sessionSnippetsMemo?.hosts !== source.hosts ||
    sessionSnippetsMemo.teamVaults !== source.teamVaults ||
    sessionSnippetsMemo.snippets !== source.snippets ||
    sessionSnippetsMemo.hostId !== hostId
  ) {
    const team = hostId ? teamOfHost(source, hostId) : undefined;
    const others = source.teamVaults
      .filter(vault => vault !== team)
      .flatMap(vault => vault.snippets);
    sessionSnippetsMemo = {
      hosts: source.hosts,
      teamVaults: source.teamVaults,
      snippets: source.snippets,
      hostId,
      result: team
        ? [...team.snippets, ...source.snippets, ...others]
        : [...source.snippets, ...others],
    };
  }
  return sessionSnippetsMemo.result;
}

/** 그 호스트의 시작 명령이 가리킬 수 있는 스니펫 — 그 호스트의 볼트 것. */
export function snippetsForHost(
  source: Pick<VaultCatalogSource, 'hosts' | 'teamVaults' | 'snippets'>,
  hostId: string,
): SnippetRecord[] {
  return teamOfHost(source, hostId)?.snippets ?? source.snippets;
}
