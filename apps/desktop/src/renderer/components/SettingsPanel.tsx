import type { AppSettings, AppTheme } from '@shared';

interface SettingsPanelProps {
  settings: AppSettings;
  onChangeTheme: (theme: AppTheme) => Promise<void>;
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

export function SettingsPanel({ settings, onChangeTheme, onLogout }: SettingsPanelProps) {
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
              onClick={async () => onChangeTheme(option.value)}
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
