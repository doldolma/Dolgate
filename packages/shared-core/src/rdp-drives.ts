import type { HostDraft, HostRecord, RdpDriveShare } from './models';

/** 이름을 못 만들었을 때 쓰는 드라이브 이름. */
const FALLBACK_DRIVE_NAME = 'Dolgate';

/** 공유 폴더 하나와, 원격에 보일 드라이브 이름. */
export interface DescribedRdpDrive {
  path: string;
  readOnly: boolean;
  /** 원격 탐색기에 뜨는 이름. 저장하지 않고 경로에서 만든다. */
  name: string;
}

/**
 * 경로의 마지막 구성요소를 뽑는다. 구분자는 `/` 와 `\` 둘 다 본다.
 *
 * 끝에 붙은 구분자는 무시한다 — `/Users/me/docs/` 도 `docs` 다.
 */
function lastSegment(path: string): string {
  const segments = path
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? '';
}

/**
 * 공유 폴더 목록에 원격에 보일 드라이브 이름을 붙인다.
 *
 * **이 규칙은 여기에만 둔다.** 편집 화면이 보여주는 이름과 코어가 원격에 알리는 이름이 서로
 * 다르면 사용자는 원격의 드라이브가 어느 폴더인지 알 수 없다. 그래서 코어는 이름을 만들지 않고
 * 여기서 만든 값을 그대로 받는다.
 *
 * - 이름은 경로의 마지막 구성요소다(`/Users/me/docs` → `docs`)
 * - 뽑을 것이 없으면(루트 등) `Dolgate`
 * - 이름이 겹치면 뒤에 ` 2`, ` 3` … 을 붙인다. 원격에서 이름이 겹치면 하나가 아예 안 보인다
 * - 경로가 빈 항목은 버린다 — 원격에 드라이브만 뜨고 모든 접근이 실패하는 것보다 낫다
 */
export function describeRdpDrives(
  drives: readonly RdpDriveShare[] | null | undefined,
): DescribedRdpDrive[] {
  const used = new Map<string, number>();
  const described: DescribedRdpDrive[] = [];

  for (const drive of drives ?? []) {
    const path = drive.path?.trim() ?? '';
    if (!path) {
      continue;
    }

    const base = lastSegment(path) || FALLBACK_DRIVE_NAME;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    described.push({
      path,
      readOnly: drive.readOnly === true,
      name: seen === 0 ? base : `${base} ${seen + 1}`,
    });
  }

  return described;
}

/**
 * 이 호스트에 붙일 공유 폴더를 정한다.
 *
 * 공유 폴더는 **기기 로컬 설정**이다(`AppSettings.rdpDrivesByHostId`) — 경로가 그 기기의 것이라
 * 동기화되는 호스트 레코드에 둘 수 없다. 자세한 이유는 그 필드 주석에.
 *
 * 레코드의 `drives` 는 폴백으로만 읽는다. 옛 빌드에서 설정해 레코드에만 값이 있는 호스트가
 * 있고, 그것까지 잃게 하지는 않는다. **기기 로컬에 항목이 생기는 순간 레코드는 안 본다** —
 * 빈 목록으로 저장한 것도 항목이므로, 이 기기에서 공유를 끈 것이 다음에 되살아나지 않는다.
 *
 * 새 값은 레코드에 쓰지 않으므로, 여기서부터 만들어진 설정은 다른 기기로 넘어가지 않는다.
 */
export function resolveHostDrives(
  hostId: string,
  drivesByHostId: Readonly<Record<string, RdpDriveShare[]>> | null | undefined,
  legacyRecordDrives: readonly RdpDriveShare[] | null | undefined,
): RdpDriveShare[] {
  const local = drivesByHostId?.[hostId];
  if (local) {
    return [...local];
  }
  return [...(legacyRecordDrives ?? [])];
}

/**
 * 저장 직전에 공유 폴더를 레코드에서 떼어 낸다.
 *
 * 레코드는 동기화되므로 경로가 실려 나가면 다른 기기에서 열 수 없는 값이 된다. 떼어 낸 목록은
 * 부르는 쪽이 저장이 끝난 뒤 기기 로컬 설정에 넣는다 — 새로 만드는 경우 호스트 id 가 저장
 * 뒤에야 나오기 때문에 두 걸음으로 나뉜다.
 *
 * RDP 가 아니면 그대로 돌려준다(`drives` 는 null).
 */
export function detachHostDrives(draft: HostDraft): {
  draft: HostDraft;
  drives: RdpDriveShare[] | null;
} {
  if (draft.kind !== 'rdp') {
    return { draft, drives: null };
  }
  return { draft: { ...draft, drives: null }, drives: draft.drives ?? [] };
}

/**
 * 기기 로컬 목록에 이 호스트의 공유 폴더를 넣은 새 맵.
 *
 * **빈 목록도 항목으로 남긴다** — 지우면 레코드에 남아 있는 옛 값이 폴백으로 되살아난다.
 */
export function withHostDrives(
  drivesByHostId: Readonly<Record<string, RdpDriveShare[]>> | null | undefined,
  hostId: string,
  drives: readonly RdpDriveShare[],
): Record<string, RdpDriveShare[]> {
  return { ...(drivesByHostId ?? {}), [hostId]: [...drives] };
}

/**
 * 호스트 목록의 공유 폴더를 이 기기의 값으로 갈아 끼운다.
 *
 * 보여주는 자리(호스트 상세·탭 말풍선)가 레코드 값을 그대로 읽으면, 연결이 실제로 붙이는 폴더와
 * 화면이 말하는 폴더가 갈린다 — 어느 폴더가 원격에 열려 있는지는 틀리면 안 되는 정보다.
 */
export function withLocalHostDrives<T extends HostRecord>(
  hosts: readonly T[],
  drivesByHostId: Readonly<Record<string, RdpDriveShare[]>> | null | undefined,
): T[] {
  return hosts.map((host) =>
    host.kind === 'rdp'
      ? { ...host, drives: resolveHostDrives(host.id, drivesByHostId, host.drives) }
      : host,
  );
}
