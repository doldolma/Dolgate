import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi, XshellProbeResult } from '@shared';
import {
  XshellImportDialog,
  buildXshellImportTree,
  collectEffectiveSelectedXshellGroupPaths,
  collectVisibleXshellSelectionTargets,
  countEffectiveSelectedXshellHosts
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
      path: 'Servers/Empty',
      name: 'Empty',
      parentPath: 'Servers',
      hostCount: 0
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
      key: 'host-root',
      label: 'root-host',
      hostname: 'root.example.com',
      port: 22,
      username: 'root',
      authType: 'password',
      groupPath: null,
      privateKeyPath: null,
      sourceFilePath: 'C:/Users/tester/Documents/NetSarang Computer/8/Xshell/Sessions/root-host.xsh',
      hasPasswordHint: false,
      hasAuthProfile: false
    },
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
      code: 'auth-profile-not-imported',
      message: 'db: Xshell 인증 프로필은 현재 버전에서 가져오지 않습니다.'
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
        createdGroupCount: 4,
        createdHostCount: 3,
        createdSecretCount: 1,
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

  it('builds a filtered tree that keeps ancestor groups for matching hosts', () => {
    const tree = buildXshellImportTree(initialProbeResult.groups, initialProbeResult.hosts, 'postgres');

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      kind: 'group',
      path: 'Servers'
    });
    if (tree[0]?.kind !== 'group') {
      throw new Error('Expected a group node');
    }

    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0]).toMatchObject({
      kind: 'group',
      path: 'Servers/Nested'
    });
  });

  it('counts effective hosts and created groups from explicit selections', () => {
    expect(countEffectiveSelectedXshellHosts(initialProbeResult.hosts, ['Servers'], [])).toBe(2);
    expect(countEffectiveSelectedXshellHosts(initialProbeResult.hosts, [], ['host-root'])).toBe(1);
    expect(collectEffectiveSelectedXshellGroupPaths(initialProbeResult.groups, initialProbeResult.hosts, ['Servers'], [])).toEqual([
      'Servers',
      'Servers/Empty',
      'Servers/Nested'
    ]);
    expect(collectEffectiveSelectedXshellGroupPaths(initialProbeResult.groups, initialProbeResult.hosts, [], ['host-root'])).toEqual([]);
  });

  it('selects only matching hosts when visible tree comes from a host search', () => {
    const tree = buildXshellImportTree(initialProbeResult.groups, initialProbeResult.hosts, 'postgres');

    expect(collectVisibleXshellSelectionTargets(tree)).toEqual({
      groupPaths: [],
      hostKeys: ['host-2']
    });
  });
});

describe('Xshell import dialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the default snapshot, appends folders, and imports root hosts plus selected groups', async () => {
    const api = installMockApi();
    const onClose = vi.fn();
    const onImported = vi.fn().mockResolvedValue(undefined);
    render(<XshellImportDialog open onClose={onClose} onImported={onImported} />);

    await waitFor(() => expect(api.xshell.probeDefault).toHaveBeenCalled());

    expect(screen.getByText('Xshell 가져오기')).toBeInTheDocument();
    expect(screen.getByText('암호화된 비밀번호는 복호화를 시도합니다. 실패하면 호스트만 추가됩니다.')).toBeInTheDocument();
    expect(screen.getByText('root-host')).toBeInTheDocument();
    expect(screen.getByText('루트 세션')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '세션 폴더 선택' }));

    await waitFor(() => expect(api.shell.pickXshellSessionFolder).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.xshell.addFolderToSnapshot).toHaveBeenCalledWith({
        snapshotId: initialProbeResult.snapshotId,
        folderPath: 'D:/shared/xshell'
      })
    );

    await waitFor(() => expect(screen.getByText('lab')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('root-host 호스트 선택'));
    fireEvent.click(screen.getByLabelText('Servers 그룹 선택'));

    const nestedHostCheckbox = screen.getByLabelText('db 호스트 선택') as HTMLInputElement;
    expect(nestedHostCheckbox.checked).toBe(true);
    expect(nestedHostCheckbox.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '가져오기' }));

    await waitFor(() =>
      expect(api.xshell.importSelection).toHaveBeenCalledWith({
        snapshotId: appendedProbeResult.snapshotId,
        selectedGroupPaths: ['Servers'],
        selectedHostKeys: ['host-root']
      })
    );
    expect(onImported).toHaveBeenCalledWith({
      createdGroupCount: 4,
      createdHostCount: 3,
      createdSecretCount: 1,
      skippedHostCount: 0,
      warnings: []
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('imports an empty group without adding hosts', async () => {
    const api = installMockApi();
    render(<XshellImportDialog open onClose={vi.fn()} onImported={vi.fn()} />);

    await waitFor(() => expect(api.xshell.probeDefault).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('그룹, 호스트, 사용자명, 경로 검색'), {
      target: { value: 'Empty' }
    });
    fireEvent.click(screen.getByRole('button', { name: '보이는 항목 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '가져오기' }));

    await waitFor(() =>
      expect(api.xshell.importSelection).toHaveBeenCalledWith({
        snapshotId: initialProbeResult.snapshotId,
        selectedGroupPaths: ['Servers/Empty'],
        selectedHostKeys: []
      })
    );
  });

  it('stays usable when no sessions are found', async () => {
    const api = installMockApi();
    api.xshell.probeDefault.mockResolvedValueOnce(emptyProbeResult);

    render(<XshellImportDialog open onClose={vi.fn()} onImported={vi.fn()} />);

    await waitFor(() => expect(api.xshell.probeDefault).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: '세션 폴더 선택' })).toBeEnabled();
    expect(screen.getByText('현재 조건과 일치하는 Xshell 그룹이나 호스트가 없습니다.')).toBeInTheDocument();
  });
});
