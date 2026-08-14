import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PendingSessionInteractiveAuth } from '../../store/createAppStore';
import { TerminalInteractiveAuthOverlay } from './TerminalInteractiveAuthOverlay';

const genericAuth: PendingSessionInteractiveAuth = {
  source: 'ssh',
  sessionId: 'session-1',
  challengeId: 'challenge-1',
  instruction: '코드를 입력하세요.',
  prompts: [{ label: 'Code', echo: true }],
  provider: 'generic',
  autoSubmitted: false,
};

const warpgateAuth: PendingSessionInteractiveAuth = {
  source: 'ssh',
  sessionId: 'session-1',
  challengeId: 'challenge-2',
  instruction: 'Authorize in browser',
  prompts: [],
  provider: 'warpgate',
  approvalUrl: 'https://warpgate.test/approve',
  authCode: '123456',
  autoSubmitted: true,
};

describe('TerminalInteractiveAuthOverlay', () => {
  it('submits prompt responses for generic interactive auth', () => {
    const onPromptResponseChange = vi.fn();
    const onSubmit = vi.fn();

    render(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={genericAuth}
        promptResponses={['']}
        onPromptResponseChange={onPromptResponseChange}
        onSubmit={onSubmit}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Code'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: '응답 보내기' }));

    expect(onPromptResponseChange).toHaveBeenCalledWith(0, '654321');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('offers the saved password per prompt, and only when one exists', () => {
    // 어느 칸이 비밀번호인지 우리가 라벨로 판정하지 않는다 — 사용자가 지목한다. 잘못 채워 보내면
    // 인증 기회가 한 번뿐이라(x/crypto 는 한 방식을 한 번만 시도) 그걸로 연결이 끝난다.
    const twoRoundAuth: PendingSessionInteractiveAuth = {
      ...genericAuth,
      prompts: [
        { label: 'Password:', echo: false },
        { label: 'Verification code:', echo: false },
      ],
      hasStoredPassword: true,
    };
    const onStoredPasswordToggle = vi.fn();

    const { rerender } = render(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={twoRoundAuth}
        promptResponses={['', '']}
        storedPasswordPrompts={[false, false]}
        onPromptResponseChange={vi.fn()}
        onStoredPasswordToggle={onStoredPasswordToggle}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // 칸마다 하나씩 — 어느 칸이든 사용자가 고를 수 있다.
    const buttons = screen.getAllByRole('button', { name: '저장된 비밀번호 사용' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onStoredPasswordToggle).toHaveBeenCalledWith(0);

    // 지목한 칸은 입력을 막고 무엇이 나가는지 말해 준다.
    rerender(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={twoRoundAuth}
        promptResponses={['', '']}
        storedPasswordPrompts={[true, false]}
        onPromptResponseChange={vi.fn()}
        onStoredPasswordToggle={onStoredPasswordToggle}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Password:')).toBeDisabled();
    expect(screen.getByLabelText('Verification code:')).not.toBeDisabled();

    // 저장된 비밀번호가 없으면 내밀지 않는다.
    rerender(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={{ ...twoRoundAuth, hasStoredPassword: false }}
        promptResponses={['', '']}
        storedPasswordPrompts={[false, false]}
        onPromptResponseChange={vi.fn()}
        onStoredPasswordToggle={onStoredPasswordToggle}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: '저장된 비밀번호 사용' }),
    ).toBeNull();
  });

  it('shows the server wording verbatim', () => {
    // 무엇을 묻는지는 서버가 쓴 대로가 가장 정확하다 — 순서(비밀번호 먼저, 그다음 코드)가 여기 있다.
    render(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={{
          ...genericAuth,
          name: 'Two-factor authentication',
          instruction: '비밀번호를 넣은 뒤 인증 코드를 넣으세요.',
        }}
        promptResponses={['']}
        onPromptResponseChange={vi.fn()}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Two-factor authentication')).toBeTruthy();
    expect(
      screen.getByText('비밀번호를 넣은 뒤 인증 코드를 넣으세요.'),
    ).toBeTruthy();
  });

  it('names the hop that asked, and stays silent when the core did not say', () => {
    // 점프 체인에서는 베스천과 최종 대상이 똑같은 "Verification code:" 를 내민다 — 누구의
    // 코드인지 이 줄로만 알 수 있다.
    const { rerender } = render(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={{
          ...genericAuth,
          hop: { username: 'ubuntu', host: '192.168.200.37', port: 22 },
        }}
        promptResponses={['']}
        onPromptResponseChange={vi.fn()}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('요청한 호스트')).toBeTruthy();
    expect(screen.getByText('ubuntu@192.168.200.37:22')).toBeTruthy();

    rerender(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={{ ...genericAuth, hop: null }}
        promptResponses={['']}
        onPromptResponseChange={vi.fn()}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('요청한 호스트')).toBeNull();
  });

  it('shows why an answer could not be delivered', () => {
    // 답을 보낼 곳이 없어진 경우(연결이 이미 끝난 뒤) 조용히 실패하면 버튼이 먹통으로 보인다.
    render(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={{
          ...genericAuth,
          deliveryError: 'challenge hostkey-1 not found',
        }}
        promptResponses={['443626']}
        onPromptResponseChange={vi.fn()}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={vi.fn()}
        onReopenApprovalUrl={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('연결이 끝났습니다');
  });

  it('renders Warpgate-specific approval actions', () => {
    const onCopyApprovalUrl = vi.fn();
    const onReopenApprovalUrl = vi.fn();

    render(
      <TerminalInteractiveAuthOverlay
        interactiveAuth={warpgateAuth}
        promptResponses={[]}
        onPromptResponseChange={vi.fn()}
        onSubmit={vi.fn()}
        onCopyApprovalUrl={onCopyApprovalUrl}
        onReopenApprovalUrl={onReopenApprovalUrl}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '브라우저 다시 열기' }));
    fireEvent.click(screen.getByRole('button', { name: '링크 복사' }));

    expect(onReopenApprovalUrl).toHaveBeenCalledTimes(1);
    expect(onCopyApprovalUrl).toHaveBeenCalledTimes(1);
  });
});
