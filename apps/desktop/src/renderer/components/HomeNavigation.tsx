import type { HomeSection } from '../store/createAppStore';

interface HomeNavigationProps {
  activeSection: HomeSection;
  onSelectSection: (section: HomeSection) => void;
}

const items: Array<{ section: HomeSection; icon: string; label: string }> = [
  { section: 'hosts', icon: '▣', label: 'Hosts' },
  { section: 'portForwarding', icon: '⇄', label: 'Port Forwarding' },
  { section: 'logs', icon: '☰', label: 'Logs' },
  { section: 'settings', icon: '◌', label: 'Settings' }
];

export function HomeNavigation({ activeSection, onSelectSection }: HomeNavigationProps) {
  return (
    <aside className="overflow-auto border-r border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-elevated)_94%,var(--app-bg)_6%)] px-4 py-[1.2rem] max-[1040px]:hidden">
      <nav className="mt-[0.2rem] flex flex-col gap-[0.65rem]" aria-label="Home navigation">
        {items.map((item) => (
          <button
            key={item.section}
            type="button"
            className={
              activeSection === item.section
                ? 'flex w-full items-center gap-3 rounded-[18px] border border-[var(--selection-border)] bg-[var(--selection-tint)] px-[0.95rem] py-[0.88rem] text-left text-[var(--text)] shadow-none transition-[background-color,color,border-color] duration-150'
                : 'flex w-full items-center gap-3 rounded-[18px] bg-transparent px-[0.95rem] py-[0.88rem] text-left text-[var(--text-soft)] transition-[background-color,color,box-shadow] duration-150 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]'
            }
            onClick={() => onSelectSection(item.section)}
          >
            <span className="inline-grid h-[1.8rem] w-[1.8rem] place-items-center rounded-[12px] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] text-[var(--accent-strong)]">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
