import type { PendingSessionInteractiveAuth } from '../../store/createAppStore';
import { Button, Card, SectionLabel } from '../../ui';

interface TerminalInteractiveAuthOverlayProps {
  interactiveAuth: PendingSessionInteractiveAuth;
  promptResponses: string[];
  onPromptResponseChange: (index: number, value: string) => void;
  onSubmit: () => void;
  onCopyApprovalUrl: () => Promise<void>;
  onReopenApprovalUrl: () => void;
  onClose: () => void;
}

export function TerminalInteractiveAuthOverlay({
  interactiveAuth,
  promptResponses,
  onPromptResponseChange,
  onSubmit,
  onCopyApprovalUrl,
  onReopenApprovalUrl,
  onClose,
}: TerminalInteractiveAuthOverlayProps) {
  if (interactiveAuth.provider === 'warpgate') {
    return (
      <Card className="terminal-interactive-auth grid max-w-[28rem] justify-stretch gap-3 p-5">
        <SectionLabel className="terminal-interactive-auth__label">
          Warpgate Approval
        </SectionLabel>
        <strong>Warpgate 승인을 기다리는 중입니다.</strong>
        <p>
          브라우저에서 Warpgate 로그인 후 <code>Authorize</code>를 눌러
          주세요. 가능한 입력은 앱이 자동으로 처리합니다.
        </p>
        {interactiveAuth.authCode ? (
          <p className="terminal-interactive-auth__code">
            인증 코드 <code>{interactiveAuth.authCode}</code> 는 자동으로
            입력됩니다.
          </p>
        ) : null}
        <div className="terminal-interactive-auth__actions flex flex-wrap items-center gap-3">
          {interactiveAuth.approvalUrl ? (
            <Button variant="secondary" size="sm" onClick={onReopenApprovalUrl}>
              브라우저 다시 열기
            </Button>
          ) : null}
          {interactiveAuth.approvalUrl ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void onCopyApprovalUrl();
              }}
            >
              링크 복사
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>
        <pre className="terminal-interactive-auth__raw">
          {interactiveAuth.instruction}
        </pre>
      </Card>
    );
  }

  return (
    <Card className="terminal-interactive-auth max-w-[28rem] justify-stretch p-5">
      <form
        className="terminal-interactive-auth__form grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <SectionLabel className="terminal-interactive-auth__label">
          Additional Authentication
        </SectionLabel>
        <strong>추가 인증 입력이 필요합니다.</strong>
        {interactiveAuth.instruction ? <p>{interactiveAuth.instruction}</p> : null}
        {interactiveAuth.prompts.map((prompt, index) => (
          <label
            key={`${interactiveAuth.challengeId}:${index}`}
            className="terminal-interactive-auth__field"
          >
            <span>{prompt.label || `Prompt ${index + 1}`}</span>
            <input
              className="mt-2 min-h-11 rounded-[16px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-muted)] px-4 py-3 text-[var(--text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-[border-color,box-shadow] duration-150 focus:border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] focus:ring-4 focus:ring-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)]"
              type={prompt.echo ? 'text' : 'password'}
              value={promptResponses[index] ?? ''}
              onChange={(event) => {
                onPromptResponseChange(index, event.target.value);
              }}
            />
          </label>
        ))}
        <div className="terminal-interactive-auth__actions flex items-center justify-end gap-3">
          <Button type="submit" variant="primary">
            응답 보내기
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </form>
    </Card>
  );
}
