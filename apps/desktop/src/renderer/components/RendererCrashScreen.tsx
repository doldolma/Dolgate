import { t } from '../i18n';

/**
 * 창 전체가 그려지지 못했을 때 대신 뜨는 화면.
 *
 * **스토어·컨텍스트·훅에 기대지 않는다.** 이 화면이 뜨는 상황은 앱 트리가 이미 죽은 상황이라,
 * 무엇에 기대든 그것도 같이 죽어 있을 수 있다. CSS 변수와 모듈 `t()` 만 쓴다(언어는 첫 렌더 전에
 * 정해진다).
 *
 * 오류 문구를 그대로 보여준다 — "문제가 발생했습니다" 만 띄우면 사용자가 전할 수 있는 정보가
 * 없고, 우리도 빈 화면 신고를 받고 처음부터 다시 좁혀야 한다.
 */
export function RendererCrashScreen({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div className="grid h-screen place-items-center bg-[var(--app-bg)] px-6 text-[var(--text)]">
      <div className="flex w-full max-w-[34rem] flex-col gap-3">
        <h1 className="text-[1.05rem] font-bold">{t('errorBoundary.title')}</h1>
        <p className="text-[0.86rem] leading-[1.55] text-[var(--text-soft)]">
          {t('errorBoundary.message')}
        </p>
        <code className="select-text max-h-[9rem] overflow-auto whitespace-pre-wrap rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 font-mono text-[0.76rem] leading-[1.5] text-[var(--danger-text)]">
          {error.message || String(error)}
        </code>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1.5 text-[0.82rem] font-semibold text-[var(--text)]"
          >
            {t('errorBoundary.retry')}
          </button>
          <button
            type="button"
            onClick={() => globalThis.location?.reload()}
            className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1.5 text-[0.82rem] font-semibold text-[var(--text)]"
          >
            {t('errorBoundary.reload')}
          </button>
        </div>
      </div>
    </div>
  );
}
