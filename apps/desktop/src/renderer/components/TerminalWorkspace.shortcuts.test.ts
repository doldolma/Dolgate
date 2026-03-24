import { describe, expect, it } from 'vitest';
import { didTerminalSessionJustConnect, shouldOpenTerminalSearch } from './TerminalWorkspace';

describe('TerminalWorkspace search shortcut helper', () => {
  it('opens search only for visible active panes on Cmd/Ctrl+F', () => {
    expect(
      shouldOpenTerminalSearch({
        active: true,
        visible: true,
        key: 'f',
        ctrlKey: true,
        metaKey: false
      })
    ).toBe(true);

    expect(
      shouldOpenTerminalSearch({
        active: true,
        visible: true,
        key: 'F',
        ctrlKey: false,
        metaKey: true
      })
    ).toBe(true);
  });

  it('ignores non-search shortcuts and inactive panes', () => {
    expect(
      shouldOpenTerminalSearch({
        active: false,
        visible: true,
        key: 'f',
        ctrlKey: true,
        metaKey: false
      })
    ).toBe(false);

    expect(
      shouldOpenTerminalSearch({
        active: true,
        visible: false,
        key: 'f',
        ctrlKey: true,
        metaKey: false
      })
    ).toBe(false);

    expect(
      shouldOpenTerminalSearch({
        active: true,
        visible: true,
        key: 'g',
        ctrlKey: true,
        metaKey: false
      })
    ).toBe(false);
  });

  it('requests a resize resync only when a session transitions into connected', () => {
    expect(didTerminalSessionJustConnect(null, 'connected')).toBe(true);
    expect(didTerminalSessionJustConnect('connecting', 'connected')).toBe(true);
    expect(didTerminalSessionJustConnect('connected', 'connected')).toBe(false);
    expect(didTerminalSessionJustConnect('error', 'error')).toBe(false);
    expect(didTerminalSessionJustConnect('connected', 'closed')).toBe(false);
  });
});
