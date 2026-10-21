import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';

const NO_LISTS: Readonly<Record<string, never[]>> = Object.freeze({});

/**
 * 설정의 볼트별 묶음 — 볼트 표의 팀마다 그 팀 볼트의 목록을 읽는다(AWS Profiles·Tailscale·Saved Credentials·known
 * hosts). 개인 목록은 지금처럼 따로 온다.
 *
 * 팀이 없으면 읽지 않는다(화면도 지금 그대로). 볼트 표가 바뀌거나(팀이 생기고 빠짐·팀 동기화) reloadKey 가 바뀌면 다시
 * 읽는다 — 부르는 쪽은 쓰기 뒤에 스토어가 새로 읽는 개인 목록을 reloadKey 로 준다. 못 읽은 팀은 빈 목록이다.
 */
export function useTeamVaultLists<T>(
  load: (teamId: string) => Promise<T[]>,
  reloadKey?: unknown,
): { listsByTeamId: Readonly<Record<string, T[]>>; reload: () => Promise<void> } {
  const vaultIndex = useAppStore((state) => state.vaultIndex);
  const teamKey = (vaultIndex?.teams ?? []).map((team) => team.id).join('\n');
  const [listsByTeamId, setListsByTeamId] = useState<Readonly<Record<string, T[]>>>(NO_LISTS);
  // 부르는 쪽이 렌더마다 새 함수를 줘도 효과가 다시 돌지 않게 거울에 둔다.
  const loadRef = useRef(load);
  loadRef.current = load;
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    const teamIds = teamKey ? teamKey.split('\n') : [];
    if (teamIds.length === 0) {
      setListsByTeamId(NO_LISTS);
      return;
    }
    const entries = await Promise.all(
      teamIds.map(async (teamId) => [teamId, await loadRef.current(teamId).catch(() => [] as T[])] as const),
    );
    // 늦게 온 옛 요청이 새 결과를 덮지 않게.
    if (request === requestRef.current) {
      setListsByTeamId(Object.fromEntries(entries));
    }
  }, [teamKey]);

  useEffect(() => {
    void reload();
  }, [reload, vaultIndex, reloadKey]);

  return { listsByTeamId, reload };
}
