import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { applyRendererLanguage, initRendererI18n } from './i18n';
import { ConnectionHopSteps } from './components/ConnectionHopSteps';
import { OfflineModeBanner } from './shells/OfflineModeBanner';

// 카탈로그 키 검사(common/i18n/locale.test.ts)와 별개로, 실제 컴포넌트가 언어 전환에
// 반응하는지 본다. useTranslation 을 빼먹고 모듈 t 만 쓰면 화면이 그대로 남는데,
// 키 검사만으로는 그 실수를 잡지 못한다.
afterEach(() => {
  applyRendererLanguage('system');
  initRendererI18n('ko');
});

describe('언어 전환이 화면에 반영된다', () => {
  it('연결 단계 배지가 두 언어로 렌더된다', () => {
    const steps = [
      { index: 0, count: 1, label: 'ops@bastion:22', stage: 'connected' as const },
    ];

    const view = render(<ConnectionHopSteps steps={steps} />);
    expect(screen.getByText('연결됨')).toBeInTheDocument();

    applyRendererLanguage('en');
    view.rerender(<ConnectionHopSteps steps={steps} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('오프라인 배너가 두 언어로 렌더된다', () => {
    const props = { expiryLabel: null, isRetrying: false, onRetry: () => {} };

    const view = render(<OfflineModeBanner {...props} />);
    expect(screen.getByText(/오프라인 모드로 실행 중입니다/)).toBeInTheDocument();

    applyRendererLanguage('en');
    view.rerender(<OfflineModeBanner {...props} />);
    expect(screen.getByText(/running in offline mode/)).toBeInTheDocument();
  });
});
