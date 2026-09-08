import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DolgateImportDialog, HostExportDialog } from './HostTransferDialogs';

const mocks = vi.hoisted(() => ({
  previewHostExport: vi.fn(),
  pickDolgateImportFile: vi.fn(),
  probeDolgateImport: vi.fn(),
  discardDolgateImport: vi.fn(),
}));

vi.mock('../services/desktop/imports', () => ({
  previewHostExport: mocks.previewHostExport,
  exportHostSelection: vi.fn(),
  pickDolgateImportFile: mocks.pickDolgateImportFile,
  probeDolgateImport: mocks.probeDolgateImport,
  commitDolgateImport: vi.fn(),
  discardDolgateImport: mocks.discardDolgateImport,
}));

describe('HostExportDialog', () => {
  beforeEach(() => {
    mocks.previewHostExport.mockReset();
    mocks.pickDolgateImportFile.mockReset();
    mocks.probeDolgateImport.mockReset();
    mocks.discardDolgateImport.mockReset();
    mocks.discardDolgateImport.mockResolvedValue(undefined);
  });

  it('normalizes Electron IPC errors from export preview', async () => {
    mocks.previewHostExport.mockRejectedValue(
      new Error(
        "Error invoking remote method 'host-transfer:preview-export': Error: 내보내기 항목을 확인하지 못했습니다.",
      ),
    );

    render(
      <HostExportDialog
        open
        hostIds={['host-1']}
        workspaceIds={[]}
        onClose={vi.fn()}
        onExported={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '내보내기 항목을 확인하지 못했습니다.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error invoking remote method');
  });

  it('explains why a Dolgate export password is not ready', async () => {
    mocks.previewHostExport.mockResolvedValue({
      selectedHostCount: 1,
      selectedWorkspaceCount: 0,
      dolgateHostCount: 1,
      dolgateWorkspaceCount: 0,
      opensshHostCount: 1,
      opensshDependencyCount: 0,
      opensshSkippedCount: 0,
      opensshWorkspaceSkippedCount: 0,
      opensshWarnings: [],
    });

    render(
      <HostExportDialog
        open
        hostIds={['host-1']}
        workspaceIds={[]}
        onClose={vi.fn()}
        onExported={vi.fn()}
      />,
    );

    const exportButton = await screen.findByRole('button', { name: '내보내기' });
    const passwordInput = screen.getByLabelText('암호');
    const passwordConfirmInput = screen.getByLabelText('암호 확인');

    fireEvent.change(passwordInput, { target: { value: 'abc' } });
    expect(screen.getByText('암호는 4자 이상이어야 합니다.')).toBeInTheDocument();
    expect(exportButton).toBeDisabled();

    fireEvent.change(passwordInput, { target: { value: 'abcd' } });
    expect(screen.getByText('암호 확인을 입력해 주세요.')).toBeInTheDocument();

    fireEvent.change(passwordConfirmInput, { target: { value: 'abce' } });
    expect(screen.getByText('암호와 암호 확인이 일치하지 않습니다.')).toBeInTheDocument();
    expect(exportButton).toBeDisabled();

    fireEvent.change(passwordConfirmInput, { target: { value: 'abcd' } });
    expect(screen.getByText('암호가 일치합니다.')).toBeInTheDocument();
    expect(exportButton).toBeEnabled();
  });
});

  // 부모(HomeShell)는 선택을 HomeAssetRef[] 로 들고 있고, 예전에는 렌더마다 그 배열을
  // filter().map() 으로 새로 만들어 넘겼다. 미리보기 효과가 그 배열 **동일성**에 걸려 있어서,
  // 활동 로그가 하나 도착하거나 30초 동기화 폴링이 돌기만 해도 효과가 다시 실행돼 입력 중인
  // 내보내기 암호가 지워졌다.
  it('부모가 다시 렌더돼도 입력한 암호를 지우지 않는다', async () => {
    mocks.previewHostExport.mockResolvedValue({
      selectedHostCount: 1,
      selectedWorkspaceCount: 0,
      dolgateHostCount: 1,
      dolgateWorkspaceCount: 0,
      opensshHostCount: 1,
      opensshDependencyCount: 0,
      opensshSkippedCount: 0,
      opensshWorkspaceSkippedCount: 0,
      opensshWarnings: [],
    });

    let bumpParent = () => {};
    function Parent() {
      const [, setTick] = useState(0);
      bumpParent = () => setTick((value) => value + 1);
      return (
        <HostExportDialog
          open
          // 렌더마다 새 배열 — 예전 HomeShell 이 넘기던 모양 그대로다.
          hostIds={['host-1'].map((id) => id)}
          workspaceIds={[]}
          onClose={vi.fn()}
          onExported={vi.fn()}
        />
      );
    }

    render(<Parent />);
    const passwordInput = await screen.findByLabelText('암호');
    fireEvent.change(passwordInput, { target: { value: 'super-secret-1234' } });
    expect(passwordInput).toHaveValue('super-secret-1234');
    const previewCallsBefore = mocks.previewHostExport.mock.calls.length;

    act(() => {
      bumpParent();
    });

    expect(screen.getByLabelText('암호')).toHaveValue('super-secret-1234');
    // 선택이 바뀌지 않았으므로 미리보기도 다시 받지 않는다.
    expect(mocks.previewHostExport.mock.calls.length).toBe(previewCallsBefore);
  });

describe('DolgateImportDialog', () => {
  beforeEach(() => {
    mocks.pickDolgateImportFile.mockReset();
    mocks.probeDolgateImport.mockReset();
    mocks.discardDolgateImport.mockReset();
    mocks.discardDolgateImport.mockResolvedValue(undefined);
  });

  it('describes skipped import items by their actual type', async () => {
    mocks.pickDolgateImportFile.mockResolvedValue({
      filePath: '/tmp/hosts.dolgate',
      fileName: 'hosts.dolgate',
    });
    mocks.probeDolgateImport.mockResolvedValue({
      snapshotId: 'snapshot-1',
      hostCount: 1,
      workspaceCount: 0,
      groupCount: 0,
      secretCount: 0,
      awsProfileCount: 0,
      snippetCount: 0,
      portForwardCount: 0,
      dnsOverrideCount: 0,
      knownHostCount: 0,
      skippedCount: 4,
      skippedCounts: {
        hosts: 0,
        workspaces: 0,
        groups: 3,
        secrets: 0,
        awsProfiles: 1,
        snippets: 0,
        portForwards: 0,
        dnsOverrides: 0,
        knownHosts: 0,
      },
      warnings: [],
    });

    render(
      <DolgateImportDialog
        open
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '파일 선택' }));
    await screen.findByText('hosts.dolgate');
    fireEvent.change(screen.getByLabelText('내보내기 암호'), {
      target: { value: 'password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '내용 확인' }));

    expect(await screen.findByText('호스트 1개를 가져올 준비가 됐습니다.')).toBeInTheDocument();
    expect(screen.getByText('이미 존재하여 제외: 그룹 3개, AWS 프로필 1개.')).toBeInTheDocument();
    expect(screen.queryByText(/이미 있는 항목 4개/)).not.toBeInTheDocument();
  });
});
