import { describe, expect, it } from 'vitest';
import { normalizeHostOsId, resolveHostOsMark } from '@shared';
import { HOST_OS_MARK_ART, isLetteredMark } from './lib/host-os-marks';

describe('resolveHostOsMark', () => {
  it('os-release 의 ID 를 그대로 대조한다', () => {
    // 값이 규격으로 정해져 있어(`ID=ubuntu`) 문자열을 추측하지 않는다.
    expect(resolveHostOsMark({ id: 'ubuntu' })).toBe('ubuntu');
    expect(resolveHostOsMark({ id: 'rocky' })).toBe('rocky');
    expect(resolveHostOsMark({ id: 'almalinux' })).toBe('alma');
    expect(resolveHostOsMark({ id: 'opensuse-leap' })).toBe('suse');
    // Amazon Linux 는 전용 로고가 없다. ID_LIKE 로 되돌리면 centos·fedora 로고가 붙어 다른
    // 배포판처럼 보이므로 일반 리눅스(Tux)로 그린다.
    expect(resolveHostOsMark({ id: 'amzn', like: 'centos rhel fedora' })).toBe('linux');
    expect(resolveHostOsMark({ id: 'darwin' })).toBe('macos');
  });

  it('BSD 는 os-release 든 uname 이든 같은 값으로 온다', () => {
    // FreeBSD 12+ 는 os-release 를 갖고 있고, 없는 판에서는 uname 이 `FreeBSD` 를 준다.
    expect(resolveHostOsMark({ id: 'freebsd' })).toBe('freebsd');
    expect(resolveHostOsMark({ id: 'openbsd' })).toBe('openbsd');
    expect(resolveHostOsMark({ id: 'netbsd' })).toBe('netbsd');
  });

  it('NAS·하이퍼바이저·방화벽도 자기 마크로 그린다', () => {
    // 코어가 표시 파일을 보고 이 id 로 보고한다 — os-release 는 대부분 데비안·FreeBSD 다.
    expect(resolveHostOsMark({ id: 'dsm' })).toBe('synology');
    expect(resolveHostOsMark({ id: 'qts' })).toBe('qnap');
    expect(resolveHostOsMark({ id: 'truenas' })).toBe('truenas');
    expect(resolveHostOsMark({ id: 'unraid' })).toBe('unraid');
    expect(resolveHostOsMark({ id: 'omv' })).toBe('omv');
    expect(resolveHostOsMark({ id: 'pve' })).toBe('proxmox');
    expect(resolveHostOsMark({ id: 'pfsense' })).toBe('pfsense');
    expect(resolveHostOsMark({ id: 'opnsense' })).toBe('opnsense');
    expect(resolveHostOsMark({ id: 'openwrt' })).toBe('openwrt');
    expect(resolveHostOsMark({ id: 'hassos' })).toBe('homeassistant');
    expect(resolveHostOsMark({ id: 'android' })).toBe('android');
    // ESXi 는 uname 이 커널 이름을 준다.
    expect(resolveHostOsMark({ id: 'vmkernel' })).toBe('esxi');
  });

  it('데비안 기반 어플라이언스가 데비안으로 보이지 않는다', () => {
    // 코어가 표시 파일을 os-release 위에 덮으므로 여기 오는 id 는 이미 pve·truenas 다.
    // 혹시 like 만 오면 데비안으로 되돌아가는 것이 맞다(그게 아는 전부다).
    expect(resolveHostOsMark({ id: 'pve', like: 'debian' })).toBe('proxmox');
    expect(resolveHostOsMark({ id: 'raspbian', like: 'debian' })).toBe('raspbian');
  });

  it('마크가 없는 OS 는 글자 뱃지로 남는다', () => {
    expect(resolveHostOsMark({ id: 'windows' })).toBeNull();
    expect(resolveHostOsMark({ id: 'sunos' })).toBeNull();
    expect(resolveHostOsMark({ id: 'aix' })).toBeNull();
  });

  it('모르는 배포판은 ID_LIKE 의 부모로 되돌린다', () => {
    // Linux Mint 처럼 우리가 모르는 파생판도 부모 로고로 그린다.
    expect(resolveHostOsMark({ id: 'zorin', like: 'ubuntu debian' })).toBe('ubuntu');
    expect(resolveHostOsMark({ id: 'endeavouros', like: 'arch' })).toBe('arch');
  });

  it('가까운 부모가 먼저다', () => {
    // ID_LIKE 는 가까운 순으로 오는 것이 규격의 관례다.
    expect(resolveHostOsMark({ id: 'unknown', like: 'ubuntu debian' })).toBe('ubuntu');
    expect(resolveHostOsMark({ id: 'unknown', like: 'debian ubuntu' })).toBe('debian');
  });

  it('아는 것이 없으면 null — 그때 앱은 예전처럼 그린다', () => {
    expect(resolveHostOsMark({ id: 'plan9' })).toBeNull();
    expect(resolveHostOsMark({ id: 'plan9', like: 'inferno' })).toBeNull();
    expect(resolveHostOsMark(null)).toBeNull();
    expect(resolveHostOsMark(undefined)).toBeNull();
  });

  it('대소문자와 공백을 가리지 않는다', () => {
    // uname 은 `Darwin`, `FreeBSD` 처럼 대문자를 준다.
    expect(resolveHostOsMark({ id: '  Ubuntu ' })).toBe('ubuntu');
    expect(normalizeHostOsId('  DEBIAN ')).toBe('debian');
    expect(normalizeHostOsId('   ')).toBeNull();
    expect(normalizeHostOsId(undefined)).toBeNull();
  });
});

// 마크와 그림은 1:1 이어야 한다. 타입(Record<HostOsMark, …>)이 빠진 것을 잡아 주지만, 경로가
// 깨진 채 생성된 것은 못 잡는다 — 그림 파일은 스크립트로 다시 뽑으므로 그 사고가 가능하다.
describe('마크 그림', () => {
  it('모든 마크가 그림이나 글자 중 하나로 그려진다', () => {
    for (const [mark, art] of Object.entries(HOST_OS_MARK_ART)) {
      expect(art.title, mark).toBeTruthy();
      expect(art.hex, mark).toMatch(/^#[0-9a-fA-F]{6}$/);
      if (isLetteredMark(art)) {
        // 정사각 뱃지에 들어가는 길이만 허용한다 — 네 글자가 한계다.
        expect(art.letters.length, mark).toBeGreaterThan(1);
        expect(art.letters.length, mark).toBeLessThanOrEqual(4);
        continue;
      }
      // simple-icons 경로는 24x24 단일 path 라 항상 이 정도 길이가 넘는다.
      expect(art.path.length, mark).toBeGreaterThan(50);
      expect(art.path, mark).toMatch(/^[Mm]/);
      // 브랜드색을 잉크로 쓸 수 있는 테마. 어느 테마에서도 못 쓰면 글자색으로만 그려진다.
      expect(['both', 'light', 'dark', 'none'], mark).toContain(art.ink);
    }
  });

  it('브랜드색 잉크는 대비가 되는 테마에만 허용된다', () => {
    // 눈으로 확인한 판정을 못 박는다 — 다시 뽑을 때 이 값이 뒤집히면 뱃지가 사라진다.
    const inkOf = (mark: string) => {
      const art = HOST_OS_MARK_ART[mark as keyof typeof HOST_OS_MARK_ART];
      return isLetteredMark(art) ? 'letters' : art.ink;
    };
    // 노란 Tux 는 라이트에서, 검은 Apple 은 다크에서 브랜드색을 쓸 수 없다.
    expect(inkOf('linux')).toBe('dark');
    expect(inkOf('macos')).toBe('light');
    expect(inkOf('ubuntu')).toBe('both');
    // 워드마크는 색과 무관하게 글자로 그린다.
    expect(inkOf('synology')).toBe('letters');
  });

  it('감지되는 id 는 모두 그림까지 닿는다', () => {
    // 코어가 실제로 보고하는 값들. 하나라도 그림에 못 닿으면 그 호스트는 글자로 남는다.
    const reported = [
      'ubuntu', 'debian', 'fedora', 'rhel', 'centos', 'rocky', 'almalinux',
      'opensuse-leap', 'sles', 'arch', 'manjaro', 'alpine', 'linuxmint', 'pop',
      'elementary', 'kali', 'gentoo', 'nixos', 'void', 'raspbian', 'amzn',
      'darwin', 'freebsd', 'openbsd', 'netbsd',
      'dsm', 'qts', 'truenas', 'unraid', 'omv', 'pve', 'pfsense', 'opnsense',
      'vmkernel', 'openwrt', 'hassos', 'android',
    ];
    for (const id of reported) {
      const mark = resolveHostOsMark({ id });
      expect(mark, id).not.toBeNull();
      expect(HOST_OS_MARK_ART[mark!], id).toBeTruthy();
    }
  });
});
