import type {
  AppSettings,
  AppTheme,
  GlobalTerminalThemeId,
  HostRecord,
  KnownHostRecord,
  SecretMetadataRecord,
  SftpConflictPolicy,
  TerminalFontFamilyId,
} from '@shared';
import {
  MAX_SESSION_REPLAY_RETENTION_COUNT,
  MIN_SESSION_REPLAY_RETENTION_COUNT,
} from '@shared';
import type { ReactNode } from 'react';
import type { SettingsSection } from '../store/createAppStore';
import { terminalFontOptions, terminalThemePresets } from '../lib/terminal-presets';
import { TMUX_PREFIX_KEY_OPTIONS } from '../lib/tmux-prefix';
import { KeychainPanel } from './KeychainPanel';
import { KnownHostsPanel } from './KnownHostsPanel';
import { AwsProfilesPanel } from './AwsProfilesPanel';
import {
  Button,
  FieldGroup,
  Input,
  OptionCard,
  SectionLabel,
  SelectField,
  TabButton,
  Tabs,
  ToggleSwitch,
} from '../ui';

// shared-core의 clampCommandNotificationThresholdSeconds 범위와 동일하게 유지.
// @shared value를 직접 import하면 vite dev에서 export* 누락 이슈가 있어 인라인.
const COMMAND_NOTIFICATION_THRESHOLD_MIN_SECONDS = 1;
const COMMAND_NOTIFICATION_THRESHOLD_MAX_SECONDS = 86400;

interface SettingsPanelProps {
  activeSection: SettingsSection;
  settings: AppSettings;
  hosts: HostRecord[];
  knownHosts: KnownHostRecord[];
  keychainEntries: SecretMetadataRecord[];
  savedCredentialsSearchQuery: string;
  currentUserEmail?: string | null;
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  onSelectSection: (section: SettingsSection) => void;
  onSavedCredentialsSearchQueryChange: (query: string) => void;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
  onRemoveKnownHost: (id: string) => Promise<void>;
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onEditSecret: (secretRef: string) => void;
  onLogout: () => Promise<void>;
}

const themeOptions: Array<{ value: AppTheme; title: string; description: string }> = [
  {
    value: 'system',
    title: 'System',
    description: '기기 라이트/다크 설정을 따라갑니다.'
  },
  {
    value: 'light',
    title: 'Light',
    description: '밝은 배경과 또렷한 대비를 사용합니다.'
  },
  {
    value: 'dark',
    title: 'Dark',
    description: '어두운 배경으로 눈부심을 줄입니다.'
  }
];

const fontSizeOptions = Array.from({ length: 8 }, (_, index) => index + 11);
const macOnlyTerminalFonts = new Set<TerminalFontFamilyId>(['sf-mono', 'menlo', 'monaco']);

const settingsSections: Array<{ id: SettingsSection; title: string }> = [
  { id: 'general', title: 'General' },
  { id: 'sftp', title: 'SFTP' },
  { id: 'security', title: 'Security' },
  { id: 'secrets', title: 'Saved Credentials' },
  { id: 'aws-profiles', title: 'AWS Profiles' }
];

function renderTerminalThemePreview(
  preview: ReactNode,
  background?: string,
  color?: string,
) {
  return (
    <div
      className="flex min-h-[86px] w-full flex-col justify-between rounded-[18px] border border-[color-mix(in_srgb,currentColor_12%,transparent_88%)] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      style={background || color ? { background, color } : undefined}
    >
      {preview}
    </div>
  );
}

function renderTerminalThemePreviewChrome(accent?: string) {
  return (
    <>
      <span className="inline-flex gap-[0.32rem]">
        <i className="h-[0.46rem] w-[0.46rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.46rem] w-[0.46rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.46rem] w-[0.46rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
      </span>
      <span className="grid gap-[0.38rem]">
        <span className="block h-[0.42rem] w-[54%] rounded-full" style={accent ? { background: accent } : undefined} />
        <span className="block h-[0.42rem] w-[82%] rounded-full bg-[color-mix(in_srgb,currentColor_24%,transparent_76%)]" />
        <span className="block h-[0.42rem] w-[68%] rounded-full bg-[color-mix(in_srgb,currentColor_24%,transparent_76%)]" />
        <span className="block h-[0.42rem] w-[40%] rounded-full" style={accent ? { background: accent } : undefined} />
      </span>
    </>
  );
}

function renderAppearanceThemeMiniWindow(
  background: string,
  color: string,
  accent: string,
) {
  return (
    <div
      className="grid min-h-[66px] gap-[0.5rem] rounded-[16px] border border-[color-mix(in_srgb,currentColor_12%,transparent_88%)] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      style={{ background, color }}
    >
      <span className="inline-flex gap-[0.28rem]">
        <i className="h-[0.42rem] w-[0.42rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.42rem] w-[0.42rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.42rem] w-[0.42rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
      </span>
      <span className="grid gap-[0.34rem]">
        <span className="block h-[0.4rem] w-[58%] rounded-full" style={{ background: accent }} />
        <span className="block h-[0.4rem] w-[82%] rounded-full bg-[color-mix(in_srgb,currentColor_20%,transparent_80%)]" />
        <span className="block h-[0.4rem] w-[64%] rounded-full bg-[color-mix(in_srgb,currentColor_20%,transparent_80%)]" />
      </span>
    </div>
  );
}

function renderAppearanceThemePreview(theme: AppTheme) {
  if (theme === 'system') {
    return (
      <div className="grid w-full grid-cols-2 gap-2" aria-hidden="true">
        {renderAppearanceThemeMiniWindow('#f5f7fb', '#243041', '#2468ff')}
        {renderAppearanceThemeMiniWindow('#0b1220', '#dce6ff', '#7aa2ff')}
      </div>
    );
  }

  if (theme === 'light') {
    return (
      <div className="w-full" aria-hidden="true">
        {renderAppearanceThemeMiniWindow('#f5f7fb', '#243041', '#2468ff')}
      </div>
    );
  }

  return (
    <div className="w-full" aria-hidden="true">
      {renderAppearanceThemeMiniWindow('#0b1220', '#dce6ff', '#7aa2ff')}
    </div>
  );
}

export function SettingsPanel({
  activeSection,
  settings,
  hosts,
  knownHosts,
  keychainEntries,
  savedCredentialsSearchQuery,
  currentUserEmail = null,
  desktopPlatform,
  onSelectSection,
  onSavedCredentialsSearchQueryChange,
  onUpdateSettings,
  onRemoveKnownHost,
  onRemoveSecret,
  onEditSecret,
  onLogout
}: SettingsPanelProps) {
  const visibleTerminalFontOptions =
    desktopPlatform === 'darwin'
      ? terminalFontOptions
      : terminalFontOptions.filter((option) => !macOnlyTerminalFonts.has(option.id));

  async function handleChangeTerminalTheme(globalTerminalThemeId: GlobalTerminalThemeId) {
    await onUpdateSettings({ globalTerminalThemeId });
  }

  async function handleChangeTerminalFontFamily(terminalFontFamily: TerminalFontFamilyId) {
    await onUpdateSettings({ terminalFontFamily });
  }

  async function handleChangeTerminalFontSize(terminalFontSize: number) {
    await onUpdateSettings({ terminalFontSize });
  }

  async function handleChangeTerminalWebglEnabled(terminalWebglEnabled: boolean) {
    await onUpdateSettings({ terminalWebglEnabled });
  }

  async function handleChangeTerminalAutocompleteEnabled(
    terminalAutocompleteEnabled: boolean,
  ) {
    await onUpdateSettings({ terminalAutocompleteEnabled });
  }

  async function handleChangeTerminalScrollbackLines(terminalScrollbackLines: number) {
    await onUpdateSettings({ terminalScrollbackLines });
  }

  async function handleChangeTerminalLineHeight(terminalLineHeight: number) {
    await onUpdateSettings({ terminalLineHeight });
  }

  async function handleChangeTerminalLetterSpacing(terminalLetterSpacing: number) {
    await onUpdateSettings({ terminalLetterSpacing });
  }

  async function handleChangeTerminalMinimumContrastRatio(terminalMinimumContrastRatio: number) {
    await onUpdateSettings({ terminalMinimumContrastRatio });
  }

  async function handleChangeTerminalAltIsMeta(terminalAltIsMeta: boolean) {
    await onUpdateSettings({ terminalAltIsMeta });
  }

  async function handleChangeTmuxPrefixKey(tmuxPrefixKey: string) {
    await onUpdateSettings({ tmuxPrefixKey });
  }

  async function handleChangeSessionReplayRetentionCount(
    sessionReplayRetentionCount: number,
  ) {
    await onUpdateSettings({ sessionReplayRetentionCount });
  }

  async function handleChangeSftpConflictPolicy(
    sftpConflictPolicy: SftpConflictPolicy,
  ) {
    await onUpdateSettings({ sftpConflictPolicy });
  }

  return (
    <div className="flex min-h-full flex-1 flex-col gap-5">
      <div className="px-0 pb-[0.25rem] pt-[0.35rem]">
        <SectionLabel>Preferences</SectionLabel>
        <h2>Settings</h2>
      </div>

      <Tabs role="tablist" aria-label="Settings sections">
        {settingsSections.map((section) => (
          <TabButton
            key={section.id}
            role="tab"
            aria-selected={activeSection === section.id}
            active={activeSection === section.id}
            onClick={() => onSelectSection(section.id)}
          >
            {section.title}
          </TabButton>
        ))}
      </Tabs>

      {activeSection === 'general' ? (
        <>
          <section className="rounded-[28px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.55rem] shadow-[var(--shadow-soft)]">
            <div className="mb-4">
              <div>
                <SectionLabel>Terminal</SectionLabel>
                <h3>Preferences</h3>
              </div>
            </div>

            <div className="mb-[1.15rem] grid items-start grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[1320px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[760px]:grid-cols-1">
              <FieldGroup label="Font">
                <SelectField
                  value={settings.terminalFontFamily}
                  onChange={async (event) =>
                    handleChangeTerminalFontFamily(
                      event.target.value as TerminalFontFamilyId,
                    )
                  }
                >
                  {visibleTerminalFontOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.title}
                    </option>
                  ))}
                </SelectField>
              </FieldGroup>

              <FieldGroup label="Font Size">
                <SelectField
                  value={settings.terminalFontSize}
                  onChange={async (event) =>
                    handleChangeTerminalFontSize(Number(event.target.value))
                  }
                >
                  {fontSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size}px
                    </option>
                  ))}
                </SelectField>
              </FieldGroup>

              <FieldGroup label="Scrollback">
                <Input
                  aria-label="Scrollback"
                  type="number"
                  min={1000}
                  max={25000}
                  step={100}
                  value={settings.terminalScrollbackLines}
                  onChange={async (event) =>
                    handleChangeTerminalScrollbackLines(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                  보관할 터미널 히스토리 줄 수입니다.
                </p>
              </FieldGroup>

              <FieldGroup label="Line Height">
                <Input
                  aria-label="Line Height"
                  type="number"
                  min={1}
                  max={2}
                  step={0.05}
                  value={settings.terminalLineHeight}
                  onChange={async (event) =>
                    handleChangeTerminalLineHeight(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                  문자 줄 간격을 조절합니다.
                </p>
              </FieldGroup>

              <FieldGroup label="Letter Spacing">
                <Input
                  aria-label="Letter Spacing"
                  type="number"
                  min={0}
                  max={2}
                  step={1}
                  value={settings.terminalLetterSpacing}
                  onChange={async (event) =>
                    handleChangeTerminalLetterSpacing(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                  문자 사이 간격을 조금 더 넓힐 수 있습니다.
                </p>
              </FieldGroup>

              <FieldGroup label="Minimum Contrast">
                <Input
                  aria-label="Minimum Contrast"
                  type="number"
                  min={1}
                  max={21}
                  step={0.5}
                  value={settings.terminalMinimumContrastRatio}
                  onChange={async (event) =>
                    handleChangeTerminalMinimumContrastRatio(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                  가독성이 낮은 색 조합을 자동으로 보정합니다.
                </p>
              </FieldGroup>

              <FieldGroup label="Session Replay Retention">
                <Input
                  aria-label="Session Replay Retention"
                  type="number"
                  min={MIN_SESSION_REPLAY_RETENTION_COUNT}
                  max={MAX_SESSION_REPLAY_RETENTION_COUNT}
                  step={10}
                  value={settings.sessionReplayRetentionCount}
                  onChange={async (event) =>
                    handleChangeSessionReplayRetentionCount(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                  로컬에 보관할 종료된 세션 replay 개수입니다.
                </p>
              </FieldGroup>

            </div>

            {/* 터미널 동작 토글 — 토글끼리 묶어 input과 높이가 섞이지 않게 한다 */}
            <div className="mb-[1.15rem] grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1">
              <ToggleSwitch
                checked={settings.terminalWebglEnabled}
                label="WebGL Renderer"
                description="지원되지 않는 환경에서는 자동으로 기본 렌더러로 전환합니다."
                onClick={() => {
                  void handleChangeTerminalWebglEnabled(!settings.terminalWebglEnabled);
                }}
              />

              <ToggleSwitch
                checked={settings.terminalAutocompleteEnabled}
                label="Command autocomplete"
                description="PATH·history에 더해 Fig 스펙·generator로 자동완성합니다. (SSM 에서는 일부 기능 제한)"
                onClick={() => {
                  void handleChangeTerminalAutocompleteEnabled(
                    !settings.terminalAutocompleteEnabled,
                  );
                }}
              />

              {desktopPlatform === 'darwin' ? (
                <ToggleSwitch
                  checked={settings.terminalAltIsMeta}
                  label="Use Option/Alt as Meta"
                  description="macOS에서 Option 키를 터미널 메타 키로 사용합니다."
                  onClick={() => {
                    void handleChangeTerminalAltIsMeta(!settings.terminalAltIsMeta);
                  }}
                />
              ) : null}

              <FieldGroup label="Tmux Prefix 키">
                <SelectField
                  value={settings.tmuxPrefixKey ?? 'C-b'}
                  onChange={async (event) =>
                    handleChangeTmuxPrefixKey(event.target.value)
                  }
                >
                  {TMUX_PREFIX_KEY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
                <p className="mt-1.5 text-[0.78rem] leading-relaxed text-[var(--text-muted)]">
                  tmux 제어 모드에서 prefix 다음 키를 네이티브 tmux 동작으로 매핑합니다.
                </p>
              </FieldGroup>
            </div>

            {/* 명령 완료 알림 — 관련 설정을 한 그룹 카드로 묶는다 */}
            <div className="mb-[1.15rem] grid gap-[0.7rem] rounded-[20px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_55%,transparent_45%)] p-[1.1rem]">
              <SectionLabel>Notifications</SectionLabel>
              <ToggleSwitch
                checked={settings.commandNotificationsEnabled}
                label="명령 완료 알림"
                description="오래 걸리거나 실패한 명령이 끝나면 OS 알림으로 알려줍니다."
                onClick={() => {
                  const next = !settings.commandNotificationsEnabled;
                  // 알림을 켤 때 OS 권한이 미결정이면 권한 요청 프롬프트를 유도한다.
                  if (
                    next &&
                    typeof window !== 'undefined' &&
                    'Notification' in window &&
                    typeof window.Notification?.requestPermission === 'function' &&
                    window.Notification.permission === 'default'
                  ) {
                    void window.Notification.requestPermission();
                  }
                  void onUpdateSettings({ commandNotificationsEnabled: next });
                }}
              />

              {settings.commandNotificationsEnabled ? (
                <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-[0.9rem] border-t border-[color-mix(in_srgb,var(--border)_60%,transparent_40%)] pt-[0.85rem] max-[760px]:grid-cols-1">
                  <FieldGroup label="알림 기준 시간(초)">
                    <Input
                      aria-label="알림 기준 시간(초)"
                      type="number"
                      min={COMMAND_NOTIFICATION_THRESHOLD_MIN_SECONDS}
                      max={COMMAND_NOTIFICATION_THRESHOLD_MAX_SECONDS}
                      step={5}
                      value={settings.commandNotificationThresholdSeconds}
                      onChange={async (event) =>
                        onUpdateSettings({
                          commandNotificationThresholdSeconds: Number(
                            event.target.value,
                          ),
                        })
                      }
                    />
                    <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                      이 시간 이상 걸린 명령이 끝나면 알립니다.
                    </p>
                  </FieldGroup>

                  <ToggleSwitch
                    checked={settings.commandNotificationOnlyWhenUnfocused}
                    label="비활성 상태일 때만 알림"
                    description="앱을 보고 있고 해당 탭이 활성일 때는 알리지 않습니다."
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationOnlyWhenUnfocused:
                          !settings.commandNotificationOnlyWhenUnfocused,
                      });
                    }}
                  />

                  <ToggleSwitch
                    checked={settings.commandNotificationOnFailure}
                    label="실패한 명령은 항상 알림"
                    description="0이 아닌 종료 코드는 시간과 무관하게 알립니다."
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationOnFailure:
                          !settings.commandNotificationOnFailure,
                      });
                    }}
                  />

                  <ToggleSwitch
                    checked={settings.commandNotificationSound}
                    label="알림 소리"
                    description="알림이 표시될 때 소리를 함께 재생합니다."
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationSound:
                          !settings.commandNotificationSound,
                      });
                    }}
                  />
                </div>
              ) : null}
            </div>

            {/* 자동 재연결 — 끊김 시 백오프 재연결 동작 제어 */}
            <div className="mb-[1.15rem] grid gap-[0.7rem] rounded-[20px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_55%,transparent_45%)] p-[1.1rem]">
              <SectionLabel>Auto-Reconnect</SectionLabel>
              <ToggleSwitch
                checked={settings.autoReconnectEnabled}
                label="자동 재연결"
                description="연결이 예기치 않게 끊기면 자동으로 다시 연결합니다 (SSH/Warpgate 터미널, SFTP, 포트포워딩)."
                onClick={() => {
                  void onUpdateSettings({
                    autoReconnectEnabled: !settings.autoReconnectEnabled,
                  });
                }}
              />

              {settings.autoReconnectEnabled ? (
                <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-[0.9rem] border-t border-[color-mix(in_srgb,var(--border)_60%,transparent_40%)] pt-[0.85rem] max-[760px]:grid-cols-1">
                  <FieldGroup label="최대 재시도 횟수">
                    <Input
                      aria-label="최대 재시도 횟수"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={settings.autoReconnectMaxAttempts}
                      onChange={async (event) =>
                        onUpdateSettings({
                          autoReconnectMaxAttempts: Number(event.target.value),
                        })
                      }
                    />
                    <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                      이 횟수만큼 실패하면 수동 재연결로 전환합니다.
                    </p>
                  </FieldGroup>

                  <FieldGroup label="최대 재시도 간격(초)">
                    <Input
                      aria-label="최대 재시도 간격(초)"
                      type="number"
                      min={1}
                      max={300}
                      step={1}
                      value={Math.round(settings.autoReconnectMaxDelayMs / 1000)}
                      onChange={async (event) =>
                        onUpdateSettings({
                          autoReconnectMaxDelayMs:
                            Number(event.target.value) * 1000,
                        })
                      }
                    />
                    <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                      지수 백오프가 늘어날 수 있는 최대 간격입니다.
                    </p>
                  </FieldGroup>
                </div>
              ) : null}
            </div>

            <div className="mb-4">
              <div>
                <SectionLabel>Appearance</SectionLabel>
                <h3>Theme</h3>
              </div>
            </div>
            <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-[0.9rem] max-[1320px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[760px]:grid-cols-1">
              {themeOptions.map((option) => (
                <OptionCard
                  key={option.value}
                  active={settings.theme === option.value}
                  title={option.title}
                  description={option.description}
                  preview={renderAppearanceThemePreview(option.value)}
                  onClick={async () => onUpdateSettings({ theme: option.value })}
                />
              ))}
            </div>
          </section>

          <section className="rounded-[28px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.55rem] shadow-[var(--shadow-soft)]">
            <div className="mb-4 mt-1">
              <div>
                <SectionLabel>Terminal</SectionLabel>
                <h3>Terminal Theme</h3>
              </div>
            </div>
            <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-[0.9rem] max-[1320px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[760px]:grid-cols-1">
              <OptionCard
                aria-label="Terminal Theme: System"
                active={settings.globalTerminalThemeId === 'system'}
                title="System"
                onClick={async () => handleChangeTerminalTheme('system')}
                preview={renderTerminalThemePreview(
                  renderTerminalThemePreviewChrome('#2468ff'),
                  'linear-gradient(135deg, #f5f7fb 0%, #f5f7fb 50%, #0b1220 50%, #0b1220 100%)',
                  '#243041',
                )}
              />
              {terminalThemePresets.map((option) => (
                <OptionCard
                  key={option.id}
                  active={settings.globalTerminalThemeId === option.id}
                  title={option.title}
                  onClick={async () => handleChangeTerminalTheme(option.id)}
                  preview={renderTerminalThemePreview(
                    renderTerminalThemePreviewChrome(option.preview.accent),
                    option.preview.background,
                    option.preview.foreground,
                  )}
                />
              ))}
            </div>
          </section>

          <section className="rounded-[28px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.55rem] shadow-[var(--shadow-soft)]">
            <div className="mb-4">
              <div>
                <SectionLabel>Session</SectionLabel>
                <h3>Account</h3>
              </div>
            </div>
            <dl className="mb-4 grid gap-[0.85rem]">
              <div className="grid gap-1 rounded-[18px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-4 py-[0.9rem]">
                <dt className="text-[0.84rem] text-[var(--text-soft)]">Email</dt>
                <dd className="m-0 break-all text-[var(--text)]">{currentUserEmail ?? '—'}</dd>
              </div>
              <div className="grid gap-1 rounded-[18px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-4 py-[0.9rem]">
                <dt className="text-[0.84rem] text-[var(--text-soft)]">Server</dt>
                <dd className="m-0 break-all text-[var(--text)]">{settings.serverUrl || '—'}</dd>
              </div>
            </dl>
            <Button variant="danger" onClick={async () => onLogout()}>
              로그아웃
            </Button>
          </section>
        </>
      ) : null}

      {activeSection === 'sftp' ? (
        <section className="rounded-[28px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.55rem] shadow-[var(--shadow-soft)]">
          <div className="mb-4">
            <div>
              <SectionLabel>SFTP</SectionLabel>
              <h3>Transfer Defaults</h3>
            </div>
          </div>
          <div className="grid items-start grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1">
            <FieldGroup label="Conflict Policy">
              <SelectField
                value={settings.sftpConflictPolicy ?? 'ask'}
                onChange={async (event) =>
                  handleChangeSftpConflictPolicy(
                    event.target.value as SftpConflictPolicy,
                  )
                }
              >
                <option value="ask">Ask every time</option>
                <option value="overwrite">Overwrite</option>
                <option value="skip">Skip</option>
                <option value="keepBoth">Keep both</option>
              </SelectField>
            </FieldGroup>

            <FieldGroup label="Editor Max File Size (MB)">
              <Input
                aria-label="Editor max file size"
                type="number"
                min={1}
                max={50}
                step={1}
                value={settings.editorMaxFileSizeMB ?? 5}
                onChange={async (event) => {
                  const next = Number(event.target.value);
                  await onUpdateSettings({
                    editorMaxFileSizeMB: Number.isFinite(next)
                      ? Math.min(50, Math.max(1, Math.round(next)))
                      : 5,
                  });
                }}
              />
              <p className="m-0 text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
                이 크기 이하의 텍스트 파일만 내장 편집기로 열 수 있습니다.
              </p>
            </FieldGroup>

            <ToggleSwitch
              checked={settings.sftpPreserveMtime ?? true}
              aria-label="Preserve modified time"
              label="Preserve modified time"
              description="전송 완료 후 원본 수정 시간을 대상 파일에 적용합니다."
              onClick={() => {
                void onUpdateSettings({
                  sftpPreserveMtime: !(settings.sftpPreserveMtime ?? true),
                });
              }}
            />

            <ToggleSwitch
              checked={settings.sftpPreservePermissions ?? false}
              aria-label="Preserve permissions"
              label="Preserve permissions"
              description="가능한 경우 원본 권한 비트를 대상 파일에 적용합니다."
              onClick={() => {
                void onUpdateSettings({
                  sftpPreservePermissions: !(settings.sftpPreservePermissions ?? false),
                });
              }}
            />
          </div>
        </section>
      ) : null}

      {activeSection === 'security' ? <KnownHostsPanel records={knownHosts} onRemove={onRemoveKnownHost} /> : null}

      {activeSection === 'secrets' ? (
        <KeychainPanel
          entries={keychainEntries}
          hosts={hosts}
          searchQuery={savedCredentialsSearchQuery}
          onSearchQueryChange={onSavedCredentialsSearchQueryChange}
          onRemoveSecret={onRemoveSecret}
          onEditSecret={onEditSecret}
        />
      ) : null}

      {activeSection === 'aws-profiles' ? <AwsProfilesPanel hosts={hosts} /> : null}
    </div>
  );
}
