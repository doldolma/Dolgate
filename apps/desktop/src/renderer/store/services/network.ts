import type { SliceDeps } from "./context";
import { createBootstrapSyncServices } from "./bootstrap-sync";
import { createSessionServices } from "./session";
import { createTrustAuthServices } from "./trust-auth";
import { normalizeErrorMessage, upsertForwardRuntime } from "../utils";
import { t } from "../../i18n";

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
        portForwardRuntimes: upsertForwardRuntime(
          state.portForwardRuntimes,
          runtime,
        ),
      }));
    } catch (error) {
      // 실패를 삼키면 규칙이 "starting" 에 영원히 앉는다.
      //
      // 예전 주석은 "실패는 코어·런타임 이벤트가 알려 준다" 였는데, 그것은 **코어까지 갔을 때만**
      // 참이다. 그 앞에서 끊기면(메인이 거절, IPC 오류, 요청 예산 초과) 코어는 아무것도 emit 하지
      // 않으므로 화면에는 시작한 적도 실패한 적도 없는 줄만 남는다 — 눌러도 아무 일이 없는 것처럼
      // 보인다. 이유를 그 줄에 적어 둔다.
      const rule = get().portForwards.find((item) => item.id === ruleId);
      set((state) => ({
        portForwardRuntimes: upsertForwardRuntime(state.portForwardRuntimes, {
          ...(state.portForwardRuntimes.find(
            (runtime) => runtime.ruleId === ruleId,
          ) ?? {
            ruleId,
            hostId: rule?.hostId ?? "",
            transport: rule?.transport ?? "ssh",
            mode: "local",
            bindAddress: "",
            bindPort: 0,
          }),
          status: "error",
          message: normalizeErrorMessage(error, t("portForwarding.startFailed")),
          updatedAt: new Date().toISOString(),
        }),
      }));
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
