import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared';
import { SettingsPanel } from './SettingsPanel';

const settings: AppSettings = {
  theme: 'system',
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: 'sf-mono',
  terminalFontSize: 13,
  terminalWebglEnabled: true,
  serverUrl: 'https://ssh.doldolma.com',
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: '2026-03-24T00:00:00.000Z'
};

describe('SettingsPanel', () => {
  it('renders and updates the WebGL renderer toggle', () => {
    const onUpdateSettings = vi.fn().mockResolvedValue(undefined);

    render(<SettingsPanel settings={settings} onUpdateSettings={onUpdateSettings} onLogout={vi.fn()} />);

    const toggle = screen.getByLabelText('WebGL Renderer') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText('지원되지 않는 환경에서는 자동으로 기본 렌더러로 전환합니다.')).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalWebglEnabled: false });
  });
});
