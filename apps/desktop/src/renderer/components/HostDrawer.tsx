import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { LEGACY_TOLERATED_HOST_KINDS, getHostBadgeLabel } from '@shared';
import type { HostRecord, SecretMetadataRecord, SnippetRecord } from '@shared';
import { HostForm, type HostFormActionState, type HostFormHandle, type HostFormProps } from './HostForm';
import { cn } from '../lib/cn';
import { Button, Tooltip } from '../ui';
import { X } from '../ui/icons';
import type { SearchableSelectOption } from '../ui';
import { useTranslation } from 'react-i18next';

type HostCreateKind = 'ssh' | 'serial' | 'rdp' | 'vnc';

// 프로토콜 이름이라 번역하지 않는다(이 컴포넌트의 'New Host'·'Create Host' 와 같은 취급).
const HOST_KIND_TABS: ReadonlyArray<{ kind: HostCreateKind; label: string }> = [
  { kind: 'ssh', label: 'SSH' },
  { kind: 'serial', label: 'Serial' },
  { kind: 'rdp', label: 'RDP' },
  { kind: 'vnc', label: 'VNC' },
];

/**
 * 종류 칸 목록과, 각 칸을 지금 고를 수 있는지.
 *
 * 옛 클라이언트가 모르는 종류(RDP·VNC 등)는 서버가 계정 데이터 수준을 저장할 수 있어야 한다. 못
 * 하는 서버(자체 호스팅 옛 버전)에서 만들면, 같은 계정의 옛 기기가 그 레코드를 받아 조용히
 * 망가진다 — 서버가 막아 줄 수 없는 상태다.
 *
 * **숨기지 않고 비활성으로 둔다.** 없애면 사용자는 그 기능이 아예 없는 줄 알거나, 다른 기기에서는
 * 보이는데 여기서는 안 보이는 이유를 알 수 없다. 비활성 칸에 마우스를 올리면 서버를 업데이트하면
 * 된다고 알려 준다(호출부가 `disabledReason` 을 쓴다).
 *
 * **판정을 종류 이름으로 하지 않는다.** 예전에는 `kind !== 'rdp'` 였는데, 그러면 새 종류를 만들
 * 때마다 이 함수를 기억해야 하고 한 번 잊으면 보호 없이 열린다(데이터 수준 판정도 같은 이유로
 * 일반화했다 — sync-service 의 resolveSyncDataFloor 참고).
 *
 * 이미 만들어 둔 호스트는 그대로 둔다. 이미 올라가 있으므로 가려도 위험이 줄지 않고, 쓰던 것이
 * 사라지는 편이 더 나쁘다.
 */
export function resolveCreatableHostKinds(input: {
  serverSupportsDataFloor: boolean;
}): ReadonlyArray<{ kind: HostCreateKind; label: string; disabled: boolean }> {
  return HOST_KIND_TABS.map((tab) => ({
    ...tab,
    disabled:
      !LEGACY_TOLERATED_HOST_KINDS.has(tab.kind) && !input.serverSupportsDataFloor,
  }));
}

const HOST_KIND_BADGE_LABELS: Record<HostCreateKind, string> = {
  ssh: 'S',
  serial: 'SER',
  rdp: 'RDP',
  vnc: 'VNC',
};

/**
 * 종류 세그먼트. 공용 Tabs 프리미티브(알약형)를 쓰지 않는다 — 그건 AWS 임포트·프로필
 * 위저드·컨테이너 상세가 함께 쓰는 모양이라 여기 맞춰 고치면 그 화면들이 같이 바뀌고,
 * 좁은 드로어에서는 아래 입력들과 폭·라운드가 어긋나 혼자 떠 보인다.
 *
 * 그래서 Input 과 같은 rounded-[10px]·같은 테두리·같은 배경으로 트랙을 만들고 3등분해 풀폭으로
 * 깐다.
 *
 * 선택 표시는 명도가 아니라 강조색 틴트로 한다(--selection-tint/-border). surface-* 토큰들은
 * 서로 몇 단위 차이라(라이트 elevated 255,255,255 vs strong 250,252,255 / 다크 16,28,43 vs
 * 18,32,48) 흰 칸을 얹는 방식으로는 어느 테마에서도 보이지 않는다.
 */
const KIND_SEGMENT_TRACK_CLASS =
  // 칸 수는 서버 능력에 따라 달라진다(resolveCreatableHostKinds). 3등분으로 고정해 두면 네 번째
  // 칸이 줄바꿈되므로 자동 열로 둔다.
  'grid auto-cols-fr grid-flow-col gap-[0.15rem] rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] p-[0.2rem]';

// 비활성 칸도 같은 굵기의 투명 테두리를 둬서 선택이 옮겨갈 때 칸 크기가 흔들리지 않게 한다.
const KIND_SEGMENT_BASE_CLASS =
  'rounded-[7px] border py-[0.5rem] text-[0.85rem] font-semibold transition-[background-color,border-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]';

interface HostDrawerProps {
  open: boolean;
  mode: 'create' | 'edit';
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  jumpHostOptions?: SearchableSelectOption[];
  /** 점프 후보별 tailnet 이름. 폼이 "첫 홉의 tailnet 을 탄다" 를 말하는 데 쓴다. */
  jumpHostTailnetNames?: Record<string, string>;
  tailnetOptions?: Array<{ id: string; label: string }>;
  snippets?: SnippetRecord[];
  defaultGroupPath?: string | null;
  /** 생성 모드를 열 때의 초기 종류. 이후 종류는 폼 맨 위 셀렉터로 사용자가 고른다. */
  createKind?: HostCreateKind;
  /**
   * 붙어 있는 서버가 계정 데이터 수준을 저장·판정할 수 있는가(resolveCreatableHostKinds 참고).
   *
   * 기본 false — 아직 /api/info 를 못 읽었거나 오프라인이면 만들 수 있다고 보지 않는다. 잘못
   * 열어 주면 같은 계정의 옛 기기가 망가지고, 그건 되돌리기 어렵다.
   */
  serverSupportsDataFloor?: boolean;
  desktopPlatform?: 'darwin' | 'win32' | 'linux' | 'unknown';
  onClose: () => void;
  onSubmit: HostFormProps['onSubmit'];
  onConnect?: HostFormProps['onConnect'];
  onEditExistingSecret?: (secretRef: string) => void;
  /** tailnet 이 새로 추가됐을 때 — 상위가 목록을 다시 읽는다. */
  onTailnetAdded?: () => void | Promise<void>;
}

/**
 * 상위(HomeShell)가 편집 상태를 물어볼 창구.
 *
 * 편집 중에 목록에서 다른 호스트를 고르면 편집 대상을 갈아타는데, 자동저장이 아니라서 저장하지
 * 않은 변경이 있는지 먼저 알아야 한다. dirty 를 렌더마다 위로 올리면(콜백) 타이핑마다 상위가
 * 다시 그려지므로, 필요한 순간에만 물어보는 명령형 창구로 둔다.
 */
export interface HostDrawerHandle {
  isDirty: () => boolean;
  /** 편집 중인 내용을 저장한다. 저장했으면 true. */
  save: () => Promise<boolean>;
}

export const HostDrawer = forwardRef<HostDrawerHandle, HostDrawerProps>(function HostDrawer({
  open,
  mode,
  host,
  keychainEntries,
  groupOptions,
  jumpHostOptions = [],
  jumpHostTailnetNames = {},
  tailnetOptions = [],
  snippets = [],
  defaultGroupPath = null,
  createKind = 'ssh',
  serverSupportsDataFloor = false,
  desktopPlatform = 'unknown',
  onClose,
  onSubmit,
  onConnect,
  onEditExistingSecret,
  onTailnetAdded
}: HostDrawerProps, ref) {
  const { t: translate } = useTranslation();
  const drawerRef = useRef<HTMLElement | null>(null);
  const hostFormRef = useRef<HostFormHandle | null>(null);
  const [isActionInFlight, setIsActionInFlight] = useState(false);
  const [formActionState, setFormActionState] = useState<HostFormActionState>({
    saveInFlight: false,
    saveStatusText: null,
  });
  const isFooterBusy = isActionInFlight || formActionState.saveInFlight;
  const formHost = host;
  // 헤더의 굵은 이름을 편집 가능한 타이틀로 쓴다(예전 정적 h2 자리). label 상태의 원본은
  // HostForm 의 draft 이고, 폼→헤더는 onLabelChange 로, 헤더→폼은 ref.setLabel 로 동기화한다.
  const [headerLabel, setHeaderLabel] = useState(host?.label ?? '');
  // 폼 내부에서 label 이 바뀌면(호스트 하이드레이션·hostname 자동 파생 등) 헤더 입력에 반영.
  const handleFormLabelChange = useCallback((label: string) => {
    setHeaderLabel(label);
  }, []);
  // 헤더 입력 편집: 컨트롤드 입력이라 즉시 headerLabel 을 갱신하고, 폼 draft 에도 되돌린다.
  const handleHeaderLabelInput = useCallback((value: string) => {
    setHeaderLabel(value);
    hostFormRef.current?.setLabel(value);
  }, []);

  // 생성 모드는 종류를 폼 안에서 고른다 — SSH·Serial·RDP 마다 따로 있던 입구를 하나로 모은
  // 자리다. 스토어가 준 createKind 로 시작하고(기본 SSH), 그 뒤로는 이 로컬 상태가 원본이다.
  // HostForm 은 createKind 가 바뀌면 그 종류의 빈 draft 로 스스로 갈아탄다.
  const [selectedKind, setSelectedKind] = useState<HostCreateKind>(createKind);
  const creatableKinds = resolveCreatableHostKinds({ serverSupportsDataFloor });
  // 드로어를 다시 열면(스토어가 createKind 를 새로 정함) 그 값에서 다시 시작한다.
  useEffect(() => {
    setSelectedKind(createKind);
  }, [createKind]);

  // 종류를 바꾸면 폼이 draft 를 리셋하므로 라벨도 비워진다. 라벨 입력이 셀렉터 바로 위에
  // 있어서 눈앞에서 사라지면 어색하니, 사용자가 적어 둔 라벨만 되돌려준다.
  const labelToRestoreRef = useRef<string | null>(null);
  const handleKindChange = useCallback(
    (kind: HostCreateKind) => {
      if (kind === selectedKind) {
        return;
      }
      labelToRestoreRef.current = headerLabel.trim() ? headerLabel : null;
      setSelectedKind(kind);
    },
    [headerLabel, selectedKind],
  );
  // 자식(HostForm)의 리셋 이펙트가 부모보다 먼저 도므로, 여기서 되돌리면 리셋 뒤에 적용된다.
  useEffect(() => {
    const pendingLabel = labelToRestoreRef.current;
    if (pendingLabel === null) {
      return;
    }
    labelToRestoreRef.current = null;
    setHeaderLabel(pendingLabel);
    hostFormRef.current?.setLabel(pendingLabel);
  }, [selectedKind]);
  // Overview(HostDetailPanel) 헤더와 같은 뱃지 로직을 써서 편집 헤더도 동일한 모양으로 맞춘다.
  // 생성 모드는 아직 호스트가 없으므로 지금 고른 종류 기준 대체 라벨을 보여준다(저장 후
  // getHostBadgeLabel 이 내는 값과 같게 맞춰 뱃지가 바뀌지 않게 한다).
  const headerBadgeLabel = formHost
    ? getHostBadgeLabel(formHost)
    : HOST_KIND_BADGE_LABELS[selectedKind];

  useImperativeHandle(ref, () => ({
    isDirty: () => hostFormRef.current?.isDirty() ?? false,
    save: async () => {
      if (!hostFormRef.current) {
        return false;
      }
      // 생성 중이면 저장이 곧 "만들기" 다. 확인 창의 선택지가 취소/저장 둘뿐이라, 여기서 막으면
      // 작성 중인 내용을 들고 앞으로 갈 방법이 없어진다(버리려면 X 로 닫는다).
      return mode === 'create'
        ? hostFormRef.current.submitCreate()
        : hostFormRef.current.submit();
    },
  }), [mode]);

  async function handlePrimaryAction() {
    if (!hostFormRef.current) {
      return;
    }
    setIsActionInFlight(true);
    try {
      if (mode === 'create') {
        await hostFormRef.current.submitCreate();
        return;
      }
      // 저장에 성공하면 편집 폼을 닫아 호스트 상세 화면으로 돌아간다.
      const saved = await hostFormRef.current.submit();
      if (saved) {
        onClose();
      }
    } finally {
      setIsActionInFlight(false);
    }
  }

  // 패널에 transform(translate-x 슬라이드)을 두면 내부 fixed 다이얼로그(SSH 키 생성 등)의 기준이
  // 이 좁은 패널로 잡혀 갇히므로, 애니메이션을 빼서 다이얼로그가 앱 중앙에 뜨게 한다.
  return (
    <aside
      ref={drawerRef}
      className="flex min-w-0 min-h-0 h-full flex-col overflow-hidden border-l border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--app-bg)_8%)]"
      aria-hidden={!open}
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-[0.7rem] pb-[0.7rem] pt-[0.9rem]">
        <div className="flex min-w-0 items-center gap-[0.55rem]">
          <span
            className="inline-grid h-[2rem] min-w-[2rem] place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--accent-strong)_68%,var(--chrome-bg)_32%)] px-[0.4rem] text-[0.7rem] font-bold text-white"
            aria-hidden="true"
          >
            {headerBadgeLabel}
          </span>
          <input
            type="text"
            value={headerLabel}
            onChange={(event) => handleHeaderLabelInput(event.target.value)}
            placeholder={mode === 'create' ? 'New Host' : 'Label'}
            aria-label="Label"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-[6px] bg-transparent px-[0.35rem] py-[0.15rem] text-[1rem] font-bold text-[var(--text)] outline-none transition-colors duration-140 placeholder:font-normal placeholder:text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_78%,transparent_22%)] focus:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]"
          />
        </div>
        {/* Overview(HostDetailPanel) 상세 닫기와 동일한 고스트 스타일 X 버튼으로 맞춘다. */}
        <button
          type="button"
          aria-label="Close host editor"
          className="inline-grid h-[1.9rem] w-[1.9rem] place-items-center rounded-[10px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
          onClick={onClose}
        >
          <X className="h-[1.05rem] w-[1.05rem]" />
        </button>
      </div>

      <div
        data-testid="drawer-scroll-body"
        className="min-h-0 flex-1 overflow-y-auto px-[0.7rem] pb-[1.3rem] pt-[1.1rem]"
      >
        {mode === 'create' ? (
          <div className={cn(KIND_SEGMENT_TRACK_CLASS, 'mb-[1.1rem]')} aria-label="Host type">
            {creatableKinds.map((tab) => {
              const isSelected = selectedKind === tab.kind;
              const disabledReason = tab.disabled
                ? translate('hostDrawer.kindNeedsServerUpdate', { kind: tab.label })
                : undefined;
              const button = (
                <button
                  type="button"
                  aria-pressed={isSelected}
                  disabled={tab.disabled}
                  title={disabledReason}
                  className={cn(
                    KIND_SEGMENT_BASE_CLASS,
                    'w-full',
                    tab.disabled
                      ? // 비활성도 자리를 지킨다 — 칸이 사라지면 다른 기기와 화면이 달라 보인다.
                        //
                        // pointer-events-none 이 필요하다: 비활성 버튼은 마우스 이벤트를 삼켜서
                        // 감싼 span 의 hover 가 안 잡히고, 그러면 툴팁이 뜨지 않는다.
                        // 커서 모양은 감싼 래퍼가 낸다 — pointer-events-none 인 요소에는
                        // cursor 가 적용되지 않는다.
                        'pointer-events-none border-transparent text-[var(--text-soft)] opacity-45'
                      : isSelected
                        ? 'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]'
                        : 'border-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_70%,transparent_30%)] hover:text-[var(--text)]',
                  )}
                  onClick={() => handleKindChange(tab.kind)}
                >
                  {tab.label}
                </button>
              );

              if (!tab.disabled) {
                return <Fragment key={tab.kind}>{button}</Fragment>;
              }
              // 왜 못 고르는지 말해 준다. 비활성 버튼만 두면 사용자는 고장으로 읽는다.
              //
              // `title` 은 비활성 컨트롤에서 뜨지 않으므로(브라우저가 마우스 이벤트를 주지 않는다)
              // 실제로 보이는 것은 이 Tooltip 이다. title 은 접근성 도구용으로 남긴다.
              return (
                <Tooltip
                  key={tab.kind}
                  className="w-full cursor-not-allowed"
                  label={disabledReason ?? ''}
                >
                  {button}
                </Tooltip>
              );
            })}
          </div>
        ) : null}

        <HostForm
          ref={hostFormRef}
          hideTitle
          host={formHost}
          keychainEntries={keychainEntries}
          groupOptions={groupOptions}
          jumpHostOptions={jumpHostOptions}
          jumpHostTailnetNames={jumpHostTailnetNames}
          tailnetOptions={tailnetOptions}
          snippets={snippets}
          defaultGroupPath={defaultGroupPath}
          createKind={selectedKind}
          desktopPlatform={desktopPlatform}
          onSubmit={onSubmit}
          onConnect={onConnect}
          onEditExistingSecret={onEditExistingSecret}
          onTailnetAdded={onTailnetAdded}
          onActionStateChange={setFormActionState}
          onLabelChange={handleFormLabelChange}
        />
      </div>

      <div
        data-testid="drawer-footer"
        className="shrink-0 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--app-bg)_8%)] px-[0.7rem] pb-[1.3rem] pt-[0.9rem]"
      >
        <div className="flex gap-[0.7rem]">
          <Button
            variant="primary"
            className="flex-1 rounded-[10px] border border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--surface-elevated)_90%,var(--accent-strong)_10%)] px-[1.1rem] py-[0.9rem] font-[650] text-[var(--text)] shadow-none transition-[border-color,background-color,color] duration-160 hover:border-[color-mix(in_srgb,var(--accent-strong)_40%,var(--border)_60%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_84%,var(--accent-strong)_16%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_60%,white_40%)] focus-visible:ring-offset-2"
            disabled={isFooterBusy}
            onClick={async () => {
              await handlePrimaryAction();
            }}
          >
            {mode === 'create' ? 'Create Host' : translate('common.save')}
          </Button>
        </div>
        {mode === 'edit' && formActionState.saveStatusText ? (
          <div
            className={cn(
              'mt-[0.55rem] text-[0.82rem] leading-[1.4] text-[var(--text-soft)]',
              formActionState.saveStatusText === "Couldn't save changes" &&
                'text-[color-mix(in_srgb,var(--danger)_82%,white_18%)]',
            )}
          >
            {formActionState.saveStatusText}
          </div>
        ) : null}
      </div>
    </aside>
  );
});
