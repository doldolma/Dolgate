import React from 'react';
import ReactDOM from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import 'uplot/dist/uPlot.min.css';
import './styles/tokens.css';
import './styles/tailwind.css';
import './styles/fonts';
import { App } from './App';
import { SessionReplayWindow } from './components/SessionReplayWindow';
import { SessionShareChatWindow } from './components/SessionShareChatWindow';
import { RdpMonitorWindow } from './components/rdp/RdpMonitorWindow';
import { RendererCrashScreen } from './components/RendererCrashScreen';
// 배럴(`./ui`)이 아니라 파일을 직접 가리킨다. 이 바운더리는 "무엇이 깨져도 창은 뜬다" 를 맡는데,
// 배럴을 지나면 그 안의 다른 모듈이 로드 중 던지는 것만으로 바운더리까지 함께 사라진다.
import { ErrorBoundary } from './ui/ErrorBoundary';
import { initRendererI18n } from './i18n';
import { resolveRendererWindowMode } from './window-mode';

// 첫 렌더보다 먼저 언어를 정해 문구가 나중에 바뀌며 깜빡이지 않게 한다.
initRendererI18n();

const rendererWindowMode = resolveRendererWindowMode(window.location.search);

// 가장 바깥에서 감싼다. 창 컴포넌트 **안쪽**에 두면 그 컴포넌트 자신의 훅·렌더에서 던진 오류는
// 잡히지 않고, 그게 정확히 창이 빈 화면으로 남는 경우다.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary
    label={`window:${rendererWindowMode.kind}`}
    fallback={(error, reset) => <RendererCrashScreen error={error} onRetry={reset} />}
  >
    {rendererWindowMode.kind === 'session-share-chat' ? (
      <SessionShareChatWindow sessionId={rendererWindowMode.sessionId} />
    ) : rendererWindowMode.kind === 'session-replay' ? (
      <SessionReplayWindow recordingId={rendererWindowMode.recordingId} />
    ) : rendererWindowMode.kind === 'rdp-monitor' ? (
      <RdpMonitorWindow
        sessionId={rendererWindowMode.sessionId}
        monitorIndex={rendererWindowMode.monitorIndex}
      />
    ) : (
      <App />
    )}
  </ErrorBoundary>,
);
