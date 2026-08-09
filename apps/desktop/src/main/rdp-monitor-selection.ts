import type { RdpMonitorSelection } from "@shared";

/** 대조에 필요한 만큼만 추린 로컬 디스플레이. Electron 의 `Display` 가 이 모양을 만족한다. */
export interface LocalDisplay {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * 저장해 둔 선택을 지금 붙어 있는 디스플레이에 맞춘다.
 *
 * id 를 먼저 보고, 못 찾으면 이름과 크기로 한 번 더 찾는다. 재부팅하거나 케이블을 다시 꽂으면
 * OS 가 주는 id 가 바뀌기 때문이다 — mstsc 의 selectedmonitors 가 재부팅 뒤 엉뚱한 화면을
 * 잡는 것이 이 대조를 안 해서다.
 *
 * 하나도 못 찾으면 빈 배열을 준다. 호출부가 "선택이 지금 환경과 안 맞는다"로 판단해 기본 동작으로
 * 되돌리게 하기 위해서다 — 임의의 화면을 골라 주면 사용자는 왜 그 화면이 떴는지 알 수 없다.
 *
 * 결과는 저장된 순서가 아니라 **디스플레이 배치 순서**를 따른다. 선언 순서가 원격의 모니터
 * 번호가 되므로, 저장 시점의 순서를 그대로 쓰면 화면을 재배치했을 때 번호가 뒤엉킨다.
 */
export function resolveSelectedDisplays(
  displays: readonly LocalDisplay[],
  selection: readonly RdpMonitorSelection[] | null | undefined,
): LocalDisplay[] {
  if (!selection || selection.length === 0) {
    return [];
  }

  const remaining = [...displays];
  const matched: LocalDisplay[] = [];

  const take = (predicate: (display: LocalDisplay) => boolean): boolean => {
    const index = remaining.findIndex(predicate);
    if (index < 0) {
      return false;
    }
    matched.push(remaining[index]);
    remaining.splice(index, 1);
    return true;
  };

  // id 대조를 전부 끝낸 뒤에 이름 대조로 넘어간다. 섞어서 하면 같은 모델 두 대를 쓸 때 이름
  // 대조가 다른 항목의 id 짝을 먼저 채가, 정작 id 가 맞는 항목이 빈손이 된다.
  const unmatchedById = selection.filter(
    (wanted) => !take((display) => display.id === wanted.id),
  );

  for (const wanted of unmatchedById) {
    take(
      (display) =>
        display.label === wanted.label &&
        display.bounds.width === wanted.width &&
        display.bounds.height === wanted.height,
    );
  }

  // 배치 순서로 되돌린다(위→아래, 왼→오른). 원격 모니터 번호가 여기서 정해진다.
  return matched.sort(
    (a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x,
  );
}

/** 지금 붙어 있는 디스플레이를 호스트에 저장할 형태로 바꾼다. */
export function describeSelection(
  displays: readonly LocalDisplay[],
): RdpMonitorSelection[] {
  return displays.map((display) => ({
    id: display.id,
    label: display.label,
    width: display.bounds.width,
    height: display.bounds.height,
  }));
}
