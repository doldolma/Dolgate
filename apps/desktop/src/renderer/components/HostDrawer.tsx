import { useCallback, useRef, useState } from 'react';
import { getHostBadgeLabel } from '@shared';
import type { HostRecord, SecretMetadataRecord, SnippetRecord } from '@shared';
import { HostForm, type HostFormActionState, type HostFormHandle, type HostFormProps } from './HostForm';
import { cn } from '../lib/cn';
import { Button } from '../ui';
import { X } from '../ui/icons';
import type { SearchableSelectOption } from '../ui';
import { useTranslation } from 'react-i18next';

interface HostDrawerProps {
  open: boolean;
  mode: 'create' | 'edit';
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  jumpHostOptions?: SearchableSelectOption[];
  tailnetOptions?: Array<{ id: string; label: string }>;
  snippets?: SnippetRecord[];
  defaultGroupPath?: string | null;
  createKind?: 'ssh' | 'serial' | 'rdp';
  desktopPlatform?: 'darwin' | 'win32' | 'linux' | 'unknown';
  onClose: () => void;
  onSubmit: HostFormProps['onSubmit'];
  onConnect?: HostFormProps['onConnect'];
  onEditExistingSecret?: (secretRef: string) => void;
  onOpenSecrets?: () => void;
  onOpenTailnets?: () => void;
}

export function HostDrawer({
  open,
  mode,
  host,
  keychainEntries,
  groupOptions,
  jumpHostOptions = [],
  tailnetOptions = [],
  snippets = [],
  defaultGroupPath = null,
  createKind = 'ssh',
  desktopPlatform = 'unknown',
  onClose,
  onSubmit,
  onConnect,
  onEditExistingSecret,
  onOpenSecrets,
  onOpenTailnets
}: HostDrawerProps) {
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
  // Overview(HostDetailPanel) 헤더와 같은 뱃지 로직을 써서 편집 헤더도 동일한 모양으로 맞춘다.
  // 생성 모드는 아직 호스트가 없으므로 createKind 기준 대체 라벨을 보여준다.
  const headerBadgeLabel = formHost
    ? getHostBadgeLabel(formHost)
    : createKind === 'serial'
      ? 'SER'
      : 'S';

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
        <HostForm
          ref={hostFormRef}
          hideTitle
          host={formHost}
          keychainEntries={keychainEntries}
          groupOptions={groupOptions}
          jumpHostOptions={jumpHostOptions}
          tailnetOptions={tailnetOptions}
          snippets={snippets}
          defaultGroupPath={defaultGroupPath}
          createKind={createKind}
          desktopPlatform={desktopPlatform}
          onSubmit={onSubmit}
          onConnect={onConnect}
          onEditExistingSecret={onEditExistingSecret}
          onOpenSecrets={onOpenSecrets}
          onOpenTailnets={onOpenTailnets}
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
}
