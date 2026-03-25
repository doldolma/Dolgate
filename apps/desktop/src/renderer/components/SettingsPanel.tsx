import type {
  AppSettings,
  AppTheme,
  KnownHostRecord,
  SecretMetadataRecord,
  TerminalFontFamilyId,
  TerminalThemeId
} from '@shared';
import type { SettingsSection } from '../store/createAppStore';
import { terminalFontOptions, terminalThemePresets } from '../lib/terminal-presets';
import { KeychainPanel } from './KeychainPanel';
import { KnownHostsPanel } from './KnownHostsPanel';

interface SettingsPanelProps {
  activeSection: SettingsSection;
  settings: AppSettings;
  knownHosts: KnownHostRecord[];
  keychainEntries: SecretMetadataRecord[];
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  onSelectSection: (section: SettingsSection) => void;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
  onRemoveKnownHost: (id: string) => Promise<void>;
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onEditSecret: (secretRef: string, credentialKind: 'password' | 'passphrase') => void;
  onLogout: () => Promise<void>;
}

const themeOptions: Array<{ value: AppTheme; title: string }> = [
  {
    value: 'system',
    title: 'System'
  },
  {
    value: 'light',
    title: 'Light'
  },
  {
    value: 'dark',
    title: 'Dark'
  }
];

const fontSizeOptions = Array.from({ length: 8 }, (_, index) => index + 11);
const macOnlyTerminalFonts = new Set<TerminalFontFamilyId>(['sf-mono', 'menlo', 'monaco']);

const settingsSections: Array<{ id: SettingsSection; title: string }> = [
  { id: 'general', title: 'General' },
  { id: 'security', title: 'Security' },
  { id: 'secrets', title: 'Secrets' }
];

export function SettingsPanel({
  activeSection,
  settings,
  knownHosts,
  keychainEntries,
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

  async function handleChangeTerminalTheme(globalTerminalThemeId: TerminalThemeId) {
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

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <div className="section-kicker">Preferences</div>
        <h2>Settings</h2>
      </div>

      <div className="operations-tabs settings-panel__tabs" role="tablist" aria-label="Settings sections">
        {settingsSections.map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={activeSection === section.id}
            className={`operations-tab ${activeSection === section.id ? 'active' : ''}`}
            onClick={() => onSelectSection(section.id)}
          >
            {section.title}
          </button>
        ))}
      </div>

      {activeSection === 'general' ? (
        <>
          <section className="settings-card">
            <div className="settings-card__header">
              <div>
                <div className="eyebrow">Terminal</div>
                <h3>Preferences</h3>
              </div>
            </div>

            <div className="terminal-settings-grid">
              <label className="terminal-setting-field">
                <span>Font</span>
                <select
                  value={settings.terminalFontFamily}
                  onChange={async (event) => handleChangeTerminalFontFamily(event.target.value as TerminalFontFamilyId)}
                >
                  {visibleTerminalFontOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.title}
                    </option>
                  ))}
                </select>
              </label>

              <label className="terminal-setting-field">
                <span>Font Size</span>
                <select
                  value={settings.terminalFontSize}
                  onChange={async (event) => handleChangeTerminalFontSize(Number(event.target.value))}
                >
                  {fontSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size}px
                    </option>
                  ))}
                </select>
              </label>

              <label className="terminal-setting-toggle" htmlFor="terminal-webgl-enabled">
                <div>
                  <span>WebGL Renderer</span>
                  <p>지원되지 않는 환경에서는 자동으로 기본 렌더러로 전환합니다.</p>
                </div>
                <input
                  id="terminal-webgl-enabled"
                  aria-label="WebGL Renderer"
                  type="checkbox"
                  checked={settings.terminalWebglEnabled}
                  onChange={async (event) => handleChangeTerminalWebglEnabled(event.target.checked)}
                />
              </label>

              <label className="terminal-setting-field">
                <span>Scrollback</span>
                <input
                  aria-label="Scrollback"
                  type="number"
                  min={1000}
                  max={25000}
                  step={100}
                  value={settings.terminalScrollbackLines}
                  onChange={async (event) => handleChangeTerminalScrollbackLines(Number(event.target.value))}
                />
                <p>보관할 터미널 히스토리 줄 수입니다.</p>
              </label>

              <label className="terminal-setting-field">
                <span>Line Height</span>
                <input
                  aria-label="Line Height"
                  type="number"
                  min={1}
                  max={2}
                  step={0.05}
                  value={settings.terminalLineHeight}
                  onChange={async (event) => handleChangeTerminalLineHeight(Number(event.target.value))}
                />
                <p>문자 줄 간격을 조절합니다.</p>
              </label>

              <label className="terminal-setting-field">
                <span>Letter Spacing</span>
                <input
                  aria-label="Letter Spacing"
                  type="number"
                  min={0}
                  max={2}
                  step={1}
                  value={settings.terminalLetterSpacing}
                  onChange={async (event) => handleChangeTerminalLetterSpacing(Number(event.target.value))}
                />
                <p>문자 사이 간격을 조금 더 넓힐 수 있습니다.</p>
              </label>

              <label className="terminal-setting-field">
                <span>Minimum Contrast</span>
                <input
                  aria-label="Minimum Contrast"
                  type="number"
                  min={1}
                  max={21}
                  step={0.5}
                  value={settings.terminalMinimumContrastRatio}
                  onChange={async (event) => handleChangeTerminalMinimumContrastRatio(Number(event.target.value))}
                />
                <p>가독성이 낮은 색 조합을 자동으로 보정합니다.</p>
              </label>

              {desktopPlatform === 'darwin' ? (
                <label className="terminal-setting-toggle" htmlFor="terminal-alt-is-meta">
                  <div>
                    <span>Use Option/Alt as Meta</span>
                    <p>macOS에서 Option 키를 터미널 메타 키로 사용합니다.</p>
                  </div>
                  <input
                    id="terminal-alt-is-meta"
                    aria-label="Use Option/Alt as Meta"
                    type="checkbox"
                    checked={settings.terminalAltIsMeta}
                    onChange={async (event) => handleChangeTerminalAltIsMeta(event.target.checked)}
                  />
                </label>
              ) : null}
            </div>

            <div className="settings-card__header terminal-theme-header">
              <div>
                <div className="eyebrow">Terminal</div>
                <h3>Terminal Theme</h3>
              </div>
            </div>
            <div className="theme-options">
              {terminalThemePresets.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`theme-option terminal-theme-option ${settings.globalTerminalThemeId === option.id ? 'active' : ''}`}
                  onClick={async () => handleChangeTerminalTheme(option.id)}
                >
                  <div className="terminal-theme-option__preview" style={{ background: option.preview.background, color: option.preview.foreground }}>
                    <span className="terminal-theme-option__window">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="terminal-theme-option__lines">
                      <span style={{ background: option.preview.accent }} />
                      <span />
                      <span />
                      <span style={{ background: option.preview.accent }} />
                    </span>
                  </div>
                  <strong>{option.title}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card__header">
              <div>
                <div className="eyebrow">Appearance</div>
                <h3>Theme</h3>
              </div>
            </div>
            <div className="theme-options">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`theme-option ${settings.theme === option.value ? 'active' : ''}`}
                  onClick={async () => onUpdateSettings({ theme: option.value })}
                >
                  <strong>{option.title}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card__header">
              <div>
                <div className="eyebrow">Session</div>
                <h3>Account</h3>
              </div>
            </div>
            <button type="button" className="danger-button" onClick={async () => onLogout()}>
              로그아웃
            </button>
          </section>
        </>
      ) : null}

      {activeSection === 'security' ? <KnownHostsPanel records={knownHosts} onRemove={onRemoveKnownHost} /> : null}

      {activeSection === 'secrets' ? (
        <KeychainPanel entries={keychainEntries} onRemoveSecret={onRemoveSecret} onEditSecret={onEditSecret} />
      ) : null}
    </div>
  );
}
