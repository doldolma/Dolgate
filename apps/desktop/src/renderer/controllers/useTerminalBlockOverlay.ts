// 명령 블록 오버레이의 지오메트리·hover 판정.
//
// xterm 데코레이션이 아니라 자체 오버레이를 쓰는 이유: 데코레이션은 높이가 생성 시 고정이고,
// 마커 행이 뷰포트를 벗어나면 아예 그려지지 않아 긴 출력에서 하이라이트가 사라진다. 여기서는
// 매 렌더/스크롤마다 (행 − viewportY) × 셀높이 로 직접 계산해 화면에 보이는 부분만 그린다.
//
// 셀→픽셀 환산은 자동완성 앵커(refreshAutocompleteAnchor)와 같은 방식이다.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Terminal } from 'xterm';
import {
  getCommandBlockAtLine,
  type TerminalCommandBlockState,
} from '../lib/terminal-command-blocks';

/** 툴바 위에서는 hover 대상을 다시 계산하지 않는다(버튼을 누르러 가다 블록이 바뀌는 것 방지). */
export const BLOCK_TOOLBAR_ATTRIBUTE = 'data-terminal-block-toolbar';

export interface TerminalBlockOverlayState {
  blockId: number;
  /** 컨테이너 기준 픽셀 좌표(보이는 부분만). */
  top: number;
  height: number;
  state: TerminalCommandBlockState;
  exitCode: number | null;
  durationMs: number | null;
  command: string | null;
}

/**
 * 출력 안으로 스크롤해 들어가 명령 줄이 화면 위로 사라졌을 때, 상단에 붙여 보여 줄 정보.
 * "지금 보고 있는 출력이 어느 명령의 것인가"를 잃지 않게 한다.
 */
export interface TerminalBlockStickyState {
  blockId: number;
  /** 컨테이너 기준 상단 위치(터미널 첫 행 위치). */
  top: number;
  height: number;
  state: TerminalCommandBlockState;
  exitCode: number | null;
  durationMs: number | null;
  command: string | null;
  /** 클릭 시 되돌아갈 명령 줄(절대 버퍼 행). */
  startLine: number;
}

interface Options {
  terminalRef: MutableRefObject<Terminal | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  sessionIdRef: MutableRefObject<string>;
  enabled: boolean;
}

interface Geometry {
  screenTop: number;
  cellHeight: number;
  rows: number;
  viewportY: number;
}

function readGeometry(
  terminal: Terminal,
  container: HTMLDivElement,
): { geometry: Geometry; screenBoundsTop: number } | null {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen || terminal.rows <= 0) {
    return null;
  }
  const containerBounds = container.getBoundingClientRect();
  const screenBounds = screen.getBoundingClientRect();
  if (screenBounds.height <= 0) {
    return null;
  }
  return {
    geometry: {
      screenTop: screenBounds.top - containerBounds.top,
      cellHeight: screenBounds.height / terminal.rows,
      rows: terminal.rows,
      viewportY: terminal.buffer.active.viewportY,
    },
    screenBoundsTop: screenBounds.top,
  };
}

export function useTerminalBlockOverlay({
  terminalRef,
  containerRef,
  sessionIdRef,
  enabled,
}: Options) {
  const [overlay, setOverlay] = useState<TerminalBlockOverlayState | null>(null);
  const [sticky, setSticky] = useState<TerminalBlockStickyState | null>(null);
  /** 마지막으로 마우스가 가리킨 절대 버퍼 행. 스크롤 시 같은 행 기준으로 다시 계산한다. */
  const hoveredLineRef = useRef<number | null>(null);

  const clearHover = useCallback(() => {
    hoveredLineRef.current = null;
    setOverlay(null);
  }, []);

  const recompute = useCallback(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const line = hoveredLineRef.current;
    if (!enabled || !terminal || !container || line === null) {
      setOverlay(null);
      return;
    }
    // 대체화면(vim·htop)에서는 블록 개념이 성립하지 않는다.
    if (terminal.buffer.active.type !== 'normal') {
      setOverlay(null);
      return;
    }
    const read = readGeometry(terminal, container);
    if (!read) {
      setOverlay(null);
      return;
    }
    const { geometry } = read;
    const block = getCommandBlockAtLine(sessionIdRef.current, line);
    if (!block || block.marker.line < 0) {
      setOverlay(null);
      return;
    }

    // 블록이 뷰포트를 벗어난 부분은 잘라 보이는 구간만 그린다.
    const endLine = block.endLine ?? geometry.viewportY + geometry.rows;
    const startRow = Math.max(0, block.marker.line - geometry.viewportY);
    const endRow = Math.min(geometry.rows, endLine - geometry.viewportY + 1);
    if (endRow <= startRow) {
      setOverlay(null);
      return;
    }

    const next: TerminalBlockOverlayState = {
      blockId: block.id,
      top: geometry.screenTop + startRow * geometry.cellHeight,
      height: (endRow - startRow) * geometry.cellHeight,
      state: block.state,
      exitCode: block.exitCode,
      durationMs: block.durationMs,
      command: block.command,
    };
    setOverlay((current) =>
      current &&
      current.blockId === next.blockId &&
      current.state === next.state &&
      Math.abs(current.top - next.top) < 0.5 &&
      Math.abs(current.height - next.height) < 0.5
        ? current
        : next,
    );
  }, [containerRef, enabled, sessionIdRef, terminalRef]);

  const recomputeSticky = useCallback(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!enabled || !terminal || !container) {
      setSticky(null);
      return;
    }
    if (terminal.buffer.active.type !== 'normal') {
      setSticky(null);
      return;
    }
    const read = readGeometry(terminal, container);
    if (!read) {
      setSticky(null);
      return;
    }
    const { geometry } = read;
    const block = getCommandBlockAtLine(sessionIdRef.current, geometry.viewportY);
    // 명령 줄이 아직 화면에 보이면 붙일 필요가 없다.
    if (!block || block.marker.line < 0 || block.marker.line >= geometry.viewportY) {
      setSticky(null);
      return;
    }
    const next: TerminalBlockStickyState = {
      blockId: block.id,
      top: geometry.screenTop,
      height: geometry.cellHeight,
      state: block.state,
      exitCode: block.exitCode,
      durationMs: block.durationMs,
      command: block.command,
      startLine: block.marker.line,
    };
    setSticky((current) =>
      current &&
      current.blockId === next.blockId &&
      current.state === next.state &&
      Math.abs(current.top - next.top) < 0.5 &&
      Math.abs(current.height - next.height) < 0.5
        ? current
        : next,
    );
  }, [containerRef, enabled, sessionIdRef, terminalRef]);

  /** 스티키 헤더를 눌렀을 때 그 명령 줄로 되돌아간다. */
  const scrollToStickyBlock = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal && sticky) {
      terminal.scrollToLine(sticky.startLine);
    }
  }, [sticky, terminalRef]);

  const handlePointerMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!enabled) {
        return;
      }
      // 툴바로 마우스를 옮기는 중에는 대상 블록을 유지한다.
      if (
        event.target instanceof Element &&
        event.target.closest(`[${BLOCK_TOOLBAR_ATTRIBUTE}]`)
      ) {
        return;
      }
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!terminal || !container) {
        return;
      }
      const read = readGeometry(terminal, container);
      if (!read) {
        return;
      }
      const row = Math.floor(
        (event.clientY - read.screenBoundsTop) / read.geometry.cellHeight,
      );
      if (row < 0 || row >= read.geometry.rows) {
        clearHover();
        return;
      }
      const line = read.geometry.viewportY + row;
      if (hoveredLineRef.current === line) {
        return;
      }
      hoveredLineRef.current = line;
      recompute();
    },
    [clearHover, containerRef, enabled, recompute, terminalRef],
  );

  // 스크롤·리렌더로 행 위치가 바뀌면 하이라이트와 스티키 헤더도 따라가야 한다.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!enabled) {
      setSticky(null);
      return;
    }
    if (!terminal) {
      return;
    }
    const update = () => {
      recompute();
      recomputeSticky();
    };
    update();
    const renderDisposable = terminal.onRender(update);
    const scrollDisposable = terminal.onScroll(update);
    return () => {
      renderDisposable.dispose();
      scrollDisposable.dispose();
    };
  }, [enabled, recompute, recomputeSticky, terminalRef]);

  useEffect(() => {
    if (!enabled) {
      clearHover();
    }
  }, [clearHover, enabled]);

  return { overlay, sticky, handlePointerMove, clearHover, scrollToStickyBlock };
}
