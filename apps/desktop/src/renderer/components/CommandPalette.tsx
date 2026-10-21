import type { LucideIcon } from "../ui/icons";
import { cn } from "../lib/cn";
import { useTranslation } from "react-i18next";
import { TeamMark } from "./teams/TeamMark";

export type CommandPaletteItemGroup =
  | "navigation"
  | "settings"
  | "host"
  | "workspace"
  | "quick-connect"
  | "local-terminal";

export interface CommandPaletteItem {
  id: string;
  group: CommandPaletteItemGroup;
  title: string;
  subtitle?: string;
  keywords: string[];
  Icon?: LucideIcon;
  disabledReason?: string;
  /** 팀 것이면 그 팀 — 부제목 앞에 "[머리글자] 팀 이름 · " 으로 보인다(홈 카드 아래 줄과 같은 문법). */
  team?: { name: string } | null;
  run: () => void | Promise<void>;
}

const GROUP_LABELS: Record<CommandPaletteItemGroup, string> = {
  navigation: "palette.group.navigation",
  settings: "palette.group.settings",
  host: "palette.group.host",
  workspace: "palette.group.workspace",
  "quick-connect": "palette.group.quickConnect",
  "local-terminal": "palette.group.localTerminal",
};

interface CommandPaletteProps {
  /**
   * `anchored`(기본)는 기준 요소 **아래에 떠서** 붙는다 — 검색칸 하나만 있는 화면에서 쓴다.
   * `inline` 은 흐름 안에 그대로 놓인다 — 이미 말풍선 같은 판 안에 있을 때. 기본값으로 두면
   * 판 밖에 또 하나의 카드가 떠서 검색칸과 목록이 따로 노는 것처럼 보인다.
   */
  variant?: "anchored" | "inline";
  items: CommandPaletteItem[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onRunItem: (item: CommandPaletteItem) => void;
}

export function CommandPalette({
  variant = "anchored",
  items,
  activeIndex,
  onActiveIndexChange,
  onRunItem,
}: CommandPaletteProps) {
  const { t: translate } = useTranslation();
  const groupedItems = items.reduce<
    Array<{ group: CommandPaletteItemGroup; items: CommandPaletteItem[] }>
  >((groups, item) => {
    const existing = groups.find((group) => group.group === item.group);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.push({ group: item.group, items: [item] });
    }
    return groups;
  }, []);

  return (
    <div
      id="command-palette-results"
      role="listbox"
      aria-label="Command Palette"
      className={cn(
        "max-h-[min(26rem,calc(100vh-11rem))] overflow-y-auto rounded-[14px] p-[0.45rem]",
        variant === "anchored"
          ? "absolute left-0 right-0 top-[calc(100%+0.45rem)] z-[18] border border-[var(--border)] bg-[var(--surface-strong)] shadow-[var(--shadow-floating)]"
          : "mt-2 p-0",
      )}
    >
      {items.length === 0 ? (
        <div className="px-[0.75rem] py-[0.8rem] text-[0.85rem] text-[var(--text-muted)]">
          {translate("palette.noResults")}
        </div>
      ) : (
        groupedItems.map((group) => (
          <div key={group.group} className="py-[0.15rem]">
            <div className="px-[0.55rem] pb-[0.3rem] pt-[0.45rem] text-[0.66rem] font-bold uppercase tracking-[0.14em] text-[var(--text-soft)]">
              {translate(GROUP_LABELS[group.group])}
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
                      "flex min-h-[2.7rem] w-full items-center gap-[0.7rem] rounded-[10px] px-[0.65rem] py-[0.45rem] text-left transition-colors duration-140",
                      active
                        ? "bg-[var(--selection-tint)] text-[var(--accent-strong)]"
                        : "text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)]",
                      item.disabledReason &&
                        "cursor-not-allowed opacity-50 hover:bg-transparent",
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
                      <span className="truncate text-[0.9rem] font-semibold">
                        {item.title}
                      </span>
                      {item.team && !item.disabledReason ? (
                        <span className="flex min-w-0 items-center gap-[0.35rem] text-[0.76rem] font-medium text-[var(--text-muted)]">
                          <TeamMark name={item.team.name} size="xs" />
                          <span className="min-w-0 truncate">
                            {item.subtitle
                              ? `${item.team.name} · ${item.subtitle}`
                              : item.team.name}
                          </span>
                        </span>
                      ) : item.subtitle || item.disabledReason ? (
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
