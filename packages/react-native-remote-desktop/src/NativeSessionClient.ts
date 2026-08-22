/**
 * Typed client for the native VNC/RDP session module.
 *
 * Framebuffer and audio bytes are intentionally absent from this contract. They
 * stay in the native renderer/audio path; React Native receives control events
 * only.
 */

import { NativeEventEmitter, NativeModules } from "react-native";
import type { EmitterSubscription, NativeModule } from "react-native";

export type RemoteDesktopSessionEventType =
  | "status"
  | "resize"
  | "capabilities"
  | "certificate"
  | "clipboard"
  | "error"
  | "closed"
  /**
   * A typed native event this version does not model.
   *
   * **모르는 종류를 상태 변경으로 승격하지 않기 위해 존재한다.** 예전에는 아는 목록에 없으면
   * `status` 필드만 보고 상태 이벤트를 합성했는데, 네이티브 catch-all 이 `entry.status`(=connected)
   * 를 실어 보내는 통지들까지 "지금 connected 가 되었다" 로 바뀌었다. 그 이벤트에는 크기가
   * 없으니 화면 크기가 매번 지워졌다(RDP 클릭 좌표가 어긋난 실제 원인).
   */
  | "unknown";

export interface RemoteDesktopSessionEvent {
  sessionId: string;
  type: RemoteDesktopSessionEventType;
  /** `type: "unknown"` 일 때 네이티브가 보낸 원래 종류. 로깅·진단용. */
  rawType?: string;
  status?: "connecting" | "connected" | "disconnecting";
  message?: string;
  width?: number;
  height?: number;
  name?: string;
  text?: string;
  capabilities?: string;
  fingerprint?: string;
  subject?: string;
  issuer?: string;
  notAfter?: string;
  graceful?: boolean;
  reason?: string;
}

export interface RemoteDesktopDriveShare {
  label?: string;
  path: string;
  readOnly?: boolean;
}

export interface RemoteDesktopConnectOptions {
  protocol: "vnc" | "rdp";
  /** Logical host used for TLS identity and certificate pinning. */
  host: string;
  port: number;
  /** Actual tunnel endpoint. RDP keeps `host` as the original server name. */
  dialAddress?: string;
  /** Secret preface for a Go-owned loopback tunnel; omitted for direct TCP. */
  tunnelAuthToken?: string;
  password?: string;
  username?: string;
  domain?: string;
  viewOnly?: boolean;
  shared?: boolean;
  imageQuality?: string;
  desktopWidth?: number;
  desktopHeight?: number;
  audioEnabled?: boolean;
  clipboardEnabled?: boolean;
  microphoneEnabled?: boolean;
  cameraEnabled?: boolean;
  adminSession?: boolean;
  colorDepth?: 16 | 32;
  drives?: RemoteDesktopDriveShare[];
}

interface RemoteDesktopSessionNativeModule extends NativeModule {
  isAvailable(protocol: string): Promise<boolean>;
  connect(
    sessionId: string,
    options: RemoteDesktopConnectOptions,
  ): Promise<void>;
  disconnect(sessionId: string): Promise<void>;
  setActive(sessionId: string, active: boolean): Promise<void>;
  setOrientationUnlocked(unlocked: boolean): Promise<void>;
  pointerMove(sessionId: string, x: number, y: number): void;
  pointerButton(
    sessionId: string,
    button: number,
    pressed: boolean,
    x: number,
    y: number,
  ): void;
  scroll(
    sessionId: string,
    vertical: boolean,
    delta: number,
    x: number,
    y: number,
  ): void;
  keyEvent(
    sessionId: string,
    keysym: number,
    pressed: boolean,
    keycode: number,
  ): void;
  unicodeEvent(sessionId: string, codepoint: number, pressed: boolean): void;
  trustCertificate(sessionId: string, accept: boolean): Promise<void>;
  sendClipboard(sessionId: string, text: string): Promise<void>;
  refresh(sessionId: string): Promise<void>;
  resize(sessionId: string, width: number, height: number): Promise<void>;
}

const MODULE_NAME = "RemoteDesktopSessionModule";
const EVENT_NAME = "remoteDesktopSessionEvent";

function getNativeModule(): RemoteDesktopSessionNativeModule | null {
  return (
    (NativeModules[MODULE_NAME] as RemoteDesktopSessionNativeModule) ?? null
  );
}

export async function isNativeSessionAvailable(
  protocol: "vnc" | "rdp",
): Promise<boolean> {
  const mod = getNativeModule();
  if (!mod) return false;
  try {
    return await mod.isAvailable(protocol);
  } catch {
    return false;
  }
}

export async function nativeConnect(
  sessionId: string,
  options: RemoteDesktopConnectOptions,
): Promise<void> {
  const mod = getNativeModule();
  if (!mod) {
    throw new Error(
      `Native module ${MODULE_NAME} is not available. Cannot connect.`,
    );
  }
  await mod.connect(sessionId, options);
}

export async function nativeDisconnect(sessionId: string): Promise<void> {
  await getNativeModule()?.disconnect(sessionId);
}

export async function nativeSetActive(
  sessionId: string,
  active: boolean,
): Promise<void> {
  await getNativeModule()?.setActive(sessionId, active);
}

export async function setOrientationUnlocked(unlocked: boolean): Promise<void> {
  const mod = getNativeModule();
  if (!mod || typeof mod.setOrientationUnlocked !== "function") return;
  await mod.setOrientationUnlocked(unlocked);
}

export function nativePointerMove(
  sessionId: string,
  x: number,
  y: number,
): void {
  getNativeModule()?.pointerMove(sessionId, x, y);
}

/** button: 0=left, 1=middle, 2=right. */
export function nativePointerButton(
  sessionId: string,
  button: number,
  pressed: boolean,
  x: number,
  y: number,
): void {
  getNativeModule()?.pointerButton(sessionId, button, pressed, x, y);
}

export function nativeScroll(
  sessionId: string,
  vertical: boolean,
  delta: number,
  x: number,
  y: number,
): void {
  getNativeModule()?.scroll(sessionId, vertical, delta, x, y);
}

/**
 * VNC consumes `keysym`; RDP consumes the low 16 bits of `keycode` as a PS/2
 * set-1 scancode (extended keys use the 0xE000 convention).
 */
export function nativeKeyEvent(
  sessionId: string,
  keysym: number,
  pressed: boolean,
  keycode = 0,
): void {
  getNativeModule()?.keyEvent(sessionId, keysym, pressed, keycode);
}

/** Send one RDP Unicode keyboard event. */
export function nativeUnicodeEvent(
  sessionId: string,
  codepoint: number,
  pressed: boolean,
): void {
  getNativeModule()?.unicodeEvent(sessionId, codepoint, pressed);
}

/** Resolve the pending RDP TLS certificate check. */
export async function nativeTrustCertificate(
  sessionId: string,
  accept: boolean,
): Promise<void> {
  const mod = getNativeModule();
  if (!mod) {
    throw new Error(`Native module ${MODULE_NAME} is not available.`);
  }
  await mod.trustCertificate(sessionId, accept);
}

export async function nativeSendClipboard(
  sessionId: string,
  text: string,
): Promise<void> {
  await getNativeModule()?.sendClipboard(sessionId, text);
}

export async function nativeRefresh(sessionId: string): Promise<void> {
  await getNativeModule()?.refresh(sessionId);
}

export async function nativeResize(
  sessionId: string,
  width: number,
  height: number,
): Promise<void> {
  await getNativeModule()?.resize(sessionId, width, height);
}

let emitterInstance: NativeEventEmitter | null = null;

function getEmitter(): NativeEventEmitter | null {
  if (emitterInstance) return emitterInstance;
  const mod = getNativeModule();
  if (!mod) return null;
  emitterInstance = new NativeEventEmitter(mod);
  return emitterInstance;
}

function stringField(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof raw[key] === "string" ? raw[key] : undefined;
}

function normalizeSessionEvent(
  raw: Record<string, unknown>,
): RemoteDesktopSessionEvent | null {
  const sessionId = stringField(raw, "sessionId") ?? "";
  if (!sessionId) return null;

  const rawType = stringField(raw, "type") ?? stringField(raw, "event") ?? null;
  const rawStatus = stringField(raw, "status") ?? null;
  const width =
    typeof raw.width === "number"
      ? raw.width
      : typeof raw.desktopWidth === "number"
        ? raw.desktopWidth
        : undefined;
  const height =
    typeof raw.height === "number"
      ? raw.height
      : typeof raw.desktopHeight === "number"
        ? raw.desktopHeight
        : undefined;

  if (rawType === "resized" || rawType === "resize") {
    return { sessionId, type: "resize", width, height };
  }
  if (rawType === "capabilities") {
    return {
      sessionId,
      type: "capabilities",
      capabilities:
        stringField(raw, "capabilities") ?? stringField(raw, "json"),
    };
  }
  if (rawType === "certificate") {
    return {
      sessionId,
      type: "certificate",
      fingerprint: stringField(raw, "fingerprint"),
      subject: stringField(raw, "subject"),
      issuer: stringField(raw, "issuer"),
      notAfter: stringField(raw, "notAfter"),
    };
  }
  if (rawType === "clipboard") {
    return { sessionId, type: "clipboard", text: stringField(raw, "text") };
  }
  if (rawType === "error" || rawStatus === "error") {
    return {
      sessionId,
      type: "error",
      message: stringField(raw, "message") ?? stringField(raw, "error"),
    };
  }
  if (
    rawType === "closed" ||
    rawStatus === "closed" ||
    rawStatus === "disconnected"
  ) {
    return {
      sessionId,
      type: "closed",
      graceful: typeof raw.graceful === "boolean" ? raw.graceful : undefined,
      reason: stringField(raw, "reason"),
    };
  }

  // **`type` 이 붙어 있는데 아는 종류가 아니면 상태 이벤트로 만들지 않는다.**
  //
  // 네이티브의 catch-all 은 모르는 통지를 `status: entry.status` 와 함께 올린다. 세션이 이미
  // 붙어 있으면 그 값이 "connected" 이므로, 여기서 상태로 받아들이면 크기 없는 connected 가
  // 계속 흘러들어와 이미 알고 있던 화면 크기를 지운다.
  const knownStatusType =
    rawType === "connected" ||
    rawType === "connecting" ||
    rawType === "disconnecting";
  if (rawType && !knownStatusType) {
    return { sessionId, type: "unknown", rawType };
  }

  const status =
    rawType === "connected"
      ? "connected"
      : rawType === "connecting"
        ? "connecting"
        : rawType === "disconnecting"
          ? "disconnecting"
          : rawStatus === "connected" ||
              rawStatus === "connecting" ||
              rawStatus === "disconnecting"
            ? rawStatus
            : null;
  if (!status) return null;
  return {
    sessionId,
    type: "status",
    status,
    width,
    height,
    name: stringField(raw, "name") ?? stringField(raw, "desktopName"),
  };
}

export function subscribeToSessionEvents(
  listener: (event: RemoteDesktopSessionEvent) => void,
): (() => void) | null {
  const emitter = getEmitter();
  if (!emitter) return null;
  const subscription: EmitterSubscription = emitter.addListener(
    EVENT_NAME,
    (raw: Record<string, unknown>) => {
      const event = normalizeSessionEvent(raw);
      if (event) listener(event);
    },
  );
  return () => subscription.remove();
}

export function _resetEmitterForTests(): void {
  emitterInstance = null;
}
