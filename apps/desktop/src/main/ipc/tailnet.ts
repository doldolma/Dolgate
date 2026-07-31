import { BrowserWindow, ipcMain } from "electron";
import type {
  TailnetConfig,
  TailnetRecord,
  TailnetSnapshot,
  TailnetStatus,
} from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { t } from "../i18n";
import type { MainIpcContext } from "./context";

/**
 * 코어가 올려 보낸 오류를 사용자가 읽을 수 있는 문장으로 바꾼다.
 *
 * 코어 오류는 진단용이라 식별자와 영어가 섞여 있다 — 그대로 화면에 띄우면
 * `tailnet node is in use: "8404eb7b-…"` 처럼 사용자가 할 수 있는 일이 없는 문장이 된다.
 * 여기서 걸러 두면 렌더러 세 군데가 각자 문자열을 뒤지지 않는다.
 */
function toUserFacingTailnetError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);

  // Go 의 tailnet.ErrNodeInUse. 노드에 얹힌 세션이 있으면 끊지 않는다 — 그 밑에서 내리면
  // 그 세션이 죽는다.
  if (message.includes("node is in use")) {
    return new Error(t("tailnetIpc.nodeInUse"));
  }
  return cause instanceof Error ? cause : new Error(message);
}

/** 렌더러가 저장을 요청할 때 보내는 것. authKey 는 저장 시에만 위로 올라온다. */
export interface TailnetSaveInput {
  record: TailnetRecord;
  /** 생략하면 기존 키를 그대로 둔다. 빈 문자열이면 키를 지운다. */
  authKey?: string;
}

/**
 * tailnet 등록·테스트·해제 IPC.
 *
 * auth key 는 렌더러로 절대 돌려보내지 않는다. 저장할 때만 위로 올라오고, 연결할 때는
 * 여기서 암호화 저장소에서 읽어 코어로 넘긴다. 렌더러가 아는 것은 키가 설정돼 있는지 여부
 * (record.hasAuthKey)뿐이다.
 *
 * 연결 테스트는 응답 하나로 끝나지 않는다. 브라우저 로그인이면 사용자가 브라우저에서
 * 인증하는 구간이 있어서, 그동안 무엇을 기다리는지(로그인인지 관리자 승인인지)를 보여줘야
 * 한다. 그래서 중간 상태를 요청한 창으로 밀어 주고, 마지막 상태만 invoke 의 반환값이 된다.
 */

/**
 * 코어에 심을 설정 목록. auth key 를 포함하므로 렌더러로는 절대 나가지 않는다.
 *
 * ephemeral 은 요청하지 않는다. auth key 가 있다는 이유로 켜던 값인데, 그러면 앱을 끌 때마다
 * 컨트롤 플레인이 노드를 지운다 — Tailscale auth key 는 기본이 1회용이라 다음 실행의 재등록이
 * "invalid key" 로 실패하고, 그때부터 그 tailnet 은 새 키를 넣기 전까지 못 쓴다. 실기기에서
 * 그렇게 깨졌다.
 *
 * 자동 정리가 필요한 사람은 ephemeral 속성이 켜진 재사용 가능한 키를 쓰면 되고, 그 경우 노드가
 * ephemeral 이 되는지는 컨트롤 플레인이 키를 보고 정한다 — 우리가 요청하지 않아도 그렇게 된다.
 */
function buildTailnetConfigs(ctx: MainIpcContext): TailnetConfig[] {
  return ctx.tailnets.listPayloads().map((payload) => {
    const authKey = payload.authKey?.trim() || undefined;
    return {
      id: payload.id,
      controlUrl: payload.controlUrl,
      authKey,
      ephemeral: false,
    };
  });
}

export function registerTailnetIpcHandlers(ctx: MainIpcContext): void {
  // 코어는 설정을 알아야 노드를 만들 수 있는데, 호스트 연결 경로는 tailnetId 만 들고 온다.
  // 이걸 등록해 두면 설정 화면에서 미리 연결해 두지 않아도 첫 dial 이 노드를 올린다. 코어가
  // 다시 떠도 CoreManager 가 이 제공자를 다시 불러 복구한다.
  ctx.coreManager.setTailnetConfigProvider(() => buildTailnetConfigs(ctx));

  ipcMain.handle(
    ipcChannels.tailnet.list,
    async (): Promise<TailnetRecord[]> => ctx.tailnets.list(),
  );

  ipcMain.handle(
    ipcChannels.tailnet.save,
    async (_event, input: TailnetSaveInput): Promise<TailnetRecord> => {
      const saved = ctx.tailnets.save(input.record, input.authKey);
      // 코어가 새 설정을 알아야 이 tailnet 을 지정한 호스트가 곧바로 붙는다.
      ctx.coreManager.pushTailnetConfigs();
      // 동기화에도 알린다. 이것이 없으면 방금 저장한 레코드가 **사라진다** — 다음 기동의
      // pull 이 서버 스냅샷으로 목록을 통째로 갈아 끼우고, 서버에 없는 것은 삭제로 취급된다.
      // 다른 컬렉션(호스트·스니펫·포워딩 …)이 모두 저장 직후 이것을 부르는 이유가 그것이다.
      ctx.queueSync();
      return saved;
    },
  );

  ipcMain.handle(
    ipcChannels.tailnet.remove,
    async (_event, id: string): Promise<void> => {
      // 설정을 지우기 전에 노드부터 정리한다. 순서가 반대면 컨트롤 플레인에 노드가 남는데
      // 그것을 지울 자격증명은 이미 사라진 뒤다.
      try {
        await ctx.coreManager.forgetTailnet(id);
      } catch (cause) {
        // 쓰이는 중이면 설정만 지우고 노드를 남기는 것이 아니라, 지우지 않고 알린다 —
        // 설정이 사라지면 그 노드를 정리할 자격증명도 함께 사라진다.
        if (cause instanceof Error && cause.message.includes("node is in use")) {
          throw toUserFacingTailnetError(cause);
        }
        // 그 외에는 노드가 없거나 컨트롤 플레인에 닿지 못한 경우. 설정 삭제까지 막을 이유는
        // 없다 — 사용자가 지우겠다고 한 것이고, 남은 노드는 콘솔에서 지울 수 있다.
      }
      ctx.tailnets.remove(id);
      // 지워진 설정은 코어에서도 빼야 한다. 목록에 없는 id 는 코어가 버린다.
      ctx.coreManager.pushTailnetConfigs();
      // 다른 기기도 지워야 한다. 동기화는 "안 보낸 것을 지운다"가 아니라 툼스톤 기반이라,
      // 여기서 기록하지 않으면 다른 기기에서 되살아난다.
      ctx.syncOutbox.upsertDeletion("tailnets", id);
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.tailnet.test,
    async (event, config: TailnetConfig): Promise<TailnetStatus> => {
      // 진행 상태는 요청한 창에만 보낸다. 다른 창이 남의 tailnet 인증 URL 을 받을 이유가
      // 없고, 창이 닫힌 뒤 보내면 예외가 난다.
      const sender = BrowserWindow.fromWebContents(event.sender);
      const pushStatus = (status: TailnetStatus) => {
        if (!sender || sender.isDestroyed()) {
          return;
        }
        sender.webContents.send(ipcChannels.tailnet.status, status);
      };

      // 저장 전에도 시험할 수 있어야 하므로, 방금 입력한 키가 딸려 오면 그것을 쓴다.
      // 그 외에는 렌더러가 키를 갖고 있지 않으니 여기서 읽어 넣는다. 키가 위로 올라오는 건
      // 저장과 같은 방향이라 "키는 렌더러로 내려보내지 않는다"는 원칙과 무관하다.
      const typedAuthKey = config.authKey?.trim();
      const authKey = typedAuthKey
        ? typedAuthKey
        : (ctx.tailnets.readAuthKey(config.id) ?? undefined);

      return ctx.coreManager
        .testTailnet(
          {
            ...config,
            authKey,
            // 저장 때와 같은 규칙이어야 한다 — 시험과 실제 연결이 다르게 붙으면 같은 tailnet 에
            // 노드가 둘로 갈라진다. 둘 다 요청하지 않는다(위 buildTailnetConfigs 설명 참조).
            ephemeral: false,
          },
          pushStatus,
        )
        .catch((cause: unknown) => {
          throw toUserFacingTailnetError(cause);
        });
    },
  );

  ipcMain.handle(
    ipcChannels.tailnet.disconnect,
    async (_event, id: string): Promise<void> => {
      try {
        await ctx.coreManager.disconnectTailnet(id);
      } catch (cause) {
        throw toUserFacingTailnetError(cause);
      }
    },
  );

  ipcMain.handle(
    ipcChannels.tailnet.cancel,
    async (_event, id: string): Promise<void> => {
      await ctx.coreManager.cancelTailnet(id);
    },
  );

  ipcMain.handle(
    ipcChannels.tailnet.snapshot,
    async (): Promise<TailnetSnapshot> => ctx.coreManager.snapshotTailnets(),
  );

  ipcMain.handle(
    ipcChannels.tailnet.forget,
    async (_event, id: string): Promise<void> => {
      await ctx.coreManager.forgetTailnet(id);
    },
  );
}
