import type {
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  ManagedAwsProfilePayload,
  SnippetRecord,
  TailnetPayload,
} from '@dolssh/shared-core';
import type { MobileTeamVault } from '../src/store/team-sync';
import {
  awsProfilesForHost,
  connectSecretForHost,
  findHost,
  findPersonalHost,
  findPersonalSecret,
  hostsInVaultOf,
  knownHostsForHost,
  listHosts,
  listVaults,
  myCredentialsForHost,
  personalKnownHosts,
  secretForHost,
  snippetsForHost,
  snippetsForSession,
  tailnetsForHost,
  teamIdOfHost,
  teamAwsKeyMissing,
  teamNamesByHostId,
  withTrustedKnownHost,
  type VaultCatalogSource,
} from '../src/store/vault-catalog';

const updatedAt = '2026-10-27T00:00:00.000Z';

function sshHost(
  id: string,
  label: string,
  hostname: string,
  extra: Partial<HostRecord> = {},
): HostRecord {
  return {
    id,
    kind: 'ssh',
    label,
    hostname,
    port: 22,
    username: 'deploy',
    authType: 'password',
    groupName: null,
    tags: [],
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  } as HostRecord;
}

function knownHost(
  id: string,
  host: string,
  algorithm: string,
  publicKeyBase64: string,
): KnownHostRecord {
  return {
    id,
    host,
    port: 22,
    algorithm,
    publicKeyBase64,
    fingerprintSha256: `SHA256:${publicKeyBase64}`,
    createdAt: updatedAt,
    lastSeenAt: updatedAt,
    updatedAt,
  };
}

function secret(
  secretRef: string,
  password: string,
): LoadedManagedSecretPayload {
  return {
    secretRef,
    label: `${secretRef} credentials`,
    password,
    updatedAt,
  } as LoadedManagedSecretPayload;
}

function teamVault(): MobileTeamVault {
  return {
    id: 'team-1',
    name: 'Acme Infra',
    role: 'member',
    wrappedTeamDek: 'wrapped',
    state: 'ready',
    errorMessage: null,
    hosts: [
      sshHost('team-app', 'app', 'app.internal', {
        secretRef: 'secret-team-app',
        jumpHostIds: ['team-bastion'],
      } as Partial<HostRecord>),
      sshHost('team-bastion', 'bastion', 'bastion.acme.example'),
    ],
    groups: [],
    knownHosts: [
      knownHost('known-team-ed', 'app.internal', 'ssh-ed25519', 'TEAM-ED'),
      knownHost(
        'known-team-ecdsa',
        'app.internal',
        'ecdsa-sha2-nistp256',
        'TEAM-ECDSA',
      ),
    ],
    awsProfiles: [
      {
        id: 'aws-team',
        name: 'acme',
        kind: 'sso',
        updatedAt,
      } as ManagedAwsProfilePayload,
    ],
    tailnets: [
      {
        id: 'tailnet-team',
        label: 'acme',
        createdAt: updatedAt,
        updatedAt,
      } as TailnetPayload,
    ],
    snippets: [
      {
        id: 'snippet-team',
        label: 'deploy',
        command: './deploy.sh',
        createdAt: updatedAt,
        updatedAt,
      } as SnippetRecord,
    ],
    hostPrefs: [
      {
        id: 'team-app',
        favorite: true,
        agentForwarding: null,
        rdpCertificateFingerprint: null,
        // 내가 폰·데스크톱에서 신뢰한 키 — 같은 자리의 팀 것보다 먼저다.
        knownHosts: [
          knownHost('known-mine-ed', 'app.internal', 'ssh-ed25519', 'MINE-ED'),
        ],
        updatedAt,
      },
    ],
  };
}

function vaults(withTeam = true): VaultCatalogSource {
  return {
    hosts: [
      sshHost('host-web', 'web', 'web.example.com', {
        secretRef: 'secret-web',
      } as Partial<HostRecord>),
      sshHost('host-bastion', 'bastion', 'bastion.example.com'),
    ],
    groups: [
      {
        id: 'group-lab',
        path: 'Lab',
        name: 'Lab',
        createdAt: updatedAt,
        updatedAt,
      } as GroupRecord,
    ],
    secretsByRef: { 'secret-web': secret('secret-web', 'pw') },
    knownHosts: [
      knownHost('known-web', 'web.example.com', 'ssh-ed25519', 'WEB'),
    ],
    awsProfiles: [
      {
        id: 'aws-1',
        name: 'prod',
        kind: 'sso',
        updatedAt,
      } as ManagedAwsProfilePayload,
    ],
    tailnets: [
      {
        id: 'tailnet-1',
        label: 'corp',
        createdAt: updatedAt,
        updatedAt,
      } as TailnetPayload,
    ],
    snippets: [
      {
        id: 'snippet-1',
        label: 'uptime',
        command: 'uptime',
        createdAt: updatedAt,
        updatedAt,
      } as SnippetRecord,
    ],
    teamVaults: withTeam ? [teamVault()] : [],
    teamSecrets: withTeam
      ? {
          'team-1': {
            secretsByRef: {
              'secret-team-app': secret('secret-team-app', 'team-pw'),
            },
            hostCredentials: {},
          },
        }
      : {},
  };
}

describe('vault-catalog', () => {
  it('볼트가 개인 하나뿐이면 개인 것을 그대로 돌려준다', () => {
    const source = vaults(false);

    expect(listHosts(source)).toBe(source.hosts);
    expect(hostsInVaultOf(source, 'host-web')).toBe(source.hosts);
    expect(knownHostsForHost(source, 'host-web')).toBe(source.knownHosts);
    expect(personalKnownHosts(source)).toBe(source.knownHosts);
    expect(awsProfilesForHost(source, 'host-web')).toBe(source.awsProfiles);
    expect(tailnetsForHost(source, 'host-web')).toBe(source.tailnets);
    expect(snippetsForHost(source, 'host-web')).toBe(source.snippets);
  });

  it('개인 호스트와 비밀값을 id 로 찾는다', () => {
    const source = vaults();

    expect(findHost(source, 'host-bastion')).toBe(source.hosts[1]);
    expect(findPersonalHost(source, 'host-web')).toBe(source.hosts[0]);
    expect(secretForHost(source, 'host-web', 'secret-web')).toBe(
      source.secretsByRef['secret-web'],
    );
    expect(findPersonalSecret(source, 'secret-web')).toBe(
      source.secretsByRef['secret-web'],
    );
  });

  it('없는 것은 없다고 답한다', () => {
    const source = vaults();

    expect(findHost(source, 'host-gone')).toBeUndefined();
    expect(findPersonalHost(source, 'host-gone')).toBeUndefined();
    expect(secretForHost(source, 'host-web', 'secret-gone')).toBeUndefined();
    expect(findPersonalSecret(source, 'secret-gone')).toBeUndefined();
  });

  it('팀 호스트도 찾지만, 개인 편집 도우미는 팀 호스트를 못 찾는다', () => {
    const source = vaults();

    expect(findHost(source, 'team-app')).toMatchObject({
      id: 'team-app',
      hostname: 'app.internal',
    });
    expect(findPersonalHost(source, 'team-app')).toBeUndefined();
  });

  it('팀 호스트가 쓰는 것은 그 팀 볼트 안에서만 찾는다', () => {
    const source = vaults();
    const team = source.teamVaults[0];

    // 점프 사슬·tailnet 판정은 그 팀의 호스트로.
    expect(hostsInVaultOf(source, 'team-app').map(host => host.id)).toEqual(
      team.hosts.map(host => host.id),
    );
    expect(
      hostsInVaultOf(source, 'team-app').some(
        host => host.id === 'host-bastion',
      ),
    ).toBe(false);
    // 비밀값은 그 팀 것 — 같은 ref 라도 개인 것을 넘보지 않는다.
    expect(secretForHost(source, 'team-app', 'secret-team-app')?.password).toBe(
      'team-pw',
    );
    expect(secretForHost(source, 'team-app', 'secret-web')).toBeUndefined();
    expect(
      secretForHost(source, 'host-web', 'secret-team-app'),
    ).toBeUndefined();
    expect(awsProfilesForHost(source, 'team-app')).toBe(team.awsProfiles);
    expect(tailnetsForHost(source, 'team-app')).toBe(team.tailnets);
    expect(snippetsForHost(source, 'team-app')).toBe(team.snippets);
    // 개인 호스트는 개인 것 그대로.
    expect(awsProfilesForHost(source, 'host-web')).toBe(source.awsProfiles);
  });

  it('팀 호스트의 호스트 키는 내가 신뢰한 것이 먼저고, 같은 자리의 팀 것은 뺀다', () => {
    const source = vaults();

    expect(
      knownHostsForHost(source, 'team-app').map(
        record => record.publicKeyBase64,
      ),
    ).toEqual(['MINE-ED', 'TEAM-ECDSA']);
    expect(knownHostsForHost(source, 'host-web')).toBe(source.knownHosts);
  });

  it('id 가 겹치면 개인이 이긴다', () => {
    const source = vaults();
    const shadow = sshHost('team-app', 'mine', 'mine.example.com');
    source.hosts = [...source.hosts, shadow];

    expect(findHost(source, 'team-app')).toBe(shadow);
    expect(hostsInVaultOf(source, 'team-app')).toBe(source.hosts);
  });

  it('섞인 목록은 개인 것 다음에 팀 것이고, 팀 호스트의 별표는 내 개인 칸의 것이다', () => {
    const source = vaults();
    const team = source.teamVaults[0];

    const listed = listHosts(source);
    expect(listed.map(host => host.id)).toEqual([
      'host-web',
      'host-bastion',
      'team-app',
      'team-bastion',
    ]);
    expect(listed[2].favorite).toBe(true);
    expect(listed[3].favorite).toBeUndefined();
    // 팀 레코드 자체는 그대로다 — 별표를 팀 것에 써 넣지 않는다. 찾기도 같은(내 값을 얹은) 것을 준다.
    expect(team.hosts[0].favorite).toBeUndefined();
    expect(findHost(source, 'team-app')).toBe(listed[2]);
  });

  it('팀 호스트에는 내 값을 얹는다 — 별표·SSH 사용자 이름·인증 방식·RDP 인증서 지문', () => {
    const source = vaults();
    const team = source.teamVaults[0];
    team.hosts = [
      ...team.hosts,
      {
        id: 'team-rdp',
        kind: 'rdp',
        label: 'desk',
        hostname: 'desk.internal',
        port: 3389,
        certificateFingerprint: 'TEAM-FP',
        groupName: null,
        tags: [],
        createdAt: updatedAt,
        updatedAt,
      } as unknown as HostRecord,
    ];
    team.hostPrefs = [
      ...team.hostPrefs,
      {
        id: 'team-rdp',
        favorite: null,
        agentForwarding: null,
        rdpCertificateFingerprint: 'MY-FP',
        knownHosts: [],
        updatedAt,
      },
    ];
    source.teamSecrets['team-1'].hostCredentials = {
      'team-app': { username: 'me', authType: 'privateKey' },
      'team-bastion': { password: 'only-a-password' },
    };

    expect(findHost(source, 'team-app')).toMatchObject({
      username: 'me',
      authType: 'privateKey',
      favorite: true,
    });
    // 사용자 이름을 안 둔 호스트는 팀 것 그대로다.
    expect(findHost(source, 'team-bastion')).toBe(team.hosts[1]);
    expect(findHost(source, 'team-rdp')).toMatchObject({
      certificateFingerprint: 'MY-FP',
    });
    // 점프 사슬도 내 값을 얹은 홉을 본다.
    expect(
      hostsInVaultOf(source, 'team-bastion').find(
        host => host.id === 'team-app',
      ),
    ).toMatchObject({ username: 'me' });
    // 팀 레코드는 그대로다.
    expect(team.hosts[0]).toMatchObject({
      username: 'deploy',
      authType: 'password',
    });
    expect(team.hosts[2]).toMatchObject({ certificateFingerprint: 'TEAM-FP' });
  });

  it('붙을 때 쓸 비밀값은 내 것이 먼저이고 비운 칸은 팀 것이다 — 개인 호스트는 그대로', () => {
    const source = vaults();
    const teamApp = findHost(source, 'team-app')!;

    expect(connectSecretForHost(source, teamApp)?.password).toBe('team-pw');

    source.teamSecrets['team-1'].hostCredentials = {
      'team-app': { username: 'me', password: 'my-pw' },
    };
    expect(connectSecretForHost(source, teamApp)).toMatchObject({
      username: 'me',
      password: 'my-pw',
    });

    source.teamSecrets['team-1'].hostCredentials = {
      'team-app': { username: 'me' },
    };
    expect(connectSecretForHost(source, teamApp)).toMatchObject({
      username: 'me',
      password: 'team-pw',
    });

    // 팀 비밀값이 없는 호스트도 내 자격 증명으로 붙는다.
    source.teamSecrets['team-1'].hostCredentials = {
      'team-bastion': { password: 'mine-only' },
    };
    expect(
      connectSecretForHost(source, findHost(source, 'team-bastion')!)?.password,
    ).toBe('mine-only');

    const web = findHost(source, 'host-web')!;
    expect(connectSecretForHost(source, web)).toBe(
      source.secretsByRef['secret-web'],
    );
  });

  it('내 개인 칸 쓰기가 쓰는 팀 id·내 자격 증명 — 개인 호스트는 없다', () => {
    const source = vaults();
    source.teamSecrets['team-1'].hostCredentials = {
      'team-app': { username: 'me' },
    };

    expect(teamIdOfHost(source, 'team-app')).toBe('team-1');
    expect(myCredentialsForHost(source, 'team-app')).toEqual({
      username: 'me',
    });
    expect(teamIdOfHost(source, 'host-web')).toBeUndefined();
    expect(myCredentialsForHost(source, 'host-web')).toBeUndefined();
  });

  it('신뢰한 호스트 키는 같은 자리의 내 것을 갈아 끼우고 id·처음 본 때를 이어 쓴다', () => {
    const old = {
      ...knownHost('known-mine-ed', 'app.internal', 'ssh-ed25519', 'OLD'),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const other = knownHost('known-mine-rsa', 'app.internal', 'ssh-rsa', 'RSA');
    const fresh = {
      ...knownHost('known-new', 'app.internal', 'ssh-ed25519', 'NEW'),
      createdAt: '2026-10-27T09:00:00.000Z',
    };

    expect(withTrustedKnownHost([old, other], fresh)).toEqual([
      other,
      { ...fresh, id: 'known-mine-ed', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    // 다른 tailnet 의 같은 주소는 다른 자리다.
    const viaTailnet = { ...fresh, tailnetId: 'tailnet-1' };
    expect(withTrustedKnownHost([old], viaTailnet)).toEqual([old, viaTailnet]);
    expect(withTrustedKnownHost([], fresh)).toEqual([fresh]);
  });

  it('세션 자동 완성 스니펫은 그 세션 호스트의 볼트 것이 먼저다', () => {
    const lone = vaults(false);
    expect(snippetsForSession(lone, 'host-web')).toBe(lone.snippets);

    const source = vaults();
    expect(
      snippetsForSession(source, 'team-app').map(snippet => snippet.id),
    ).toEqual(['snippet-team', 'snippet-1']);
    expect(
      snippetsForSession(source, 'host-web').map(snippet => snippet.id),
    ).toEqual(['snippet-1', 'snippet-team']);
    expect(snippetsForSession(source, null).map(snippet => snippet.id)).toEqual(
      ['snippet-1', 'snippet-team'],
    );
    // 고르기로 쓰므로 같은 입력이면 같은 배열이다.
    expect(snippetsForSession(source, 'team-app')).toBe(
      snippetsForSession(source, 'team-app'),
    );
  });

  it('볼트 목록은 개인 먼저, 팀은 받은 순서대로 그 팀의 그룹·호스트만 든다', () => {
    const lone = vaults(false);
    expect(listVaults(lone)).toEqual([
      {
        id: null,
        name: null,
        blocked: null,
        groups: lone.groups,
        hosts: lone.hosts,
      },
    ]);

    const source = vaults();
    const team = source.teamVaults[0];
    const [personal, teamView] = listVaults(source);
    expect(personal.hosts).toBe(source.hosts);
    expect(personal.groups).toBe(source.groups);
    expect(teamView).toMatchObject({
      id: 'team-1',
      name: 'Acme Infra',
      blocked: null,
    });
    expect(teamView.groups).toBe(team.groups);
    // 볼트 안에서도 별표는 내 것 — 섞인 목록과 같은 호스트 객체다.
    expect(teamView.hosts[0].favorite).toBe(true);
    expect(teamView.hosts[0]).toBe(listHosts(source)[2]);
  });

  it('막힌 팀(다시 들어와야 함·업데이트 필요)만 막혔다고 하고, 지나가는 오류는 아니다', () => {
    const source = vaults();
    const states = ['needs-rejoin', 'outdated', 'error', 'ready'] as const;
    source.teamVaults = states.map((state, index) => ({
      ...teamVault(),
      id: `team-${index}`,
      hosts: [],
      state,
    }));

    expect(listVaults(source).map(vault => vault.blocked)).toEqual([
      null,
      'needs-rejoin',
      'outdated',
      null,
      null,
    ]);
  });

  it('팀 호스트에만 그 팀 이름이 있고, id 가 겹친 것은 개인이 이긴다', () => {
    const source = vaults();
    expect([...teamNamesByHostId(source)]).toEqual([
      ['team-app', 'Acme Infra'],
      ['team-bastion', 'Acme Infra'],
    ]);

    const shadowed = vaults();
    shadowed.hosts = [
      ...shadowed.hosts,
      sshHost('team-app', 'mine', 'mine.example.com'),
    ];
    expect(teamNamesByHostId(shadowed).has('team-app')).toBe(false);
    expect(teamNamesByHostId(vaults(false)).size).toBe(0);
  });

  // zustand 5 는 고르기가 매번 새 배열을 주면 화면을 끝없이 다시 그린다. 화면은 이것들을 고르기로 쓴다.
  it('화면 고르기로 써도 같은 입력이면 같은 것이다', () => {
    const source = vaults();

    expect(listHosts(source)).toBe(listHosts(source));
    expect(listVaults(source)).toBe(listVaults(source));
    expect(teamNamesByHostId(source)).toBe(teamNamesByHostId(source));
    expect(findHost(source, 'team-app')).toBe(findHost(source, 'team-app'));

    // 내 자격 증명이 바뀌면(새 객체) 다시 만든다.
    const withCredentials = {
      ...source,
      teamSecrets: {
        'team-1': {
          ...source.teamSecrets['team-1'],
          hostCredentials: { 'team-app': { username: 'me' } },
        },
      },
    };
    expect(listHosts(withCredentials)).not.toBe(listHosts(source));
    expect(listHosts(withCredentials)[2]).toMatchObject({ username: 'me' });

    // 개인 목록만 바뀌면 새 목록이지만, 팀 호스트(별표를 얹은 것)는 그대로다.
    const before = listHosts(source);
    const next = { ...source, hosts: [...source.hosts] };
    const after = listHosts(next);
    expect(after).not.toBe(before);
    expect(after[2]).toBe(before[2]);
    expect(listVaults(next)).not.toBe(listVaults(source));
  });
});

// ── 이 기기의 팀 AWS 키(작업 8-4b) ──────────────────────────────────────────────
describe('vault-catalog — 팀 AWS 키', () => {
  const MINE = { accessKeyId: 'AKIAMINE', secretAccessKey: 'mine-secret' };

  function ec2(id: string, awsProfileId: string): HostRecord {
    return {
      id,
      kind: 'aws-ec2',
      label: id,
      awsProfileId,
      awsProfileName: awsProfileId,
      awsRegion: 'ap-northeast-2',
      awsInstanceId: `i-${id}`,
      createdAt: updatedAt,
      updatedAt,
    } as HostRecord;
  }

  /** 팀 정적 프로필 하나와 그것을 원본으로 쓰는 role, SSO 하나 — 팀 레코드에는 키가 없다(받을 때 뺀다). */
  function awsSource(): VaultCatalogSource {
    const source = vaults();
    const team = source.teamVaults[0];
    team.awsProfiles = [
      {
        id: 'aws-static',
        name: 'acme-static',
        kind: 'static',
        region: 'ap-northeast-2',
        accessKeyId: '',
        secretAccessKey: '',
        updatedAt,
      },
      {
        id: 'aws-role',
        name: 'acme-admin',
        kind: 'role',
        sourceProfileId: 'aws-static',
        roleArn: 'arn:aws:iam::111111111111:role/admin',
        updatedAt,
      },
      {
        id: 'aws-team',
        name: 'acme',
        kind: 'sso',
        updatedAt,
      } as ManagedAwsProfilePayload,
    ];
    team.hosts = [
      ...team.hosts,
      ec2('team-ec2', 'aws-static'),
      ec2('team-ec2-role', 'aws-role'),
      ec2('team-ec2-sso', 'aws-team'),
      {
        id: 'team-rdp',
        kind: 'rdp',
        label: 'win',
        hostname: '10.0.0.5',
        port: 3389,
        // id 없이 이름만 둔 옛 레코드 — 이름으로 찾는다.
        awsSsm: {
          profileName: 'acme-static',
          region: 'ap-northeast-2',
          instanceId: 'i-win',
        },
        createdAt: updatedAt,
        updatedAt,
      } as HostRecord,
    ];
    source.hosts = [...source.hosts, ec2('host-ec2', 'aws-1')];
    return source;
  }

  it('이 기기에 키가 없는 팀 정적 프로필을 가린다 — role 은 그 원본, SSM 원격 데스크톱은 그 터널의 프로필', () => {
    const source = awsSource();
    const missing = {
      teamId: 'team-1',
      teamName: 'Acme Infra',
      profileId: 'aws-static',
      profileName: 'acme-static',
      region: 'ap-northeast-2',
    };
    expect(teamAwsKeyMissing(source, 'team-ec2')).toEqual(missing);
    expect(teamAwsKeyMissing(source, 'team-ec2-role')).toEqual(missing);
    expect(teamAwsKeyMissing(source, 'team-rdp')).toEqual(missing);
    // SSO 는 넣을 키가 없다. 개인 호스트와 AWS 를 안 쓰는 팀 호스트도 해당이 없다.
    expect(teamAwsKeyMissing(source, 'team-ec2-sso')).toBeNull();
    expect(teamAwsKeyMissing(source, 'host-ec2')).toBeNull();
    expect(teamAwsKeyMissing(source, 'team-app')).toBeNull();

    source.teamSecrets['team-1'].awsKeys = { 'aws-static': MINE };
    expect(teamAwsKeyMissing(source, 'team-ec2')).toBeNull();
    expect(teamAwsKeyMissing(source, 'team-ec2-role')).toBeNull();
    expect(teamAwsKeyMissing(source, 'team-rdp')).toBeNull();
  });

  it('팀 정적 프로필에는 이 기기의 키를 얹어 준다 — 팀 레코드와 다른 종류, 개인 것은 그대로', () => {
    const source = awsSource();
    const team = source.teamVaults[0];
    expect(awsProfilesForHost(source, 'team-ec2')).toBe(team.awsProfiles);

    source.teamSecrets['team-1'].awsKeys = { 'aws-static': MINE };
    const profiles = awsProfilesForHost(source, 'team-ec2');
    expect(profiles[0]).toEqual({ ...team.awsProfiles[0], ...MINE });
    expect(profiles[1]).toBe(team.awsProfiles[1]);
    expect(profiles[2]).toBe(team.awsProfiles[2]);
    expect(team.awsProfiles[0]).toMatchObject({
      accessKeyId: '',
      secretAccessKey: '',
    });
    expect(awsProfilesForHost(source, 'host-ec2')).toBe(source.awsProfiles);
  });
});
