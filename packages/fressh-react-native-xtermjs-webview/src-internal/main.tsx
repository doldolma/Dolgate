// WebView 안에서 도는 xterm 페이지. RN 쪽(src/index.tsx)과는 src/bridge.ts 의 메시지로만 말한다.
//
// **이 파일이 왜 여기 있나.** 상류 패키지(@fressh/react-native-xtermjs-webview 0.0.8)는 이 소스를
// 배포에 넣지 않아서, 우리 저장소에는 빌드된 페이지(dist-internal/index.html)만 있었다. 그런데 그건
// gitignore 대상이라 새로 클론하면 페이지를 만들 방법이 없었고, 무엇보다 **손댈 수가 없었다** —
// 링크 애드온처럼 페이지 안에서만 할 수 있는 일이 막혀 있었다. 그래서 기존 번들의 동작을 그대로
// 되살려 옮겨 적었다. 아래 동작은 0.0.8 번들과 같고, 링크 처리만 새로 붙였다.
//
// 링크를 페이지에서 다루는 이유: URL 을 찾는 일은 xterm 이 이미 애드온으로 한다. RN 쪽에서 글을
// 정규식으로 뒤지면 배너 하나는 되지만 세션 출력 전체(MOTD 의 업데이트 안내, 로그에 찍힌 주소)는
// 그대로 남는다. 그리고 무엇이 링크인지 판정하는 규칙이 두 곳으로 갈린다.

import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Base64 } from 'js-base64';
import type {
	BridgeInboundMessage,
	BridgeOutboundMessage,
} from '../src/bridge';

declare global {
	interface Window {
		terminal?: Terminal;
		fitAddon?: FitAddon;
		__FRESSH_XTERM_BRIDGE__?: boolean;
		__FRESSH_XTERM_MSG_HANDLER__?: (event: MessageEvent) => void;
		ReactNativeWebView?: {
			postMessage?: (data: string) => void;
			injectedObjectJson?: () => string | undefined;
		};
	}
}

const postToHost = (message: BridgeInboundMessage): void =>
	window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));

const debug = (message: string): void => postToHost({ type: 'debug', message });

window.onload = () => {
	try {
		// WebView 가 스크립트를 두 번 넣는 경우가 있다(안드로이드의 재주입). 두 번째 부팅은
		// 터미널을 새로 만들어 화면을 지우므로 여기서 접는다.
		if (window.__FRESSH_XTERM_BRIDGE__) {
			debug('bridge already installed; ignoring duplicate boot');
			return;
		}
		const injected = window.ReactNativeWebView?.injectedObjectJson?.();
		if (!injected) {
			debug('injectedObjectJson not found; ignoring duplicate boot');
			return;
		}
		window.__FRESSH_XTERM_BRIDGE__ = true;

		const options = JSON.parse(injected) as ConstructorParameters<
			typeof Terminal
		>[0];
		const terminal = new Terminal(options);
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);

		// 링크는 애드온이 찾고, 누른 결과는 RN 이 정한다.
		//
		// 여기서 열지 않는 것이 중요하다. 기본 동작은 window.open 인데, 이 WebView 는
		// setSupportMultipleWindows:false 라서 같은 창이 그 주소로 이동한다 — 터미널 페이지가
		// 사라지고 세션이 그대로 죽는다. 그래서 주소만 올려보내고, 어디서 열지는 앱이 정한다.
		terminal.loadAddon(
			new WebLinksAddon((event, uri) => {
				event.preventDefault();
				postToHost({ type: 'linkActivated', uri });
			}),
		);

		const element = document.getElementById('terminal');
		if (!element) {
			throw new Error('#terminal not found');
		}
		terminal.open(element);
		fitAddon.fit();
		window.terminal = terminal;
		window.fitAddon = fitAddon;

		terminal.onData((str) => {
			postToHost({ type: 'input', str });
		});

		if (window.__FRESSH_XTERM_MSG_HANDLER__) {
			window.removeEventListener(
				'message',
				window.__FRESSH_XTERM_MSG_HANDLER__ as EventListener,
			);
		}
		const handler = (event: MessageEvent) => {
			try {
				const message = event.data as BridgeOutboundMessage | undefined;
				if (!message || typeof message.type !== 'string') {
					return;
				}
				const write = (bStr: string) => {
					terminal.write(Base64.toUint8Array(bStr));
				};
				switch (message.type) {
					case 'write': {
						write(message.bStr);
						break;
					}
					case 'writeMany': {
						for (const chunk of message.chunks) {
							write(chunk);
						}
						break;
					}
					case 'resize': {
						terminal.resize(message.cols, message.rows);
						break;
					}
					case 'fit': {
						fitAddon.fit();
						break;
					}
					case 'setOptions': {
						const next = {
							...terminal.options,
							...message.opts,
							theme: { ...terminal.options.theme, ...message.opts.theme },
						};
						// cols·rows 는 생성할 때만 쓰는 값이다. 여기서 넘기면 xterm 이 거부한다.
						delete (next as Record<string, unknown>).cols;
						delete (next as Record<string, unknown>).rows;
						terminal.options = next;
						// 터미널 배경은 캔버스 안쪽만 칠한다. 페이지 배경까지 맞추지 않으면 화면을
						// 채우기 전 여백이 흰색으로 비친다.
						if (next.theme?.background) {
							document.body.style.backgroundColor = next.theme.background;
						}
						break;
					}
					case 'clear': {
						terminal.clear();
						break;
					}
					case 'focus': {
						terminal.focus();
						break;
					}
				}
			} catch (error) {
				debug(`message handler error: ${String(error)}`);
			}
		};
		window.__FRESSH_XTERM_MSG_HANDLER__ = handler;
		window.addEventListener('message', handler as EventListener);

		// xterm 의 숨은 textarea 를 모바일 키보드에 맞춘다. 자동수정·자동대문자가 켜져 있으면
		// 셸에 엉뚱한 글자가 들어간다. 요소는 open() 뒤에 생기므로 한 틱 뒤에 찾는다.
		setTimeout(() => {
			const textarea = document.querySelector('.xterm-helper-textarea');
			if (!textarea) {
				throw new Error('xterm-helper-textarea not found');
			}
			textarea.setAttribute('autocomplete', 'off');
			textarea.setAttribute('autocorrect', 'off');
			textarea.setAttribute('autocapitalize', 'none');
			textarea.setAttribute('spellcheck', 'false');
			textarea.setAttribute('inputmode', 'verbatim');
			return postToHost({ type: 'initialized' });
		}, 200);
	} catch (error) {
		debug(`error in xtermjs-webview: ${String(error)}`);
	}
};
