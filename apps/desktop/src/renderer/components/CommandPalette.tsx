import type { LucideIcon } from '../ui/icons';
import { cn } from '../lib/cn';

export type CommandPaletteItemGroup =
  | 'navigation'
  | 'settings'
  | 'host'
  | 'quick-connect'
  | 'local-terminal';

export interface CommandPaletteItem {
  id: string;
  group: CommandPaletteItemGroup;
  title: string;
  subtitle?: string;
  keywords: string[];
  Icon?: LucideIcon;
  disabledReason?: string;
  run: () => void | Promise<void>;
}

const GROUP_LABELS: Record<CommandPaletteItemGroup, string> = {
  navigation: '이동',
  settings: '설정',
  host: '호스트',
  'quick-connect': '빠른 연결',
  'local-terminal': '터미널',
};

interface CommandPaletteProps {
  items: CommandPaletteItem[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onRunItem: (item: CommandPaletteItem) => void;
}

export function CommandPalette({
  items,
  activeIndex,
  onActiveIndexChange,
  onRunItem,
}: CommandPaletteProps) {
  const groupedItems = items.reduce<Array<{ group: CommandPaletteItemGroup; items: CommandPaletteItem[] }>>(
    (groups, item) => {
      const existing = groups.find((group) => group.group === item.group);
      if (existing) {
        existing.items.push(item);
      } else {
        groups.push({ group: item.group, items: [item] });
      }
      return groups;
    },
    [],
  );

  return (
    <div
      id="command-palette-results"
      role="listbox"
      aria-label="Command Palette"
      className="absolute left-0 right-0 top-[calc(100%+0.45rem)] z-[18] max-h-[min(26rem,calc(100vh-11rem))] overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface-strong)] p-[0.45rem] shadow-[var(--shadow-floating)]"
    >
      {items.length === 0 ? (
        <div className="px-[0.75rem] py-[0.8rem] text-[0.85rem] text-[var(--text-muted)]">
          검색 결과가 없습니다.
        </div>
      ) : (
        groupedItems.map((group) => (
          <div key={group.group} className="py-[0.15rem]">
            <div className="px-[0.55rem] pb-[0.3rem] pt-[0.45rem] text-[0.66rem] font-bold uppercase tracking-[0.14em] text-[var(--text-soft)]">
              {GROUP_LABELS[group.group]}
            </div>
            <div className="grid gap-[0.15rem]">
              {group.items.map((item) => {
                const index = items.indexOf(item);
                const Icon = item.Icon;
                const active = index === activeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={Boolean(item.disabledReason)}
                    className={cn(
                      'flex min-h-[2.7rem] w-full items-center gap-[0.7rem] rounded-[10px] px-[0.65rem] py-[0.45rem] text-left transition-colors duration-140',
                      active
                        ? 'bg-[var(--selection-tint)] text-[var(--accent-strong)]'
                        : 'text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)]',
                      item.disabledReason && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                    )}
                    onMouseEnter={() => onActiveIndexChange(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onRunItem(item)}
                  >
                    {Icon ? (
                      <Icon
                        className="h-[1rem] w-[1rem] shrink-0 text-[var(--text-soft)]"
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="grid min-w-0 flex-1 gap-[0.1rem]">
                      <span className="truncate text-[0.9rem] font-semibold">{item.title}</span>
                      {item.subtitle || item.disabledReason ? (
                        <span className="truncate text-[0.76rem] font-medium text-[var(--text-muted)]">
                          {item.disabledReason ?? item.subtitle}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
