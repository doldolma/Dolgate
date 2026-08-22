import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isRdpHostRecord,
  isSshHostRecord,
  isVncHostRecord,
  type RdpHostRecord,
  type SshHostRecord,
  type TailnetRecord,
  type TailnetStatus,
  type VncHostRecord,
} from '@shared';
import {
  Badge,
  Button,
  Card,
  CardMain,
  EmptyState,
  FieldGroup,
  InfoHint,
  InfoHintPoints,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
} from '../ui';
import { DialogBackdrop } from './DialogBackdrop';
import { RefreshCw, SquareTerminal } from '../ui/icons';
import { useAppStore } from '../store/appStore';
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts';
import {
  deriveTailnetLabel,
  useTailnetDraft,
} from '../controllers/useTailnetDraft';
import { TailnetForm } from './tailnet/TailnetForm';
import {
  isAttempting,
  TailnetIdentity,
  TailnetStateBadge,
  TailnetStatusNotice,
} from './tailnet/TailnetStatusViews';
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


// 스냅샷을 다시 읽는 간격.
//
// tailnet 상태에는 밀어 주는 채널이 없다 — 코어는 연결 시험 중에만 상태 이벤트를 낸다. 그래서
// 화면이 열려 있는 동안은 이쪽에서 읽는다. 만료로 노드가 떨어지는 것을 화면을 열어 둔 채로
// 지켜볼 수 있어야 하므로 1 초로 둔다(읽기 한 번은 코어 안의 상태 조회라 값싸다).
const snapshotPollIntervalMs = 1000;
import {
  isTailnetHostnameExact,
  normalizeTailnetHostname,
} from '../lib/tailnet-hostname';

/**
 * 이 기기가 tailnet 에 등록할 이름을 정하는 칸.
 *
 * 비워 두면 코어가 정하는 기본값(`dolgate-<기기이름>`)을 쓴다. 값은 기기마다 달라야 해서
 * 동기화하지 않는다 — 같은 이름이면 컨트롤 플레인이 `-1`, `-2` 를 붙인다.
 *
 * 이름을 바꿔도 연결은 끊기지 않는다. 코어는 이름만 바뀐 변경으로는 노드를 버리지 않고,
 * 저장해 뒀다가 노드가 다음에 만들어질 때 쓴다 — 같은 노드키라 재인증도 없다.
 */
function LocalNodeNameField({ defaultName }: { defaultName: string | null }) {
  const { t: translate } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const saved = settings?.tailnetHostname ?? '';
  const [value, setValue] = useState(saved);
  // 저장된 값이 밖에서 바뀌면(다른 화면·재로드) 입력도 따라간다.
  useEffect(() => {
    setValue(saved);
  }, [saved]);

  const normalized = normalizeTailnetHostname(value);
  const dirty = normalized !== saved.trim();
  // 입력한 그대로 등록되지 않으면 무엇으로 등록될지 보여 준다. 컨트롤 플레인이
  // 어차피 다듬으므로, 말해 주지 않으면 목록에서 다른 이름을 보고 당황한다.
  const willDiffer = value.trim().length > 0 && !isTailnetHostnameExact(value);

  const commit = () => {
    if (!dirty) {
      return;
    }
    setValue(normalized);
    void updateSettings({ tailnetHostname: normalized || null });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label
        className="shrink-0 text-[0.85rem] text-[var(--text-soft)]"
        htmlFor="tailnet-node-hostname"
      >
        {translate('tailnetSettings.field.nodeName')}
      </label>
      <Input
        id="tailnet-node-hostname"
        className="w-[15rem]"
        value={value}
        placeholder={defaultName ?? ''}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
        }}
      />
      {/* 값을 건드렸을 때만 말한다.
          평소에도 글자를 두면 입력 양옆에 같은 크기·색 문구가 놓여 어느 것이 라벨인지 알 수
          없다. 손댄 뒤에만 뜨면 라벨과 경쟁하는 설명이 아니라 내 행동에 대한 응답으로 읽힌다.
          "이 기기에만 저장된다"는 라벨의 "이 기기의" 가 이미 말해 준다. */}
      {willDiffer || dirty ? (
        <span className="text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
          {willDiffer
            ? translate('tailnetSettings.field.nodeNameNormalized', {
                name: normalized || (defaultName ?? ''),
              })
            : translate('tailnetSettings.field.nodeNamePending')}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 빈 상태에서 알려줄 것은 "이게 무엇인가"가 아니라 "그래서 뭘 하면 되는가"다.
 *
 * 무엇인가는 바로 위 설명 줄이 이미 말한다. 같은 층위의 설명을 한 번 더 놓으면 둘 다 안
 * 읽힌다. 이 자리는 등록·지정·연결이라는 순서를 처음 보는 사람이 짐작하기 어려워서 있다 —
 * 네트워크만 추가해도 아무 일이 없고, 호스트 쪽에서 지정해야 비로소 경유한다.
 */
function TailnetUsageSteps() {
  const { t: translate } = useTranslation();
  const steps = [
    'tailnetSettings.stepAdd',
    'tailnetSettings.stepAssign',
    'tailnetSettings.stepConnect',
  ];
  return (
    <ol className="m-0 grid list-none gap-2 p-0 text-left text-[0.85rem] text-[var(--text-soft)]">
      {steps.map((key, index) => (
        <li key={key} className="flex items-start gap-2.5">
          <span
            className="mt-[0.1rem] inline-flex h-[1.15rem] w-[1.15rem] shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[0.7rem] font-medium text-[var(--text)]"
            aria-hidden
          >
            {index + 1}
          </span>
          <span>{translate(key)}</span>
        </li>
      ))}
    </ol>
  );
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

  // 상태는 스토어 한곳에서 온다. 화면마다 따로 읽으면 설정과 터미널이 서로 다른 말을 한다.
  const statusById = useAppStore((state) => state.tailnetStatuses);
  const localNodeName = useAppStore((state) => state.localTailnetNodeName);
  const hosts = useAppStore((state) => state.hosts);
  const refreshHostCatalog = useAppStore((state) => state.refreshHostCatalog);

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
  // 초안(시험 → 저장) 컨트롤러. 호스트 폼의 추가 팝업이 같은 훅을 쓴다 — 복사하면 한쪽이
  // 미저장 노드 정리를 잃는다.
  const {
    draft,
    setDraft,
    beginDraft,
    testingId,
    test: handleTest,
    cancelTest: handleCancel,
    saveDraft,
    discardDraft: handleCancelDraft,
  } = useTailnetDraft({ setError });
  /**
   * 이 기기가 tailnet 에 등록할 때 쓰는 이름.
   *
   * 노드 이름은 사용자가 정하지 않고 기기 이름에서 자동으로 만든다. 그래서 기기 목록에서
   * 어느 항목이 이 기기인지 알려면 그 이름을 화면에 보여 줘야 한다. 값은 Go 가 정하므로
   * 여기서 다시 계산하지 않고 받아 온다.
   */

  // 이미 연 인증 URL. 같은 URL 로 창을 여러 번 띄우지 않는다.
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

  // 저장은 훅이 하고, 목록 재조회는 이 화면의 몫이다(훅은 레코드 목록을 모른다).
  const handleSave = useCallback(async () => {
    const saved = await saveDraft();
    if (saved) {
      await refresh();
    }
  }, [refresh, saveDraft]);

  // 다시 시도는 따로 없다 — 연결 버튼이 그것이다.
  //
  // "처음부터 다시 밟아라" 를 화면에서 조립하지 않는다. 붙어 있으면 그대로 쓰고, 링크가 오지
  // 않으면 코어가 스스로 노드를 다시 세운다. 확실히 처음부터 하려면 취소를 먼저 누르면 되고,
  // 취소가 노드를 없애므로 뒤이은 연결이 새 노드로 시작한다.

  const handleDisconnect = useCallback(async (record: TailnetRecord) => {
    setError(null);
    try {
      await disconnectTailnet(record.id);
      applyTailnetStatus({ id: record.id, state: 'stopped' });
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
    }
  }, []);

  const handleRemove = useCallback(async () => {
    if (!pendingRemoval) {
      return;
    }
    setError(null);
    try {
      await removeTailnet(pendingRemoval.id);
      // 삭제는 이 Tailnet 을 사용하던 호스트의 tailnetId 도 함께 비운다. 메인의 저장값만
      // 바뀌고 렌더러 목록이 낡아 있으면 바로 누른 연결이 여전히 Tailnet 준비 경로로 가므로
      // 삭제 대화상자를 닫기 전에 호스트 목록을 다시 읽는다.
      await refreshHostCatalog();
      // 인증 방식으로 분기하지 않는다. 노드가 실제로 지워지는 것은 ephemeral 속성이 켜진
      // 키로 등록했을 때뿐이고, 그것은 우리가 알 수 없다 — 우리가 보내는 ephemeral 요청은
      // 키가 있으면 키에 밀리고, Headscale 은 브라우저 경로에서 아예 무시한다.
      setRemovedPersistent(pendingRemoval.controlUrl ? 'headscale' : 'tailscale');
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
    }
    setPendingRemoval(null);
    await refresh();
  }, [pendingRemoval, refresh, refreshHostCatalog]);

  const hostsByTailnetId = useMemo(() => {
    const grouped = new Map<string, TailnetCapableHost[]>();
    for (const host of hosts) {
      // **SSH 만 세면 안 된다.** RDP·VNC 도 tailnetId 를 갖는다. 빠뜨리면 그 tailnet 이 "쓰는 호스트
      // 없음" 으로 보여서, 지울 때 경고가 없고 지운 뒤 그 호스트들이 조용히 못 붙는다.
      if (!isSshHostRecord(host) && !isRdpHostRecord(host) && !isVncHostRecord(host)) {
        continue;
      }
      const tailnetId = host.tailnetId?.trim();
      if (!tailnetId) {
        continue;
      }
      const entries = grouped.get(tailnetId) ?? [];
      entries.push(host);
      grouped.set(tailnetId, entries);
    }
    for (const entries of grouped.values()) {
      entries.sort((left, right) => left.label.localeCompare(right.label));
    }
    return grouped;
  }, [hosts]);

  const rows = useMemo(
    () =>
      records.map((record) => ({
        record,
        status: statusById[record.id],
        hosts: hostsByTailnetId.get(record.id) ?? [],
      })),
    [hostsByTailnetId, records, statusById],
  );

  return (
    <div className="grid gap-5">
      {/* 호스트명은 제목 블록 밖에 둔다. 안에 넣으면 헤더가 다섯 줄로 불어나고, 추가 버튼이
          그 블록 바닥에 정렬돼(items-end) 붕 뜬다. 제목·설명·버튼은 한 줄로 두고, 기기 설정은
          구분선 아래 제 행을 갖는다. */}
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {/* 상단 탭이 이미 "Tailscale" 이라 여기서 한 번 더 말하지 않는다. */}
            <h3 className="m-0 flex items-center gap-2">
              {translate('tailnetSettings.heading')}
              {/* 아래 설명 줄은 tailnet 이 무엇인지, 빈 상태는 쓰는 순서, 이 말풍선은 "내
                  컴퓨터에 무엇이 생기나" — 셋이 각각 다른 물음에 답해야 서로를 밀어내지 않는다. */}
              <InfoHint label={translate('tailnetSettings.aboutToggle')}>
                <InfoHintPoints
                  items={[
                    translate('tailnetSettings.aboutNoClient'),
                    translate('tailnetSettings.aboutNoOsChange'),
                    translate('tailnetSettings.aboutMultiple'),
                  ]}
                />
              </InfoHint>
            </h3>
            <p className="mb-0 mt-2 max-w-[46rem] text-[0.9rem] text-[var(--text-soft)]">
              {translate('tailnetSettings.description')}
            </p>
          </div>

          <Button
            variant="primary"
            onClick={beginDraft}
            disabled={draft !== null}
          >
            {translate('tailnetSettings.add')}
          </Button>
        </div>

        <div className="border-t border-[var(--border)] pt-4">
          <LocalNodeNameField defaultName={localNodeName} />
        </div>
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
        // 이 기능을 처음 보는 사람의 물음은 여기서 딱 한 번 생긴다. 화면이 비어 있는 지금이
        // 설명할 자리이고, 하나라도 등록하면 사라지므로 매일 쓰는 사람에게는 비용이 없다.
        <EmptyState title={translate('tailnetSettings.empty')}>
          <TailnetUsageSteps />
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <div className="grid gap-3">
          {rows.map(({ record, status, hosts: usingHosts }) => (
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
                  <TailnetHostUsage hosts={usingHosts} />
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
                    // 진행 중에 내밀 수 있는 것은 취소뿐이다. 결과가 나오지 않은 상태에서
                    // "다시 시도" 는 모순이고, 링크가 오지 않는 경우는 코어가 스스로 노드를
                    // 다시 세워 푼다(그 횟수는 아래 상태 줄에 나온다).
                    <Button
                      variant="secondary"
                      onClick={() => void handleCancel(record.id)}
                    >
                      <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
                      {translate('common.cancel')}
                    </Button>
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
        hostCount={
          pendingRemoval ? (hostsByTailnetId.get(pendingRemoval.id)?.length ?? 0) : 0
        }
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => void handleRemove()}
      />
    </div>
  );
}

/** 되돌릴 수 없다 — 노드 등록도 저장된 auth key 도 같이 사라진다. */
function TailnetDeleteConfirmDialog({
  record,
  hostCount,
  onCancel,
  onConfirm,
}: {
  record: TailnetRecord | null;
  hostCount: number;
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
            {translate(
              hostCount > 0
                ? 'tailnetSettings.removeConfirmInUse'
                : 'tailnetSettings.removeConfirm',
              { count: hostCount },
            )}
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
type TailnetCapableHost = SshHostRecord | RdpHostRecord | VncHostRecord;

function TailnetHostUsage({ hosts }: { hosts: TailnetCapableHost[] }) {
  const { t: translate } = useTranslation();
  if (hosts.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="mb-2 text-[0.76rem] font-medium text-[var(--text-soft)]">
        {translate('tailnetSettings.usedByHosts', { count: hosts.length })}
      </div>
      <ul className="m-0 max-h-32 list-none space-y-1.5 overflow-y-auto p-0 pr-1 text-[0.8rem]">
        {hosts.map((host) => {
          // 계정은 SSH 레코드에만 있다. RDP·VNC 는 자격증명에 들어 있어 여기서는 주소만 보여준다.
          const account = isSshHostRecord(host) && host.username ? `${host.username}@` : '';
          const endpoint = `${account}${host.hostname}:${host.port}`;
          return (
            <li key={host.id} className="flex min-w-0 items-center gap-2">
              <SquareTerminal
                className="h-3.5 w-3.5 flex-none text-[var(--text-subtle)]"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-medium" title={host.label}>
                {host.label}
              </span>
              <span
                className="min-w-0 max-w-[60%] truncate font-mono text-[0.74rem] text-[var(--text-soft)]"
                title={endpoint}
              >
                {endpoint}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 연결이 확인된 결과. 값이 있으면 붙은 것이고, 그것이 곧 저장 가능 조건이다.
 *
 * 이름이 없을 수도 있어서(컨트롤 플레인이 안 알려 주는 경우) 차례로 물러선다. 붙었는데
 * 이름이 없다는 이유로 저장을 막으면, 멀쩡한 연결을 두고 사용자가 손쓸 방법이 없어진다.
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
