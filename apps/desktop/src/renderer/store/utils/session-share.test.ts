import { describe, expect, it } from "vitest";
import type { SessionShareChatMessage } from "@shared";
import {
  appendSessionShareChatNotification,
  clearSessionShareChatNotifications,
  createInactiveSessionShareState,
  dismissSessionShareChatNotification,
  normalizeSessionShareState,
} from "./session-share";

const messageA: SessionShareChatMessage = {
  id: "message-a",
  nickname: "viewer-a",
  senderRole: "viewer",
  text: "hello",
  sentAt: "2026-04-04T00:00:00.000Z",
};

const messageB: SessionShareChatMessage = {
  id: "message-b",
  nickname: "viewer-b",
  senderRole: "viewer",
  text: "world",
  sentAt: "2026-04-04T00:01:00.000Z",
};

describe("session-share utils", () => {
  it("normalizes missing share state to inactive", () => {
    expect(normalizeSessionShareState()).toEqual(createInactiveSessionShareState());
  });

  it("appends and dismisses chat notifications", () => {
    const notifications = appendSessionShareChatNotification(
      {},
      "session-1",
      messageA,
    );
    const next = appendSessionShareChatNotification(
      notifications,
      "session-1",
      messageB,
    );

    expect(next["session-1"]).toEqual([messageA, messageB]);
    expect(
      dismissSessionShareChatNotification(next, "session-1", "message-a"),
    ).toEqual({
      "session-1": [messageB],
    });
  });

  it("clears the session key when the last notification is removed", () => {
    const notifications = {
      "session-1": [messageA],
    };

    expect(
      dismissSessionShareChatNotification(
        notifications,
        "session-1",
        "message-a",
      ),
    ).toEqual({});
    expect(clearSessionShareChatNotifications(notifications, "session-1")).toEqual(
      {},
    );
  });
});
