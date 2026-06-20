import { useStore } from 'zustand';
import { createAppStore } from './createAppStore';
import { desktopApi } from './desktopApi';

export { desktopApi };

export const appStore = createAppStore(desktopApi);

export function useAppStore<T>(selector: (state: ReturnType<typeof appStore.getState>) => T): T {
  return useStore(appStore, selector);
}
