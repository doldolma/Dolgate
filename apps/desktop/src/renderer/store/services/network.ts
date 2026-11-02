import type { SliceDeps } from "./context";
import { createBootstrapSyncServices } from "./bootstrap-sync";
import { createSessionServices } from "./session";
import { createTrustAuthServices } from "./trust-auth";
import type { ConnectAttemptSecrets } from "../types";
import { buildHopCredentialRetry, normalizeErrorMessage, upsertForwardRuntime } from "../utils";
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
    /** 요청 창에 넣은 값(그 호스트와 점프 홉). */
    attempt?: ConnectAttemptSecrets,
  ) => {
    try {
      const result = await api.portForwards.start(ruleId, attempt);
      if ("credentialsNeeded" in result) {
        // 그 홉의 비밀번호가 있어야 붙는다 — 요청 창을 그 홉으로 띄운다(점프면 베스천부터). 누른 즉시 바꾼
        // '시작 중'은 거두고 실패로 물들이지 않는다. 앞서 넣은 값은 요청에 실어 다음 시도로 넘긴다.
        const rule = get().portForwards.find((item) => item.id === ruleId);
        const retry = rule
          ? buildHopCredentialRetry({
              hosts: get().hosts,
              vaultIndex: get().vaultIndex,
              hostId: rule.hostId,
              needed: result.credentialsNeeded,
              source: "portForward",
              ruleId,
              carried: attempt,
            })
          : null;
        if (!retry) {
          throw new Error(t("portForwarding.startFailed"));
        }
        set((state) => ({
          pendingCredentialRetry: retry,
          portForwardRuntimes: state.portForwardRuntimes.map((runtime) =>
            runtime.ruleId === ruleId && runtime.status === "starting"
              ? { ...runtime, status: "stopped" as const, message: undefined, updatedAt: new Date().toISOString() }
              : runtime,
          ),
        }));
        return;
      }
      set((state) => ({
        portForwardRuntimes: upsertForwardRuntime(
          state.portForwardRuntimes,
          result,
        ),
      }));
      if (attempt) {
        // 넣은 사용자 이름은 붙은 뒤 개인 호스트 레코드에 들어간다 — 목록을 다시 읽는다(SFTP 와 같다).
        await bootstrapServices.refreshHostAndKeychainState(set);
      }
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
