// Mock react-native before importing the client.
const mockModule = {
  isAvailable: jest.fn(
    async (protocol: string) => protocol === "vnc" || protocol === "rdp",
  ),
  connect: jest.fn(async () => undefined),
  disconnect: jest.fn(async () => undefined),
  setActive: jest.fn(async () => undefined),
  setOrientationUnlocked: jest.fn(async () => undefined),
  pointerMove: jest.fn(async () => undefined),
  pointerButton: jest.fn(async () => undefined),
  scroll: jest.fn(async () => undefined),
  keyEvent: jest.fn(async () => undefined),
  unicodeEvent: jest.fn(async () => undefined),
  trustCertificate: jest.fn(async () => undefined),
  sendClipboard: jest.fn(async () => undefined),
  refresh: jest.fn(async () => undefined),
  resize: jest.fn(async () => undefined),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

const mockSubscriptionRemove = jest.fn();
const mockEmitterAddListener = jest.fn(() => ({
  remove: mockSubscriptionRemove,
}));

function emitNativeEvent(raw: Record<string, unknown>): void {
  const calls = mockEmitterAddListener.mock.calls as unknown as Array<
    [string, (event: Record<string, unknown>) => void]
  >;
  const callback = calls[0]?.[1];
  if (!callback) throw new Error("Native event listener was not registered");
  callback(raw);
}

jest.mock("react-native", () => ({
  NativeModules: {
    RemoteDesktopSessionModule: mockModule,
  },
  NativeEventEmitter: jest.fn(() => ({
    addListener: mockEmitterAddListener,
  })),
}));

import {
  isNativeSessionAvailable,
  nativeConnect,
  nativeDisconnect,
  nativeSetActive,
  setOrientationUnlocked,
  nativePointerMove,
  nativePointerButton,
  nativeScroll,
  nativeKeyEvent,
  nativeUnicodeEvent,
  nativeTrustCertificate,
  nativeSendClipboard,
  nativeRefresh,
  nativeResize,
  subscribeToSessionEvents,
  _resetEmitterForTests,
} from "../NativeSessionClient";
import { NativeModules } from "react-native";

describe("NativeSessionClient", () => {
  beforeEach(() => {
    _resetEmitterForTests();
    jest.clearAllMocks();
    (NativeModules as any).RemoteDesktopSessionModule = mockModule;
  });

  describe("isNativeSessionAvailable", () => {
    it.each(["vnc", "rdp"] as const)(
      "returns true for linked %s support",
      async (protocol) => {
        await expect(isNativeSessionAvailable(protocol)).resolves.toBe(true);
        expect(mockModule.isAvailable).toHaveBeenCalledWith(protocol);
      },
    );

    it("returns false when the module is absent", async () => {
      (NativeModules as any).RemoteDesktopSessionModule = undefined;
      await expect(isNativeSessionAvailable("rdp")).resolves.toBe(false);
    });
  });

  describe("nativeConnect", () => {
    it("passes VNC options unchanged", async () => {
      const options = {
        protocol: "vnc" as const,
        host: "192.168.1.10",
        port: 5900,
        password: "secret",
        viewOnly: true,
        shared: true,
      };
      await nativeConnect("session-1", options);
      expect(mockModule.connect).toHaveBeenCalledWith("session-1", options);
    });

    it("keeps the RDP logical host separate from a tunnel endpoint", async () => {
      const options = {
        protocol: "rdp" as const,
        host: "windows.internal",
        dialAddress: "127.0.0.1",
        tunnelAuthToken: "ab".repeat(32),
        port: 49152,
        username: "alice",
        domain: "CORP",
        password: "secret",
        audioEnabled: true,
        clipboardEnabled: true,
        colorDepth: 32 as const,
        drives: [{ path: "/tmp/share", readOnly: true }],
      };
      await nativeConnect("session-rdp", options);
      expect(mockModule.connect).toHaveBeenCalledWith("session-rdp", options);
    });

    it("throws when the module is unavailable", async () => {
      (NativeModules as any).RemoteDesktopSessionModule = undefined;
      await expect(
        nativeConnect("session-1", {
          protocol: "vnc",
          host: "localhost",
          port: 5900,
        }),
      ).rejects.toThrow("not available");
    });
  });

  it("forwards disconnect, active state, and orientation policy", async () => {
    await nativeDisconnect("session-1");
    await nativeSetActive("session-1", true);
    await setOrientationUnlocked(true);
    expect(mockModule.disconnect).toHaveBeenCalledWith("session-1");
    expect(mockModule.setActive).toHaveBeenCalledWith("session-1", true);
    expect(mockModule.setOrientationUnlocked).toHaveBeenCalledWith(true);
  });

  describe("input and control events", () => {
    it("sends pointer, wheel, VNC key, and RDP scancode events", () => {
      nativePointerMove("s1", 100, 200);
      nativePointerButton("s1", 0, true, 100, 200);
      nativeScroll("s1", true, -3, 100, 200);
      nativeKeyEvent("s1", 0xff1b, true);
      nativeKeyEvent("s2", 0, true, 0xe04b);

      expect(mockModule.pointerMove).toHaveBeenCalledWith("s1", 100, 200);
      expect(mockModule.pointerButton).toHaveBeenCalledWith(
        "s1",
        0,
        true,
        100,
        200,
      );
      expect(mockModule.scroll).toHaveBeenCalledWith("s1", true, -3, 100, 200);
      expect(mockModule.keyEvent).toHaveBeenNthCalledWith(
        1,
        "s1",
        0xff1b,
        true,
        0,
      );
      expect(mockModule.keyEvent).toHaveBeenNthCalledWith(
        2,
        "s2",
        0,
        true,
        0xe04b,
      );
    });

    it("sends RDP Unicode and certificate verdicts", async () => {
      nativeUnicodeEvent("s1", 0x1f642, true);
      nativeUnicodeEvent("s1", 0x1f642, false);
      await nativeTrustCertificate("s1", true);

      expect(mockModule.unicodeEvent).toHaveBeenNthCalledWith(
        1,
        "s1",
        0x1f642,
        true,
      );
      expect(mockModule.unicodeEvent).toHaveBeenNthCalledWith(
        2,
        "s1",
        0x1f642,
        false,
      );
      expect(mockModule.trustCertificate).toHaveBeenCalledWith("s1", true);
    });

    it("sends clipboard, refresh, and resize controls", async () => {
      await nativeSendClipboard("s1", "hello");
      await nativeRefresh("s1");
      await nativeResize("s1", 1920, 1080);
      expect(mockModule.sendClipboard).toHaveBeenCalledWith("s1", "hello");
      expect(mockModule.refresh).toHaveBeenCalledWith("s1");
      expect(mockModule.resize).toHaveBeenCalledWith("s1", 1920, 1080);
    });
  });

  describe("subscribeToSessionEvents", () => {
    it("subscribes and removes the native listener", () => {
      const unsubscribe = subscribeToSessionEvents(jest.fn());
      expect(unsubscribe).not.toBeNull();
      unsubscribe!();
      expect(mockSubscriptionRemove).toHaveBeenCalled();
    });

    it("returns null when the module is unavailable", () => {
      (NativeModules as any).RemoteDesktopSessionModule = undefined;
      _resetEmitterForTests();
      expect(subscribeToSessionEvents(jest.fn())).toBeNull();
    });

    it("normalizes a connected status payload", () => {
      const listener = jest.fn();
      subscribeToSessionEvents(listener);
      emitNativeEvent({
        sessionId: "s1",
        status: "connected",
        desktopWidth: 1920,
        desktopHeight: 1080,
        desktopName: "RDP",
      });

      expect(listener).toHaveBeenCalledWith({
        sessionId: "s1",
        type: "status",
        status: "connected",
        width: 1920,
        height: 1080,
        name: "RDP",
      });
    });

    it("normalizes certificate prompts without credentials or pixels", () => {
      const listener = jest.fn();
      subscribeToSessionEvents(listener);
      emitNativeEvent({
        sessionId: "s1",
        event: "certificate",
        fingerprint: "SHA256:abc",
        subject: "CN=windows.internal",
        issuer: "CN=windows.internal",
        notAfter: "2030-01-01T00:00:00Z",
      });

      expect(listener).toHaveBeenCalledWith({
        sessionId: "s1",
        type: "certificate",
        fingerprint: "SHA256:abc",
        subject: "CN=windows.internal",
        issuer: "CN=windows.internal",
        notAfter: "2030-01-01T00:00:00Z",
      });
    });

    it("normalizes resize, error, and close details", () => {
      const listener = jest.fn();
      subscribeToSessionEvents(listener);
      emitNativeEvent({
        sessionId: "s1",
        event: "resized",
        desktopWidth: 1280,
        desktopHeight: 720,
      });
      emitNativeEvent({
        sessionId: "s1",
        event: "error",
        message: "network lost",
      });
      emitNativeEvent({
        sessionId: "s1",
        event: "closed",
        graceful: true,
        reason: "user",
      });

      expect(listener).toHaveBeenNthCalledWith(1, {
        sessionId: "s1",
        type: "resize",
        width: 1280,
        height: 720,
      });
      expect(listener).toHaveBeenNthCalledWith(2, {
        sessionId: "s1",
        type: "error",
        message: "network lost",
      });
      expect(listener).toHaveBeenNthCalledWith(3, {
        sessionId: "s1",
        type: "closed",
        graceful: true,
        reason: "user",
      });
    });

    it("drops malformed events", () => {
      const listener = jest.fn();
      subscribeToSessionEvents(listener);
      emitNativeEvent({ event: "connected" });
      expect(listener).not.toHaveBeenCalled();
    });

    /**
     * 모르는 종류는 **버리지 않고 `unknown` 으로 올린다.** 조용히 버리면 네이티브가 새 이벤트를
     * 추가했을 때 아무 흔적이 안 남는다.
     *
     * 결코 하지 말아야 할 것은 상태 이벤트로 승격하는 것이다. 네이티브 catch-all 은 모르는
     * 통지에 `entry.status`(세션이 붙어 있으면 "connected")를 실어 보내므로, 상태로 받아들이면
     * 크기 없는 connected 가 흘러들어와 이미 알던 원격 해상도를 지운다 — RDP 클릭 좌표가
     * 어긋난 실제 원인이었다.
     */
    it("surfaces an unknown type without turning it into a status change", () => {
      const listener = jest.fn();
      subscribeToSessionEvents(listener);
      emitNativeEvent({
        sessionId: "s1",
        event: "microphoneFormat",
        status: "connected",
      });
      expect(listener).toHaveBeenCalledWith({
        sessionId: "s1",
        type: "unknown",
        rawType: "microphoneFormat",
      });
    });

    it("still treats a bare status body as a status change", () => {
      const listener = jest.fn();
      subscribeToSessionEvents(listener);
      emitNativeEvent({
        sessionId: "s1",
        status: "connected",
        desktopWidth: 1280,
        desktopHeight: 720,
      });
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          status: "connected",
          width: 1280,
          height: 720,
        }),
      );
    });
  });
});
