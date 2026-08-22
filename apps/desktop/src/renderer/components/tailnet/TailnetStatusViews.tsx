// tailnet 연결 상태를 보여 주는 조각들.
//
// 설정 화면(TailnetSettingsPanel)과 호스트 폼의 tailnet 추가 팝업이 **함께 쓴다.**
// 한쪽 파일에만 두면 다른 쪽이 import 하면서 순환 참조가 되므로 여기로 뺐다.

import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import type { TailnetStatus } from '@shared';
import { Badge, Button, NoticeCard } from '../../ui';
import { useAppStore } from '../../store/appStore';

/**
 * 노드가 올라오는 중인지. 누가 시작했는지가 아니라 상태로 판단한다 — 호스트 연결도 노드를
 * 올리고, 그 시도에도 브라우저 로그인·관리자 승인처럼 사람을 기다리는 구간이 있다.
 */
export function isComingUp(status: TailnetStatus | undefined): boolean {
  return (
    status?.state === 'starting' ||
    status?.state === 'needsAuth' ||
    status?.state === 'needsApproval'
  );
}

/**
 * 지금 이 tailnet 을 올리는 일이 실제로 돌고 있는가.
 *
 * 상태만 보면 안 된다 — 인증이 필요한 노드는 아무도 손대지 않아도 계속 needsAuth 로 보고된다.
 * 그것을 진행 중으로 그리면 스피너와 "링크를 받는 중" 이 영원히 떠 있고, 취소할 대상도 없는데
 * 취소 버튼이 뜬다(눌러도 아무 일이 없어 먹통으로 보인다). 진행 여부는 코어가 알려 준다.
 */
export function isAttempting(status: TailnetStatus | undefined): boolean {
  return status?.attempting === true;
}

/**
 * 붙고 나서 알게 된 것들.
 *
 * Tailscale 기본 서버로 여러 개를 등록하면 설정이 전부 비어 있어 화면에서 구분이 안 된다.
 * 어떤 계정으로 어느 tailnet 에 붙었는지가 유일한 단서라, 붙었으면 그것을 보여 준다.
 */
export function TailnetIdentity({
  tailnetName,
  loginName,
  nodeName,
  nodeIp,
}: {
  tailnetName?: string;
  loginName?: string;
  nodeName?: string;
  nodeIp?: string;
}) {
  const { t: translate } = useTranslation();
  const rows: Array<[string, string]> = [];
  if (tailnetName) {
    rows.push([translate('tailnetSettings.identity.tailnet'), tailnetName]);
  }
  if (loginName) {
    rows.push([translate('tailnetSettings.identity.account'), loginName]);
  }
  if (nodeName) {
    rows.push([
      translate('tailnetSettings.identity.node'),
      nodeIp ? `${nodeName} · ${nodeIp}` : nodeName,
    ]);
  }
  if (rows.length === 0) {
    return null;
  }

  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.82rem]">
      {rows.map(([term, value]) => (
        <Fragment key={term}>
          <dt className="text-[var(--text-soft)]">{term}</dt>
          <dd className="m-0 truncate font-medium">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** tailnet 을 경유할 수 있는 호스트 종류. 세 종류가 같은 `tailnetId` 필드를 쓴다. */

export function TailnetStateBadge({ status }: { status: TailnetStatus }) {
  const { t: translate } = useTranslation();

  if (status.error) {
    return <Badge tone="error">{translate('tailnetSettings.state.failed')}</Badge>;
  }

  // 로그인이 거부됐으면 실패다.
  //
  // 상태는 needsAuth 로 남아서 "링크를 받는 중" 으로 보이지만, 링크는 오지 않는다 — 잘못된
  // auth key 가 그렇다. 기다리면 될 것처럼 그리면 사용자는 3 분을 앉아 있게 된다.
  if (status.loginError) {
    return <Badge tone="error">{translate('tailnetSettings.state.loginRejected')}</Badge>;
  }

  const tone = {
    stopped: 'stopped',
    needsAuth: 'starting',
    needsApproval: 'starting',
    starting: 'starting',
    running: 'running',
  } as const;

  // 컨트롤 플레인이 로그인 URL 을 내려주기까지 몇 초에서 십여 초 걸린다. 그동안 "인증 대기"
  // 라고 하면 사용자는 인증하려 들지만 누를 것이 없다. 무엇을 기다리는지 그대로 말한다.
  //
  // 단, **실제로 시도가 돌고 있을 때만** 그렇게 쓴다. 아무도 손대지 않는 노드도 계속 needsAuth
  // 로 보고되므로, 진행 여부를 보지 않으면 "링크를 받는 중" 이 영원히 떠 있는다 — 화면이
  // 거짓말을 하고 사용자는 무엇을 기다리는지도 모른 채 갇힌다.
  const waitingForAuthUrl =
    status.state === 'needsAuth' && !status.authUrl && isAttempting(status);

  // running 으로 보고되지만 컨트롤 플레인과 끊긴 상태가 있다. 그것을 "연결됨" 이라고 쓰면 화면이
  // 거짓말을 한다 — 판정(ready)이 아니라고 하면 그렇게 보여준다.
  //
  // 다만 "연결 끊김" 이라고 쓰지 않는다. 그렇게 쓰면 통신 자체가 안 되는 것으로 읽히는데, 실제로는
  // 갱신 통로만 끊긴 것이고 기존 경로는 통한다 — 사용자가 이 배지를 보고 멀쩡한 연결을 끊고 다시
  // 등록하러 갔다. 만료는 그 자체로 말할 수 있으므로 따로 쓴다.
  if (status.state === 'running' && status.ready !== true) {
    return (
      <Badge tone={status.identityInvalid === true ? 'starting' : 'stopped'}>
        {translate(
          status.identityInvalid === true
            ? 'tailnetSettings.state.reRegistering'
            : status.expired === true
              ? 'tailnetSettings.state.expired'
              : 'tailnetSettings.state.syncStalled',
        )}
      </Badge>
    );
  }

  return (
    <Badge tone={tone[status.state]}>
      {waitingForAuthUrl
        ? translate('tailnetSettings.state.preparingAuth')
        : translate(`tailnetSettings.state.${status.state}`)}
    </Badge>
  );
}

/**
 * 상태가 사용자의 행동을 기다릴 때만 나오는 안내.
 *
 * Headscale 은 브라우저를 열어도 로그인 화면이 아닐 수 있다 — OIDC 가 설정돼 있지 않으면
 * 안내문과 Auth ID 가 나오고 관리자가 승인해야 끝난다. 그것을 모르면 사용자는 로그인이
 * 실패한 줄 안다. ControlURL 이 설정돼 있다는 것만으로 Headscale 임을 알 수 있으므로,
 * 감지하지 않고 미리 알려준다.
 */
export function TailnetStatusNotice({
  controlUrl,
  status,
}: {
  /** 값이 있으면 Headscale 이다. 그 경우에만 승인 안내를 붙인다. */
  controlUrl?: string;
  status: TailnetStatus;
}) {
  const { t: translate } = useTranslation();
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);

  if (status.error) {
    return (
      <NoticeCard tone="danger" role="alert">
        {status.error}
      </NoticeCard>
    );
  }

  if (status.state !== 'needsAuth' || !status.authUrl) {
    return null;
  }

  const authUrl = status.authUrl;
  return (
    <NoticeCard tone="info">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{translate('tailnetSettings.needsAuth')}</span>
        <Button variant="primary" onClick={() => void openExternalUrl(authUrl)}>
          {translate('tailnetSettings.openBrowser')}
        </Button>
      </div>
      {controlUrl ? (
        <p className="mb-0 mt-2 text-[0.8rem] leading-[1.5]">
          {translate('tailnetSettings.headscaleApprovalHint')}
        </p>
      ) : null}
    </NoticeCard>
  );
}
