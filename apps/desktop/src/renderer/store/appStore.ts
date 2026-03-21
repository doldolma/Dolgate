import { useStore } from 'zustand';
import { createAppStore } from './createAppStore';

export const appStore = createAppStore(window.keyterm);

export function useAppStore<T>(selector: (state: ReturnType<typeof appStore.getState>) => T): T {
  return useStore(appStore, selector);
}
