import { useEffect } from 'react';
import { desktopApi, useAppStore } from '../store/appStore';

/**
 * 브라우저의 링크 페이지가 앱으로 넘긴 초대 링크를 메인에서 가져온다 — 창이 뜰 때 한 번(링크로 앱이 켜진 경우),
 * 그 뒤로는 링크가 올 때마다. 로그인 전에도 가져가 기억해 두고, 참여 카드는 팀을 쓸 수 있게 되면 뜬다.
 */
export function TeamInviteBridge() {
  const takePendingInviteLink = useAppStore((state) => state.takePendingInviteLink);
  useEffect(() => {
    void takePendingInviteLink();
    return desktopApi.teams.onInviteLink(() => {
      void takePendingInviteLink();
    });
  }, [takePendingInviteLink]);
  return null;
}
