import type { AppSettings, AppTheme, TerminalFontFamilyId, TerminalThemeId } from '@shared';
import { terminalFontOptions, terminalThemePresets } from '../lib/terminal-presets';

interface SettingsPanelProps {
  settings: AppSettings;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
  onLogout: () => Promise<void>;
}

const themeOptions: Array<{ value: AppTheme; title: string; description: string }> = [
  {
    value: 'system',
    title: 'System',
    description: 'macOS 또는 Windows의 기본 라이트/다크 모드를 그대로 따라갑니다.'
  },
  {
    value: 'light',
    title: 'Light',
    description: '밝은 캔버스와 부드러운 패널 대비를 사용합니다.'
  },
  {
    value: 'dark',
    title: 'Dark',
    description: '터미널 작업에 집중하기 좋은 다크 테마를 사용합니다.'
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

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <div className="section-kicker">Preferences</div>
        <h2>Settings</h2>
        <p>앱 종료는 창 닫기와 다릅니다. Cmd+Q 또는 Dock의 Quit으로 종료하면 SSH 세션도 함께 정리됩니다.</p>
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
              <span>{option.description}</span>
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
              <span>{option.description}</span>
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
        <p className="settings-card__description">현재 세션을 종료하면 로컬에 캐시된 서버 관리 secret도 함께 정리되고, 다시 로그인해야 앱을 사용할 수 있습니다.</p>
        <button type="button" className="danger-button" onClick={async () => onLogout()}>
          로그아웃
        </button>
      </section>
    </div>
  );
}
