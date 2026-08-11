import type { HostRecord } from '@shared';
import type { ReactNode } from 'react';
import { ErrorBoundary } from '../../ui';
import { t } from '../../i18n';

/**
 * 호스트 한 줄(카드·표의 행)을 감싼다.
 *
 * 목록은 호스트마다 같은 코드를 돌리므로, 한 레코드가 이 빌드가 모르는 모양이면 목록 전체가 —
 * 즉 앱 전체가 — 안 그려진다. 그 레코드만 자리를 대신 차지하게 만들어 나머지 호스트는 계속 쓸 수
 * 있게 한다.
 *
 * **줄 내용을 `render` 함수로 받는 이유:** 에러 바운더리는 자기 자손의 렌더에서 난 오류만 잡는다.
 * `<Boundary><Row prop={host.label} /></Boundary>` 처럼 쓰면 `host.label` 은 부모(목록)의 렌더에서
 * 읽히므로, 거기서 던지면 바운더리를 지나쳐 목록 전체가 죽는다. 함수로 받아 자손 안에서 부르면
 * 그 계산까지 이 줄 안에 묶인다.
 */
export function HostRowBoundary({
  host,
  render,
}: {
  host: HostRecord;
  render: () => ReactNode;
}) {
  const id = safeText(() => host.id);
  return (
    <ErrorBoundary
      label={`host-row:${id}`}
      resetKey={id}
      fallback={() => (
        <div className="flex min-w-0 items-center gap-2 rounded-[10px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-3 py-2 text-[0.82rem] text-[var(--danger-text)]">
          <span className="min-w-0 truncate">
            {/* 라벨도 읽다 던질 수 있다(값이 getter 일 수 있다). 폴백이 던지면 그 오류는 다시
                위로 올라가 목록을 죽이므로 여기서도 감싸 읽는다. */}
            {t('errorBoundary.hostRow', { label: safeText(() => host.label) || id || '?' })}
          </span>
        </div>
      )}
    >
      <HostRowBody render={render} />
    </ErrorBoundary>
  );
}

/** 줄 내용을 바운더리의 자손에서 만든다 — 여기서 던진 오류는 위의 바운더리가 잡는다. */
function HostRowBody({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

function safeText(read: () => unknown): string {
  try {
    const value = read();
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
