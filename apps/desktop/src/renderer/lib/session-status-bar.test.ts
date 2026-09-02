import { describe, expect, it } from 'vitest';
import type { HostRecord, TerminalConnectionHop } from '@shared';
import {
  buildHopRows,
  resolveSessionKindChip,
  resolveStatusBarFold,
  shortenRatio,
} from './session-status-bar';

function sshHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'Prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as HostRecord;
}

function hop(
  index: number,
  label: string,
  extra: Partial<TerminalConnectionHop> = {},
): TerminalConnectionHop {
  return { index, count: 2, label, stage: 'connected', ...extra };
}

describe('접힘 단계', () => {
  it('넓으면 NET·DISK 까지 그대로 보인다', () => {
    const fold = resolveStatusBarFold(760);
    expect(fold).toEqual({
      showDisk: true,
      showNet: true,
      chipsIconOnly: false,
      shortUnits: false,
      hideLabels: false,
      showRam: true,
      showRtt: true,
    });
  });

  it('초당 값이 가장 먼저 빠진다 — 디스크, 그다음 네트워크', () => {
    const noDisk = resolveStatusBarFold(650);
    expect(noDisk.showDisk).toBe(false);
    expect(noDisk.showNet).toBe(true);
    // 칩은 아직 글자를 들고 있다.
    expect(noDisk.chipsIconOnly).toBe(false);

    const noNet = resolveStatusBarFold(560);
    expect(noNet.showNet).toBe(false);
    expect(noNet.chipsIconOnly).toBe(false);
  });

  it('그다음이 칩이다', () => {
    // 칩만 아이콘이 되고 CPU·RAM 은 그대로다.
    const fold = resolveStatusBarFold(500);
    expect(fold.chipsIconOnly).toBe(true);
    expect(fold.shortUnits).toBe(false);
    expect(fold.showRam).toBe(true);
  });

  it('다음은 단위, 그다음이 라벨이다', () => {
    expect(resolveStatusBarFold(420).shortUnits).toBe(true);
    expect(resolveStatusBarFold(420).hideLabels).toBe(false);
    expect(resolveStatusBarFold(360).hideLabels).toBe(true);
  });

  it('RAM 이 지연보다 먼저 빠지고 CPU 가 마지막까지 남는다', () => {
    const narrow = resolveStatusBarFold(300);
    expect(narrow.showRam).toBe(false);
    expect(narrow.showRtt).toBe(true);

    const narrower = resolveStatusBarFold(200);
    expect(narrower.showRam).toBe(false);
    expect(narrower.showRtt).toBe(false);
  });
});

describe('연결종류 칩', () => {
  it('평범한 SSH 는 칩을 만들지 않는다', () => {
    expect(resolveSessionKindChip({ host: sshHost() })).toBeNull();
  });

  it('컨테이너 exec 은 호스트 종류보다 앞선다', () => {
    const chip = resolveSessionKindChip({
      host: sshHost({ kind: 'aws-ec2' } as Partial<HostRecord>),
      shellKind: 'container-exec',
    });
    expect(chip?.kind).toBe('container');
  });

  // SSH over SSM 과 SSM 셸은 다른 물건이다 — 이 칩이 그것을 상시로 말하는 유일한 자리다.
  it('EC2 는 실제로 탄 전송으로 갈라 말하고, 모르면 SSM 으로만 그린다', () => {
    const ec2 = sshHost({ kind: 'aws-ec2' } as Partial<HostRecord>);
    expect(resolveSessionKindChip({ host: ec2, awsTransport: 'ssh-over-ssm' })?.kind).toBe('ssh-over-ssm');
    expect(resolveSessionKindChip({ host: ec2, awsTransport: 'ssm-shell' })?.kind).toBe('ssm-shell');
    expect(resolveSessionKindChip({ host: ec2 })?.kind).toBe('ssm');
  });

  it('AWS·Warpgate·시리얼은 각자 종류가 된다', () => {
    expect(resolveSessionKindChip({ host: sshHost({ kind: 'aws-ec2' } as Partial<HostRecord>) })?.kind).toBe('ssm');
    expect(resolveSessionKindChip({ host: sshHost({ kind: 'aws-ecs' } as Partial<HostRecord>) })?.kind).toBe('ecs');
    expect(resolveSessionKindChip({ host: sshHost({ kind: 'warpgate-ssh' } as Partial<HostRecord>) })?.kind).toBe('warpgate');
    expect(resolveSessionKindChip({ host: sshHost({ kind: 'serial' } as Partial<HostRecord>) })?.kind).toBe('serial');
  });

  it('점프는 홉을 세고 1홉이면 이름을 준다', () => {
    const chip = resolveSessionKindChip({
      host: sshHost({ jumpHostId: 'bastion' } as Partial<HostRecord>),
      hops: [
        hop(0, 'ubuntu@bastion.example.com:22', { name: 'Bastion' }),
        hop(1, 'ubuntu@10.0.3.14:22'),
      ],
    });
    expect(chip?.kind).toBe('jump');
    expect(chip?.hopCount).toBe(1);
    expect(chip?.hopName).toBe('Bastion');
  });

  it('이름이 없으면 라벨에서 호스트만 떼어 쓴다', () => {
    const chip = resolveSessionKindChip({
      host: sshHost({ jumpHostId: 'bastion' } as Partial<HostRecord>),
      hops: [hop(0, 'ubuntu@bastion.example.com:22'), hop(1, 'ubuntu@10.0.3.14:22')],
    });
    expect(chip?.hopName).toBe('bastion.example.com');
  });

  it('홉 정보가 아직 없어도 점프인 것은 안다', () => {
    // 연결 진행 이벤트가 오기 전이거나 옛 세션이면 홉이 비어 있다.
    const chip = resolveSessionKindChip({
      host: sshHost({ jumpHostId: 'bastion' } as Partial<HostRecord>),
      hops: null,
    });
    expect(chip).toEqual({ kind: 'jump', hopCount: 1, hopName: null });
  });

  it('2홉 이상이면 이름 대신 홉 수로 접는다', () => {
    const chip = resolveSessionKindChip({
      host: sshHost({ jumpHostId: 'bastion' } as Partial<HostRecord>),
      hops: [hop(0, 'a@one:22'), hop(1, 'a@two:22'), hop(2, 'a@three:22')],
    });
    expect(chip?.hopCount).toBe(2);
  });
});

describe('홉 목록', () => {
  it('순서대로 세우고 마지막을 목적지로 표시한다', () => {
    const rows = buildHopRows([
      hop(1, 'ubuntu@10.0.3.14:22'),
      hop(0, 'ubuntu@bastion:22', { name: 'Bastion' }),
    ]);
    expect(rows.map((row) => row.label)).toEqual([
      'ubuntu@bastion:22',
      'ubuntu@10.0.3.14:22',
    ]);
    expect(rows[0].name).toBe('Bastion');
    expect(rows[0].destination).toBe(false);
    expect(rows[1].destination).toBe(true);
  });

  it('실패한 홉을 구분한다', () => {
    const rows = buildHopRows([hop(0, 'a@one:22', { stage: 'failed' })]);
    expect(rows[0].failed).toBe(true);
  });

  it('없으면 빈 목록이다', () => {
    expect(buildHopRows(null)).toEqual([]);
  });
});

describe('단위 축약', () => {
  it('공백과 iB 를 줄인다', () => {
    expect(shortenRatio('1.2 / 7.7GiB')).toBe('1.2/7.7G');
    expect(shortenRatio('812 / 1024MiB')).toBe('812/1024M');
  });

  it('읽을 수 없는 값은 그대로 둔다', () => {
    expect(shortenRatio('—')).toBe('—');
  });
});
