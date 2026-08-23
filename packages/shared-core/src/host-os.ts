// 호스트의 운영체제를 아이콘 하나로 되돌리는 판정.
//
// 값은 연결할 때 셸에서 읽어 온다(`/etc/os-release` 의 ID·ID_LIKE, macOS 는 uname/sw_vers).
// 데스크톱과 모바일이 같은 답을 봐야 하므로 판정은 여기 두고, 그림은 각 앱이 그린다 —
// shared-core 는 UI 자산을 갖지 않는다.

/**
 * 호스트 레코드에 저장하는 감지 결과.
 *
 * 폼에서 입력하는 값이 아니다 — 연결할 때 셸에서 읽어 좁은 setter 로 쓴다(favorite 과 같은 결).
 */
export interface HostDetectedOs {
  /** os-release 의 `ID` (`ubuntu`) 또는 커널 이름(`darwin`). 소문자. */
  id: string;
  /** os-release 의 `ID_LIKE`. 모르는 파생 배포판을 부모로 되돌릴 때 쓴다. */
  like?: string | null;
  /** 사람이 읽는 이름(`Ubuntu 20.04.6 LTS`). 툴팁·상세에 쓴다. */
  prettyName?: string | null;
}

/** 아이콘이 있는 표시 대상. 앱이 이 값으로 자기 자산을 고른다. */
export type HostOsMark =
  | 'ubuntu'
  | 'debian'
  | 'fedora'
  | 'rhel'
  | 'centos'
  | 'rocky'
  | 'alma'
  | 'suse'
  | 'arch'
  | 'manjaro'
  | 'alpine'
  | 'mint'
  | 'pop'
  | 'elementary'
  | 'kali'
  | 'gentoo'
  | 'nixos'
  | 'void'
  | 'raspbian'
  | 'linux'
  | 'freebsd'
  | 'openbsd'
  | 'netbsd'
  | 'macos'
  // NAS·하이퍼바이저·방화벽. 대부분 os-release 가 데비안·FreeBSD 라 표시 파일로 갈라야 한다.
  | 'synology'
  | 'qnap'
  | 'truenas'
  | 'unraid'
  | 'omv'
  | 'proxmox'
  | 'pfsense'
  | 'opnsense'
  | 'esxi'
  | 'openwrt'
  | 'homeassistant'
  | 'android';

/**
 * os-release 의 `ID` → 아이콘.
 *
 * 값이 규격으로 정해져 있어(`ID=ubuntu`) 문자열을 추측하지 않는다. 여기 없는 배포판은
 * `ID_LIKE` 로 한 번 더 시도하고, 그래도 없으면 null 이다 — 그때 앱은 예전처럼 그린다.
 */
const BY_ID: Record<string, HostOsMark> = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  raspbian: 'raspbian',
  fedora: 'fedora',
  rhel: 'rhel',
  redhat: 'rhel',
  'rhel-fedora': 'rhel',
  centos: 'centos',
  rocky: 'rocky',
  almalinux: 'alma',
  opensuse: 'suse',
  'opensuse-leap': 'suse',
  'opensuse-tumbleweed': 'suse',
  sles: 'suse',
  sled: 'suse',
  arch: 'arch',
  archarm: 'arch',
  manjaro: 'manjaro',
  'manjaro-arm': 'manjaro',
  alpine: 'alpine',
  linuxmint: 'mint',
  pop: 'pop',
  elementary: 'elementary',
  kali: 'kali',
  gentoo: 'gentoo',
  nixos: 'nixos',
  void: 'void',
  // Amazon Linux 는 전용 로고가 없다(simple-icons 에서 아마존 계열이 빠졌다). ID_LIKE 로 되돌리면
  // centos·fedora 로고가 붙어 다른 배포판처럼 보이므로, 일반 리눅스(Tux)로 그린다.
  amzn: 'linux',
  // BSD 계열. FreeBSD 12+ 는 os-release 를 갖고 있어 `ID=freebsd` 로 오고, 없는 판에서는
  // uname 이 준 커널 이름(`FreeBSD`)이 소문자로 와서 같은 값이 된다.
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  netbsd: 'netbsd',
  // macOS 에는 os-release 가 없어 uname 이 준 커널 이름으로 온다.
  darwin: 'macos',
  // 어플라이언스. 코어가 표시 파일을 보고 이 id 로 보고한다(os-release 가 데비안이어도).
  dsm: 'synology',
  qts: 'qnap',
  truenas: 'truenas',
  unraid: 'unraid',
  omv: 'omv',
  pve: 'proxmox',
  pfsense: 'pfsense',
  opnsense: 'opnsense',
  // ESXi 는 uname 이 커널 이름을 준다. 전용 마크가 없어 VMware 마크로 그린다.
  vmkernel: 'esxi',
  openwrt: 'openwrt',
  hassos: 'homeassistant',
  android: 'android',
  // 여기 없는 것: Windows(마크 없음)·Solaris·AIX. 글자 뱃지로 남는다.
};

/** 정규화한 OS 식별자. 저장할 때도 이 함수를 지나게 한다. */
export function normalizeHostOsId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 아이콘으로 쓸 마크. 없으면 null.
 *
 * `ID_LIKE` 는 공백으로 여러 개가 올 수 있다(`ID_LIKE="ubuntu debian"`) — 앞에서부터 아는 것을
 * 찾는다. 가까운 부모가 먼저 오는 것이 규격의 관례다.
 */
export function resolveHostOsMark(
  detected: HostDetectedOs | null | undefined,
): HostOsMark | null {
  const id = normalizeHostOsId(detected?.id);
  if (id && BY_ID[id]) {
    return BY_ID[id];
  }
  const like = normalizeHostOsId(detected?.like);
  if (!like) {
    return null;
  }
  for (const parent of like.split(/\s+/)) {
    const mark = BY_ID[parent];
    if (mark) {
      return mark;
    }
  }
  return null;
}
