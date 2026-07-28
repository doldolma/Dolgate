import { BrowserWindow, ipcMain } from "electron";
import type { TailnetConfig, TailnetRecord, TailnetSnapshot, TailnetStatus } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

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
export function registerTailnetIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.tailnet.list,
    async (): Promise<TailnetRecord[]> => ctx.tailnets.list(),
  );

  ipcMain.handle(
    ipcChannels.tailnet.save,
    async (_event, input: TailnetSaveInput): Promise<TailnetRecord> =>
      ctx.tailnets.save(input.record, input.authKey),
  );

  ipcMain.handle(
    ipcChannels.tailnet.remove,
    async (_event, id: string): Promise<void> => {
      // 설정을 지우기 전에 노드부터 정리한다. 순서가 반대면 컨트롤 플레인에 노드가 남는데
      // 그것을 지울 자격증명은 이미 사라진 뒤다.
      try {
        await ctx.coreManager.forgetTailnet(id);
      } catch {
        // 노드가 없거나 컨트롤 플레인에 닿지 못한 경우. 설정 삭제까지 막을 이유는 없다 —
        // 사용자가 지우겠다고 한 것이고, 남은 노드는 콘솔에서 지울 수 있다.
      }
      ctx.tailnets.remove(id);
      // 다른 기기도 지워야 한다. 동기화는 "안 보낸 것을 지운다"가 아니라 툼스톤 기반이라,
      // 여기서 기록하지 않으면 다른 기기에서 되살아난다.
      ctx.syncOutbox.upsertDeletion("tailnets", id);
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

      return ctx.coreManager.testTailnet(
        {
          ...config,
          authKey,
          // 저장 때와 같은 규칙이어야 한다. 시험에서 ephemeral 로 붙였다가 저장 후
          // persistent 로 붙으면 노드가 둘로 갈라진다.
          ephemeral: Boolean(authKey),
        },
        pushStatus,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.tailnet.disconnect,
    async (_event, id: string): Promise<void> => {
      await ctx.coreManager.disconnectTailnet(id);
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
