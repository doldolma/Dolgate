import type { RdpDriveShare } from './models';

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
