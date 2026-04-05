import type { PendingInteractiveAuth } from '../../store/createAppStore';
import { Button, Input, SectionLabel } from '../../ui';

interface TerminalInteractiveAuthOverlayProps {
  interactiveAuth: PendingInteractiveAuth;
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
      <div className="grid max-w-[28rem] gap-3 rounded-[20px] border border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-raised)_84%,var(--accent-strong)_16%)] px-5 py-5 text-[var(--text)] shadow-[var(--shadow-soft)]">
        <SectionLabel>
          Warpgate Approval
        </SectionLabel>
        <strong>Warpgate 승인을 기다리는 중입니다.</strong>
        <p>
          브라우저에서 Warpgate 로그인 후 <code>Authorize</code>를 눌러
          주세요. 가능한 입력은 앱이 자동으로 처리합니다.
        </p>
        {interactiveAuth.authCode ? (
          <p className="text-sm text-[var(--text-soft)]">
            인증 코드 <code>{interactiveAuth.authCode}</code> 는 자동으로
            입력됩니다.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
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
        <pre className="rounded-[12px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-3 py-2 text-[0.84rem] text-[var(--text-soft)] whitespace-pre-wrap break-words">
          {interactiveAuth.instruction}
        </pre>
      </div>
    );
  }

  return (
    <div className="grid max-w-[28rem] gap-4 rounded-[20px] border border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-raised)_84%,var(--accent-strong)_16%)] px-5 py-5 text-[var(--text)] shadow-[var(--shadow-soft)]">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <SectionLabel>
          Additional Authentication
        </SectionLabel>
        <strong>추가 인증 입력이 필요합니다.</strong>
        {interactiveAuth.instruction ? <p>{interactiveAuth.instruction}</p> : null}
        {interactiveAuth.prompts.map((prompt, index) => (
          <label
            key={`${interactiveAuth.challengeId}:${index}`}
            className="grid gap-1.5"
          >
            <span className="text-sm font-medium text-[var(--text)]">
              {prompt.label || `Prompt ${index + 1}`}
            </span>
            <Input
              type={prompt.echo ? 'text' : 'password'}
              value={promptResponses[index] ?? ''}
              onChange={(event) => {
                onPromptResponseChange(index, event.target.value);
              }}
            />
          </label>
        ))}
        <div className="flex items-center justify-end gap-3">
          <Button type="submit" variant="primary">
            응답 보내기
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </form>
    </div>
  );
}
