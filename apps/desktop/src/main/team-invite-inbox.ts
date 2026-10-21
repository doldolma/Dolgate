/**
 * 브라우저의 링크 페이지가 넘긴 초대 링크를 화면이 가져갈 때까지 둔다.
 *
 * 링크는 앱이 꺼져 있을 때도 온다(처음 실행 인자·macOS open-url) — 그때는 창이 아직 없다. 화면은 받았다는
 * 신호(`teams:invite-link`)를 듣거나 켤 때 한 번 물어 가져간다. 가져가면 비운다 — 창이 여럿이어도 참여 카드는
 * 한 창에만 뜬다. 링크에는 팀 키를 여는 비밀값이 있어 메모리에만 둔다.
 */
export class TeamInviteInbox {
  private pending: string | null = null;
  private notify: () => void = () => undefined;

  /** 링크가 오면 부를 것(창에 알리고 앞으로 가져온다). */
  setNotifier(notify: () => void): void {
    this.notify = notify;
  }

  receive(link: string): void {
    this.pending = link;
    this.notify();
  }

  take(): string | null {
    const link = this.pending;
    this.pending = null;
    return link;
  }
}

let inbox: TeamInviteInbox | null = null;

export function getTeamInviteInbox(): TeamInviteInbox {
  inbox ??= new TeamInviteInbox();
  return inbox;
}

export function resetTeamInviteInboxForTests(): void {
  inbox = null;
}
