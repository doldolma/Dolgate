import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared';
import { SettingsPanel } from './SettingsPanel';

const settings: AppSettings = {
  theme: 'system',
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: 'sf-mono',
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  serverUrl: 'https://ssh.doldolma.com',
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: '2026-03-24T00:00:00.000Z'
};

describe('SettingsPanel', () => {
  it('renders and updates the WebGL renderer toggle', () => {
    const onUpdateSettings = vi.fn().mockResolvedValue(undefined);

    render(<SettingsPanel settings={settings} desktopPlatform="darwin" onUpdateSettings={onUpdateSettings} onLogout={vi.fn()} />);

    const toggle = screen.getByLabelText('WebGL Renderer') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText('지원되지 않는 환경에서는 자동으로 기본 렌더러로 전환합니다.')).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalWebglEnabled: false });
  });

  it('renders extended terminal controls and updates numeric settings', () => {
    const onUpdateSettings = vi.fn().mockResolvedValue(undefined);

    render(<SettingsPanel settings={settings} desktopPlatform="darwin" onUpdateSettings={onUpdateSettings} onLogout={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Scrollback'), { target: { value: '6400' } });
    fireEvent.change(screen.getByLabelText('Line Height'), { target: { value: '1.2' } });
    fireEvent.change(screen.getByLabelText('Letter Spacing'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Minimum Contrast'), { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText('Use Option/Alt as Meta'));

    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalScrollbackLines: 6400 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalLineHeight: 1.2 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalLetterSpacing: 1 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalMinimumContrastRatio: 3 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalAltIsMeta: true });
  });
});
