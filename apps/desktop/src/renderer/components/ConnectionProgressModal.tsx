import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogBackdrop } from './DialogBackdrop';
import { ConnectionStatusOverlay } from './ConnectionStatusOverlay';
import { ModalShell } from '../ui';
import { useAppStore } from '../store/appStore';
import { resolveConnectionStages } from './terminal-workspace/connectionStages';
import { resolveConnectionFailurePresentation } from '../store/utils';
import type { HostRecord } from '@shared';

interface ConnectionProgressModalProps {
  /**
   * 이 연결의 상관 ID. 코어가 이벤트에 달아 보내는 값과 같아야 한다
   * (포워딩은 ruleId, 공개키 설치는 `keyinstall:<hostId>`).
   */
  connectionKey: string;
  /** 이 연결이 붙는 호스트. tailnet 여부와 이름을 여기서 찾는다. */
  host?: HostRecord | null;
  title: string;
  onClose: () => void;
}

/**
 * 터미널에서 보던 연결 진행 화면을, 자기 화면이 없는 경로에 팝업으로 띄운다.
 *
 * **왜 필요한가:** 포워딩과 공개키 설치는 탭이 없어서 진행을 보여줄 자리가 없었다. 그래서
 * tailnet 을 거치는지, 점프를 몇 단 지나는지, 어디서 막혔는지가 하나도 보이지 않고 결과만
 * 떨어졌다 — 실패하면 붉은 한 줄이 전부였다.
 *
 * 내용은 터미널과 **같은 것을 쓴다**(resolveConnectionStages + ConnectionStatusOverlay).
 * 따로 만들면 다음 기능이 한쪽에만 도착한다.
 *
 * 인증 물음과 신뢰 물음은 여기서 그리지 않는다 — 각자 자기 자리(설치 대화상자 안의 카드, 전역
 * 신뢰 대화상자)가 이미 있고, 그것들은 이 팝업 위에 뜬다.
 */
export function ConnectionProgressModal({
  connectionKey,
  host,
  title,
  onClose,
}: ConnectionProgressModalProps) {
  const { t: translate } = useTranslation();
  const view = useAppStore((state) => state.connectionViews[connectionKey] ?? null);
  const tailnetStatuses = useAppStore((state) => state.tailnetStatuses);
  /**
   * 사람에게 묻는 중이면 이 팝업은 내려간다.
   *
   * 진행 화면은 "기다리는 동안 보는 것" 이고, 물음이 뜬 순간부터는 **답하는 것**이 할 일이다.
   * 둘을 겹쳐 두면 팝업이 입력창을 덮어 답을 넣을 수 없다 — 실기기에서 그렇게 막혔다.
   * 터미널·컨테이너·SFTP 가 이미 같은 규칙이다(인증 카드가 뜨면 진행 오버레이를 내린다).
   */
  const askingSomething = useAppStore(
    (state) =>
      state.pendingInteractiveAuths.some(
        (auth) =>
          ("endpointId" in auth ? auth.endpointId : auth.sessionId) ===
          connectionKey,
      ) || state.pendingHostKeyPrompt != null,
  );

  const tailnetId =
    host && 'tailnetId' in host ? (host.tailnetId ?? null) : null;
  const tailnetStatus = tailnetId ? tailnetStatuses[tailnetId] : undefined;

  const stages = useMemo(
    () =>
      resolveConnectionStages({
        subject: view
          ? { status: view.status, stage: view.stage }
          : { status: 'connecting' },
        tailnetStatus,
        hasTailscale: Boolean(tailnetId),
        hostKind: host?.kind,
        // 실패 계층은 문구에서 나온다 — 터미널이 쓰는 것과 같은 판정기다.
        failureLayer: view?.message
          ? (resolveConnectionFailurePresentation(view.message).layer ?? null)
          : null,
        failureMessage: view?.message ?? undefined,
      }),
    [view, tailnetStatus, tailnetId, host?.kind],
  );

  if (!view || askingSomething) {
    return null;
  }

  const failed = view.status === 'error';
  return (
    <DialogBackdrop onDismiss={onClose}>
      <ModalShell role="dialog" aria-modal="true">
        <ConnectionStatusOverlay
          error={failed}
          title={title}
          message={view.message ?? translate('connectionOverlay.connecting')}
          stages={stages}
          steps={view.hops}
          // 서버가 사람에게 할 일을 알려 온 경우다. 문구를 해석하지 않고 그대로 보여 준다.
          notes={view.banner ? [view.banner] : null}
          showRetry={false}
          showCancel={!failed}
          cancelLabel={translate('common.cancel')}
          onCancel={onClose}
          onClose={onClose}
        />
      </ModalShell>
    </DialogBackdrop>
  );
}
