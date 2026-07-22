import { fireEvent, render, screen } from '@testing-library/react';
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
      dolgateHostCount: 1,
      opensshHostCount: 1,
      opensshDependencyCount: 0,
      opensshSkippedCount: 0,
      opensshWarnings: [],
    });

    render(
      <HostExportDialog
        open
        hostIds={['host-1']}
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
