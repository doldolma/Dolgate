import type { DesktopApi } from "@shared";

// Leaf module: the preload bridge proxy lives here (not in appStore) so stores
// that need the API — appStore and the standalone editorStore — can both import
// it without forming an import cycle.
export const desktopApi: DesktopApi = new Proxy({} as DesktopApi, {
  get(_target, property) {
    return (window.dolssh as unknown as Record<PropertyKey, unknown>)[property];
  },
});
