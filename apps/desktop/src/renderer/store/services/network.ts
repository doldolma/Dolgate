import type { SliceDeps } from "./context";
import { createBootstrapSyncServices } from "./bootstrap-sync";
import { createSessionServices } from "./session";
import { createTrustAuthServices } from "./trust-auth";
import { upsertForwardRuntime } from "../utils";

type StoreSetter = SliceDeps["set"];
type StoreGetter = SliceDeps["get"];

export function createNetworkServices(deps: SliceDeps) {
  const { api } = deps;
  const bootstrapServices = createBootstrapSyncServices(deps);
  const sessionServices = createSessionServices(deps);
  const trustServices = createTrustAuthServices(deps);

  const startTrustedPortForward = async (
    set: StoreSetter,
    get: StoreGetter,
    ruleId: string,
  ) => {
    try {
      const runtime = await api.portForwards.start(ruleId);
      set((state) => ({
        homeSection: "portForwarding",
        portForwardRuntimes: upsertForwardRuntime(
          state.portForwardRuntimes,
          runtime,
        ),
      }));
    } catch {
      // start failures are surfaced by core/runtime events and activity logs.
    }
  };

  return {
    startTrustedPortForward,
    ensureTrustedHost: trustServices.ensureTrustedHost,
    promptForMissingUsername: sessionServices.promptForMissingUsername,
    markSessionError: sessionServices.markSessionError,
    syncOperationalData: bootstrapServices.syncOperationalData,
  };
}
