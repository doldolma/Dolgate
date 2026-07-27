import React from 'react';
import ReactDOM from 'react-dom/client';
import 'xterm/css/xterm.css';
import 'uplot/dist/uPlot.min.css';
import './styles/tokens.css';
import './styles/tailwind.css';
import './styles/fonts';
import { App } from './App';
import { SessionReplayWindow } from './components/SessionReplayWindow';
import { SessionShareChatWindow } from './components/SessionShareChatWindow';
import { initRendererI18n } from './i18n';
import { resolveRendererWindowMode } from './window-mode';

// 첫 렌더보다 먼저 언어를 정해 문구가 나중에 바뀌며 깜빡이지 않게 한다.
initRendererI18n();

const rendererWindowMode = resolveRendererWindowMode(window.location.search);

ReactDOM.createRoot(document.getElementById('root')!).render(
  rendererWindowMode.kind === 'session-share-chat' ? (
    <SessionShareChatWindow sessionId={rendererWindowMode.sessionId} />
  ) : rendererWindowMode.kind === 'session-replay' ? (
    <SessionReplayWindow recordingId={rendererWindowMode.recordingId} />
  ) : (
    <App />
  ),
);
