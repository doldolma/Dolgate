import type { DesktopApi } from '@shared';

declare global {
  interface Window {
    dolssh: DesktopApi;
  }

  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

export {};
