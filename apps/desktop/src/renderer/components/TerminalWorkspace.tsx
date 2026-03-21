import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { useAppStore } from '../store/appStore';
import { createTerminalResizeScheduler } from './terminal-resize';
import type { AppTheme } from '@keyterm/shared';

interface TerminalThemePalette {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

function terminalTheme(theme: Exclude<AppTheme, 'system'>): TerminalThemePalette {
  if (theme === 'light') {
    return {
      background: '#f7fafc',
      foreground: '#1e2a35',
      cursor: '#2468ff',
      selectionBackground: 'rgba(36, 104, 255, 0.18)'
    };
  }

  return {
    background: '#0b1220',
    foreground: '#d9e4ee',
    cursor: '#8ed1c2',
    selectionBackground: 'rgba(142, 209, 194, 0.16)'
  };
}

interface TerminalSessionViewProps {
  sessionId: string;
  active: boolean;
  theme: Exclude<AppTheme, 'system'>;
}

function TerminalSessionView({ sessionId, active, theme }: TerminalSessionViewProps) {
  // xterm 인스턴스는 React state가 아니라 ref로 들고 있어야 리렌더마다 재생성되지 않는다.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeSchedulerRef = useRef<ReturnType<typeof createTerminalResizeScheduler> | null>(null);
  const tabs = useAppStore((state) => state.tabs);
  const currentTab = tabs.find((tab) => tab.sessionId === sessionId);

  function refreshViewport() {
    const terminal = terminalRef.current;
    if (!terminal || terminal.rows <= 0) {
      return;
    }
    terminal.refresh(0, terminal.rows - 1);
  }

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    // 터미널 인스턴스는 세션별로 한 번만 생성한다.
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: terminalTheme(theme)
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.onData((data) => {
      // 사용자가 입력한 키 입력을 즉시 SSH 코어로 흘려보낸다.
      void window.keyterm.ssh.write(sessionId, data);
    });
    terminal.onBinary((data) => {
      // onBinary는 마우스 보고처럼 raw byte가 필요한 입력을 위해 별도 경로를 사용한다.
      const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0));
      void window.keyterm.ssh.writeBinary(sessionId, bytes);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    resizeSchedulerRef.current = createTerminalResizeScheduler({
      fit: () => {
        fitAddon.fit();
      },
      readSize: () => ({
        cols: terminal.cols,
        rows: terminal.rows
      }),
      afterResize: () => {
        // 일부 macOS/Electron 조합에서는 fit 이후 canvas가 다시 그려지지 않아 refresh를 한 번 강제한다.
        refreshViewport();
      },
      sendResize: ({ cols, rows }) => window.keyterm.ssh.resize(sessionId, cols, rows)
    });

    const handlePointerActivate = () => {
      // 클릭이나 포커스 이후에 viewport가 검게 보이는 경우를 막기 위해 layout 동기화와 repaint를 함께 건다.
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
    };
    const handleFocusIn = () => {
      handlePointerActivate();
    };
    const handleFocusOut = () => {
      requestAnimationFrame(() => {
        refreshViewport();
      });
    };

    containerRef.current.addEventListener('mousedown', handlePointerActivate);
    containerRef.current.addEventListener('focusin', handleFocusIn);
    containerRef.current.addEventListener('focusout', handleFocusOut);

    const resizeObserver = new ResizeObserver(() => {
      // 크기 변경은 즉시 감지하되, 실제 resize 전송은 같은 프레임 안에서 한 번만 실행한다.
      resizeSchedulerRef.current?.request();
    });
    resizeObserver.observe(containerRef.current);

    resizeSchedulerRef.current.request();

    return () => {
      resizeObserver.disconnect();
      containerRef.current?.removeEventListener('mousedown', handlePointerActivate);
      containerRef.current?.removeEventListener('focusin', handleFocusIn);
      containerRef.current?.removeEventListener('focusout', handleFocusOut);
      resizeSchedulerRef.current?.reset();
      resizeSchedulerRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    // xterm도 앱 테마 전환에 맞춰 즉시 색상을 바꿔 홈/세션의 시각 언어를 일관되게 유지한다.
    if (!terminalRef.current) {
      return;
    }
    terminalRef.current.options.theme = terminalTheme(theme);
    refreshViewport();
  }, [theme]);

  useEffect(() => {
    // 터미널 출력은 renderer store를 거치지 않고 xterm에 직접 넣어 렌더 hot path를 짧게 유지한다.
    return window.keyterm.ssh.onData(sessionId, (chunk) => {
      terminalRef.current?.write(chunk);
    });
  }, [sessionId]);

  useEffect(() => {
    if (active) {
      // 탭이 활성화될 때 숨겨져 있던 동안 바뀐 레이아웃을 다음 프레임 기준으로 다시 측정한다.
      terminalRef.current?.focus();
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
    }
  }, [active]);

  return (
    <div className={`terminal-session ${active ? 'active' : ''}`}>
      {currentTab?.errorMessage ? <div className="terminal-error-banner">{currentTab.errorMessage}</div> : null}
      <div ref={containerRef} className="terminal-canvas" />
    </div>
  );
}

interface TerminalWorkspaceProps {
  sessionIds: string[];
  activeTabId: string | null;
  theme: Exclude<AppTheme, 'system'>;
}

export function TerminalWorkspace({ sessionIds, activeTabId, theme }: TerminalWorkspaceProps) {
  if (sessionIds.length === 0) {
    return (
      <div className="terminal-empty">
        <div className="empty-state-card">
          <div className="section-title">연결 준비 완료</div>
          <h3>첫 SSH 세션을 시작해보세요</h3>
          <p>오른쪽에서 호스트를 생성한 뒤 왼쪽 목록에서 Connect를 누르면 여기에서 원격 터미널 탭이 열립니다.</p>
          <div className="empty-steps">
            <div>
              <strong>1</strong>
              <span>Host Editor에 접속 정보를 입력합니다.</span>
            </div>
            <div>
              <strong>2</strong>
              <span>Create host로 저장합니다.</span>
            </div>
            <div>
              <strong>3</strong>
              <span>왼쪽 목록에서 Connect를 눌러 세션을 엽니다.</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-workspace">
      {sessionIds.map((sessionId) => (
        <TerminalSessionView
          key={sessionId}
          sessionId={sessionId}
          active={activeTabId === sessionId}
          theme={theme}
        />
      ))}
    </div>
  );
}
