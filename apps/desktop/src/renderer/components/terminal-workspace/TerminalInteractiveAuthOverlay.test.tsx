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
