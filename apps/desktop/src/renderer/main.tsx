import React from 'react';
import ReactDOM from 'react-dom/client';
import 'xterm/css/xterm.css';
import 'uplot/dist/uPlot.min.css';
import './styles/index.css';
import { App } from './App';
import { SessionReplayWindow } from './components/SessionReplayWindow';
import { SessionShareChatWindow } from './components/SessionShareChatWindow';
import { resolveRendererWindowMode } from './window-mode';

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
