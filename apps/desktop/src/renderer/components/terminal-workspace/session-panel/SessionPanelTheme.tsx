// 테마 섹션. 글꼴·크기·행간·자간·최소 대비(전역 설정)가 위, 테마 목록이 아래다.
//
// 글꼴 쪽은 SessionPanelAppearance 가 쥔다. 테마는 앱 외형이 아니라 **이 호스트의 터미널 테마**다.
//
// 값을 여기에 따로 두지 않는다 — 호스트 편집에 이미 있는 `terminalThemeId` 를 그대로 읽고 쓴다.
// 두 곳이 서로 다른 값을 들면 어느 쪽이 맞는지 알 수 없게 된다.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalThemeId } from '@shared';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/appStore';
import {
  getTerminalThemePreset,
  resolveGlobalTerminalThemeId,
  terminalThemePresets,
  type TerminalThemeDefinition,
} from '../../../lib/terminal-presets';
import { Check } from '../../../ui/icons';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelAppearance } from './SessionPanelAppearance';

interface SessionPanelThemeProps {
  /** 이 세션의 호스트. 로컬 터미널처럼 호스트가 없으면 null. */
  hostId: string | null;
}

/**
 * 팔레트 썸네일.
 *
 * 이름만으로는 무엇을 고르는지 알 수 없다. 그렇다고 예전처럼 가로 폭을 다 쓰는 미리보기를
 * 깔면 한 화면에 세 개밖에 안 들어가 아래쪽 테마는 있는 줄도 모르게 된다. 배경 위에 색 네
 * 줄이면 밝기와 색조는 충분히 갈린다 — 나머지는 골라서 터미널에서 바로 보면 된다.
 */
function ThemeThumbnail({ theme }: { theme: TerminalThemeDefinition['theme'] }) {
  return (
    <span
      className="flex h-12 w-[4.6rem] shrink-0 flex-col justify-center gap-1 overflow-hidden rounded-[8px] px-2 shadow-[inset_0_0_0_1px_var(--border)]"
      style={{ background: theme.background }}
      aria-hidden
    >
      {THUMBNAIL_BARS.map(({ key, width }) => (
        <span
          key={key}
          className="h-[5px] rounded-[3px]"
          style={{ width, background: theme[key] }}
        />
      ))}
    </span>
  );
}

/** 썸네일에 그릴 네 줄. 폭을 달리해 터미널 출력처럼 보이게 한다. */
const THUMBNAIL_BARS = [
  { key: 'green', width: '72%' },
  { key: 'yellow', width: '46%' },
  { key: 'blue', width: '60%' },
  { key: 'brightBlack', width: '34%' },
] as const;

export function SessionPanelTheme({ hostId }: SessionPanelThemeProps) {
  const { t: translate } = useTranslation();
  const host = useAppStore((state) =>
    hostId ? (state.hosts.find((entry) => entry.id === hostId) ?? null) : null,
  );
  const globalThemeId = useAppStore((state) => state.settings?.globalTerminalThemeId);
  const setHostTerminalTheme = useAppStore((state) => state.setHostTerminalTheme);
  // 저장이 실패하면 말해 준다. 예전에는 `void` 로 던져 버려서 아무 반응이 없었고, 그러면
  // "골라도 작동을 안 한다" 와 "저장이 실패했다" 를 구분할 수 없다.
  const [error, setError] = useState<string | null>(null);

  // 호스트가 없는 세션(로컬 터미널)에는 고를 테마가 없다. 글꼴은 전역이라 그대로 쓸 수 있으므로
  // 섹션 전체를 비우지 않는다 — 예전에는 여기서 빈 화면만 보여 줬다.
  if (!host) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SessionPanelAppearance />
        <div className="border-t border-[var(--border)] px-1.5 py-2">
          <SessionPanelEmpty
            title={translate('sessionPanel.theme.noHostTitle')}
            description={translate('sessionPanel.theme.noHost')}
          />
        </div>
      </div>
    );
  }

  const selected = host.terminalThemeId ?? null;

  const choose = (themeId: TerminalThemeId | null) => {
    if (themeId === selected) {
      return;
    }
    setError(null);
    void setHostTerminalTheme(host.id, themeId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SessionPanelAppearance />
      <div className="flex flex-col gap-0.5 border-t border-[var(--border)] px-2 pb-2 pt-2">
        {error ? (
          <p className="mx-1 mb-1.5 rounded-[8px] bg-[var(--danger-bg)] px-2.5 py-1.5 text-[0.72rem] leading-[1.45] text-[var(--danger-text)]">
            {translate('sessionPanel.theme.saveFailed', { message: error })}
          </p>
        ) : null}
        {/* 앱 설정을 따를 때 실제로 무엇이 나오는지는 썸네일이 말해 준다 — 문구로 적지 않는다. */}
        <Row
          selected={selected === null}
          title={translate('sessionPanel.theme.followGlobal')}
          theme={
            getTerminalThemePreset(
              resolveGlobalTerminalThemeId(globalThemeId, prefersDarkAppearance()),
            ).theme
          }
          onClick={() => choose(null)}
        />
        {terminalThemePresets.map((preset) => (
          <Row
            key={preset.id}
            selected={selected === preset.id}
            title={preset.title}
            theme={preset.theme}
            onClick={() => choose(preset.id)}
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  selected,
  title,
  theme,
  onClick,
}: {
  selected: boolean;
  title: string;
  theme: TerminalThemeDefinition['theme'];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[10px] p-1.5 text-left transition-colors',
        selected
          ? 'bg-[var(--selection-tint)] shadow-[inset_0_0_0_1px_var(--selection-border)]'
          : 'hover:bg-[var(--surface-muted)]',
      )}
    >
      <ThemeThumbnail theme={theme} />
      <span className="min-w-0 flex-1 truncate text-[0.82rem] text-[var(--text)]">
        {title}
      </span>
      {selected ? (
        <Check className="mr-1 h-4 w-4 shrink-0 text-[var(--accent-strong)]" aria-hidden />
      ) : null}
    </button>
  );
}

/**
 * 시스템이 어두운 외형인가.
 *
 * 앱 설정이 "시스템 따르기" 일 때 어느 테마가 실제로 나오는지 알아야 썸네일이 거짓말을 하지
 * 않는다. 값은 썸네일에만 쓰이므로 구독하지 않고 그릴 때 한 번 읽는다.
 */
function prefersDarkAppearance(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
