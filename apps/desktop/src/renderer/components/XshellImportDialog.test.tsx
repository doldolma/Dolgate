import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi, XshellProbeResult } from '@shared';
import {
  XshellImportDialog,
  countEffectiveSelectedXshellHosts,
  filterXshellImportGroups,
  filterXshellImportHosts
} from './XshellImportDialog';

const initialProbeResult: XshellProbeResult = {
  snapshotId: 'snapshot-1',
  sources: [
    {
      id: 'source:default',
      folderPath: 'C:/Users/tester/Documents/NetSarang Computer/8/Xshell/Sessions',
      origin: 'default-session-dir',
      label: '기본 Xshell 세션'
    }
  ],
  groups: [
    {
      path: 'Servers',
      name: 'Servers',
      parentPath: null,
      hostCount: 2
    },
    {
      path: 'Servers/Nested',
      name: 'Nested',
      parentPath: 'Servers',
      hostCount: 1
    }
  ],
  hosts: [
    {
      key: 'host-1',
      label: 'web',
      hostname: 'web.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'privateKey',
      groupPath: 'Servers',
      privateKeyPath: 'C:/keys/web.pem',
      sourceFilePath: 'C:/Users/tester/Documents/NetSarang Computer/8/Xshell/Sessions/Servers/web.xsh',
      hasPasswordHint: false,
      hasAuthProfile: false
    },
    {
      key: 'host-2',
      label: 'db',
      hostname: 'db.example.com',
      port: 2200,
      username: 'postgres',
      authType: 'password',
      groupPath: 'Servers/Nested',
      privateKeyPath: null,
      sourceFilePath: 'C:/Users/tester/Documents/NetSarang Computer/8/Xshell/Sessions/Servers/Nested/db.xsh',
      hasPasswordHint: true,
      hasAuthProfile: true
    }
  ],
  warnings: [
    {
      code: 'password-not-imported',
      message: 'db: 저장된 Xshell 비밀번호는 현재 버전에서 가져오지 않습니다.'
    }
  ],
  skippedExistingHostCount: 1,
  skippedDuplicateHostCount: 0
};

const appendedProbeResult: XshellProbeResult = {
  ...initialProbeResult,
  sources: [
    ...initialProbeResult.sources,
    {
      id: 'source:manual',
      folderPath: 'D:/shared/xshell',
      origin: 'manual-folder',
      label: 'xshell'
    }
  ],
  groups: [
    ...initialProbeResult.groups,
    {
      path: 'Lab',
      name: 'Lab',
      parentPath: null,
      hostCount: 1
    }
  ],
  hosts: [
    ...initialProbeResult.hosts,
    {
      key: 'host-3',
      label: 'lab',
      hostname: 'lab.example.com',
      port: 22,
      username: 'root',
      authType: 'password',
      groupPath: 'Lab',
      privateKeyPath: null,
      sourceFilePath: 'D:/shared/xshell/Lab/lab.xsh',
      hasPasswordHint: false,
      hasAuthProfile: false
    }
  ]
};

const emptyProbeResult: XshellProbeResult = {
  snapshotId: 'snapshot-empty',
  sources: [],
  groups: [],
  hosts: [],
  warnings: [],
  skippedExistingHostCount: 0,
  skippedDuplicateHostCount: 0
};

function installMockApi() {
  const api = {
    xshell: {
      probeDefault: vi.fn().mockResolvedValue(initialProbeResult),
      addFolderToSnapshot: vi.fn().mockResolvedValue(appendedProbeResult),
      importSelection: vi.fn().mockResolvedValue({
        createdGroupCount: 3,
        createdHostCount: 3,
        createdSecretCount: 0,
        skippedHostCount: 0,
        warnings: []
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined)
    },
    shell: {
      pickXshellSessionFolder: vi.fn().mockResolvedValue('D:/shared/xshell')
    }
  };

  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    value: api as unknown as DesktopApi
  });

  return api;
}

describe('Xshell import dialog helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('filters groups and hosts by search metadata', () => {
    expect(filterXshellImportGroups(initialProbeResult.groups, 'nested')).toEqual([initialProbeResult.groups[1]]);
    expect(filterXshellImportHosts(initialProbeResult.hosts, 'web.pem')).toEqual([initialProbeResult.hosts[0]]);
    expect(filterXshellImportHosts(initialProbeResult.hosts, 'postgres')).toEqual([initialProbeResult.hosts[1]]);
  });

  it('counts hosts selected by explicit hosts and selected group subtrees', () => {
    expect(countEffectiveSelectedXshellHosts(initialProbeResult.hosts, ['Servers'], [])).toBe(2);
    expect(countEffectiveSelectedXshellHosts(initialProbeResult.hosts, [], ['host-2'])).toBe(1);
  });
});

describe('Xshell import dialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the default snapshot, appends folders, and imports selected groups and hosts', async () => {
    const api = installMockApi();
    const onClose = vi.fn();
    const onImported = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<XshellImportDialog open onClose={onClose} onImported={onImported} />);

    await waitFor(() => expect(api.xshell.probeDefault).toHaveBeenCalled());

    expect(screen.getByText('Xshell 가져오기')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();

    const selectionButtons = container.querySelectorAll('.xshell-import-dialog__selection-actions .secondary-button');
    fireEvent.click(selectionButtons[0] as HTMLButtonElement);

    await waitFor(() => expect(api.shell.pickXshellSessionFolder).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.xshell.addFolderToSnapshot).toHaveBeenCalledWith({
        snapshotId: initialProbeResult.snapshotId,
        folderPath: 'D:/shared/xshell'
      })
    );

    expect(screen.getByText('lab')).toBeInTheDocument();

    fireEvent.click(selectionButtons[1] as HTMLButtonElement);
    fireEvent.click(container.querySelector('.modal-card__footer .primary-button') as HTMLButtonElement);

    await waitFor(() =>
      expect(api.xshell.importSelection).toHaveBeenCalledWith({
        snapshotId: appendedProbeResult.snapshotId,
        selectedGroupPaths: ['Servers', 'Servers/Nested', 'Lab'],
        selectedHostKeys: ['host-1', 'host-2', 'host-3']
      })
    );
    expect(onImported).toHaveBeenCalledWith({
      createdGroupCount: 3,
      createdHostCount: 3,
      createdSecretCount: 0,
      skippedHostCount: 0,
      warnings: []
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('stays usable when no sessions are found', async () => {
    const api = installMockApi();
    api.xshell.probeDefault.mockResolvedValueOnce(emptyProbeResult);

    const { container } = render(<XshellImportDialog open onClose={vi.fn()} onImported={vi.fn()} />);

    await waitFor(() => expect(api.xshell.probeDefault).toHaveBeenCalled());

    expect(container.querySelector('.xshell-import-dialog__selection-actions .secondary-button')).toBeTruthy();
    expect(container.querySelector('.xshell-import-dialog__empty')).toBeTruthy();
  });
});
