import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } from "@shared";
import type { AppSettings, TerminalFontFamilyId } from "@shared";
import type { HomeSection, SettingsSection } from "../types";

export function normalizeHomeSectionInput(
  section: HomeSection | "knownHosts" | "keychain",
): {
  homeSection: HomeSection;
  settingsSection?: SettingsSection;
} {
  if (section === "knownHosts") {
    return {
      homeSection: "settings",
      settingsSection: "security",
    };
  }

  if (section === "keychain") {
    return {
      homeSection: "settings",
      settingsSection: "secrets",
    };
  }

  return {
    homeSection: section,
  };
}


export function detectRendererPlatform(): "darwin" | "win32" | "linux" | "unknown" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const userAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = (
    userAgentData.userAgentData?.platform ??
    navigator.platform ??
    ""
  ).toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "darwin";
  }
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "win32";
  }
  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }
  return "unknown";
}

export function resolveRendererDefaultTerminalFontFamily(): TerminalFontFamilyId {
  const platform = detectRendererPlatform();
  if (platform === "win32") {
    return "consolas";
  }
  if (platform === "linux") {
    return "jetbrains-mono";
  }
  return "sf-mono";
}

export const defaultSettings: AppSettings = {
  // 기기 로컬 설정. 비면 코어가 `dolgate-<기기이름>` 을 쓴다.
  tailnetHostname: null,
  rdpMonitorsByHostId: {},
  rdpDrivesByHostId: {},
  theme: "system",
  homeHostViewMode: "grid",
  globalTerminalThemeId: "system",
  terminalFontFamily: resolveRendererDefaultTerminalFontFamily(),
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  terminalAutocompleteEnabled: true,
  sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
  sftpConflictPolicy: "ask",
  sftpPreserveMtime: true,
  sftpPreservePermissions: false,
  editorMaxFileSizeMB: 5,
  sessionReplayRetentionCount: 1000,
  // @shared의 DEFAULT_COMMAND_NOTIFICATION_SETTINGS를 인라인한다. vite dev가
  // workspace 패키지(@dolssh/shared-core)의 export*로 추가된 value를 module
  // graph에 비결정적으로 누락시켜 렌더러 모듈 로드가 깨지는 이슈를 피하기 위함.
  commandNotificationsEnabled: true,
  commandNotificationThresholdSeconds: 30,
  commandNotificationOnlyWhenUnfocused: true,
  commandNotificationOnFailure: false,
  commandNotificationSound: false,
  hostMetricsEnabled: true,
  // @shared의 DEFAULT_AUTO_RECONNECT_SETTINGS를 인라인한다(위 command notification과
  // 동일한 이유 — vite dev의 비결정적 export* 누락 회피).
  autoReconnectEnabled: true,
  autoReconnectMaxAttempts: 10,
  autoReconnectBaseDelayMs: 1000,
  // 상한 8초(@shared DEFAULT_AUTO_RECONNECT_SETTINGS 와 동일). 네트워크 복구 즉시 재시도가
  // Windows 에서 navigator.onLine 감지 누락으로 안 걸려도 8초 안에 다시 시도하도록.
  autoReconnectMaxDelayMs: 8000,
  // tmux prefix 키(기본 Ctrl-b). control mode pane 에서 항상 가로채며, 키만 변경 가능.
  tmuxPrefixKey: "C-b",
  // @shared의 DEFAULT_AI_SETTINGS를 인라인한다(위 command notification / auto reconnect 와 동일한
  // vite dev export* 값-누락 회피). AiSettings 타입만 @shared에서 가져온다(값 import 금지).
  ai: {
    enabled: false,
    providerId: "openai-compat",
    // 미설정 = 기본 호스트 사용(설정 UI 는 placeholder 로만 안내).
    baseUrl: undefined,
    model: "",
    temperature: undefined,
    contextTokens: 128000,
  },
  serverUrl: "https://ssh.doldolma.com",
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: new Date(0).toISOString(),
};
