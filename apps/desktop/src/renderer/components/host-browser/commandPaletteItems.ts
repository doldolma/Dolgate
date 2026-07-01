import {
  getHostSearchText,
  getHostSubtitle,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from '@shared';
import type { HostRecord } from '@shared';
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

const MAX_PALETTE_HOSTS = 6;

function commandItemMatches(item: CommandPaletteItem, query: string): boolean {
  const haystack = [item.title, item.subtitle, ...item.keywords].filter(Boolean).join(' ');
  return matchesKeyboardLayoutQuery(haystack, query);
}

function getHostPaletteText(host: HostRecord): string {
  return getHostSearchText(host).join(' ');
}

function getHostPaletteSubtitle(host: HostRecord, prefix?: string): string {
  const subtitle = getHostSubtitle(host);
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

function hostSupportsTerminalConnect(host: HostRecord): boolean {
  return !isAwsEcsHostRecord(host);
}

function hostSupportsSftp(host: HostRecord): boolean {
  return isSshHostRecord(host) || isWarpgateSshHostRecord(host) || isAwsEc2HostRecord(host);
}

function hostSupportsContainers(host: HostRecord): boolean {
  return isSshHostRecord(host) || isWarpgateSshHostRecord(host) || isAwsEc2HostRecord(host);
}

export function buildHostBrowserCommandPaletteItems(
  hb: HostBrowserModel,
): CommandPaletteItem[] {
  const query = hb.searchQuery.trim();
  const baseItems: CommandPaletteItem[] = [
    {
      id: 'nav:home-hosts',
      group: 'navigation',
      title: 'Home',
      subtitle: '호스트',
      keywords: ['home', 'hosts', 'host browser', '호스트'],
      Icon: Home,
      run: () => hb.onSelectSection?.('hosts'),
    },
    {
      id: 'nav:sftp',
      group: 'navigation',
      title: 'SFTP',
      subtitle: '파일 전송',
      keywords: ['sftp', 'files', 'file transfer', '파일'],
      Icon: Folder,
      run: () => hb.onActivateSftp?.(),
    },
    {
      id: 'nav:containers',
      group: 'navigation',
      title: '컨테이너',
      subtitle: 'Docker, Podman, ECS',
      keywords: ['containers', 'docker', 'podman', 'ecs', 'container'],
      Icon: Container,
      run: () => hb.onActivateContainers?.(),
    },
    {
      id: 'nav:port-forwarding',
      group: 'navigation',
      title: '포트 포워딩',
      subtitle: '터널',
      keywords: ['port', 'forward', 'forwarding', 'tunnel', '포트'],
      Icon: ArrowLeftRight,
      run: () => hb.onSelectSection?.('portForwarding'),
    },
    {
      id: 'nav:snippets',
      group: 'navigation',
      title: '스니펫',
      subtitle: '저장된 명령어',
      keywords: ['snippets', 'snippet', 'commands', '명령'],
      Icon: Scissors,
      run: () => hb.onSelectSection?.('snippets'),
    },
    {
      id: 'nav:logs',
      group: 'navigation',
      title: '로그',
      subtitle: '활동 기록',
      keywords: ['logs', 'activity', 'audit', '로그'],
      Icon: List,
      run: () => hb.onSelectSection?.('logs'),
    },
    {
      id: 'nav:settings',
      group: 'navigation',
      title: '설정',
      subtitle: '환경설정',
      keywords: ['settings', 'preferences', '설정'],
      Icon: Settings,
      run: () => hb.onSelectSection?.('settings'),
    },
    {
      id: 'terminal:local',
      group: 'local-terminal',
      title: '로컬 터미널',
      subtitle: '로컬 셸',
      keywords: ['local', 'terminal', 'shell', '터미널'],
      Icon: SquareTerminal,
      run: () => hb.onOpenLocalTerminal(),
    },
    ...(
      [
        ['general', '일반', '테마와 터미널', 'general appearance terminal'],
        ['sftp', 'SFTP 설정', '전송 기본값', 'sftp transfer'],
        ['security', '보안', '신뢰와 보안', 'security trust'],
        ['secrets', '저장된 인증 정보', '비밀번호와 키', 'saved credentials password keys secrets'],
        ['aws-profiles', 'AWS 프로필', 'AWS CLI 프로필', 'aws profiles cli'],
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
      title: '저장하고 SSH 연결',
      subtitle: formatQuickSshHostLabel(parsedQuickSsh),
      keywords: ['ssh', 'quick connect', parsedQuickSsh.username, parsedQuickSsh.hostname],
      Icon: SquareTerminal,
      run: () => hb.onQuickConnectSsh?.(parsedQuickSsh),
    });
  }

  const hostMatches = query
    ? hb.hosts
        .filter((host) =>
          matchesKeyboardLayoutQuery(
            [host.label, host.groupName ?? '', getHostPaletteText(host)].join(' '),
            query,
          ),
        )
        .sort(compareHostsByRecentThenName(hb.lastConnectedByHostId))
    : getDefaultHostCandidates(hb);

  const hostItems: CommandPaletteItem[] = [];
  hostMatches.slice(0, MAX_PALETTE_HOSTS).forEach((host) => {
    if (hostSupportsTerminalConnect(host)) {
      hostItems.push({
        id: `host:connect:${host.id}`,
        group: 'host',
        title: `${host.label} 연결`,
        subtitle: getHostPaletteSubtitle(
          host,
          !query && (hb.lastConnectedByHostId.get(host.id) ?? 0) > 0 ? '최근 접속' : undefined,
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
        title: `${host.label} 컨테이너`,
        subtitle: getHostPaletteSubtitle(host),
        keywords: ['containers', 'docker', 'podman', host.label, getHostPaletteText(host)],
        Icon: Container,
        run: () => hb.onOpenHostContainers(host.id),
      });
    }
  });

  if (!query) {
    return [...baseItems, ...hostItems.filter((item) => item.id.startsWith('host:connect:'))];
  }

  const matchedBaseItems = baseItems.filter((item) => commandItemMatches(item, query));
  return [...quickItems, ...hostItems, ...matchedBaseItems];
}
