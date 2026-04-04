import type { DesktopApi } from "@shared";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "../types";

export interface SliceDeps {
  api: DesktopApi;
  set: StoreApi<AppState>["setState"];
  get: StoreApi<AppState>["getState"];
}
