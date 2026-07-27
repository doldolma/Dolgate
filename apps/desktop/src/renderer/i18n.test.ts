import i18next from 'i18next';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { applyRendererLanguage, initRendererI18n, t } from './i18n';

// 테스트 전체는 vitest.setup.ts 에서 한국어로 고정된다. 여기서만 영어로 바꿔
// 두 카탈로그가 실제로 연결됐는지 확인하고 되돌린다.
afterEach(() => {
  window.localStorage.clear();
});

afterAll(() => {
  applyRendererLanguage('system');
  initRendererI18n('ko');
});

describe('렌더러 i18n', () => {
  it('기본은 한국어 원문을 그대로 돌려준다', () => {
    expect(i18next.language).toBe('ko');
    expect(t('login.openBrowser')).toBe('브라우저로 로그인하기');
    expect(t('common.save')).toBe('저장');
  });

  it('시스템 언어가 한국어가 아니면 영어로 번역한다', () => {
    initRendererI18n('en-US');

    expect(i18next.language).toBe('en');
    expect(t('login.openBrowser')).toBe('Sign in with Browser');
    expect(t('common.save')).toBe('Save');
  });

  it('영어 번역이 없는 키는 한국어로 폴백한다', () => {
    initRendererI18n('en-US');

    // 실제로 존재하지 않는 키는 키 문자열이 그대로 나오고, 폴백 언어는 한국어다.
    expect(i18next.options.fallbackLng).toContain('ko');
  });
});

describe('언어 설정 적용', () => {
  it('설정에서 고른 언어가 시스템 언어를 이긴다', () => {
    initRendererI18n('ko-KR');
    expect(i18next.language).toBe('ko');

    applyRendererLanguage('en');
    expect(i18next.language).toBe('en');
    expect(t('common.save')).toBe('Save');

    applyRendererLanguage('ko');
    expect(i18next.language).toBe('ko');
    expect(t('common.save')).toBe('저장');
  });

  it("'system' 으로 되돌리면 다시 시스템 언어를 따른다", () => {
    initRendererI18n('en-US');
    applyRendererLanguage('ko');
    expect(i18next.language).toBe('ko');

    // navigator.language(jsdom 기본값 en-US)를 다시 따라간다.
    applyRendererLanguage('system');
    expect(i18next.language).toBe('en');
  });

  // 설정은 IPC 로 첫 렌더 뒤에 도착한다. 마지막 선택을 기억하지 않으면 앱을 켤 때마다
  // 시스템 언어로 한 프레임 그린 뒤 바뀌어 깜빡인다.
  it('선택한 언어를 기억해 다음 실행의 첫 프레임부터 적용한다', () => {
    applyRendererLanguage('ko');

    initRendererI18n('en-US');
    expect(i18next.language).toBe('ko');
  });
});
