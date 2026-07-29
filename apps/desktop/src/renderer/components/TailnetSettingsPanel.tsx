import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TailnetRecord, TailnetStatus } from '@shared';
import {
  Badge,
  Button,
  Card,
  CardMain,
  EmptyState,
  FieldGroup,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
} from '../ui';
import { DialogBackdrop } from './DialogBackdrop';
import { RefreshCw } from '../ui/icons';
import { useAppStore } from '../store/appStore';
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts';
import {
  acquireTailnetWatch,
  applyTailnetStatus,
  forgetTailnetStatus,
} from '../services/desktop/tailnet-watch';
import {
  cancelTailnet,
  disconnectTailnet,
  forgetTailnet,
  listTailnets,
  snapshotTailnets,
  onTailnetStatus,
  removeTailnet,
  saveTailnet,
  testTailnet,
} from '../services/desktop/tailnet';

interface TailnetDraft {
  id: string;
  label: string;
  controlUrl: string;
  /** 저장할 때만 쓴다. 기존 키는 절대 내려오지 않으므로 빈 값 = "그대로 두기". */
  authKey: string;
}

/**
 * 노드가 올라오는 중인지. 누가 시작했는지가 아니라 상태로 판단한다 — 호스트 연결도 노드를
 * 올리고, 그 시도에도 브라우저 로그인·관리자 승인처럼 사람을 기다리는 구간이 있다.
 */
// 스냅샷을 다시 읽는 간격.
//
// tailnet 상태에는 밀어 주는 채널이 없다 — 코어는 연결 시험 중에만 상태 이벤트를 낸다. 그래서
// 화면이 열려 있는 동안은 이쪽에서 읽는다. 만료로 노드가 떨어지는 것을 화면을 열어 둔 채로
// 지켜볼 수 있어야 하므로 1 초로 둔다(읽기 한 번은 코어 안의 상태 조회라 값싸다).
const snapshotPollIntervalMs = 1000;

function isComingUp(status: TailnetStatus | undefined): boolean {
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
function isAttempting(status: TailnetStatus | undefined): boolean {
  return status?.attempting === true;
}

/**
 * 이름이 비었을 때 대신 쓸 이름.
 *
 * 저장은 연결에 성공한 뒤에만 되므로, 그때는 컨트롤 플레인이 알려 준 tailnet 이름이 있다.
 * 그게 사용자가 직접 지을 이름보다 정확하다. 없으면 서버 주소로 대신한다.
 */
function deriveLabel(tailnetName: string | undefined, controlUrl: string): string {
  if (tailnetName) {
    return tailnetName;
  }
  const trimmed = controlUrl.trim();
  if (!trimmed) {
    return 'Tailscale';
  }
  try {
    return new URL(trimmed).host;
  } catch {
    // 주소가 아직 온전하지 않은 경우. 사용자가 적은 것을 그대로 쓴다.
    return trimmed;
  }
}

/**
 * 폼을 열 때 id 를 미리 만든다.
 *
 * 저장 전에 시험할 수 있어야 하는데, 시험은 노드를 만든다. id 를 저장 시점에 만들면 그
 * 노드는 저장될 레코드와 무관한 고아가 된다. 미리 만들어 두면 시험이 올린 노드가 그대로
 * 저장될 레코드의 노드가 되고, 취소하면 그 id 를 등록 해제하면 된다.
 */
function emptyDraft(): TailnetDraft {
  return {
    id: crypto.randomUUID(),
    label: '',
    controlUrl: '',
    authKey: '',
  };
}

/**
 * 등록된 tailnet 관리.
 *
 * 연결 테스트가 이 화면의 핵심이다. 노드가 올라오는 과정에서 무엇을 기다리는지 —
 * 브라우저 로그인인지 관리자 승인인지 — 를 보여주지 않으면 사용자는 멈춘 것으로 오해한다.
 */
export function TailnetSettingsPanel() {
  const { t: translate } = useTranslation();
  const [records, setRecords] = useState<TailnetRecord[]>([]);
  const [draft, setDraft] = useState<TailnetDraft | null>(null);
  // 상태는 스토어 한곳에서 온다. 화면마다 따로 읽으면 설정과 터미널이 서로 다른 말을 한다.
  const statusById = useAppStore((state) => state.tailnetStatuses);
  const localNodeName = useAppStore((state) => state.localTailnetNodeName);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<TailnetRecord | null>(null);
  /**
   * 방금 삭제한 tailnet 이 목록에 남을 수 있다는 안내. 값은 어디서 지워야 하는지다.
   *
   * 삭제는 노드 등록 해제까지 시도하지만, 로그아웃이 와이어에서 보내는 것은 "노드 키를
   * 만료시켜라" 하나뿐이다. 항목을 지우는 것은 컨트롤 플레인이 ephemeral 노드에 한해 해 주는
   * 정책이고, 노드가 ephemeral 이 되는 것은 ephemeral 속성이 켜진 키로 등록했을 때뿐이다.
   * 우리는 그 속성을 알 수 없으므로 항상 알린다. 행이 사라진 뒤라 여기서 말할 수밖에 없다.
   */
  const [removedPersistent, setRemovedPersistent] = useState<'tailscale' | 'headscale' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * 이 기기가 tailnet 에 등록할 때 쓰는 이름.
   *
   * 노드 이름은 사용자가 정하지 않고 기기 이름에서 자동으로 만든다. 그래서 기기 목록에서
   * 어느 항목이 이 기기인지 알려면 그 이름을 화면에 보여 줘야 한다. 값은 Go 가 정하므로
   * 여기서 다시 계산하지 않고 받아 온다.
   */

  // 이미 연 인증 URL. 같은 URL 로 창을 여러 번 띄우지 않는다.
  const openedAuthUrlRef = useRef<string | null>(null);
  // 저장되지 않은 채 노드가 올라간 초안. 취소 버튼을 거치지 않고 화면을 떠나는 경로(다른
  // 설정 섹션으로 이동, 창 닫기)가 있어서, 언마운트에서도 같은 정리를 해야 노드가 안 남는다.
  const unsavedDraftIdRef = useRef<string | null>(null);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);

  useEffect(() => {
    return () => {
      const abandoned = unsavedDraftIdRef.current;
      if (abandoned) {
        void forgetTailnet(abandoned).catch(() => {});
      }
    };
  }, []);

  const refresh = useCallback(async () => {
    setRecords(await listTailnets());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 화면이 열려 있는 동안 실제로 무엇이 붙어 있는지 계속 읽어 온다.
  //
  // 한 번만 읽으면 화면을 열어 둔 채로는 값이 굳는다 — 노드가 만료로 떨어져도, 다른 창에서
  // 연결이 됐어도 들어온 순간의 상태를 계속 보여준다. 읽은 값은 스토어로 가므로 터미널 화면도
  // 같은 것을 본다.
  useEffect(() => acquireTailnetWatch(), []);

  /**
   * 붙고 나서야 알 수 있는 값들을 설정에 채워 넣는다.
   *
   * tailnet 이름·계정을 기록하기 전에 저장된 설정에는 이 값이 없다. 붙어 봐야 알 수 있는
   * 값이라 저장 시점에 소급할 수 없고, 그래서 붙었을 때 채운다.
   *
   * 이미 다른 tailnet 이름이 적혀 있으면 덮어쓰지 않는다 — 그건 다른 계정으로 로그인했다는
   * 뜻이고, 조용히 갱신해 버리면 경고할 근거가 사라진다.
   */
  useEffect(() => {
    const stale = records.filter((record) => {
      const status = statusById[record.id];
      if (status?.state !== 'running' || !status.tailnetName) {
        return false;
      }
      if (!record.tailnetName) {
        return true;
      }
      return (
        record.tailnetName === status.tailnetName &&
        record.loginName !== status.loginName
      );
    });
    if (stale.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      for (const record of stale) {
        const status = statusById[record.id];
        await saveTailnet({
          record: {
            ...record,
            tailnetName: status?.tailnetName,
            loginName: status?.loginName,
            updatedAt: new Date().toISOString(),
          },
          // 생략하면 저장된 auth key 를 그대로 둔다.
        });
      }
      if (!cancelled) {
        await refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [records, statusById, refresh]);

  useEffect(() => {
    return onTailnetStatus((status) => {
      // 여기서 시작한 시도만 반영하면, 다른 곳에서 올린 노드는 이 화면에 없는 것이 된다 —
      // 호스트에 연결하면 그 경로가 노드를 올리는데, 그동안 이 화면은 "연결" 을 띄운 채
      // 접을 방법도 내주지 않았다. 이 화면은 노드가 지금 어떤 상태인지 보여 주는 곳이다.
      applyTailnetStatus(status);

      // 인증 링크는 메인 프로세스가 연다. 이 화면 말고 호스트 연결 중에도 인증이 필요해질 수
      // 있고, 구독자가 둘이면 같은 링크로 브라우저가 두 번 열린다. "브라우저 다시 열기" 버튼은
      // 사용자가 직접 누르는 것이라 그대로 둔다.
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) {
      return;
    }
    const status = statusById[draft.id];
    const label =
      draft.label.trim() || deriveLabel(status?.tailnetName, draft.controlUrl);

    setError(null);
    const now = new Date().toISOString();
    try {
      await saveTailnet({
        record: {
          id: draft.id,
          label,
          controlUrl: draft.controlUrl.trim() || undefined,
          // 연결에 성공해야 저장되므로 여기서는 항상 알 수 있다. 다음 연결 때 이 값과
          // 대조해서, 다른 계정으로 로그인해 다른 tailnet 에 붙은 것을 잡아낸다.
          tailnetName: status?.tailnetName,
          loginName: status?.loginName,
          createdAt: now,
          updatedAt: now,
        },
        // 빈 문자열은 "지우기"라서 그대로 넘기면 안 된다. 손대지 않았으면 생략한다.
        authKey: draft.authKey.length > 0 ? draft.authKey : undefined,
      });
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
      return;
    }
    unsavedDraftIdRef.current = null;
    setDraft(null);
    await refresh();
  }, [draft, refresh, statusById]);

  const handleTest = useCallback(
    async (config: {
      id: string;
      controlUrl?: string;
      /** 아직 저장하지 않은 초안을 시험할 때만. 저장된 것은 메인이 읽어 넣는다. */
      authKey?: string;
      /** 초안이면 저장 없이 화면을 떠날 때 노드를 정리해야 한다. */
      isDraft?: boolean;
    }) => {
      setError(null);
      setRemovedPersistent(null);
      setTestingId(config.id);
      openedAuthUrlRef.current = null;
      if (config.isDraft) {
        unsavedDraftIdRef.current = config.id;
      }
      applyTailnetStatus({ id: config.id, state: 'starting' });
      try {
        const status = await testTailnet({
          id: config.id,
          controlUrl: config.controlUrl,
          authKey: config.authKey,
        });
        applyTailnetStatus(status);
      } catch (cause) {
        applyTailnetStatus({
          id: config.id,
          state: 'stopped',
          error: normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')),
        });
      } finally {
        setTestingId(null);
      }
    },
    [],
  );

  /** 진행 중인 연결 시도를 접는다. 코어가 마지막 상태를 보내 주면 화면이 정리된다. */
  const handleCancel = useCallback(async (id: string) => {
    try {
      await cancelTailnet(id);
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
    }
  }, []);

  /**
   * 노드를 버리고 처음부터 다시 붙인다.
   *
   * 취소가 그 노드를 닫으므로, 뒤이은 시도는 새 노드로 등록을 처음부터 밟는다 — 컨트롤 플레인에서
   * 노드가 지워졌을 때 죽은 노드 키로 재등록을 반복하며 링크가 안 오는 상태를 그렇게 푼다.
   */
  const handleRestart = useCallback(async (record: TailnetRecord) => {
    setError(null);
    try {
      await cancelTailnet(record.id);
      await testTailnet(
        { id: record.id, controlUrl: record.controlUrl },
        { forceRelogin: true },
      );
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
    }
  }, []);

  const handleDisconnect = useCallback(async (record: TailnetRecord) => {
    setError(null);
    try {
      await disconnectTailnet(record.id);
      applyTailnetStatus({ id: record.id, state: 'stopped' });
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
    }
  }, []);

  /** 저장하지 않고 닫으면 시험이 올린 노드가 남는다. 그것부터 지운다. */
  const handleCancelDraft = useCallback(async () => {
    const abandoned = draft;
    unsavedDraftIdRef.current = null;
    setDraft(null);
    setError(null);
    if (!abandoned || !statusById[abandoned.id]) {
      return;
    }
    forgetTailnetStatus(abandoned.id);
    try {
      await forgetTailnet(abandoned.id);
    } catch {
      // 노드가 없거나 컨트롤 플레인에 닿지 못한 경우. 폼을 닫는 것까지 막을 이유는 없다.
    }
  }, [draft, statusById]);

  const handleRemove = useCallback(async () => {
    if (!pendingRemoval) {
      return;
    }
    setError(null);
    try {
      await removeTailnet(pendingRemoval.id);
      // 인증 방식으로 분기하지 않는다. 노드가 실제로 지워지는 것은 ephemeral 속성이 켜진
      // 키로 등록했을 때뿐이고, 그것은 우리가 알 수 없다 — 우리가 보내는 ephemeral 요청은
      // 키가 있으면 키에 밀리고, Headscale 은 브라우저 경로에서 아예 무시한다.
      setRemovedPersistent(pendingRemoval.controlUrl ? 'headscale' : 'tailscale');
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
    }
    setPendingRemoval(null);
    await refresh();
  }, [pendingRemoval, refresh]);

  const rows = useMemo(
    () => records.map((record) => ({ record, status: statusById[record.id] })),
    [records, statusById],
  );

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {/* 상단 탭이 이미 "Tailscale" 이라 여기서 한 번 더 말하지 않는다. */}
          <h3 className="m-0">{translate('tailnetSettings.heading')}</h3>
          <p className="mb-0 mt-2 max-w-[46rem] text-[0.9rem] text-[var(--text-soft)]">
            {translate('tailnetSettings.description')}
          </p>
          {localNodeName ? (
            <p className="mb-0 mt-1 text-[0.82rem] text-[var(--text-soft)]">
              {translate('tailnetSettings.localNodeName')}{' '}
              <span className="font-medium text-[var(--text)]">{localNodeName}</span>
            </p>
          ) : null}
        </div>

        <Button
          variant="primary"
          onClick={() => setDraft(emptyDraft())}
          disabled={draft !== null}
        >
          {translate('tailnetSettings.add')}
        </Button>
      </div>

      {removedPersistent ? (
        <NoticeCard tone="info">
          {translate(`tailnetSettings.removed.${removedPersistent}`)}
        </NoticeCard>
      ) : null}

      {error && !draft ? (
        <NoticeCard tone="danger" role="alert">
          {error}
        </NoticeCard>
      ) : null}

      {draft ? (
        <TailnetForm
          draft={draft}
          status={statusById[draft.id]}
          testing={testingId === draft.id}
          testDisabled={testingId !== null}
          error={error}
          onChange={setDraft}
          onSave={handleSave}
          onTest={() =>
            void handleTest({
              id: draft.id,
              controlUrl: draft.controlUrl.trim() || undefined,
              authKey: draft.authKey.trim() || undefined,
              isDraft: true,
            })
          }
          onCancelTest={() => void handleCancel(draft.id)}
          onCancel={() => void handleCancelDraft()}
        />
      ) : null}

      {rows.length === 0 && !draft ? (
        <EmptyState
          title={translate('tailnetSettings.empty')}
          description={translate('tailnetSettings.emptyHint')}
        />
      ) : null}

      {rows.length > 0 ? (
        <div className="grid gap-3">
          {rows.map(({ record, status }) => (
            <Card key={record.id} className="flex-col items-stretch gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{record.label}</span>
                    <Badge>
                      {record.hasAuthKey
                        ? translate('tailnetSettings.usingAuthKey')
                        : translate('tailnetSettings.usingBrowser')}
                    </Badge>
                    {status ? <TailnetStateBadge status={status} /> : null}
                  </div>
                  <div className="truncate text-[0.82rem] text-[var(--text-soft)]">
                    {record.controlUrl || translate('tailnetSettings.tailscaleDefault')}
                  </div>
                  {/* 붙어 있지 않아도 어느 tailnet 의 어느 계정인지는 늘 보여야 한다.
                      Tailscale 기본 서버는 설정에 단서가 없어서, 이게 없으면 다른 기기에서
                      어느 계정으로 로그인해야 하는지 알 방법이 없다. 저장할 때 넣어 둔 값을
                      쓰고, 붙어 있으면 실시간 값이 우선한다. */}
                  <div className="mt-2">
                    <TailnetIdentity
                      tailnetName={status?.tailnetName ?? record.tailnetName}
                      loginName={status?.loginName ?? record.loginName}
                      nodeName={status?.nodeName}
                      nodeIp={status?.nodeIp}
                    />
                  </div>
                  {/* 백엔드가 스스로 보고하는 문제. 상태가 "연결됨" 인데 통신이 안 되는 경우가
                      있고(컨트롤 플레인에서 노드를 만료시켜도 상태는 그대로 남는다), 그때
                      여기에만 단서가 남는다 — tailscale 자신의 GUI 도 이것을 보여 준다. */}
                  {status?.health?.length ? (
                    <ul className="mt-2 space-y-1 text-xs text-[var(--text-soft)]">
                      {status.health.map((warning) => (
                        <li key={warning}>⚠ {warning}</li>
                      ))}
                    </ul>
                  ) : null}
                  {/* 상태가 "연결됨" 인데 통신이 안 되는 경우가 있다 — 만료는 새 netmap 이 올
                      때만 계산되는데, 만료되면 그 netmap 이 오지 않아서 그대로 남는다. 무엇을
                      보고 그렇게 판단했는지 여기서 확인할 수 있어야 한다. */}
                  {status ? <TailnetDiagnostics status={status} /> : null}
                </CardMain>

                <div className="flex flex-none items-center gap-2">
                  {/* 저장된 네트워크에서 "시험"과 "연결"은 같은 동작이다. 둘을 따로 두면
                      사용자가 무엇이 다른지 알 수 없다. 상태에 따라 하나만 보여 준다. */}
                  {/* 판정은 코어가 한다(ready). 여기서 state 로 다시 판단하면 설정 화면만
                      "연결됨" 이라고 말하는 상태가 생긴다 — 만료된 노드가 그렇다. */}
                  {status?.ready === true ? (
                    <Button
                      variant="secondary"
                      onClick={() => void handleDisconnect(record)}
                      disabled={testingId !== null}
                    >
                      {translate('tailnetSettings.disconnect')}
                    </Button>
                  ) : testingId === record.id || isAttempting(status) ? (
                    // 시도 중에는 접을 수 있어야 한다. 브라우저 로그인은 최대 3 분까지
                    // 사람을 기다리는데, 그동안 누를 것이 없으면 갇힌 것과 같다.
                    // 여기서 시작한 시도만 보지 않는다 — 호스트 연결이 올리는 중일 수도 있다.
                    <>
                      {/* 인증이 필요한데 링크가 오지 않는 상태로 갇힐 수 있다(컨트롤 플레인에서
                          노드를 지운 경우 등). 코어가 유예를 넘기면 노드를 새로 만들어 스스로
                          풀지만, 그래도 안 되면 사용자가 할 수 있는 일이 취소뿐이 된다. */}
                      {status?.state === 'needsAuth' && !status.authUrl ? (
                        <Button
                          variant="secondary"
                          onClick={() => void handleRestart(record)}
                        >
                          {translate('misc.restartTailnet')}
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        onClick={() => void handleCancel(record.id)}
                      >
                        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
                        {translate('common.cancel')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => void handleTest(record)}
                      disabled={testingId !== null}
                    >
                      {translate('tailnetSettings.connect')}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={() => setPendingRemoval(record)}
                    disabled={testingId !== null}
                  >
                    {translate('common.delete')}
                  </Button>
                </div>
              </div>

              {status ? (
                <TailnetStatusNotice
                  controlUrl={record.controlUrl}
                  status={status}
                />
              ) : null}

              {isDifferentTailnet(record, status) ? (
                <NoticeCard tone="warning" role="alert">
                  {translate('tailnetSettings.tailnetMismatch', {
                    expected: record.tailnetName,
                    actual: status?.tailnetName,
                  })}
                </NoticeCard>
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}

      <TailnetDeleteConfirmDialog
        record={pendingRemoval}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => void handleRemove()}
      />
    </div>
  );
}

/** 되돌릴 수 없다 — 노드 등록도 저장된 auth key 도 같이 사라진다. */
function TailnetDeleteConfirmDialog({
  record,
  onCancel,
  onConfirm,
}: {
  record: TailnetRecord | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t: translate } = useTranslation();
  if (!record) {
    return null;
  }

  return (
    <DialogBackdrop onDismiss={onCancel}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="delete-tailnet-title">
        <ModalHeader className="block">
          <SectionLabel>{translate('common.delete')}</SectionLabel>
          <h3 id="delete-tailnet-title">{record.label}</h3>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-sm leading-6 text-[var(--text-soft)]">
            {translate('tailnetSettings.removeConfirm')}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onCancel}>
            {translate('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {translate('common.delete')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

/**
 * 붙고 나서 알게 된 것들.
 *
 * Tailscale 기본 서버로 여러 개를 등록하면 설정이 전부 비어 있어 화면에서 구분이 안 된다.
 * 어떤 계정으로 어느 tailnet 에 붙었는지가 유일한 단서라, 붙었으면 그것을 보여 준다.
 */
function TailnetIdentity({
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

/**
 * 연결이 확인된 결과. 값이 있으면 붙은 것이고, 그것이 곧 저장 가능 조건이다.
 *
 * 이름이 없을 수도 있어서(컨트롤 플레인이 안 알려 주는 경우) 차례로 물러선다. 붙었는데
 * 이름이 없다는 이유로 저장을 막으면, 멀쩡한 연결을 두고 사용자가 손쓸 방법이 없어진다.
 */
function connectedTailnet(status: TailnetStatus | undefined): string {
  if (status?.state !== 'running') {
    return '';
  }
  return status.tailnetName || status.nodeName || status.loginName || '';
}

/**
 * 이 설정이 묶인 tailnet 이 아닌 곳에 붙었는가.
 *
 * Tailscale 기본 서버는 설정에 서버 주소조차 없어서 다른 계정으로 로그인해도 겉으로는
 * 똑같아 보인다. 그런데 다른 tailnet 에 같은 이름의 머신이 있으면 엉뚱한 곳으로 연결을
 * 시도하게 된다. 호스트키 검증이 마지막에 막아 주겠지만, 그전에 알려 줘야 한다.
 */
function isDifferentTailnet(
  record: TailnetRecord,
  status: TailnetStatus | undefined,
): boolean {
  if (!record.tailnetName || !status?.tailnetName) {
    return false;
  }
  return record.tailnetName !== status.tailnetName;
}

function TailnetStateBadge({ status }: { status: TailnetStatus }) {
  const { t: translate } = useTranslation();

  if (status.error) {
    return <Badge tone="error">{translate('tailnetSettings.state.failed')}</Badge>;
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
  if (status.state === 'running' && status.ready !== true) {
    return <Badge tone="stopped">{translate('tailnetSettings.state.offline')}</Badge>;
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
function TailnetStatusNotice({
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

function TailnetForm({
  draft,
  status,
  testing,
  testDisabled,
  error,
  onChange,
  onSave,
  onTest,
  onCancelTest,
  onCancel,
}: {
  draft: TailnetDraft;
  status?: TailnetStatus;
  testing: boolean;
  testDisabled: boolean;
  error?: string | null;
  onChange: (next: TailnetDraft) => void;
  onSave: () => void;
  onTest: () => void;
  onCancelTest: () => void;
  onCancel: () => void;
}) {
  const { t: translate } = useTranslation();
  const connected = connectedTailnet(status);

  return (
    <Card tone="muted" as="section" className="flex-col items-stretch gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <FieldGroup label={translate('tailnetSettings.field.label')}>
          <Input
            value={draft.label}
            placeholder={translate('tailnetSettings.field.labelPlaceholder')}
            onChange={(event) => onChange({ ...draft, label: event.target.value })}
          />
        </FieldGroup>

        <FieldGroup label={translate('tailnetSettings.field.controlUrl')}>
          <Input
            value={draft.controlUrl}
            placeholder={translate('tailnetSettings.field.controlUrlPlaceholder')}
            onChange={(event) => onChange({ ...draft, controlUrl: event.target.value })}
          />
        </FieldGroup>

        <FieldGroup label={translate('tailnetSettings.field.authKey')}>
          <Input
            type="password"
            value={draft.authKey}
            placeholder={translate('tailnetSettings.field.authKeyPlaceholder')}
            onChange={(event) => onChange({ ...draft, authKey: event.target.value })}
          />
          {/* 1회용 키는 첫 재등록에서 막힌다. ephemeral 쪽 결과는 삭제할 때 안내한다. */}
          <span className="text-[0.76rem] font-normal leading-[1.45] text-[var(--text-soft)]">
            {translate('tailnetSettings.field.authKeyHint')}
          </span>
        </FieldGroup>
      </div>

      {error ? (
        <NoticeCard tone="danger" role="alert">
          {error}
        </NoticeCard>
      ) : null}

      {status ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <TailnetStateBadge status={status} />
          </div>
          <TailnetStatusNotice
            controlUrl={draft.controlUrl.trim() || undefined}
            status={status}
          />
        </div>
      ) : null}

      {/* 연결 결과. 손으로 채울 수 없고, 연결에 성공해야 값이 생긴다. 저장 조건이 바로
          이 값이라, 버튼이 왜 안 눌리는지 화면만 보고 알 수 있다. */}
      <FieldGroup label={translate('tailnetSettings.field.connectedTo')}>
        <Input
          readOnly
          value={connected}
          placeholder={translate('tailnetSettings.field.connectedToPlaceholder')}
          className="cursor-default"
        />
      </FieldGroup>

      {/* tailnet 이름은 바로 위 읽기 전용 필드에 이미 있다. */}
      {connected && status ? (
        <TailnetIdentity
          loginName={status.loginName}
          nodeName={status.nodeName}
          nodeIp={status.nodeIp}
        />
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {/* 저장하기 전에 시험할 수 있어야 한다. 되는지 확인하고 저장하는 게 순서다. */}
        {testing ? (
          <Button variant="secondary" onClick={onCancelTest}>
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
            {translate('tailnetSettings.stopTest')}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onTest} disabled={testDisabled}>
            {translate('tailnetSettings.test')}
          </Button>
        )}
        {/* 시험이 3분까지 갈 수 있다. 여기서 막으면 사용자가 폼에 갇힌다 — 취소는 진행
            중인 시험을 접겠다는 뜻이므로 언제든 눌릴 수 있어야 한다. */}
        <Button variant="secondary" onClick={onCancel}>
          {translate('common.cancel')}
        </Button>
        {/* 붙는 것을 확인하기 전에 저장해 봐야 쓸 수 없는 설정이 하나 늘 뿐이다.
            연결에 성공해야 tailnet 이름 같은 것도 알 수 있다. */}
        <Button variant="primary" onClick={onSave} disabled={testing || !connected}>
          {translate('common.save')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * 상태 판단의 근거를 그대로 보여준다.
 *
 * "연결됨" 이라고 나오는데 실제로 통신이 안 되는 일이 있다. 그때 화면에 요약만 있으면 무엇을
 * 믿어야 할지 알 수 없다 — 원문 상태, 만료 여부와 그 근거가 되는 만료 시각, 그리고 이 tailnet
 * 에서 몇 대가 보이는지(넷맵을 받고 있는지)를 그대로 드러낸다.
 */
function TailnetDiagnostics({ status }: { status: TailnetStatus }) {
  const parts = [
    `backend=${status.backendState || status.state}`,
    // 판정 결과와 그 근거. 두 화면이 다른 말을 할 때 어느 쪽이 굳은 값인지 이걸로 가른다.
    `ready=${status.ready === true}`,
    `online=${status.online === true}`,
    `expired=${status.expired === true}`,
    status.keyExpiry ? `keyExpiry=${status.keyExpiry}` : null,
    `peers=${status.peers?.length ?? 0}`,
    status.authUrl ? 'authUrl=yes' : null,
  ].filter((part): part is string => part !== null);

  return (
    <p className="mt-1 font-mono text-[0.68rem] leading-[1.5] text-[var(--text-subtle)]">
      {parts.join('  ')}
    </p>
  );
}
