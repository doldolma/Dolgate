// 터미널 테마 섹션. 앱 외형이 아니라 **이 호스트의 터미널 테마**다.
//
// 값을 여기에 따로 두지 않는다 — 호스트 편집에 이미 있는 `terminalThemeId` 를 그대로 읽고 쓴다.
// 두 곳이 서로 다른 값을 들면 어느 쪽이 맞는지 알 수 없게 된다.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalThemeId } from '@shared';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/appStore';
import {
  terminalThemePresets,
  type TerminalThemeDefinition,
} from '../../../lib/terminal-presets';
import { Check } from '../../../ui/icons';
import { SessionPanelEmpty } from './SessionPanelEmpty';

interface SessionPanelThemeProps {
  /** 이 세션의 호스트. 로컬 터미널처럼 호스트가 없으면 null. */
  hostId: string | null;
}

/**
 * 팔레트 미리보기.
 *
 * 이름만으로는 무엇을 고르는지 알 수 없고, 배경·글자색 세 칸만 보여 줘도 "이 테마에서 오류가
 * 붉게 보이는가" 같은 것은 알 수 없다. 그래서 실제 배경 위에 한 줄을 그리고 ANSI 색을 함께
 * 늘어놓는다 — 터미널에서 보게 될 그대로다.
 */
function ThemePreview({ theme }: { theme: TerminalThemeDefinition['theme'] }) {
  return (
    <span
      className="block overflow-hidden rounded-[7px] border border-[var(--border)] px-2 py-1.5 font-mono text-[0.68rem] leading-[1.5]"
      style={{ background: theme.background, color: theme.foreground }}
      aria-hidden
    >
      <span className="flex items-center gap-1 whitespace-pre">
        <span style={{ color: theme.green }}>user@host</span>
        <span style={{ color: theme.foreground }}>:</span>
        <span style={{ color: theme.blue }}>~</span>
        <span style={{ color: theme.foreground }}>$ ls -la</span>
        <span
          className="inline-block h-[9px] w-[4px] rounded-[1px]"
          style={{ background: theme.cursor }}
        />
      </span>
      <span className="mt-1 flex gap-[3px]">
        {ANSI_KEYS.map((key) => (
          <span
            key={key}
            className="h-2.5 flex-1 rounded-[2px]"
            style={{ background: theme[key] }}
          />
        ))}
      </span>
    </span>
  );
}

/** 미리보기에 늘어놓을 색. 밝은 변형까지 다 보여 주면 칸이 좁아 구분이 안 된다. */
const ANSI_KEYS = [
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
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

  if (!host) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.theme.noHostTitle')}
          description={translate('sessionPanel.theme.noHost')}
        />
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
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-2 pt-2">
      {error ? (
        <p className="mx-1 mb-1.5 rounded-[8px] bg-[var(--danger-bg)] px-2.5 py-1.5 text-[0.72rem] leading-[1.45] text-[var(--danger-text)]">
          {translate('sessionPanel.theme.saveFailed', { message: error })}
        </p>
      ) : null}
      <Row
        selected={selected === null}
        title={translate('sessionPanel.theme.followGlobal')}
        subtitle={
          globalThemeId === 'system'
            ? translate('sessionPanel.theme.followSystem')
            : (terminalThemePresets.find((preset) => preset.id === globalThemeId)?.title ??
              undefined)
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
  );
}

function Row({
  selected,
  title,
  subtitle,
  theme,
  onClick,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  theme?: TerminalThemeDefinition['theme'];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'block w-full rounded-[10px] p-1.5 text-left transition-colors',
        selected
          ? 'bg-[var(--selection-tint)] shadow-[inset_0_0_0_1px_var(--selection-border)]'
          : 'hover:bg-[var(--surface-muted)]',
      )}
    >
      {theme ? <ThemePreview theme={theme} /> : null}
      <span className="mt-1 flex items-center gap-1.5 px-0.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.78rem] text-[var(--text)]">{title}</span>
          {subtitle ? (
            <span className="block truncate text-[0.7rem] text-[var(--text-soft)]">
              {subtitle}
            </span>
          ) : null}
        </span>
        {selected ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent-strong)]" aria-hidden />
        ) : null}
      </span>
    </button>
  );
}
