import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { initRendererI18n } from './src/renderer/i18n';

// 테스트는 한국어로 고정한다. 원문이 한국어이고 기존 단언들이 한국어 UI 문구를 그대로
// 찾으므로, jsdom 기본 navigator.language(en-US)를 따르면 전부 깨진다.
initRendererI18n('ko');

// waitFor/findBy 의 기본 대기 시간은 1초인데, 이 단언들은 "언젠가 이 상태가 된다"를 확인하는
// 것이지 1초 안에 되는지를 재는 게 아니다. 전체 스위트는 파일을 여러 프로세스로 병렬 실행해
// 무거운 jsdom+React 파일이 겹치면 워커가 잠깐 굶고, 그때 단독으로는 늘 통과하는 테스트가
// 산발적으로 실패한다. CI 러너는 개발 머신보다 느려 더 자주 걸린다.
configure({ asyncUtilTimeout: 3000 });

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => ({
      createLinearGradient: () => ({
        addColorStop: () => undefined
      }),
      fillRect: () => undefined,
      clearRect: () => undefined,
      getImageData: () => ({
        data: new Uint8ClampedArray([0, 0, 0, 0])
      }),
      putImageData: () => undefined,
      createImageData: () => [],
      setTransform: () => undefined,
      drawImage: () => undefined,
      save: () => undefined,
      fillText: () => undefined,
      restore: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      closePath: () => undefined,
      stroke: () => undefined,
      translate: () => undefined,
      scale: () => undefined,
      rotate: () => undefined,
      arc: () => undefined,
      fill: () => undefined,
      measureText: () => ({
        width: 0
      }),
      transform: () => undefined,
      rect: () => undefined,
      clip: () => undefined
    })
  });
}

afterEach(() => {
  cleanup();
});
