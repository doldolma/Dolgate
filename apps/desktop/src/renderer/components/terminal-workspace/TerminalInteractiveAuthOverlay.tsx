import type { PendingInteractiveAuth } from '../../store/createAppStore';
import { formatInteractiveHop } from '../../store/utils';
import { Button, Input, SectionLabel } from '../../ui';
import { Trans, useTranslation } from 'react-i18next';

interface TerminalInteractiveAuthOverlayProps {
  interactiveAuth: PendingInteractiveAuth;
  promptResponses: string[];
  /** 칸별로 "저장된 비밀번호를 쓴다" 표시. 값은 코어에만 있으므로 화면은 지목만 한다. */
  storedPasswordPrompts?: boolean[];
  onPromptResponseChange: (index: number, value: string) => void;
  onStoredPasswordToggle?: (index: number) => void;
  onSubmit: () => void;
  onCopyApprovalUrl: () => Promise<void>;
  onReopenApprovalUrl: () => void;
  onClose: () => void;
}

export function TerminalInteractiveAuthOverlay({
  interactiveAuth,
  promptResponses,
  storedPasswordPrompts,
  onPromptResponseChange,
  onStoredPasswordToggle,
  onSubmit,
  onCopyApprovalUrl,
  onReopenApprovalUrl,
  onClose,
}: TerminalInteractiveAuthOverlayProps) {
  const { t: translate } = useTranslation();
  // 누가 물었는지. 점프 체인에서는 베스천과 최종 대상이 똑같은 "Verification code:" 를 내밀기
  // 때문에, 이 한 줄이 없으면 어느 쪽 OTP 를 넣어야 하는지 알 수 없다.
  const hopLabel = formatInteractiveHop(interactiveAuth.hop);
  const hopLine = hopLabel ? (
    <p className="flex flex-wrap items-baseline gap-2 text-sm text-[var(--text-soft)]">
      <span>{translate('authOverlay.hopLabel')}</span>
      <code className="rounded-[6px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-1.5 py-0.5 text-[0.82rem] break-all text-[var(--text)]">
        {hopLabel}
      </code>
    </p>
  ) : null;
  if (interactiveAuth.provider === 'warpgate') {
    return (
      // 아래 입력 카드와 같은 규칙으로 띄운다 — 흐름 안에 두면 터미널 크기가 바뀐다.
      <div className="absolute top-[0.35rem] left-1/2 z-20 grid w-full max-w-[28rem] -translate-x-1/2 gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-raised)_84%,var(--accent-strong)_16%)] px-5 py-5 text-[var(--text)] shadow-[var(--shadow-soft)]">
        <SectionLabel>
          Warpgate Approval
        </SectionLabel>
        <strong>{translate('authOverlay.warpgateTitle')}</strong>
        {hopLine}
        <p>
          <Trans i18nKey="authOverlay.warpgateHint" components={{ code: <code /> }} />
        </p>
        {interactiveAuth.authCode ? (
          <p className="text-sm text-[var(--text-soft)]">
            <Trans
              i18nKey="authOverlay.authCodeNote"
              values={{ code: interactiveAuth.authCode }}
              components={{ code: <code /> }}
            />
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {interactiveAuth.approvalUrl ? (
            <Button variant="secondary" size="sm" onClick={onReopenApprovalUrl}>
              {translate('authOverlay.reopenBrowser')}
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
              {translate('authOverlay.copyLink')}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {translate('common.close')}
          </Button>
        </div>
        <pre className="rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-3 py-2 text-[0.82rem] text-[var(--text-soft)] whitespace-pre-wrap break-words">
          {interactiveAuth.instruction}
        </pre>
      </div>
    );
  }

  return (
    // 흐름에서 빼내 위 가운데에 띄운다.
    //
    // 흐름 안에 두면 카드가 터미널 컨테이너를 밀어내 **터미널 크기가 바뀐다** — 그 자체로 PTY
    // 리사이즈가 일어나고(셸이 화면을 다시 그린다), 카드가 사라질 때 또 한 번 바뀐다. 그 사이에
    // 남는 빈 띠가 레이아웃이 깨져 보이던 것이다.
    //
    // 위쪽에 두는 이유: 가운데에 두면 방금 나온 출력을 가린다. 세션 중 재인증에서도 위 몇 줄만
    // 가리는 편이 낫다.
    <div className="absolute top-[0.35rem] left-1/2 z-20 grid w-full max-w-[28rem] -translate-x-1/2 gap-4 rounded-[12px] border border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-raised)_84%,var(--accent-strong)_16%)] px-5 py-5 text-[var(--text)] shadow-[var(--shadow-soft)]">
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
        <strong>{translate('authOverlay.extraAuthTitle')}</strong>
        {hopLine}
        {/* 서버가 보낸 문구를 그대로 보여준다. 무엇을 묻는지는 서버가 쓴 대로가 가장 정확하다 —
            우리가 다듬으면 "비밀번호 먼저, 그다음 코드" 같은 순서가 지워진다. */}
        {interactiveAuth.name ? (
          <p className="text-sm text-[var(--text-soft)] whitespace-pre-wrap break-words">
            {interactiveAuth.name}
          </p>
        ) : null}
        {interactiveAuth.instruction ? (
          <p className="whitespace-pre-wrap break-words">
            {interactiveAuth.instruction}
          </p>
        ) : null}
        {interactiveAuth.prompts.map((prompt, index) => {
          const usesStoredPassword = storedPasswordPrompts?.[index] === true;
          return (
            <label
              key={`${interactiveAuth.challengeId}:${index}`}
              className="grid gap-1.5"
            >
              <span className="text-sm font-medium text-[var(--text)]">
                {prompt.label || `Prompt ${index + 1}`}
              </span>
              <Input
                // 가릴지는 코어가 판정한다(prompt.masked). 서버의 echo 를 그대로 쓰면 일회용
                // 코드까지 가려져서, 사용자가 여섯 자리를 확인하지 못한 채 보내야 한다.
                type={prompt.masked ? 'password' : 'text'}
                value={promptResponses[index] ?? ''}
                disabled={usesStoredPassword}
                placeholder={
                  usesStoredPassword
                    ? translate('authOverlay.storedPasswordInUse')
                    : undefined
                }
                onChange={(event) => {
                  onPromptResponseChange(index, event.target.value);
                }}
              />
              {/* 어느 칸이 비밀번호인지 최종 지목은 사용자가 한다 — 잘못 채워 보내면 인증
                  기회가 한 번뿐이라 그걸로 연결이 끝난다. 다만 인증 코드처럼 **확실히 아닌**
                  칸에는 내밀지 않는다. 그 판정은 코어가 프롬프트마다 내려 준다
                  (allowStoredPassword) — 화면은 그 값을 그릴 뿐이다. */}
              {interactiveAuth.hasStoredPassword &&
              prompt.allowStoredPassword !== false &&
              onStoredPasswordToggle ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onStoredPasswordToggle(index);
                  }}
                >
                  {usesStoredPassword
                    ? translate('authOverlay.storedPasswordCancel')
                    : translate('authOverlay.storedPasswordUse')}
                </Button>
              ) : null}
            </label>
          );
        })}
        {/* 답을 전달하지 못했으면 그 자리에서 말해 준다 — 조용히 실패하면 버튼이 먹통으로 보인다. */}
        {interactiveAuth.deliveryError ? (
          <p
            role="alert"
            className="rounded-[10px] bg-[color-mix(in_srgb,var(--danger)_14%,transparent_86%)] px-3 py-2 text-sm text-[var(--danger)]"
          >
            {translate('authOverlay.deliveryFailed')}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          <Button type="submit" variant="primary">
            {translate('authOverlay.sendResponse')}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {translate('common.close')}
          </Button>
        </div>
      </form>
    </div>
  );
}
