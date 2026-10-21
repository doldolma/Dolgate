import { describe, expect, it, vi } from "vitest";
import { TeamInviteInbox } from "./team-invite-inbox";

describe("TeamInviteInbox", () => {
  it("holds the latest link until one window takes it, telling the windows each time one arrives", () => {
    const inbox = new TeamInviteInbox();
    expect(inbox.take()).toBeNull();

    // 창이 생기기 전(앱이 링크로 켜진 순간)에 와도 잃지 않는다.
    inbox.receive("https://sync.example.com/invite/a#v1.x");
    const notify = vi.fn();
    inbox.setNotifier(notify);
    inbox.receive("https://sync.example.com/invite/b#v1.y");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(inbox.take()).toBe("https://sync.example.com/invite/b#v1.y");
    // 가져가면 비운다 — 다른 창이 또 띄우지 않는다.
    expect(inbox.take()).toBeNull();
  });
});
