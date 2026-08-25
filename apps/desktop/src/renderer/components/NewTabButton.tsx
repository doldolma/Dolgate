// 탭 줄 끝의 `+` — 새 세션을 여기서 연다.
//
// 예전에는 새 세션을 열려면 **홈으로 돌아가야** 했다. 호스트 검색(⌘K)이 홈의 Hosts 화면에서만
// 열렸기 때문이다(HomeShell 의 단축키가 `homeSection === 'hosts'` 일 때만 듣는다). 터미널을
// 쓰다가 서버 하나를 더 열려는 것이 흔한 일인데 그때마다 화면을 떠나야 했다.
//
// **화면을 만들지 않고 말풍선으로 둔다.** 이 줄의 다른 것들(공유·알림·동기화)이 이미 그 모양이고,
// 여는 목적이 "빠르게 하나 더" 라 전체 화면을 덮을 이유가 없다.
//
// **말풍선은 portal 로 body 에 그린다.** 버튼은 마지막 탭 옆에 있어야 무엇을 여는 것인지 읽히는데,
// 탭 스트립은 `overflow-x-auto overflow-y-hidden` 이라 그 안에서 아래로 뻗으면 잘린다 — 실제로
// 검색칸이 탭 줄에 그대로 펼쳐졌다. 스트립 밖으로 버튼을 옮기면 탭에서 멀리 떨어져 무엇의 `+`
// 인지 알 수 없다. 그래서 버튼은 제자리에 두고 말풍선만 빠져나간다(Tooltip 과 같은 방식).
//
// 목록은 명령 팔레트를 그대로 쓴다 — 검색·최근 정렬·빠른 SSH 가 이미 거기 있다. 다만 이동·설정
// 항목은 넣지 않는다: 이 버튼은 **새 탭을 여는 자리**이고, 설정으로 가는 길은 이미 여럿이다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { HostRecord } from '@shared';
import {
  formatQuickSshHostLabel,
  getHostSubtitle,
  parseQuickSshCommand,
  type ParsedQuickSshCommand,
} from '@shared';
import { hostSubtitleLabels } from '../../common/shared-messages';
import { CommandPalette, type CommandPaletteItem } from './CommandPalette';
import { hostSupportsTerminalConnect } from './host-browser/hostCapabilities';
import { matchesKeyboardLayoutQuery } from '../lib/keyboard-layout-search';
import { Input } from '../ui';
import { Plus, SquareTerminal } from '../ui/icons';
import { cn } from '../lib/cn';

/** 말풍선에 담는 호스트 수. 더 담으면 목록이 길어져 "빠르게 하나" 라는 성격을 잃는다. */
const MAX_HOSTS = 5;

/** 말풍선 폭(px). 화면 밖으로 나가지 않게 맞출 때 쓴다 — 아래 className 의 22rem 과 같은 값. */
const POPOVER_WIDTH = 352;
const VIEWPORT_MARGIN = 8;

interface NewTabButtonProps {
  hosts: readonly HostRecord[];
  /** 호스트별 마지막 연결 시각(ms). 검색어가 없을 때 이 순서로 보여 준다. */
  lastConnectedByHostId: Map<string, number>;
  onConnectHost: (hostId: string) => void;
  onOpenLocalTerminal: () => void;
  onQuickConnectSsh?: (target: ParsedQuickSshCommand) => void;
  /** 바깥(⌘T)에서 온 신호. 값이 바뀔 때마다 여닫는다 — 같은 키로 닫히는 것이 자연스럽다. */
  openSignal?: number;
}

export function NewTabButton({
  hosts,
  lastConnectedByHostId,
  onConnectHost,
  onOpenLocalTerminal,
  onQuickConnectSsh,
  openSignal = 0,
}: NewTabButtonProps) {
  const { t: translate } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  // 열기 직전에 무엇이 포커스를 갖고 있었는지. 닫을 때 그리로 돌려준다 — 대개 터미널이고,
  // 안 돌려주면 ⌘T 를 눌렀다 취소한 사람이 키보드를 잃는다(어디에도 커서가 없다).
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const firstSignalRef = useRef(openSignal);

  // ⌘T. 처음 렌더의 값으로는 열지 않는다 — 앱을 켜자마자 말풍선이 떠 있으면 안 된다.
  // 열려 있을 때 다시 누르면 닫는다.
  useEffect(() => {
    if (openSignal === firstSignalRef.current) {
      return;
    }
    setOpen(current => !current);
    setQuery('');
    setActiveIndex(0);
  }, [openSignal]);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      // 이미 다른 곳을 눌러서 포커스가 옮겨 갔으면 건드리지 않는다 — 사용자가 고른 자리를
      // 빼앗는 셈이 된다. 우리 안쪽(입력칸·목록)에 있을 때만 되돌린다.
      const active = document.activeElement;
      const insideUs =
        active === null ||
        active === document.body ||
        Boolean(popoverRef.current?.contains(active)) ||
        Boolean(containerRef.current?.contains(active));
      if (previous?.isConnected && insideUs) {
        previous.focus();
      }
      return;
    }
    if (!previousFocusRef.current) {
      const active = document.activeElement;
      previousFocusRef.current =
        active instanceof HTMLElement && !containerRef.current?.contains(active)
          ? active
          : null;
    }
    // 버튼 아래 왼쪽에 붙이되 **화면을 넘지 않게 민다.** 탭이 많아 `+` 가 오른쪽 끝에 있으면
    // 그대로 두었을 때 말풍선이 창 밖으로 나간다.
    const measure = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
      setAnchor({
        left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)),
        top: rect.bottom + VIEWPORT_MARGIN,
      });
    };
    measure();
    // 버튼과 말풍선은 이제 다른 트리에 있다 — 둘 다 확인해야 말풍선 안을 눌렀을 때 닫히지 않는다.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // **자리를 잡은 뒤에 포커스한다.** 말풍선은 `anchor` 가 정해진 다음에야 그려지므로, 여는
  // 그 순간에는 입력칸이 아직 없다 — 거기서 부르면 아무 일도 일어나지 않는다.
  useEffect(() => {
    if (!open || !anchor) {
      return;
    }
    inputRef.current?.focus();
  }, [anchor, open]);

  const items = useMemo<CommandPaletteItem[]>(() => {
    const trimmed = query.trim();
    const connectable = hosts.filter((host) => hostSupportsTerminalConnect(host));
    const matched = trimmed
      ? connectable.filter((host) =>
          matchesKeyboardLayoutQuery(
            [host.label, host.groupName ?? '', getHostSubtitle(host, hostSubtitleLabels())].join(' '),
            trimmed,
          ),
        )
      : [...connectable].sort(
          (left, right) =>
            (lastConnectedByHostId.get(right.id) ?? 0) -
              (lastConnectedByHostId.get(left.id) ?? 0) ||
            left.label.localeCompare(right.label),
        );

    const next: CommandPaletteItem[] = [];

    // `user@host` 를 그대로 친 경우. 저장하지 않고 바로 붙는다.
    const quick = parseQuickSshCommand(query);
    if (quick && onQuickConnectSsh) {
      next.push({
        id: `quick:${quick.username}@${quick.hostname}:${quick.port}`,
        group: 'quick-connect',
        title: translate('palette.quickSsh'),
        subtitle: formatQuickSshHostLabel(quick),
        keywords: [],
        Icon: SquareTerminal,
        run: () => {
          setOpen(false);
          onQuickConnectSsh(quick);
        },
      });
    }

    matched.slice(0, MAX_HOSTS).forEach((host) => {
      next.push({
        id: `host:${host.id}`,
        group: 'host',
        title: host.label,
        subtitle: getHostSubtitle(host, hostSubtitleLabels()),
        keywords: [],
        Icon: SquareTerminal,
        run: () => {
          setOpen(false);
          onConnectHost(host.id);
        },
      });
    });

    next.push({
      id: 'terminal:local',
      group: 'local-terminal',
      title: translate('palette.nav.localTerminal'),
      subtitle: translate('palette.nav.localShell'),
      keywords: [],
      Icon: SquareTerminal,
      run: () => {
        setOpen(false);
        onOpenLocalTerminal();
      },
    });

    return next;
  }, [
    hosts,
    lastConnectedByHostId,
    onConnectHost,
    onOpenLocalTerminal,
    onQuickConnectSsh,
    query,
    translate,
  ]);

  const clampedIndex = Math.min(activeIndex, Math.max(items.length - 1, 0));

  return (
    <div className="relative [-webkit-app-region:no-drag]" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-label={translate('titleBar.newTab')}
        title={translate('titleBar.newTab')}
        onClick={() => {
          setOpen((current) => !current);
          setQuery('');
          setActiveIndex(0);
        }}
        className={cn(
          // 크기·라운드는 탭을 따라간다(`self-center mb-[0.42rem] rounded-[10px]`) — 그래야 한
          // 줄로 선다. 다만 **평소에는 배경을 깔지 않는다**: 탭처럼 칠해 두면 안 눌렀는데도 켜져
          // 있는 것처럼 보이고, 탭 하나가 더 있는 것으로도 읽힌다.
          'flex h-8 w-8 flex-none items-center justify-center rounded-[10px] border border-transparent bg-transparent text-[rgba(255,255,255,0.78)]',
          'hover:bg-[rgba(255,255,255,0.12)] hover:text-white',
          open && 'border-[rgba(255,255,255,0.16)] bg-[rgba(255,255,255,0.16)] text-white',
        )}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && anchor
        ? createPortal(
        <div
          ref={popoverRef}
          data-testid="new-tab-popover"
          style={{ left: anchor.left, top: anchor.top }}
          className="fixed z-[200] w-[min(22rem,calc(100vw-2rem))] rounded-[12px] border border-[var(--border)] bg-[var(--dialog-surface)] p-3 shadow-[var(--shadow-floating)]"
        >
          <div>
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setOpen(false);
                  return;
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    items.length === 0 ? 0 : (current + 1) % items.length,
                  );
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    items.length === 0
                      ? 0
                      : (current - 1 + items.length) % items.length,
                  );
                  return;
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  items[clampedIndex]?.run();
                }
              }}
              placeholder={translate('titleBar.newTabSearch')}
              aria-label={translate('titleBar.newTabSearch')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <CommandPalette
              variant="inline"
              items={items}
              activeIndex={clampedIndex}
              onActiveIndexChange={setActiveIndex}
              onRunItem={(item) => item.run()}
            />
          </div>
        </div>,
        document.body,
      )
        : null}
    </div>
  );
}
