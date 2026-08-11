import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { HostDrawer } from './HostDrawer';

const editHost: HostRecord = {
  id: 'host-1',
  kind: 'ssh',
  label: 'App Server',
  hostname: 'app.example.com',
  port: 22,
  username: 'ubuntu',
  authType: 'password',
  privateKeyPath: null,
  secretRef: null,
  groupName: 'Servers',
  tags: ['app'],
  terminalThemeId: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z'
};

function renderDrawer(options?: {
  mode?: 'create' | 'edit';
  open?: boolean;
  onClose?: () => void;
  host?: HostRecord | null;
  keychainEntries?: SecretMetadataRecord[];
  /** RDP 는 서버가 계정 데이터 수준을 저장할 수 있을 때만 만들 수 있다. 기본은 지원하는 서버. */
  serverSupportsDataFloor?: boolean;
}) {
  const onClose = options?.onClose ?? vi.fn();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onConnect = vi.fn().mockResolvedValue(undefined);

  return {
    onClose,
    onSubmit,
    onConnect,
    ...render(
      <HostDrawer
        open={options?.open ?? true}
        mode={options?.mode ?? 'edit'}
        host={options?.host ?? (options?.mode === 'create' ? null : editHost)}
        keychainEntries={options?.keychainEntries ?? []}
        serverSupportsDataFloor={options?.serverSupportsDataFloor ?? true}
        groupOptions={[
          { value: null, label: 'Ungrouped' },
          { value: 'Servers', label: 'Servers' }
        ]}
        onClose={onClose}
        onSubmit={onSubmit}
        onConnect={onConnect}
        onEditExistingSecret={vi.fn()}
        onOpenSecrets={vi.fn()}
      />
    )
  };
}

// SSH·Serial·RDP 각각 따로 있던 입구를 New Host 하나로 합치고, 종류는 폼 맨 위 셀렉터로
// 고른다. 폼 자체는 원래도 한 컴포넌트가 세 종류를 다 그렸으므로, 여기서 보장할 건
// "셀렉터가 실제로 폼 본문을 바꾸는가"와 "적어 둔 라벨이 살아남는가"다.
describe('HostDrawer create-mode host kind selector', () => {
  it('defaults to SSH and swaps the form body when another kind is picked', async () => {
    renderDrawer({ mode: 'create' });

    expect(screen.getByRole('button', { name: 'SSH' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText('통신 속도(baud)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Serial' }));

    await waitFor(() => {
      expect(screen.getByText('통신 속도(baud)')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Serial' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'SSH' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'RDP' }));

    await waitFor(() => {
      expect(screen.getByText('도메인')).toBeInTheDocument();
    });
    expect(screen.queryByText('통신 속도(baud)')).not.toBeInTheDocument();
  });

  // 한 번 놓친 실수: 선택된 칸을 --surface-elevated 로 칠했는데 트랙의 --surface-strong 과
  // 사실상 같은 색이라(라이트 255,255,255 vs 250,252,255) 눌러도 아무 표시가 없었다.
  // 선택은 명도가 아니라 강조색 틴트로 구분돼야 한다.
  it('paints the selected segment with the accent selection tint, not a same-tone surface', () => {
    renderDrawer({ mode: 'create' });

    const ssh = screen.getByRole('button', { name: 'SSH' });
    const serial = screen.getByRole('button', { name: 'Serial' });

    expect(ssh.className).toContain('bg-[var(--selection-tint)]');
    expect(ssh.className).toContain('border-[var(--selection-border)]');
    expect(serial.className).not.toContain('bg-[var(--selection-tint)]');

    fireEvent.click(serial);

    expect(screen.getByRole('button', { name: 'Serial' }).className).toContain(
      'bg-[var(--selection-tint)]',
    );
    expect(screen.getByRole('button', { name: 'SSH' }).className).not.toContain(
      'bg-[var(--selection-tint)]',
    );
  });

  it('keeps a label already typed in the header when the kind changes', async () => {
    renderDrawer({ mode: 'create' });

    const labelInput = screen.getByLabelText('Label');
    fireEvent.change(labelInput, { target: { value: 'Lab board' } });

    fireEvent.click(screen.getByRole('button', { name: 'Serial' }));

    await waitFor(() => {
      expect(screen.getByText('통신 속도(baud)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Label')).toHaveValue('Lab board');
  });

  it('shows the kind badge for the selected kind', async () => {
    renderDrawer({ mode: 'create' });

    expect(screen.getByText('S')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'RDP' }));

    await waitFor(() => {
      // 저장 뒤 getHostBadgeLabel 이 내는 값과 같아야 뱃지가 바뀌지 않는다.
      expect(screen.getByText('RDP', { selector: 'span' })).toBeInTheDocument();
    });
  });

  it('does not offer the selector in edit mode', () => {
    renderDrawer({ mode: 'edit' });

    expect(screen.queryByRole('button', { name: 'Serial' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'RDP' })).not.toBeInTheDocument();
  });
});

describe('HostDrawer close behavior', () => {
  it('does not close on outside clicks in edit mode (stays open)', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.mouseDown(document.body);
    fireEvent.contextMenu(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when clicking inside the edit drawer header or form', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.mouseDown(screen.getByLabelText('Label'));
    fireEvent.mouseDown(screen.getByLabelText('호스트 이름'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close from outside clicks in create mode', () => {
    const { onClose } = renderDrawer({ mode: 'create' });

    fireEvent.mouseDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes from the explicit close button', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.click(screen.getByRole('button', { name: 'Close host editor' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a fixed footer for create mode', () => {
    renderDrawer({ mode: 'create' });

    expect(screen.getByTestId('drawer-scroll-body')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-footer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Host' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('renders only the save action in the fixed footer for edit mode', () => {
    renderDrawer({ mode: 'edit' });

    expect(screen.getByRole('button', { name: '저장' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('submits create mode from the footer action', async () => {
    const { onSubmit } = renderDrawer({ mode: 'create' });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'New host' } });
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'new.example.com' } });
    fireEvent.change(screen.getByLabelText('사용자 이름'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Host' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ssh',
        label: 'New host',
        hostname: 'new.example.com',
        username: '',
      }),
      expect.objectContaining({
        password: undefined,
        passphrase: undefined,
      }),
    );
  });

  it('saves from the footer action without connecting', async () => {
    const { onSubmit, onConnect } = renderDrawer({ mode: 'edit' });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod SSH' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ label: 'Prod SSH' });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('shows save status text in the footer after an explicit save', async () => {
    const { onSubmit } = renderDrawer({ mode: 'edit' });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod API' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(screen.getByTestId('drawer-footer')).getByText('저장됨')).toBeInTheDocument(),
    );
  });
});

// 서버가 계정 데이터 수준을 저장할 수 없으면 RDP 는 만들 수 없다 — 만들어도 서버가 옛 기기를
// 막아 주지 못해, 같은 계정의 옛 기기가 그 레코드를 받아 조용히 망가진다.
describe('HostDrawer host kinds by server capability', () => {
  it('서버가 지원하지 않으면 RDP 탭이 없다', () => {
    renderDrawer({ mode: 'create', serverSupportsDataFloor: false });

    expect(screen.getByRole('button', { name: 'SSH' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Serial' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'RDP' })).not.toBeInTheDocument();
  });
});
