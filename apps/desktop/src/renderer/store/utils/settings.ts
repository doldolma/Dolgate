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
  theme: "system",
  globalTerminalThemeId: "dolssh-dark",
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
  sessionReplayRetentionCount: 100,
  // @shared의 DEFAULT_COMMAND_NOTIFICATION_SETTINGS를 인라인한다. vite dev가
  // workspace 패키지(@dolssh/shared-core)의 export*로 추가된 value를 module
  // graph에 비결정적으로 누락시켜 렌더러 모듈 로드가 깨지는 이슈를 피하기 위함.
  commandNotificationsEnabled: true,
  commandNotificationThresholdSeconds: 30,
  commandNotificationOnlyWhenUnfocused: true,
  commandNotificationOnFailure: false,
  commandNotificationSound: false,
  // @shared의 DEFAULT_AUTO_RECONNECT_SETTINGS를 인라인한다(위 command notification과
  // 동일한 이유 — vite dev의 비결정적 export* 누락 회피).
  autoReconnectEnabled: true,
  autoReconnectMaxAttempts: 10,
  autoReconnectBaseDelayMs: 1000,
  autoReconnectMaxDelayMs: 30000,
  // tmux prefix(Ctrl-b) 단축키 가로채기 — 기본 off(평소 tmux 동작 유지).
  tmuxPrefixEnabled: false,
  serverUrl: "https://ssh.doldolma.com",
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: new Date(0).toISOString(),
};
