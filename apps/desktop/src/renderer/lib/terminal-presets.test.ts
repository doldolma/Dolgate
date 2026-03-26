import { describe, expect, it } from 'vitest';
import { resolveGlobalTerminalThemeId, resolveTerminalThemeIdForSession } from './terminal-presets';

describe('resolveGlobalTerminalThemeId', () => {
  it('maps the global system mode to the light preset when the OS is light', () => {
    expect(resolveGlobalTerminalThemeId('system', false)).toBe('dolssh-light');
  });

  it('maps the global system mode to the dark preset when the OS is dark', () => {
    expect(resolveGlobalTerminalThemeId('system', true)).toBe('dolssh-dark');
  });

  it('keeps explicit presets unchanged', () => {
    expect(resolveGlobalTerminalThemeId('kanagawa-wave', false)).toBe('kanagawa-wave');
    expect(resolveGlobalTerminalThemeId('dolssh-dark', true)).toBe('dolssh-dark');
  });
});

describe('resolveTerminalThemeIdForSession', () => {
  it('lets the host override win over the global system mode', () => {
    expect(resolveTerminalThemeIdForSession('kanagawa-wave', 'system', false)).toBe('kanagawa-wave');
  });
});
