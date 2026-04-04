import { useEffect } from 'react';
import type { AppTheme } from '@shared';

interface ThemeBridgeProps {
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  resolvedTheme: 'light' | 'dark';
  theme: AppTheme;
  onPrefersDarkChange: (prefersDark: boolean) => void;
}

export function ThemeBridge({
  desktopPlatform,
  resolvedTheme,
  theme,
  onPrefersDarkChange,
}: ThemeBridgeProps) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      onPrefersDarkChange(event.matches);
    };
    media.addEventListener('change', handleChange);
    return () => {
      media.removeEventListener('change', handleChange);
    };
  }, [onPrefersDarkChange]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = theme;
    document.documentElement.dataset.platform = desktopPlatform;
  }, [desktopPlatform, resolvedTheme, theme]);

  return null;
}

