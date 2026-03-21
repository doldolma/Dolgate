import type { HomeSection } from '../store/createAppStore';

interface HomeNavigationProps {
  activeSection: HomeSection;
  onSelectSection: (section: HomeSection) => void;
}

const items: Array<{ section: HomeSection; icon: string; label: string }> = [
  { section: 'hosts', icon: '▣', label: 'Hosts' },
  { section: 'portForwarding', icon: '⇄', label: 'Port Forwarding' },
  { section: 'knownHosts', icon: '⌘', label: 'Known Hosts' },
  { section: 'logs', icon: '☰', label: 'Logs' },
  { section: 'keychain', icon: '◈', label: 'Keychain' },
  { section: 'settings', icon: '◌', label: 'Settings' }
];

export function HomeNavigation({ activeSection, onSelectSection }: HomeNavigationProps) {
  return (
    <aside className="home-navigation">
      <div className="home-navigation__header">
        <div className="eyebrow">Workspace</div>
        <h1>dolssh</h1>
      </div>

      <nav className="home-navigation__menu" aria-label="Home navigation">
        {items.map((item) => (
          <button
            key={item.section}
            type="button"
            className={`navigation-item ${activeSection === item.section ? 'active' : ''}`}
            onClick={() => onSelectSection(item.section)}
          >
            <span className="navigation-item__icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
