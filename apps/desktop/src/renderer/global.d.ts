import type { DesktopApi } from '@keyterm/shared';

declare global {
  interface Window {
    keyterm: DesktopApi;
  }

  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

export {};
