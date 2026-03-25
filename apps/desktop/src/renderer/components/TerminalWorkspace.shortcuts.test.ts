import { describe, expect, it } from 'vitest';
import {
  didTerminalSessionJustConnect,
  mergeSessionShareSnapshotKinds,
  resolveTerminalRuntimeWebglEnabled,
  shouldOpenTerminalSearch
} from './TerminalWorkspace';

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

  it('coalesces snapshot requests so resync wins over refresh', () => {
    expect(mergeSessionShareSnapshotKinds(null, 'refresh')).toBe('refresh');
    expect(mergeSessionShareSnapshotKinds('refresh', 'refresh')).toBe('refresh');
    expect(mergeSessionShareSnapshotKinds('refresh', 'resync')).toBe('resync');
    expect(mergeSessionShareSnapshotKinds('resync', 'refresh')).toBe('resync');
  });

  it('disables WebGL only for mac host sessions while share is active', () => {
    expect(
      resolveTerminalRuntimeWebglEnabled({
        isMac: true,
        terminalWebglEnabled: true,
        sessionSource: 'host',
        shareStatus: 'active'
      })
    ).toBe(false);

    expect(
      resolveTerminalRuntimeWebglEnabled({
        isMac: false,
        terminalWebglEnabled: true,
        sessionSource: 'host',
        shareStatus: 'active'
      })
    ).toBe(true);

    expect(
      resolveTerminalRuntimeWebglEnabled({
        isMac: true,
        terminalWebglEnabled: true,
        sessionSource: 'local',
        shareStatus: 'active'
      })
    ).toBe(true);

    expect(
      resolveTerminalRuntimeWebglEnabled({
        isMac: true,
        terminalWebglEnabled: false,
        sessionSource: 'host',
        shareStatus: 'inactive'
      })
    ).toBe(false);
  });
});
