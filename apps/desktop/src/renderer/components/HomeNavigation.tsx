import type { HomeSection } from '../store/createAppStore';

interface HomeNavigationProps {
  activeSection: HomeSection;
  onSelectSection: (section: HomeSection) => void;
}

export function HomeNavigation({ activeSection, onSelectSection }: HomeNavigationProps) {
  return (
    <aside className="home-navigation">
      <div className="home-navigation__header">
        <div className="eyebrow">Workspace</div>
        <h1>KeyTerm</h1>
      </div>

      <nav className="home-navigation__menu" aria-label="Home navigation">
        <button
          type="button"
          className={`navigation-item ${activeSection === 'hosts' ? 'active' : ''}`}
          onClick={() => onSelectSection('hosts')}
        >
          <span className="navigation-item__icon">▣</span>
          <span>Hosts</span>
        </button>
        <button
          type="button"
          className={`navigation-item ${activeSection === 'settings' ? 'active' : ''}`}
          onClick={() => onSelectSection('settings')}
        >
          <span className="navigation-item__icon">◌</span>
          <span>Settings</span>
        </button>
      </nav>
    </aside>
  );
}
