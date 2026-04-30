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

interface SettingsPanelProps {
  activeSection: SettingsSection;
  settings: AppSettings;
  hosts: HostRecord[];
  knownHosts: KnownHostRecord[];
  keychainEntries: SecretMetadataRecord[];
  currentUserEmail?: string | null;
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  onSelectSection: (section: SettingsSection) => void;
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
  currentUserEmail = null,
  desktopPlatform,
  onSelectSection,
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

              <ToggleSwitch
                checked={settings.terminalWebglEnabled}
                aria-label="WebGL Renderer"
                label="WebGL Renderer"
                description="지원되지 않는 환경에서는 자동으로 기본 렌더러로 전환합니다."
                className="min-h-[72px] flex-row-reverse justify-between rounded-[20px] px-4 py-4"
                onClick={() => {
                  void handleChangeTerminalWebglEnabled(!settings.terminalWebglEnabled);
                }}
              />

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

              {desktopPlatform === 'darwin' ? (
                <ToggleSwitch
                  checked={settings.terminalAltIsMeta}
                  aria-label="Use Option/Alt as Meta"
                  label="Use Option/Alt as Meta"
                  description="macOS에서 Option 키를 터미널 메타 키로 사용합니다."
                  className="min-h-[72px] flex-row-reverse justify-between rounded-[20px] px-4 py-4"
                  onClick={() => {
                    void handleChangeTerminalAltIsMeta(!settings.terminalAltIsMeta);
                  }}
                />
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

            <ToggleSwitch
              checked={settings.sftpPreserveMtime ?? true}
              aria-label="Preserve modified time"
              label="Preserve modified time"
              description="전송 완료 후 원본 수정 시간을 대상 파일에 적용합니다."
              className="min-h-[72px] flex-row-reverse justify-between rounded-[20px] px-4 py-4"
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
              className="min-h-[72px] flex-row-reverse justify-between rounded-[20px] px-4 py-4"
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
        <KeychainPanel entries={keychainEntries} onRemoveSecret={onRemoveSecret} onEditSecret={onEditSecret} />
      ) : null}

      {activeSection === 'aws-profiles' ? <AwsProfilesPanel hosts={hosts} /> : null}
    </div>
  );
}
