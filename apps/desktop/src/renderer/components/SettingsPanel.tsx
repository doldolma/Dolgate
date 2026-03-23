import type { AppSettings, AppTheme, TerminalFontFamilyId, TerminalThemeId } from '@shared';
import { terminalFontOptions, terminalThemePresets } from '../lib/terminal-presets';

interface SettingsPanelProps {
  settings: AppSettings;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
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

export function SettingsPanel({ settings, onUpdateSettings, onLogout }: SettingsPanelProps) {
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

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <div className="section-kicker">Preferences</div>
        <h2>Settings</h2>
      </div>

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
              {terminalFontOptions.map((option) => (
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
    </div>
  );
}
