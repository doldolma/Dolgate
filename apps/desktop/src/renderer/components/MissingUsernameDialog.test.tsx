import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MissingUsernameDialog } from './MissingUsernameDialog';

describe('MissingUsernameDialog', () => {
  it('explains that the entered username is saved and reused for SSH connections', () => {
    render(
      <MissingUsernameDialog
        request={{ hostLabel: 'Synology', source: 'ssh' }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(/아직 저장된 SSH 사용자명이 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/다음 연결부터 자동으로 재사용합니다/)).toBeInTheDocument();
  });

  it('keeps the same save-and-continue behavior for non-SSH fallback flows', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <MissingUsernameDialog
        request={{ hostLabel: 'Synology', source: 'sftp' }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText(/SFTP 연결을 계속하려면 사용자명을 입력해 주세요/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('SSH Username'), {
      target: { value: 'ubuntu' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장 후 계속' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ username: 'ubuntu' });
    });
  });
});
