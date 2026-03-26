import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi, OpenSshProbeResult } from '@shared';
import {
  OpenSshImportDialog,
  filterOpenSshImportHosts,
} from './OpenSshImportDialog';

const initialProbeResult: OpenSshProbeResult = {
  snapshotId: 'snapshot-1',
  sources: [
    {
      id: 'source:default',
      filePath: 'C:/Users/tester/.ssh/config',
      origin: 'default-ssh-dir',
      label: '~/.ssh/config',
    },
  ],
  warnings: [
    {
      code: 'unsupported-host-pattern',
      message: '구체적인 별칭이 없는 Host 블록은 가져오지 않았습니다.',
    },
  ],
  hosts: [
    {
      key: 'host-1',
      alias: 'web',
      hostname: 'web.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'privateKey',
      identityFilePath: 'C:/Users/tester/.ssh/id_ed25519',
      sourceFilePath: 'C:/Users/tester/.ssh/config',
      sourceLine: 4,
    },
  ],
  skippedExistingHostCount: 1,
  skippedDuplicateHostCount: 0,
};

const appendedProbeResult: OpenSshProbeResult = {
  ...initialProbeResult,
  sources: [
    ...initialProbeResult.sources,
    {
      id: 'source:file',
      filePath: 'D:/shared/team.conf',
      origin: 'manual-file',
      label: 'team.conf',
    },
  ],
  hosts: [
    ...initialProbeResult.hosts,
    {
      key: 'host-2',
      alias: 'db',
      hostname: 'db.example.com',
      port: 2200,
      username: 'postgres',
      authType: 'password',
      identityFilePath: null,
      sourceFilePath: 'D:/shared/team.conf',
      sourceLine: 9,
    },
  ],
  skippedExistingHostCount: 1,
  skippedDuplicateHostCount: 1,
};

const emptyProbeResult: OpenSshProbeResult = {
  snapshotId: 'snapshot-empty',
  sources: [],
  hosts: [],
  warnings: [],
  skippedExistingHostCount: 0,
  skippedDuplicateHostCount: 0,
};

function installMockApi() {
  const api = {
    openssh: {
      probeDefault: vi.fn().mockResolvedValue(initialProbeResult),
      addFileToSnapshot: vi.fn().mockResolvedValue(appendedProbeResult),
      importSelection: vi.fn().mockResolvedValue({
        createdHostCount: 2,
        createdSecretCount: 1,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    shell: {
      pickOpenSshConfig: vi.fn().mockResolvedValue('D:/shared/team.conf'),
    },
  };

  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    value: api as unknown as DesktopApi,
  });

  return api;
}

describe('OpenSSH import dialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('filters hosts by alias, username, and key path metadata', () => {
    expect(filterOpenSshImportHosts(appendedProbeResult.hosts, 'web')).toEqual([
      appendedProbeResult.hosts[0],
    ]);
    expect(
      filterOpenSshImportHosts(appendedProbeResult.hosts, 'postgres'),
    ).toEqual([appendedProbeResult.hosts[1]]);
    expect(
      filterOpenSshImportHosts(appendedProbeResult.hosts, 'id_ed25519'),
    ).toEqual([appendedProbeResult.hosts[0]]);
  });

  it('loads the default snapshot, appends manual files, and imports selected hosts into the current group', async () => {
    const api = installMockApi();
    const onClose = vi.fn();
    const onImported = vi.fn().mockResolvedValue(undefined);

    render(
      <OpenSshImportDialog
        open
        currentGroupPath="Servers/Prod"
        onClose={onClose}
        onImported={onImported}
      />,
    );

    await waitFor(() => expect(api.openssh.probeDefault).toHaveBeenCalled());

    expect(screen.getByText('Import OpenSSH')).toBeInTheDocument();
    expect(screen.getByText(initialProbeResult.warnings[0].message)).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('기존 호스트 생략 1')).toBeInTheDocument();
    expect(screen.getByText('Servers/Prod')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '파일 불러오기' }));

    await waitFor(() =>
      expect(api.shell.pickOpenSshConfig).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(api.openssh.addFileToSnapshot).toHaveBeenCalledWith({
        snapshotId: initialProbeResult.snapshotId,
        filePath: 'D:/shared/team.conf',
      }),
    );

    expect(screen.getByText('db')).toBeInTheDocument();
    expect(screen.getByText('중복 호스트 생략 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '보이는 항목 모두 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '가져오기' }));

    await waitFor(() =>
      expect(api.openssh.importSelection).toHaveBeenCalledWith({
        snapshotId: appendedProbeResult.snapshotId,
        selectedHostKeys: ['host-1', 'host-2'],
        groupPath: 'Servers/Prod',
      }),
    );
    expect(onImported).toHaveBeenCalledWith({
      createdHostCount: 2,
      createdSecretCount: 1,
      skippedHostCount: 0,
      warnings: [],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the dialog usable when the default probe returns no hosts', async () => {
    const api = installMockApi();
    api.openssh.probeDefault.mockResolvedValueOnce(emptyProbeResult);

    render(
      <OpenSshImportDialog
        open
        currentGroupPath={null}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.openssh.probeDefault).toHaveBeenCalled());
    expect(
      screen.getByText('가져올 수 있는 OpenSSH 호스트가 없습니다.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '파일 불러오기' })).toBeInTheDocument();
  });
});
