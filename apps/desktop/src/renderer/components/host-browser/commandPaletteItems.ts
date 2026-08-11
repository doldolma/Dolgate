import { getHostSearchText, getHostSubtitle } from '@shared';
import type { HostRecord } from '@shared';
import {
  hostSupportsContainers,
  hostSupportsSftp,
  hostSupportsTerminalConnect,
} from './hostCapabilities';
import { matchesKeyboardLayoutQuery } from '../../lib/keyboard-layout-search';
import {
  formatQuickSshHostLabel,
  parseQuickSshCommand,
} from '../../lib/quick-connect';
import type { CommandPaletteItem } from '../CommandPalette';
import {
  ArrowLeftRight,
  Container,
  Folder,
  Home,
  KeyRound,
  List,
  Scissors,
  Settings,
  SquareTerminal,
} from '../../ui/icons';
import type { HostBrowserModel } from './useHostBrowser';
import { t } from '../../i18n';
import { hostSubtitleLabels } from '../../../common/shared-messages';

const MAX_PALETTE_HOSTS = 6;

function commandItemMatches(item: CommandPaletteItem, query: string): boolean {
  const haystack = [item.title, item.subtitle, ...item.keywords].filter(Boolean).join(' ');
  return matchesKeyboardLayoutQuery(haystack, query);
}

function getHostPaletteText(host: HostRecord): string {
  return getHostSearchText(host).join(' ');
}

/**
 * 호스트 하나를 다루다 던지면 그 호스트만 건너뛴다.
 *
 * 이 빌더는 렌더 중 불리는 순수 함수라, 에러 바운더리로 감싸도 팔레트가 통째로 사라진다 —
 * 바운더리는 컴포넌트 렌더만 잡는다. 이 빌드가 모르는 모양의 레코드(다른 기기의 새 버전이 만든
 * 호스트) 하나 때문에 명령 팔레트를 못 쓰는 것보다, 그 호스트만 목록에서 빠지는 편이 낫다.
 */
function skipBrokenHost<T>(host: HostRecord, fallback: T, build: () => T): T {
  try {
    return build();
  } catch (error) {
    console.warn(`[command-palette] 호스트를 건너뜀: ${host?.id}`, error);
    return fallback;
  }
}

function getHostPaletteSubtitle(host: HostRecord, prefix?: string): string {
  const subtitle = getHostSubtitle(host, hostSubtitleLabels());
  return prefix ? `${prefix} · ${subtitle}` : subtitle;
}

function compareHostsByRecentThenName(
  lastConnectedByHostId: Map<string, number>,
): (a: HostRecord, b: HostRecord) => number {
  return (a, b) => {
    const recentDiff = (lastConnectedByHostId.get(b.id) ?? 0) - (lastConnectedByHostId.get(a.id) ?? 0);
    if (recentDiff !== 0) {
      return recentDiff;
    }
    return a.label.localeCompare(b.label);
  };
}

function getDefaultHostCandidates(hb: HostBrowserModel): HostRecord[] {
  const compare = compareHostsByRecentThenName(hb.lastConnectedByHostId);
  const recentHosts = hb.hosts
    .filter((host) => hostSupportsTerminalConnect(host))
    .filter((host) => (hb.lastConnectedByHostId.get(host.id) ?? 0) > 0)
    .sort(compare);
  if (recentHosts.length > 0) {
    return recentHosts;
  }

  const favoriteHosts = hb.hosts
    .filter((host) => hostSupportsTerminalConnect(host))
    .filter((host) => hb.favoriteHostIdSet.has(host.id))
    .sort(compare);
  if (favoriteHosts.length > 0) {
    return favoriteHosts;
  }

  return hb.hosts.filter(hostSupportsTerminalConnect).sort(compare);
}

// keywords 는 화면에 보이지 않는 검색 별칭이라 번역하지 않는다 — 한글 별칭을 남겨 두면
// UI 언어가 영어여도 한글로 타이핑해 찾을 수 있다(제목은 번역되어 영어로도 검색된다).
export function buildHostBrowserCommandPaletteItems(
  hb: HostBrowserModel,
): CommandPaletteItem[] {
  const query = hb.searchQuery.trim();
  const baseItems: CommandPaletteItem[] = [
    {
      id: 'nav:home-hosts',
      group: 'navigation',
      title: 'Home',
      subtitle: t('palette.nav.hosts'),
      keywords: ['home', 'hosts', 'host browser', '호스트'],
      Icon: Home,
      run: () => hb.onSelectSection?.('hosts'),
    },
    {
      id: 'nav:sftp',
      group: 'navigation',
      title: 'SFTP',
      subtitle: t('palette.nav.sftp'),
      keywords: ['sftp', 'files', 'file transfer', '파일'],
      Icon: Folder,
      run: () => hb.onActivateSftp?.(),
    },
    {
      id: 'nav:containers',
      group: 'navigation',
      title: t('palette.nav.containers'),
      subtitle: 'Docker, Podman, ECS',
      keywords: ['containers', 'docker', 'podman', 'ecs', 'container'],
      Icon: Container,
      run: () => hb.onActivateContainers?.(),
    },
    {
      id: 'nav:port-forwarding',
      group: 'navigation',
      title: t('palette.nav.portForwarding'),
      subtitle: t('palette.nav.tunnels'),
      keywords: ['port', 'forward', 'forwarding', 'tunnel', '포트'],
      Icon: ArrowLeftRight,
      run: () => hb.onSelectSection?.('portForwarding'),
    },
    {
      id: 'nav:snippets',
      group: 'navigation',
      title: t('palette.nav.snippets'),
      subtitle: t('palette.nav.savedCommands'),
      keywords: ['snippets', 'snippet', 'commands', '명령'],
      Icon: Scissors,
      run: () => hb.onSelectSection?.('snippets'),
    },
    {
      id: 'nav:logs',
      group: 'navigation',
      title: t('palette.nav.logs'),
      subtitle: t('palette.nav.activity'),
      keywords: ['logs', 'activity', 'audit', '로그'],
      Icon: List,
      run: () => hb.onSelectSection?.('logs'),
    },
    {
      id: 'nav:settings',
      group: 'navigation',
      title: t('palette.nav.settings'),
      subtitle: t('palette.nav.preferences'),
      keywords: ['settings', 'preferences', '설정'],
      Icon: Settings,
      run: () => hb.onSelectSection?.('settings'),
    },
    {
      id: 'terminal:local',
      group: 'local-terminal',
      title: t('palette.nav.localTerminal'),
      subtitle: t('palette.nav.localShell'),
      keywords: ['local', 'terminal', 'shell', '터미널'],
      Icon: SquareTerminal,
      run: () => hb.onOpenLocalTerminal(),
    },
    ...(
      [
        ['general', t('palette.settings.general'), t('palette.settings.generalSubtitle'), 'general appearance terminal'],
        ['sftp', t('palette.settings.sftp'), t('palette.settings.sftpSubtitle'), 'sftp transfer'],
        ['security', t('palette.settings.security'), t('palette.settings.securitySubtitle'), 'security trust'],
        ['secrets', t('palette.settings.secrets'), t('palette.settings.secretsSubtitle'), 'saved credentials password keys secrets'],
        ['aws-profiles', t('palette.settings.awsProfiles'), t('palette.settings.awsProfilesSubtitle'), 'aws profiles cli'],
      ] as const
    ).map(([section, title, subtitle, aliases]) => ({
      id: `settings:${section}`,
      group: 'settings' as const,
      title,
      subtitle,
      keywords: ['settings', section, subtitle, aliases],
      Icon: section === 'secrets' || section === 'security' ? KeyRound : Settings,
      run: () => hb.onOpenSettingsSection?.(section),
    })),
  ];

  const parsedQuickSsh = parseQuickSshCommand(hb.searchQuery);
  const quickItems: CommandPaletteItem[] = [];
  if (parsedQuickSsh && hb.onQuickConnectSsh) {
    quickItems.push({
      id: `quick:ssh:${parsedQuickSsh.username}@${parsedQuickSsh.hostname}:${parsedQuickSsh.port}`,
      group: 'quick-connect',
      title: t('palette.quickSsh'),
      subtitle: formatQuickSshHostLabel(parsedQuickSsh),
      keywords: ['ssh', 'quick connect', parsedQuickSsh.username, parsedQuickSsh.hostname],
      Icon: SquareTerminal,
      run: () => hb.onQuickConnectSsh?.(parsedQuickSsh),
    });
  }

  const hostMatches = query
    ? hb.hosts
        .filter((host) =>
          skipBrokenHost(host, false, () =>
            matchesKeyboardLayoutQuery(
              [host.label, host.groupName ?? '', getHostPaletteText(host)].join(' '),
              query,
            ),
          ),
        )
        .sort(compareHostsByRecentThenName(hb.lastConnectedByHostId))
    : getDefaultHostCandidates(hb);

  const hostItems: CommandPaletteItem[] = [];
  hostMatches.slice(0, MAX_PALETTE_HOSTS).forEach((host) => skipBrokenHost(host, undefined, () => {
    if (hostSupportsTerminalConnect(host)) {
      hostItems.push({
        id: `host:connect:${host.id}`,
        group: 'host',
        title: t('palette.host.connect', { label: host.label }),
        subtitle: getHostPaletteSubtitle(
          host,
          !query && (hb.lastConnectedByHostId.get(host.id) ?? 0) > 0 ? t('palette.host.recent') : undefined,
        ),
        keywords: [host.label, host.groupName ?? '', getHostPaletteText(host)],
        Icon: SquareTerminal,
        run: () => hb.onConnectHost(host.id),
      });
    }
    if (hb.onOpenSftp && hostSupportsSftp(host)) {
      hostItems.push({
        id: `host:sftp:${host.id}`,
        group: 'host',
        title: `${host.label} SFTP`,
        subtitle: getHostPaletteSubtitle(host),
        keywords: ['sftp', 'files', host.label, getHostPaletteText(host)],
        Icon: Folder,
        run: () => hb.onOpenSftp?.(host.id),
      });
    }
    if (hostSupportsContainers(host)) {
      hostItems.push({
        id: `host:containers:${host.id}`,
        group: 'host',
        title: t('palette.host.containers', { label: host.label }),
        subtitle: getHostPaletteSubtitle(host),
        keywords: ['containers', 'docker', 'podman', host.label, getHostPaletteText(host)],
        Icon: Container,
        run: () => hb.onOpenHostContainers(host.id),
      });
    }
  }));

  if (!query) {
    return [...baseItems, ...hostItems.filter((item) => item.id.startsWith('host:connect:'))];
  }

  const matchedBaseItems = baseItems.filter((item) => commandItemMatches(item, query));
  return [...quickItems, ...hostItems, ...matchedBaseItems];
}
