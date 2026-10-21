import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MyHostCredentialsSummary, RdpHostRecord, SshHostRecord, VncHostRecord } from '@shared';
import { MyCredentialsDialog, type MyCredentialsHost } from './MyCredentialsDialog';

// 팀 호스트의 내 자격 증명 편집(D1) — 빈 칸은 보내지 않는다(이름·방식은 팀 것, 저장된 비밀값은 그대로).

const pickers = vi.hoisted(() => ({
  pickPrivateKey: vi.fn(),
  pickSshCertificate: vi.fn(),
}));
vi.mock('../../services/desktop/settings', () => pickers);

const ssh = {
  id: 'team-web',
  kind: 'ssh',
  label: 'acme-web-1',
  hostname: '10.20.0.11',
  port: 22,
  username: 'ubuntu',
  authType: 'password',
} as SshHostRecord;
const rdp = { id: 'team-rdp', kind: 'rdp', label: 'win-rdp', hostname: '10.20.0.40', port: 3389 } as RdpHostRecord;
const vnc = { id: 'team-vnc', kind: 'vnc', label: 'lab-vnc', hostname: '10.20.0.50', port: 5900 } as VncHostRecord;

const summary = (overrides: Partial<MyHostCredentialsSummary> = {}): MyHostCredentialsSummary => ({
  username: 'deploy',
  authType: 'password',
  domain: null,
  hasPassword: true,
  hasPrivateKey: false,
  hasCertificate: false,
  hasPassphrase: false,
  ...overrides,
});

function renderDialog(host: MyCredentialsHost, current: MyHostCredentialsSummary | null = null) {
  const props = {
    onSave: vi.fn().mockResolvedValue(undefined),
    onClear: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };
  render(<MyCredentialsDialog host={host} summary={current} {...props} />);
  return props;
}

const dialog = () => within(screen.getByRole('dialog'));
const field = (label: string) =>
  dialog()
    .getByText(label, { selector: 'span' })
    .closest('label')!
    .querySelector('input, select') as HTMLInputElement & HTMLSelectElement;

describe('MyCredentialsDialog', () => {
  it("shows the team's values as hints and sends only what you filled", async () => {
    const props = renderDialog(ssh);

    expect(dialog().getByRole('heading', { name: 'acme-web-1 · 내 자격 증명' })).toBeInTheDocument();
    expect(field('사용자 이름').placeholder).toBe('ubuntu (팀)');
    expect(field('인증 방식').value).toBe('');
    expect(dialog().getByRole('option', { name: '팀 것 그대로 (비밀번호)' })).toBeInTheDocument();
    // 저장된 것이 없으니 지우기도, "그대로 유지" 도 없다.
    expect(dialog().queryByRole('button', { name: '지우기' })).toBeNull();
    expect(field('비밀번호').placeholder).toBe('');

    fireEvent.change(field('사용자 이름'), { target: { value: ' deploy ' } });
    fireEvent.change(field('비밀번호'), { target: { value: 'pw' } });
    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ username: 'deploy', password: 'pw' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('keeps stored secrets when left blank, and clears everything on 지우기', async () => {
    const props = renderDialog(ssh, summary());

    expect(field('사용자 이름').value).toBe('deploy');
    expect(field('인증 방식').value).toBe('password');
    expect(field('비밀번호').placeholder).toBe('비워 두면 그대로 유지');
    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ username: 'deploy', authType: 'password' }));

    // 저장하는 동안에는 단추가 잠긴다 — 풀린 뒤에 누른다(바쁜 기계에서는 저장이 늦게 끝난다).
    await waitFor(() => expect(dialog().getByRole('button', { name: '지우기' })).toBeEnabled());
    fireEvent.click(dialog().getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(props.onClear).toHaveBeenCalled());
  });

  it('asks for a key when switching to a private key, and drops the stored password hint', async () => {
    pickers.pickPrivateKey.mockResolvedValue({ name: 'id_ed25519', content: 'PEM' });
    const props = renderDialog(ssh, summary());

    fireEvent.change(field('인증 방식'), { target: { value: 'privateKey' } });
    expect(dialog().queryByText('비밀번호', { selector: 'span' })).toBeNull();
    fireEvent.click(dialog().getByRole('button', { name: '가져오기' }));
    await waitFor(() => expect(field('개인키 파일').value).toBe('id_ed25519'));
    fireEvent.change(field('패스프레이즈'), { target: { value: 'pp' } });
    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({
        username: 'deploy',
        authType: 'privateKey',
        privateKeyPem: 'PEM',
        passphrase: 'pp',
      }),
    );
  });

  it('promises to keep a stored key only while the auth type stays the same', () => {
    renderDialog(ssh, summary({ authType: 'privateKey', hasPassword: false, hasPrivateKey: true, hasPassphrase: true }));

    expect(field('개인키 파일').placeholder).toBe('비워 두면 그대로 유지');
    expect(field('패스프레이즈').placeholder).toBe('비워 두면 그대로 유지');
    // 방식을 바꾸면 메인이 옛 비밀값을 버린다 — 창도 "그대로 유지" 를 약속하지 않는다.
    fireEvent.change(field('인증 방식'), { target: { value: 'certificate' } });
    expect(field('개인키 파일').placeholder).toBe('/Users/.../.ssh/id_ed25519');
    expect(field('패스프레이즈').placeholder).toBe('');
  });

  it('asks for a certificate too, and nothing secret with the SSH agent', async () => {
    pickers.pickPrivateKey.mockResolvedValue({ name: 'id_ed25519', content: 'PEM' });
    pickers.pickSshCertificate.mockResolvedValue({ name: 'id_ed25519-cert.pub', content: 'CERT' });
    const props = renderDialog(ssh);

    fireEvent.change(field('인증 방식'), { target: { value: 'certificate' } });
    const [keyImport, certImport] = dialog().getAllByRole('button', { name: '가져오기' });
    fireEvent.click(keyImport!);
    fireEvent.click(certImport!);
    await waitFor(() => expect(field('SSH 인증서 파일').value).toBe('id_ed25519-cert.pub'));
    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenLastCalledWith({ authType: 'certificate', privateKeyPem: 'PEM', certificateText: 'CERT' }),
    );
  });

  it('sends only the auth type for the SSH agent', async () => {
    const props = renderDialog(ssh);

    fireEvent.change(field('인증 방식'), { target: { value: 'agent' } });
    expect(dialog().queryByText('비밀번호', { selector: 'span' })).toBeNull();
    expect(dialog().queryByText('개인키 파일', { selector: 'span' })).toBeNull();
    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ authType: 'agent' }));
  });

  it('asks RDP for account, password and domain, and VNC for a password only', async () => {
    const rdpProps = renderDialog(rdp);
    fireEvent.change(field('계정'), { target: { value: 'kim.dev' } });
    fireEvent.change(field('비밀번호'), { target: { value: 'pw' } });
    fireEvent.change(field('도메인'), { target: { value: 'ACME' } });
    expect(dialog().queryByText('인증 방식', { selector: 'span' })).toBeNull();
    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    await waitFor(() => expect(rdpProps.onSave).toHaveBeenCalledWith({ username: 'kim.dev', password: 'pw', domain: 'ACME' }));
  });

  it('asks VNC for a password only', async () => {
    const props = renderDialog(vnc, summary({ username: null, authType: null }));

    expect(dialog().queryByText('사용자 이름', { selector: 'span' })).toBeNull();
    expect(dialog().queryByText('계정', { selector: 'span' })).toBeNull();
    expect(field('비밀번호').placeholder).toBe('비워 두면 그대로 유지');
    fireEvent.change(field('비밀번호'), { target: { value: 'vnc-pw' } });
    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ password: 'vnc-pw' }));
  });

  it('stays open and says so when saving fails', async () => {
    const props = renderDialog(ssh);
    props.onSave.mockRejectedValue(new Error('vault locked'));

    fireEvent.click(dialog().getByRole('button', { name: '저장' }));
    expect(await dialog().findByRole('alert')).toHaveTextContent('vault locked');
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
